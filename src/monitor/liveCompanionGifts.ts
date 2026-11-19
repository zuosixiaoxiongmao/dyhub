import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import Long from 'long';
import type { Collector } from '../collector/collector.js';
import { normalizeDecoded } from '../pipeline/normalizer.js';
import { decodeMessageBody, longToStr } from '../proto/douyin.proto.js';
import type { GiftEvent } from '../types/events.js';

const METHOD = 'WebcastGiftMessage';
const LOG_FILE = /^(\d{4}(?:-\d{2}){5})(?:\.(\d+))?\.log$/;
/** 行首时间：直播伴侣写日志时的本机时间（与消息里的服务器 createTime 无关） */
const LINE_TS = /^\[(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
const GIFT_LINE = /^\[[\dT:.-]+\] \[INFO\] <sdk> \[node\] <revenue-kmp> \[app-base\] +receive event webcast-im-bin-data (\{.*\})$/;
const POLL_MS = 1_000;
const CHUNK_BYTES = 256 * 1024;
/** 启用时从一个已存在文件的末尾回看这么多字节，避免把整份日志从头重读 */
const TAIL_BYTES = 512 * 1024;
/** 行时间超过这个延迟（例如轮询被长时间阻塞）就放弃补报，避免启用后集中重放历史礼物 */
const MAX_LAG_MS = 10 * 60_000;

/**
 * 日志行前缀的本地时间。
 * 新鲜度判断必须用它，而不是消息里的 common.createTime：后者是抖音服务器时钟，
 * 本机时钟只要偏几十秒，「未来时间」判断就会把正常到达的礼物全部丢掉。
 */
function parseLineTs(line: string): number {
  const m = LINE_TS.exec(line);
  if (!m) return 0;
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]),
  ).getTime();
}

interface FileCursor {
  offset: number;
  partial: string;
}

function parseGift(line: string) {
  const json = GIFT_LINE.exec(line)?.[1];
  if (!json) return;
  try {
    const { method, data, msgId } = JSON.parse(json);
    if (method !== METHOD || typeof data !== 'string' || !msgId) return;
    const { low, high } = msgId;
    if (!Number.isInteger(low) || low !== (low | 0) || !Number.isInteger(high) || high !== (high | 0)) return;
    const id = Long.fromBits(low, high, true).toString();
    const payload = Buffer.from(data, 'base64');
    if (payload.toString('base64') !== data) return;
    const decoded = decodeMessageBody({ method, msgId: id, payload });
    if (!decoded) return;
    const { common, gift, user, giftId, repeatCount, groupCount, comboCount } = decoded.body;
    const webcastRoomId = longToStr(common?.roomId);
    const senderId = user?.idStr || longToStr(user?.id);
    const ts = Number(common?.createTime);
    if (id === '0' || id !== longToStr(common?.msgId) || !/^[1-9]\d*$/.test(webcastRoomId)) return;
    if (!Number.isSafeInteger(ts) || ts <= 0 || !gift?.name || !/^[1-9]\d*$/.test(senderId)) return;
    if (!(Number(giftId) > 0) || !(Math.max(Number(repeatCount), Number(groupCount), Number(comboCount)) > 0)) return;
    // ts 只用于事件本身的时间；新鲜度按日志行时间判断，见 onLine。
    return { decoded, webcastRoomId };
  } catch {
    return;
  }
}

type State = 'disabled' | 'unsupported' | 'waiting' | 'watching' | 'error';

export class LiveCompanionGifts {
  private enabled = false;
  private state: State = 'disabled';
  private published = 0;
  private stopPolling?: () => void;

  constructor(
    private readonly collector: Pick<Collector, 'getLiveRoomByWebcastId'>,
    private readonly publish: (event: GiftEvent) => boolean,
    private readonly dir = process.platform === 'win32' && process.env.APPDATA
      ? join(process.env.APPDATA, 'webcast_mate', 'matex', 'logs') : '',
    private readonly configDir = join(process.cwd(), 'data'),
  ) {}

  start(): void {
    // 缺失或损坏的配置按默认关闭处理。
    try {
      if (JSON.parse(readFileSync(join(this.configDir, 'live-companion-gifts.json'), 'utf8')).enabled !== true) return;
    } catch {
      return;
    }
    this.setEnabled(true);
  }

  stop(): void {
    this.setEnabled(false);
  }

