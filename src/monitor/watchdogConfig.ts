/**
 * 礼物 / 登录态看门狗配置 —— 持久化在 data/watchdog.json。
 *
 * 与 data/ai-chat.json 相同的读写模式：文件缺失 / 损坏时回退默认值，
 * 保存时整体写回；数值在加载时做范围收敛，避免手改坏文件导致 ticker 异常。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join(process.cwd(), 'data', 'watchdog.json');

export interface WatchdogConfig {
  /** 总开关 */
  enabled: boolean;
  /** 是否周期探测账号登录态（20003） */
  loginCheck: boolean;
  /** 多久没礼物判定为「零礼物」（分钟） */
  giftQuietMin: number;
  /** 判定窗口内至少多少条非空弹幕才算「弹幕在动」 */
  minChats: number;
  /** 登录态探测间隔（秒） */
  probeSec: number;
  /** 连续失效后的探测间隔上限（秒） */
  probeMaxSec: number;
  /** 曾有礼物流、之后突然归零时是否同账号重连一次 */
  autoReconnect: boolean;
  /** 两次自动重连的最小间隔（秒） */
  reconnectCooldownSec: number;
}

export const watchdogDefaults: WatchdogConfig = {
  enabled: true,
  loginCheck: true,
  giftQuietMin: 10,
  minChats: 5,
  probeSec: 180,
  probeMaxSec: 900,
  autoReconnect: true,
  reconnectCooldownSec: 1800,
};

/** 数值范围：加载时收敛，更新时校验 */
const RANGES: Record<'giftQuietMin' | 'minChats' | 'probeSec' | 'probeMaxSec' | 'reconnectCooldownSec', [number, number]> = {
  giftQuietMin: [1, 240],
  minChats: [0, 1000],
  probeSec: [10, 3600],
  probeMaxSec: [10, 86400],
  reconnectCooldownSec: [60, 86400],
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalize(input: Partial<WatchdogConfig>): WatchdogConfig {
  const d = watchdogDefaults;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : d.enabled,
    loginCheck: typeof input.loginCheck === 'boolean' ? input.loginCheck : d.loginCheck,
    giftQuietMin: clampInt(input.giftQuietMin, ...RANGES.giftQuietMin, d.giftQuietMin),
    minChats: clampInt(input.minChats, ...RANGES.minChats, d.minChats),
    probeSec: clampInt(input.probeSec, ...RANGES.probeSec, d.probeSec),
    probeMaxSec: clampInt(input.probeMaxSec, ...RANGES.probeMaxSec, d.probeMaxSec),
    autoReconnect: typeof input.autoReconnect === 'boolean' ? input.autoReconnect : d.autoReconnect,
    reconnectCooldownSec: clampInt(input.reconnectCooldownSec, ...RANGES.reconnectCooldownSec, d.reconnectCooldownSec),
  };
}

function load(): WatchdogConfig {
  try {
    return normalize({ ...watchdogDefaults, ...JSON.parse(readFileSync(FILE, 'utf8')) });
  } catch {
    return { ...watchdogDefaults };
  }
}

function save(c: WatchdogConfig): void {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(c, null, 2), 'utf8');
}

/** 校验 PUT 请求里的字段类型；范围错误同步抛出，便于 API 返回 400 */
function validatePatch(patch: Record<string, unknown>): Partial<WatchdogConfig> {
  const out: Partial<WatchdogConfig> = {};
  for (const key of ['enabled', 'loginCheck', 'autoReconnect'] as const) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
    out[key] = patch[key] as boolean;
  }
  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    if (patch[key] === undefined) continue;
    const n = Number(patch[key]);
    if (!Number.isFinite(n)) throw new Error(`${key} 必须是数字`);
    const [min, max] = RANGES[key];
    if (n < min || n > max) throw new Error(`${key} 必须在 ${min}–${max} 之间`);
    out[key] = Math.round(n);
  }
  return out;
}

export class WatchdogConfigStore {
  private config = load();

  get(): WatchdogConfig {
    return this.config;
  }

  update(patch: Record<string, unknown>): WatchdogConfig {
    this.config = normalize({ ...this.config, ...validatePatch(patch) });
    save(this.config);
    return this.config;
  }
}
