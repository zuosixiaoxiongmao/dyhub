import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { ChatEvent } from '../types/events.js';
import type { EventBus } from '../pipeline/eventBus.js';
import type { Collector } from '../collector/collector.js';

const DATA_DIR = join(process.cwd(), 'data');
const FILE = join(DATA_DIR, 'ai-chat.json');
const PROMPT_DIR = join(DATA_DIR, 'prompts');
const DEFAULT_PROMPT = '你是直播间的一名普通观众。根据最近的观众弹幕，自然地参与聊天。只输出一句简短中文弹幕，不要引号、解释或扮演主播。';
export interface AiConfig { enabled: boolean; count: number; baseUrl: string; apiKey: string; model: string; promptFile: string; intervalSec: number }
export interface AiLog { id: number; ts: number; roomId: string; status: 'checking' | 'skipped' | 'sent' | 'error'; inputCount?: number; output?: string; message?: string }
const defaults: AiConfig = { enabled: false, count: 10, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '', promptFile: 'default.txt', intervalSec: 20 };

function load(): AiConfig {
  try { return { ...defaults, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { return { ...defaults }; }
}
function save(c: AiConfig) { mkdirSync(join(process.cwd(), 'data'), { recursive: true }); writeFileSync(FILE, JSON.stringify(c, null, 2), 'utf8'); }

export class ChatAssistant {
  private config = load();
  private recent = new Map<string, ChatEvent[]>();
  private running = new Set<string>();
  private pending = new Map<string, ChatEvent[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private logs: AiLog[] = [];
  private nextLogId = 1;
  private listeners = new Set<(log: AiLog) => void>();
  private subscription: number;
  constructor(private bus: EventBus, private collector: Collector) {
    mkdirSync(PROMPT_DIR, { recursive: true });
    const legacy = load() as AiConfig & { systemPrompt?: string };
    if (legacy.systemPrompt && !existsSync(join(PROMPT_DIR, defaults.promptFile))) {
      writeFileSync(join(PROMPT_DIR, defaults.promptFile), legacy.systemPrompt, 'utf8');
    }
    if (!readdirSync(PROMPT_DIR).some((f) => f.endsWith('.txt'))) writeFileSync(join(PROMPT_DIR, defaults.promptFile), DEFAULT_PROMPT, 'utf8');
    this.config = { ...this.config, promptFile: this.safePromptName(legacy.promptFile) || defaults.promptFile };
    this.subscription = bus.subscribe({ type: 'chat' }, (ev) => {
      if (ev.type !== 'chat' || !ev.data.content.trim()) return;
      const list = this.recent.get(ev.roomId) ?? [];
      list.push(ev); if (list.length > 100) list.shift(); this.recent.set(ev.roomId, list);
      const pending = this.pending.get(ev.roomId) ?? [];
      pending.push(ev);
      if (pending.length > 100) pending.shift();
      this.pending.set(ev.roomId, pending);
      this.schedule(ev.roomId);
    });
  }
  getConfig() { return { ...this.config, apiKey: this.config.apiKey ? '••••••••' : '' }; }
  getLogs() { return this.logs.slice(-200).reverse(); }
  onLog(listener: (log: AiLog) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private log(entry: Omit<AiLog, 'id' | 'ts'>) {
    const item = { ...entry, id: this.nextLogId++, ts: Date.now() };
    this.logs.push(item); if (this.logs.length > 200) this.logs.shift();
    for (const listener of this.listeners) listener(item);
  }
  listPrompts() { return readdirSync(PROMPT_DIR).filter((f) => f.endsWith('.txt')).sort().map((name) => ({ name, content: readFileSync(join(PROMPT_DIR, name), 'utf8') })); }
  savePrompt(name: string, content: string) {
    const safe = this.safePromptName(name);
    if (!safe) throw new Error('文件名仅允许中文、字母、数字、空格、下划线和连字符，并以 .txt 结尾');
    if (!content.trim()) throw new Error('提示词内容不能为空');
    mkdirSync(PROMPT_DIR, { recursive: true }); writeFileSync(join(PROMPT_DIR, safe), content, 'utf8');
    return { name: safe, content };
  }
  private safePromptName(name: unknown): string | null {
    const value = basename(String(name ?? ''));
    return /^[\p{L}\p{N}_ -]{1,60}\.txt$/u.test(value) ? value : null;
  }
  update(input: Partial<AiConfig>) {
    const c = { ...this.config, ...input };
    c.count = Math.max(1, Math.min(100, Math.floor(Number(c.count) || 10)));
    c.intervalSec = Math.max(1, Math.min(3600, Math.floor(Number(c.intervalSec) || 20)));
    c.baseUrl = String(c.baseUrl || defaults.baseUrl).replace(/\/+$/, '');
    c.model = String(c.model || '').trim();
    c.promptFile = this.safePromptName(c.promptFile) || this.config.promptFile;
    if (!input.apiKey || input.apiKey === '••••••••') c.apiKey = this.config.apiKey;
    else c.apiKey = String(input.apiKey).trim();
    this.config = c; save(c); return this.getConfig();
  }
  private schedule(roomId: string) {
    if (this.timers.has(roomId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      void this.maybeSpeak(roomId);
    }, this.config.intervalSec * 1000);
    this.timers.set(roomId, timer);
  }
  private async maybeSpeak(roomId: string) {
    const c = this.config;
    const pending = this.pending.get(roomId) ?? [];
    this.pending.delete(roomId);
    if (!pending.length) return;
    if (!c.enabled) { this.log({ roomId, status: 'skipped', inputCount: pending.length, message: '自动发言未启用' }); return; }
    if (!c.apiKey || !c.model) { this.log({ roomId, status: 'error', inputCount: pending.length, message: '请配置 API Key 和模型' }); return; }
    if (this.running.has(roomId)) { this.log({ roomId, status: 'skipped', inputCount: pending.length, message: '上一轮判断仍在进行' }); return; }
    const events = (this.recent.get(roomId) ?? []).slice(-c.count);
    if (!events.length) return;
    this.running.add(roomId);
    this.log({ roomId, status: 'checking', inputCount: pending.length, message: `正在判断最近 ${events.length} 条弹幕` });
    try {
      const context = events.map(e => `${e.user?.nickname || '观众'}：${e.data.content}`).join('\n');
      const promptPath = join(PROMPT_DIR, c.promptFile);
      const systemPrompt = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : DEFAULT_PROMPT;
      const response = await fetch(`${c.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify({ model: c.model, temperature: 0.8, max_tokens: 100, messages: [{ role: 'system', content: `${systemPrompt}\n\n你需要自行判断最近的弹幕是否值得回复。若没有值得回应的内容，只输出 [SKIP]；若值得回复，只输出一条自然、简短的中文直播间弹幕，不要解释。` }, { role: 'user', content: `最近 ${events.length} 条直播间弹幕：\n${context}\n\n判断是否值得回复；不值得时严格只输出 [SKIP]。` }] }), signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body: any = await response.json();
      const raw = String(body.choices?.[0]?.message?.content ?? '').trim();
      if (/^\[SKIP\]$/i.test(raw)) { this.log({ roomId, status: 'skipped', inputCount: events.length, output: raw, message: 'LLM 判断无需回复' }); return; }
      const text = raw.replace(/^['"“”]+|['"“”]+$/g, '').slice(0, 100);
      if (text) {
        this.log({ roomId, status: 'checking', inputCount: events.length, output: text, message: 'LLM 生成回复，正在发送' });
        await this.collector.sendChat(roomId, text);
        this.log({ roomId, status: 'sent', inputCount: events.length, output: text, message: '已提交发送' });
      } else this.log({ roomId, status: 'skipped', inputCount: events.length, output: raw, message: 'LLM 未返回回复内容' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log({ roomId, status: 'error', inputCount: events.length, message });
      console.error(`[dyhub] AI 发言失败 (${roomId}):`, message);
    }
    finally { this.running.delete(roomId); }
  }
  close() {
    this.bus.unsubscribe(this.subscription);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }
}
