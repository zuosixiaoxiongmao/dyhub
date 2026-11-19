/**
 * 礼物 / 登录态看门狗
 *
 * 抖音用主播本人账号采集自己的直播间时，网页登录态会被周期性踢掉（20003）。
 * 此时连接表面仍是 live、弹幕照常，但礼物消息不再推送，属于「静默丢礼物」。
 *
 * 看门狗做两件事：
 *  1. 周期探测房间绑定账号的登录态，明确失效时写房间告警；
 *  2. 统计弹幕 / 礼物流量，弹幕活跃但长时间零礼物时写告警，并在允许时同账号重连一次。
 *
 * 告警写入 Collector（`RoomInfo.warning`），控制台 30s 轮询直接可见；
 * 变更事件由 index.ts 发布为 `roomWarning`，WS / SSE / Webhook 自动流出。
 */

import type { EventBus } from '../pipeline/eventBus.js';
import type { Collector, RoomInfo } from '../collector/collector.js';
import type { DanmakuEvent, RoomWarning } from '../types/events.js';
import { accountCookieKey, probeAccountLogin, type LoginProbe } from '../collector/accountProfile.js';
import * as accountStore from '../collector/accountStore.js';
import type { WatchdogConfig, WatchdogConfigStore } from './watchdogConfig.js';

/** tick 周期（秒级精度，10s 足够且开销可忽略） */
const TICK_MS = 10_000;
/** 「弹幕在动」统计窗口 = 零礼物窗口 × 该系数，避免窗口刚好卡在边界 */
const CHAT_WINDOW_FACTOR = 2;
/** 中文礼物名（如「小心心」「玫瑰」），用于识别「本会话确实有过礼物流」 */
const CN_GIFT_RE = /[一-龥]/;
/** 会话掉线（wss 彻底关闭 / 页面崩溃）持续多久后自动重连 */
const DEAD_RECONNECT_MS = 30_000;
/** 同一房间连续掉线重连的次数上限：主播下播后会话会一直 closed，避免无限重试 */
const MAX_DEAD_RECONNECTS = 3;
/** 这些 status 代表采集会话已断，任何一条推进依赖重连恢复 */
const DEAD_STATUSES = new Set(['closed', 'error']);

interface RoomWatch {
  /** 本会话进入 live 的时间（宽限期起点） */
  liveAt: number;
  lastGiftAt: number | null;
  /** 本会话是否收到过带中文名的礼物（强证据） */
  hadGiftFlow: boolean;
  /** 零礼物告警首次触发时间；收到礼物后清空 */
  giftSilentSince: number | null;
  /** 最近窗口内的非空弹幕时间戳 */
  chatTimestamps: number[];
  probe: LoginProbe | null;
  loginInvalid: boolean;
  loginInvalidReason: string | null;
  loginInvalidSince: number | null;
  selfSince: number | null;
  nextProbeAt: number;
  probeBackoffMs: number;
}

export interface WatchdogOptions {
  bus: EventBus;
  collector: Collector;
  config: WatchdogConfigStore;
}

export class Watchdog {
  private subId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watches = new Map<string, RoomWatch>();
  /** roomId → 上次自动重连时间，防止重连后立刻再次触发 */
  private lastReconnectAt = new Map<string, number>();
  private reconnecting = new Set<string>();
  /** roomId → 会话在线状态跟踪（页面崩溃 / 弹幕通道彻底断开时自动重连） */
  private links = new Map<string, { seenLive: boolean; deadSince: number | null; attempts: number }>();
  private ticking = false;

  constructor(private readonly opts: WatchdogOptions) {}