  getStatus() {
    return { enabled: this.enabled, state: this.state, published: this.published };
  }

  update(enabled: boolean) {
    mkdirSync(this.configDir, { recursive: true });
    const file = join(this.configDir, 'live-companion-gifts.json');
    writeFileSync(file + '.tmp', JSON.stringify({ enabled }), 'utf8');
    renameSync(file + '.tmp', file);
    this.setEnabled(enabled);
    return this.getStatus();
  }

  private setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.stopPolling?.();
    this.stopPolling = undefined;
    this.enabled = enabled;
    this.published = 0;
    this.state = enabled ? (this.dir ? 'waiting' : 'unsupported') : 'disabled';
    if (!enabled || !this.dir) return;

    const enabledAt = Date.now();
    const cursors = new Map<string, FileCursor>();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const files = await readdir(this.dir, { withFileTypes: true });
        const logs = files
          .filter((file) => file.isFile())
          .flatMap((file) => {
            const match = LOG_FILE.exec(file.name);
            return match ? [{ name: file.name, session: match[1], rotation: Number(match[2] ?? 0) }] : [];
          })
          .sort((a, b) => a.session.localeCompare(b.session) || b.rotation - a.rotation);
        let watched = false;
        const present = new Set<string>();
        for (const { name } of logs) {
          if (stopped) return;
          const path = join(this.dir, name);
          const info = await stat(path).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          if (!info) continue;
          watched = true;
          // 轮转改名后沿用原文件游标，新文件有独立游标。
          const key = [info.dev, info.ino, info.birthtimeMs].join(':');
          present.add(key);
          let cursor = cursors.get(key);
          if (!cursor) {
            // 启用前就存在的旧文件直接跳到末尾；正在写的当前文件只回看末尾一小段，
            // 否则启动时要先把整份历史日志解析一遍，新礼物会被拖后几十秒。
            cursor = {
              offset: info.mtimeMs < enabledAt ? info.size : Math.max(0, info.size - TAIL_BYTES),
              partial: '',
            };
            cursors.set(key, cursor);
          }
          if (info.size < cursor.offset) {
            cursor.offset = 0;
            cursor.partial = '';
          }
          if (info.size === cursor.offset) continue;

          const fd = await open(path, 'r').catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          if (!fd) continue;
          try {
            const current = await fd.stat();
            if (current.ino !== info.ino || current.birthtimeMs !== info.birthtimeMs) continue;
            const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, info.size - cursor.offset));
            const { bytesRead } = await fd.read(chunk, 0, chunk.length, cursor.offset);
            if (stopped) return;
            cursor.offset += bytesRead;
            const lines = (cursor.partial + chunk.toString('utf8', 0, bytesRead)).split('\n');
            cursor.partial = lines.pop() ?? '';
            if (cursor.partial.length > CHUNK_BYTES) cursor.partial = '';
            for (const line of lines) this.onLine(line, enabledAt);
          } finally {
            await fd.close();
          }
        }
        for (const key of cursors.keys()) if (!present.has(key)) cursors.delete(key);
        if (!stopped) this.state = watched ? 'watching' : 'waiting';
      } catch (error) {
        if (!stopped) this.state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'waiting' : 'error';
      } finally {
        if (!stopped) {
          timer = setTimeout(() => void poll(), POLL_MS);
          timer.unref();
        }
      }
    };
    this.stopPolling = () => {
      stopped = true;
      clearTimeout(timer);
    };
    void poll();
  }

  private onLine(line: string, enabledAt: number): void {
    const gift = parseGift(line.trimEnd());
    if (!gift) return;
    // 新鲜度判断全部基于日志行自己的本地时间：本机时钟与抖音服务器可能有偏差，
    // 用 common.createTime 对比 Date.now() 曾把正常礼物误判成「未来消息」而全部丢弃。
    const lineTs = parseLineTs(line);
    if (!lineTs || lineTs < enabledAt || lineTs < Date.now() - MAX_LAG_MS) return;
    const room = this.collector.getLiveRoomByWebcastId(gift.webcastRoomId);
    if (!room || lineTs < room.startedAt) return;
    const event = normalizeDecoded(gift.decoded, room);
    if (event?.type !== 'gift') return;
    if (this.publish({ ...event, source: 'liveCompanionLog' })) this.published++;
  }
}
