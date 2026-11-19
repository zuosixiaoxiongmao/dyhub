/**
 * 账号身份 / 登录态解析 —— 用账号 cookie 调抖音「当前登录用户」接口。
 *
 * 两个用途：
 *  1. 识别「采集/发言账号就是直播间主播本人」这种危险配置：
 *     主播本人号经网页发弹幕时抖音会返回成功、但把弹幕静默丢弃（观众也看不到），
 *     表现为 AI 日志显示 `sent`、直播间却始终没有消息。
 *  2. 看门狗周期探测登录态是否仍有效（20003 = User doesn't login）。
 *
 * 探测结果分三态：
 *  - valid   登录有效
 *  - invalid 抖音明确返回「未登录」（20003）
 *  - unknown 网络异常 / 超时 / 其它业务码（风控等），不能据此判定失效
 *
 * 接口失败不影响主链路：调用方按 unknown / null 处理，不阻断发送。
 */

import { createHash } from 'node:crypto';
import { DEFAULT_USER_AGENT } from './browser.js';

export interface AccountProfile {
  /** 抖音用户 uid（数字字符串，与 RoomMeta.uid 可直接比对） */
  uid: string;
  nickname: string;
}

export type LoginState = 'valid' | 'invalid' | 'unknown';

export interface LoginProbe {
  state: LoginState;
  /** valid 时必有；invalid 时抖音若仍返回身份也会填充（用于主播号比对） */
  profile: AccountProfile | null;
  /** invalid / unknown 的原因，用于展示与日志（如 `status_code=20003`、`timeout`） */
  reason?: string;
  /** 本次结果对应的 cookie 指纹，换 cookie 后旧结果据此作废 */
  cookieKey: string;
  at: number;
}

export interface ProbeOptions {
  /** true = 忽略缓存强制请求（看门狗用）；并发请求仍会合并到同一个 in-flight Promise */
  force?: boolean;
}

/** 登录有效 / 明确的未登录码 / 其它未知结果 的缓存时长 */
const VALID_TTL_MS = 10 * 60_000;
const INVALID_TTL_MS = 5 * 60_000;
const UNKNOWN_TTL_MS = 60_000;

/** 抖音「未登录」业务码 */
const LOGIN_INVALID_CODE = 20003;

const cache = new Map<string, { value: LoginProbe; expiresAt: number }>();
const inflight = new Map<string, Promise<LoginProbe>>();

/** cookie 指纹：同一账号重新登录后 cookie 变化，旧缓存自然失效 */
export function accountCookieKey(cookie: string): string {
  return createHash('sha1').update(cookie).digest('hex');
}

/** 业务码是否明确表示「未登录」 */
export function isLoginInvalidCode(code: unknown): boolean {
  return Number(code) === LOGIN_INVALID_CODE;
}

function ttlOf(state: LoginState): number {
  if (state === 'valid') return VALID_TTL_MS;
  if (state === 'invalid') return INVALID_TTL_MS;
  return UNKNOWN_TTL_MS;
}

/** 从接口响应里判定三态（不发起请求，便于单测式验证） */
function interpretResponse(cookieKey: string, httpOk: boolean, httpStatus: number, body: any): LoginProbe {
  const at = Date.now();
  const base = { cookieKey, at } as const;
  if (!httpOk) return { ...base, state: 'unknown', profile: null, reason: `HTTP ${httpStatus}` };
  if (!body || typeof body !== 'object') return { ...base, state: 'unknown', profile: null, reason: 'bad-json' };

  const code = body.status_code ?? body.data?.status_code;
  const data = body.data;
  const uid = data?.id != null ? String(data.id).trim() : '';
  const nickname = typeof data?.nickname === 'string' ? data.nickname.trim() : '';
  const profile: AccountProfile | null = uid ? { uid, nickname } : null;

  if (isLoginInvalidCode(code)) {
    return { ...base, state: 'invalid', profile, reason: `status_code=${code}` };
  }
  // 非 0 的其它业务码（风控 / 参数错误等）一律当未知，宁可不报也不误判为登录失效
  if (code !== undefined && code !== null && Number(code) !== 0) {
    return { ...base, state: 'unknown', profile, reason: `status_code=${code}` };
  }
  if (!profile) return { ...base, state: 'unknown', profile: null, reason: 'no-uid' };
  return { ...base, state: 'valid', profile };
}

async function requestProbe(cookie: string): Promise<LoginProbe> {
  const cookieKey = accountCookieKey(cookie);
  try {
    const res = await fetch(
      'https://live.douyin.com/webcast/user/me/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web',
      {
        headers: {
          Cookie: cookie,
          'User-Agent': DEFAULT_USER_AGENT,
          Referer: 'https://live.douyin.com/',
        },
        signal: AbortSignal.timeout(8000),
      },
    );
    const body: any = await res.json().catch(() => null);
    return interpretResponse(cookieKey, res.ok, res.status, body);
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    return {
      state: 'unknown',
      profile: null,
      reason: name === 'TimeoutError' ? 'timeout' : 'network',
      cookieKey,
      at: Date.now(),
    };
  }
}

/**
 * 探测账号登录态（带缓存 + 单飞）。
 * - 默认命中缓存直接返回；`force: true` 跳过缓存强制请求。
 * - 相同 cookie 的并发调用（无论是否 force）只发一次请求。
 */
export function probeAccountLogin(cookie: string, opts: ProbeOptions = {}): Promise<LoginProbe> {
  if (!cookie.trim()) {
    return Promise.resolve({
      state: 'unknown',
      profile: null,
      reason: 'no-cookie',
      cookieKey: '',
      at: Date.now(),
    });
  }
  const key = accountCookieKey(cookie);
  if (!opts.force) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);
  }
  const running = inflight.get(key);
  if (running) return running;

  const p = requestProbe(cookie)
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttlOf(value.state) });
      if (cache.size > 50) {
        const now = Date.now();
        for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
      }
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** 只看最近一次缓存结果，不发请求；没有则返回 null */
export function peekAccountLogin(cookie: string): LoginProbe | null {
  if (!cookie.trim()) return null;
  return cache.get(accountCookieKey(cookie))?.value ?? null;
}

/**
 * 查询抖音登录账号身份；未登录 / 接口失败返回 null。
 * 保留原签名：内部转调 probeAccountLogin，现有调用方无需改动。
 */
export async function fetchAccountProfile(cookie: string): Promise<AccountProfile | null> {
  return (await probeAccountLogin(cookie)).profile;
}
