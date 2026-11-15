/**
 * 账号身份解析 —— 用账号 cookie 调抖音「当前登录用户」接口，取 uid / 昵称。
 *
 * 目前只用于识别「采集/发言账号就是直播间主播本人」这种危险配置：
 * 主播本人号经网页发弹幕时抖音会返回成功、但把弹幕静默丢弃（观众也看不到），
 * 表现为 AI 日志显示 `sent`、直播间却始终没有消息。
 *
 * 接口失败不影响主链路：调用方把 null 当作「身份未知」处理，不阻断发送。
 */

import { createHash } from 'node:crypto';
import { DEFAULT_USER_AGENT } from './browser.js';

export interface AccountProfile {
  /** 抖音用户 uid（数字字符串，与 RoomMeta.uid 可直接比对） */
  uid: string;
  nickname: string;
}

/** 账号身份缓存：登录态不变时没必要每次连接都请求 */
const PROFILE_TTL_MS = 10 * 60_000;
/** 取不到身份时的短缓存，避免接口异常时反复请求 */
const FAIL_TTL_MS = 60_000;

const cache = new Map<string, { profile: AccountProfile | null; expiresAt: number }>();

/** 以 cookie 内容做缓存键：同一账号重新登录后 cookie 变化，旧身份自然失效 */
function cacheKey(cookie: string): string {
  return createHash('sha1').update(cookie).digest('hex');
}

/** 查询抖音登录账号身份；未登录 / 接口失败返回 null */
export async function fetchAccountProfile(cookie: string): Promise<AccountProfile | null> {
  if (!cookie.trim()) return null;
  const key = cacheKey(cookie);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.profile;

  const remember = (profile: AccountProfile | null) => {
    cache.set(key, { profile, expiresAt: Date.now() + (profile ? PROFILE_TTL_MS : FAIL_TTL_MS) });
    // 防止长期运行后缓存无限增长
    if (cache.size > 50) {
      const now = Date.now();
      for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    }
    return profile;
  };

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
    const data = body?.data;
    const uid = data?.id != null ? String(data.id).trim() : '';
    const nickname = typeof data?.nickname === 'string' ? data.nickname.trim() : '';
    if (!res.ok || !uid) return remember(null);
    return remember({ uid, nickname });
  } catch {
    return remember(null);
  }
}
