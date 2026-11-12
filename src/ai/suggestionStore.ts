/**
 * 游戏改进建议存储 —— AI 从弹幕中提炼的建议落盘保存
 *
 * 模型在 Agent 循环里调用 record_suggestion 工具，把观众对游戏的改进建议
 * 写入 `data/ai-suggestions.json`。按房间隔离，内容去重（同一房间 7 天内
 * 相同建议只记一条），最多保留最近 2000 条，避免文件无限增长。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');
const FILE = join(DATA_DIR, 'ai-suggestions.json');
const MAX_ITEMS = 2000;
/** 同一房间内相同建议的去重窗口：7 天 */
const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface SuggestionRecord {
  id: number;
  ts: number;
  roomId: string;
  /** 提出建议的观众昵称，可能为空 */
  player: string;
  /** 模型给出的分类：玩法 / 平衡 / 功能 / 体验 / 性能 / bug / 其他 */
  category: string;
  /** 提炼后的建议内容 */
  content: string;
  /** 原始弹幕，便于回溯 */
  original?: string;
}

export interface SuggestionInput {
  roomId: string;
  player?: string;
  category?: string;
  content: string;
  original?: string;
}

export interface SuggestionAddResult {
  added: boolean;
  record: SuggestionRecord;
}

interface StoreFile {
  nextId: number;
  items: SuggestionRecord[];
}

function load(): StoreFile {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<StoreFile>;
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter((item): item is SuggestionRecord =>
          Boolean(item) && typeof item === 'object' && typeof item.content === 'string')
      : [];
    const nextId = Number.isInteger(parsed.nextId) && Number(parsed.nextId) > 0
      ? Number(parsed.nextId)
      : items.reduce((max, item) => Math.max(max, item.id || 0), 0) + 1;
    return { nextId, items };
  } catch {
    return { nextId: 1, items: [] };
  }
}

function save(data: StoreFile) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** 去重用的归一化文本：全角转半角，去掉空白与标点，忽略大小写 */
function signature(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/\p{P}/gu, '')
    .toLowerCase();
}

export class SuggestionStore {
  private data = load();

  /** 记录一条建议；窗口期内相同内容返回已存在的记录且不重复写入 */
  add(input: SuggestionInput): SuggestionAddResult {
    const content = String(input.content ?? '').trim().slice(0, 500);
    const roomId = String(input.roomId ?? '').trim();
    const key = signature(content);
    const now = Date.now();
    if (key) {
      const existing = this.data.items.find((item) =>
        item.roomId === roomId &&
        now - item.ts <= DEDUPE_WINDOW_MS &&
        signature(item.content) === key);
      if (existing) return { added: false, record: existing };
    }

    const record: SuggestionRecord = {
      id: this.data.nextId++,
      ts: now,
      roomId,
      player: String(input.player ?? '').trim().slice(0, 40),
      category: String(input.category ?? '').trim().slice(0, 20) || '其他',
      content,
      ...(input.original ? { original: String(input.original).trim().slice(0, 500) } : {}),
    };
    this.data.items.push(record);
    if (this.data.items.length > MAX_ITEMS) this.data.items.splice(0, this.data.items.length - MAX_ITEMS);
    save(this.data);
    return { added: true, record };
  }

  /** 按房间（可选）列出建议，最新的在前 */
  list(roomId?: string, limit = 200): SuggestionRecord[] {
    const rid = String(roomId ?? '').trim();
    const max = Math.max(1, Math.min(MAX_ITEMS, Math.floor(Number(limit) || 200)));
    return this.data.items
      .filter((item) => !rid || item.roomId === rid)
      .slice(-max)
      .reverse();
  }

  remove(id: number): boolean {
    const index = this.data.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.data.items.splice(index, 1);
    save(this.data);
    return true;
  }

  /** 清空建议；传入 roomId 时只清空该房间 */
  clear(roomId?: string): number {
    const rid = String(roomId ?? '').trim();
    const before = this.data.items.length;
    this.data.items = rid ? this.data.items.filter((item) => item.roomId !== rid) : [];
    const removed = before - this.data.items.length;
    if (removed) save(this.data);
    return removed;
  }
}