  /** 幂等启动：订阅 chat/gift，开启 10s ticker，并立即跑一轮 */
  start(): void {
    if (this.timer) return;
    this.subId = this.opts.bus.subscribe({ type: ['chat', 'gift'] }, (ev) => this.onEvent(ev));
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.subId !== null) {
      this.opts.bus.unsubscribe(this.subId);
      this.subId = null;
    }
    this.clearWarnings();
    this.lastReconnectAt.clear();
    this.reconnecting.clear();
    this.links.clear();
  }

  private onEvent(ev: DanmakuEvent): void {
    if (ev.type !== 'chat' && ev.type !== 'gift') return;
    // 日志补报不能证明网页的礼物流恢复。
    if (ev.type === 'gift' && ev.source === 'liveCompanionLog') return;
    const cfg = this.opts.config.get();
    if (!cfg.enabled) return;
    const room = this.opts.collector.getRoomInfo(ev.roomId);
    if (!room || room.status !== 'live') return;
    const w = this.ensureWatch(room);
    const now = Date.now();

    if (ev.type === 'gift') {
      w.lastGiftAt = now;
      if (ev.data.giftId && CN_GIFT_RE.test(ev.data.giftName || '')) w.hadGiftFlow = true;
      if (w.giftSilentSince !== null) {
        w.giftSilentSince = null;
        // 礼物恢复后立刻重算，销掉 giftSilent 告警
        this.evaluate(room, w, now, cfg, 'gift-started');
      }
      return;
    }

    if (ev.data.content.trim()) w.chatTimestamps.push(now);
  }

  private ensureWatch(room: RoomInfo): RoomWatch {
    let w = this.watches.get(room.roomId);
    if (!w) {
      const now = Date.now();
      w = {
        // 从「看门狗开始观察」起算，避免服务重启 / 重新启用后对历史数据立即误报
        liveAt: now,
        lastGiftAt: null,
        hadGiftFlow: false,
        giftSilentSince: null,
        chatTimestamps: [],
        probe: null,
        loginInvalid: false,
        loginInvalidReason: null,
        loginInvalidSince: null,
        selfSince: null,
        nextProbeAt: 0,
        probeBackoffMs: this.opts.config.get().probeSec * 1000,
      };
      this.watches.set(room.roomId, w);
    }
    return w;
  }

  /**
   * 会话级自动重连：只拉起「曾经 live 过」、随后进入 closed / error 超过阈值且仍存在的房间。
   * 与礼物静默重连共用冷却时间；同一房间连续失败 MAX_DEAD_RECONNECTS 次后停手
   * （通常是主播已下播，反复开页面没有意义）。
   */
  private trackLinks(rooms: RoomInfo[], cfg: WatchdogConfig): void {
    if (!cfg.autoReconnect) return;
    const now = Date.now();
    for (const room of rooms) {
      const link = this.links.get(room.roomId) ?? { seenLive: false, deadSince: null, attempts: 0 };
      this.links.set(room.roomId, link);
      if (room.status === 'live') {
        link.seenLive = true;
        link.deadSince = null;
        link.attempts = 0;
        continue;
      }
      // stopped 是用户主动断开，connecting 是过程态，都不自动拉起；从未 live 过的房间也不管
      if (!link.seenLive || !DEAD_STATUSES.has(room.status)) {
        link.deadSince = null;
        continue;
      }
      if (link.deadSince === null) link.deadSince = now;
      if (link.attempts >= MAX_DEAD_RECONNECTS || now - link.deadSince < DEAD_RECONNECT_MS) continue;
      if (this.maybeReconnect(room, cfg, 'session')) {
        link.attempts += 1;
        link.deadSince = now;
      }
    }
  }

  private cookieOf(room: RoomInfo): string {
    return room.accountId ? accountStore.getAccountCookieStr(room.accountId) : '';
  }

  private pruneChats(w: RoomWatch, now: number, cfg: WatchdogConfig): void {
    if (!w.chatTimestamps.length) return;
    const cutoff = now - cfg.giftQuietMin * 60_000 * CHAT_WINDOW_FACTOR;
    let i = 0;
    while (i < w.chatTimestamps.length && w.chatTimestamps[i] < cutoff) i++;
    if (i) w.chatTimestamps.splice(0, i);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cfg = this.opts.config.get();
      if (!cfg.enabled) {
        this.clearWarnings();
        return;
      }

      const allRooms = this.opts.collector.getRooms();
      this.trackLinks(allRooms, cfg);
      const rooms = new Map(
        allRooms
          .filter((r) => r.status === 'live')
          .map((r) => [r.roomId, r] as const),
      );
      // 房间已移除：清掉告警并丢弃统计 / 掉线跟踪
      const present = new Set(allRooms.map((r) => r.roomId));
      for (const roomId of [...this.watches.keys()]) {
        if (!rooms.has(roomId)) {
          this.opts.collector.setRoomWarning(roomId, null, 'disconnected');
          this.watches.delete(roomId);
        }
      }
      for (const roomId of [...this.links.keys()]) {
        if (!present.has(roomId)) this.links.delete(roomId);
      }

      const now = Date.now();
      // 同一 cookie 的多个房间合并成一次探测
      const probeGroups = new Map<string, { cookie: string; rooms: RoomInfo[] }>();
      for (const room of rooms.values()) {
        const w = this.ensureWatch(room);
        this.pruneChats(w, now, cfg);
        this.evaluate(room, w, now, cfg);
        const cookie = this.cookieOf(room);
        if (cfg.loginCheck && cookie && now >= w.nextProbeAt) {
          const key = accountCookieKey(cookie);
          const g = probeGroups.get(key);
          if (g) g.rooms.push(room);
          else probeGroups.set(key, { cookie, rooms: [room] });
        }
      }

      await Promise.all(
        [...probeGroups.values()].map(async (g) => {
          const probe = await probeAccountLogin(g.cookie, { force: true });
          for (const room of g.rooms) {
            const w = this.watches.get(room.roomId);
            // 探测期间房间已断开 / 正在重连，结果不再适用
            if (!w || this.opts.collector.getRoomInfo(room.roomId)?.status !== 'live') continue;
            // 探测期间换了账号 / 换了 cookie，旧结果作废
            const current = this.cookieOf(room);
            if (!current || accountCookieKey(current) !== probe.cookieKey) continue;
            this.applyProbe(room, w, probe, cfg);
            this.evaluate(room, w, Date.now(), cfg);
          }
        }),
      );
    } catch (e) {
      console.error('[dyhub] 看门狗 tick 失败:', e instanceof Error ? e.message : e);
    } finally {
      this.ticking = false;
    }
  }

  private applyProbe(room: RoomInfo, w: RoomWatch, probe: LoginProbe, cfg: WatchdogConfig): void {
    const wasInvalid = w.loginInvalid;
    w.probe = probe;
    if (probe.state === 'invalid') {
      w.loginInvalid = true;
      w.loginInvalidReason = probe.reason ?? null;
      if (!wasInvalid) {
        w.loginInvalidSince = Date.now();
        console.log(`[dyhub] 房间 ${room.roomId} 账号登录已失效（${probe.reason ?? 'unknown'}），网页礼物采集可能中断`);
      }
      w.probeBackoffMs = Math.min(
        Math.max(w.probeBackoffMs, cfg.probeSec * 1000) * 2,
        cfg.probeMaxSec * 1000,
      );
    } else if (probe.state === 'valid') {
      if (wasInvalid) console.log(`[dyhub] 房间 ${room.roomId} 账号登录态已恢复`);
      w.loginInvalid = false;
      w.loginInvalidReason = null;
      w.loginInvalidSince = null;
      w.probeBackoffMs = cfg.probeSec * 1000;
    } else {
      // 网络异常 / 其它业务码：不改变已知的登录态，只按正常节奏重试
      w.probeBackoffMs = cfg.probeSec * 1000;
    }
    w.nextProbeAt = Date.now() + w.probeBackoffMs;
  }

  /** 按当前统计与探测结果计算告警；同一结果由 Collector 去重，不重复发事件 */
  private evaluate(room: RoomInfo, w: RoomWatch, now: number, cfg: WatchdogConfig, reason?: string): void {
    const quietMs = cfg.giftQuietMin * 60_000;
    const graceOver = now - w.liveAt >= quietMs;
    const chatMoving = w.chatTimestamps.length >= cfg.minChats;
    const quiet = now - (w.lastGiftAt ?? w.liveAt) >= quietMs;
    if (graceOver && chatMoving && quiet && w.giftSilentSince === null) {
      w.giftSilentSince = now;
    }

    const self = this.opts.collector.isSelfAccount(room.roomId);
    if (self && w.selfSince === null) w.selfSince = now;
    if (!self) w.selfSince = null;

    let warning: RoomWarning | null = null;
    if (w.loginInvalid) {
      warning = {
        level: 'error',
        code: 'loginInvalid',
        since: w.loginInvalidSince ?? now,
        hits: 1,
        message: self
          ? '主播本人号已掉登录，网页礼物采集可能中断，请换观众小号并重新登录。'
          : `账号登录已失效（${w.loginInvalidReason ?? '20003'}），网页礼物采集可能中断。请在控制台重新登录该账号或换观众小号。`,
      };
    } else if (w.giftSilentSince !== null) {
      const strong = w.hadGiftFlow;
      warning = {
        level: strong ? 'error' : 'warning',
        code: 'giftSilent',
        since: w.giftSilentSince,
        hits: 1,
        message: strong
          ? `弹幕正常但已 ${cfg.giftQuietMin} 分钟没收到礼物（此前有礼物流），疑似静默丢失；请检查账号登录态。`
          : `已 ${cfg.giftQuietMin} 分钟没收到礼物且弹幕活跃；如果直播间本来没人送礼可忽略，否则请检查账号登录态。`,
      };
    } else if (self) {
      warning = {
        level: 'warning',
        code: 'selfAccount',
        since: w.selfSince ?? now,
        hits: 1,
        message: '当前用主播本人账号采集，网页登录态会被周期性踢掉，礼物可能静默丢失；建议换观众小号。',
      };
    }

    this.opts.collector.setRoomWarning(room.roomId, warning, reason);

    // 只有「此前有礼物流、之后突然归零」的强证据才重连；从没收到过礼物的房间只给弱提示，
    // 否则小房间会被当成故障反复重连。主播本人账号也用同一个账号重连（不自动换号）：
    // 登录态仍有效但礼物流断掉时，重建会话有机会恢复推送。
    if (warning?.code === 'giftSilent' && warning.level === 'error' && cfg.autoReconnect && w.probe?.state !== 'invalid') {
      this.maybeReconnect(room, cfg, 'giftSilent');
    }
  }

  /** 返回 true 表示本次真的发起了重连（受账号、并发与冷却约束） */
  private maybeReconnect(room: RoomInfo, cfg: WatchdogConfig, reason: 'giftSilent' | 'session'): boolean {
    const roomId = room.roomId;
    const accountId = room.accountId;
    if (!accountId || this.reconnecting.has(roomId)) return false;
    const now = Date.now();
    const last = this.lastReconnectAt.get(roomId) ?? 0;
    if (now - last < cfg.reconnectCooldownSec * 1000) return false;

    this.lastReconnectAt.set(roomId, now);
    this.reconnecting.add(roomId);
    console.log(
      reason === 'session'
        ? `[dyhub] 房间 ${roomId} 看门狗：采集会话已断开（${room.status}），自动重连`
        : `[dyhub] 房间 ${roomId} 看门狗：弹幕活跃但长时间无礼物，尝试同账号重连一次`,
    );
    void (async () => {
      try {
        await this.opts.collector.disconnect(roomId);
        await this.opts.collector.connect(roomId, { accountId });
      } catch (e) {
        console.error(`[dyhub] 房间 ${roomId} 看门狗自动重连失败:`, e instanceof Error ? e.message : e);
      } finally {
        this.reconnecting.delete(roomId);
      }
    })();
    return true;
  }

  private clearWarnings(): void {
    for (const roomId of this.watches.keys()) {
      this.opts.collector.setRoomWarning(roomId, null, 'disconnected');
    }
    this.watches.clear();
  }
}
