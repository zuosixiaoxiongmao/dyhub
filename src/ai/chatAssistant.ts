import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ChatEvent } from '../types/events.js';
import type { EventBus } from '../pipeline/eventBus.js';
import type { Collector } from '../collector/collector.js';
import { DocumentKnowledgeBase, type KnowledgeDoc, type KnowledgeDocMeta, type KnowledgeHit } from './knowledgeBase.js';
import { SuggestionStore, type SuggestionRecord } from './suggestionStore.js';
import { runAgent, type AgentMessage, type AgentStep, type AgentTool } from './agent.js';

const DATA_DIR = join(process.cwd(), 'data');
const FILE = join(DATA_DIR, 'ai-chat.json');
const PROMPT_DIR = join(DATA_DIR, 'prompts');
const LEGACY_DEFAULT_PROMPT = '你是直播间的一名普通观众。根据最近的观众弹幕，自然地参与聊天。只输出一句简短中文弹幕，不要引号、解释或扮演主播。';
const DEFAULT_PROMPT = '你是本直播间的管理员兼咨询助手，语气自然、专业、有耐心，像真人管理员在弹幕里回复观众。';

/** 工具调用结果的形状（search_knowledge 的返回值） */
interface KnowledgeToolHit {
  doc: string;
  section?: string;
  content: string;
}

export interface AiConfig {
  enabled: boolean;
  count: number;
  baseUrl: string;
  apiKey: string;
  model: string;
  promptFile: string;
  intervalSec: number;
  /** 知识库目录：绝对路径，或相对运行目录的路径 */
  knowledgeDir: string;
  /** 是否允许 Agent 检索文档知识库 */
  knowledgeEnabled: boolean;
  /** 是否允许 Agent 把弹幕里的游戏改进建议记录到文件 */
  suggestionEnabled: boolean;
  /** 单轮最多调用几次工具（防止模型无限检索） */
  maxRounds: number;
  /** 单条弹幕回复的最大字符数 */
  replyMaxChars: number;
  /** 同一轮内多条回复之间的间隔（毫秒） */
  replyIntervalMs: number;
  /** 重复弹幕忽略窗口（秒），0 表示不忽略 */
  duplicateWindowSec: number;
}

export interface AiLog {
  id: number;
  ts: number;
  roomId: string;
  status: 'checking' | 'tool' | 'skipped' | 'sent' | 'error';
  inputCount?: number;
  output?: string;
  /** 这条回复对应的观众昵称（模型返回了 player_name 时） */
  player?: string;
  message?: string;
  /** 本轮引用到的知识库文档名 */
  sources?: string[];
  /** 本轮工具调用摘要 */
  steps?: string[];
}

/** 一条面向单个观众的回复；player 可能为空（模型只给了正文、或旧版纯文本输出） */
export interface AiReplyItem {
  player: string;
  content: string;
}

/** 调试面板一次测试的结果（不发送到直播间） */
export interface AiDebugReply {
  ok: boolean;
  skipped: boolean;
  skipReason?: 'skip' | 'empty';
  /** 兼容字段：所有回复正文按顺序拼接 */
  reply: string;
  replies: AiReplyItem[];
  /** 本轮被判定为重复并忽略的弹幕条数 */
  duplicates: number;
  /** 正式发言时相邻两条回复的间隔（毫秒） */
  replyIntervalMs: number;
  raw: string;
  sources: string[];
  steps: string[];
  rounds: number;
  elapsedMs: number;
  error?: string;
}

/** 生成回复的中间结果，供正式流程与调试流程共用 */
interface ComposedReply {
  raw: string;
  replies: AiReplyItem[];
  skipped: boolean;
  skipReason?: 'skip' | 'empty';
  sources: string[];
  steps: string[];
  rounds: number;
}

/** 同一轮内两条回复之间的默认间隔；默认 3 秒，避免连续发言触发风控 */
const DEFAULT_REPLY_INTERVAL_MS = (() => {
  const raw = process.env.DYHUB_AI_REPLY_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return 3000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 3000;
})();
/** 单轮最多回复多少个观众，防止模型输出过多条目刷屏 */
const MAX_REPLIES_PER_ROUND = 10;

const defaults: AiConfig = {
  enabled: false,
  count: 10,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  promptFile: 'default.txt',
  intervalSec: 20,
  knowledgeDir: process.env.DYHUB_KNOWLEDGE_DIR?.trim() || 'data/knowledge',
  knowledgeEnabled: true,
  suggestionEnabled: true,
  maxRounds: 3,
  replyMaxChars: 180,
  replyIntervalMs: DEFAULT_REPLY_INTERVAL_MS,
  duplicateWindowSec: 300,
};

/** Agent 固定工作流：人设可以换，职责与输出约束不随提示词文件漂移 */
const AGENT_RULES = `你的职责是解答直播间观众的问题、提供咨询帮助，并维护直播间的互动秩序。

工作流程：
1. 阅读“本轮新弹幕”，判断是否有观众在寻求帮助或咨询（产品、使用方法、价格、优惠、售后、物流、活动规则等）。
2. 遇到咨询类问题，优先依据用户消息里已附带的“知识库参考”回答；参考不足时再调用 search_knowledge 补充检索，并严格依据检索结果回答；资料没有覆盖时如实说明“这个我不太确定”，不要编造。
3. 如果弹幕包含对游戏改进的具体建议（玩法、平衡、数值、功能、操作体验、性能、BUG 等），调用 record_suggestion 记录提炼后的建议；一条建议一次调用，同类建议可合并。记录是后台行为，不需要因此回复观众，也不要提及“已记录”。
4. 非咨询类内容（闲聊、打招呼、刷屏、无意义表情）一般不需要回复；没有值得处理的咨询、求助或改进建议时只输出 [SKIP]。
5. 回答要完整、具体、可直接执行，像真人管理员在弹幕里解答：一般 2-4 句，把关键步骤或条件说清楚。
6. 不要提及知识库、检索、工具或 AI。
7. 可能同时有多个观众需要回复：每个需要回复的观众单独一条，不要合并成一条，也不要重复回复同一个人。只输出一个 JSON 对象，键使用“本轮新弹幕”前的编号，值为 {"player_name":"观众昵称","content":"要发送的弹幕正文"}；不要输出代码块、解释或 JSON 以外的文字。没有需要回复的观众时只输出 [SKIP]。
示例：
{"1":{"player_name":"张三","content":"直接发送宗门名就能加入。"},"2":{"player_name":"李四","content":"月卡 30 元，在商城即可开通。"}}`;

function load(): AiConfig {
  try { return { ...defaults, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { return { ...defaults }; }
}
function save(c: AiConfig) { mkdirSync(join(process.cwd(), 'data'), { recursive: true }); writeFileSync(FILE, JSON.stringify(c, null, 2), 'utf8'); }

export class ChatAssistant {
  private config = load();
  private knowledgeDir = resolveKnowledgeDir(this.config.knowledgeDir);
  private knowledge = new DocumentKnowledgeBase(this.knowledgeDir);
  private suggestions = new SuggestionStore();
  private recent = new Map<string, ChatEvent[]>();
  private running = new Set<string>();
  private pending = new Map<string, ChatEvent[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 各房间最近已处理的弹幕内容签名 → 过期时间，用于抑制重复弹幕 */
  private handledChats = new Map<string, Map<string, number>>();
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
    // 旧版默认提示词是“普通观众”，与新的管理员/咨询助手定位冲突；仅在用户没改过时升级
    const defaultPromptPath = join(PROMPT_DIR, defaults.promptFile);
    if (existsSync(defaultPromptPath) && readFileSync(defaultPromptPath, 'utf8').trim() === LEGACY_DEFAULT_PROMPT) {
      writeFileSync(defaultPromptPath, DEFAULT_PROMPT, 'utf8');
    }
    this.config = { ...this.config, promptFile: this.safePromptName(legacy.promptFile) || defaults.promptFile };
    this.subscription = bus.subscribe({ type: 'chat' }, (ev) => {
      if (ev.type !== 'chat' || !ev.data.content.trim() || !this.config.enabled) return;
      const list = this.recent.get(ev.roomId) ?? [];
      list.push(ev); if (list.length > 100) list.shift(); this.recent.set(ev.roomId, list);
      const pending = this.pending.get(ev.roomId) ?? [];
      pending.push(ev);
      if (pending.length > 100) pending.shift();
      this.pending.set(ev.roomId, pending);
      this.schedule(ev.roomId);
    });
  }
  getConfig() { return { ...this.config, apiKey: this.config.apiKey ? '••••••••' : '', knowledgeDirResolved: this.knowledgeDir }; }
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
    c.maxRounds = Math.max(1, Math.min(6, Math.floor(Number(c.maxRounds) || 3)));
    c.replyMaxChars = Math.max(20, Math.min(500, Math.floor(Number(c.replyMaxChars) || 180)));
    c.replyIntervalMs = Math.max(0, Math.min(60_000, Math.floor(Number(c.replyIntervalMs) || 0)));
    c.duplicateWindowSec = Math.max(0, Math.min(3600, Math.floor(Number(c.duplicateWindowSec) || 0)));
    c.knowledgeEnabled = input.knowledgeEnabled === undefined ? this.config.knowledgeEnabled : Boolean(input.knowledgeEnabled);
    c.suggestionEnabled = input.suggestionEnabled === undefined ? this.config.suggestionEnabled : Boolean(input.suggestionEnabled);
    c.knowledgeDir = String(c.knowledgeDir ?? '').trim() || defaults.knowledgeDir;
    c.baseUrl = String(c.baseUrl || defaults.baseUrl).replace(/\/+$/, '');
    c.model = String(c.model || '').trim();
    c.promptFile = this.safePromptName(c.promptFile) || this.config.promptFile;
    if (!input.apiKey || input.apiKey === '••••••••') c.apiKey = this.config.apiKey;
    else c.apiKey = String(input.apiKey).trim();
    // 先创建新目录（失败则不保存配置），成功后再整体切换
    const nextDir = resolveKnowledgeDir(c.knowledgeDir);
    let nextKnowledge = this.knowledge;
    if (nextDir !== this.knowledgeDir) {
      try { nextKnowledge = new DocumentKnowledgeBase(nextDir); }
      catch (e) { throw new Error(`无法使用知识库目录「${nextDir}」：${e instanceof Error ? e.message : String(e)}`); }
    }
    const wasEnabled = this.config.enabled;
    this.config = c;
    this.knowledge = nextKnowledge;
    this.knowledgeDir = nextDir;
    save(c);
    if (wasEnabled && !c.enabled) {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      this.pending.clear();
    }
    return this.getConfig();
  }

  // ---- 知识库管理（控制台 API 转发到这里，Agent 检索也走同一实例） ----
  listKnowledge(): KnowledgeDocMeta[] { return this.knowledge.list(); }
  getKnowledge(name: string): KnowledgeDoc { return this.knowledge.get(name); }
  saveKnowledge(name: string, content: string): KnowledgeDoc { return this.knowledge.save(name, content); }
  removeKnowledge(name: string): boolean { return this.knowledge.remove(name); }
  searchKnowledge(query: string, limit?: number): Promise<KnowledgeHit[]> { return this.knowledge.search(query, limit); }

  // ---- 游戏改进建议（Agent 通过 record_suggestion 工具写入） ----
  listSuggestions(roomId?: string, limit?: number): SuggestionRecord[] { return this.suggestions.list(roomId, limit); }
  removeSuggestion(id: number): boolean { return this.suggestions.remove(id); }
  clearSuggestions(roomId?: string): number { return this.suggestions.clear(roomId); }

  /**
   * 过滤重复弹幕：同一批内相同内容只保留第一条，并跳过最近已处理过的相同内容。
   * 返回 fresh（需要处理）和 duplicates（被忽略的条数）。
   */
  private filterDuplicateChats(roomId: string, pending: ChatEvent[]): { fresh: ChatEvent[]; duplicates: number } {
    if (this.config.duplicateWindowSec <= 0) return { fresh: pending, duplicates: 0 };
    const now = Date.now();
    const cache = this.handledChats.get(roomId);
    if (cache) {
      for (const [key, expiresAt] of cache) {
        if (expiresAt <= now) cache.delete(key);
      }
      if (!cache.size) this.handledChats.delete(roomId);
    }
    const seen = new Set<string>();
    const fresh: ChatEvent[] = [];
    let duplicates = 0;
    for (const ev of pending) {
      const key = chatSignature(ev.data.content);
      if (key && (cache?.has(key) || seen.has(key))) {
        duplicates++;
        continue;
      }
      if (key) seen.add(key);
      fresh.push(ev);
    }
    return { fresh, duplicates };
  }

  /** 记录本轮已处理的弹幕内容，在 duplicateWindowSec 窗口内不再重复处理 */
  private markHandledChats(roomId: string, events: ChatEvent[]) {
    if (this.config.duplicateWindowSec <= 0 || !events.length) return;
    let cache = this.handledChats.get(roomId);
    if (!cache) {
      cache = new Map();
      this.handledChats.set(roomId, cache);
    }
    const expiresAt = Date.now() + this.config.duplicateWindowSec * 1000;
    for (const ev of events) {
      const key = chatSignature(ev.data.content);
      if (key) cache.set(key, expiresAt);
    }
    // 防止长期运行后单房间缓存无限增长
    while (cache.size > 500) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
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
    if (!c.enabled) return;
    // 上一轮（可能正在逐条发送多个观众）还没结束时不要清空 pending；
    // 等本轮结束会在 finally 里自动补排下一轮。
    if (this.running.has(roomId)) return;
    const batch = this.pending.get(roomId) ?? [];
    if (!batch.length) return;
    if (!c.apiKey || !c.model) {
      this.pending.delete(roomId);
      this.log({ roomId, status: 'error', inputCount: batch.length, message: '请配置 API Key 和模型' });
      return;
    }

    // 同一批内相同内容只处理一条；窗口期内已经处理过的内容也不再重复回复
    const { fresh, duplicates } = this.filterDuplicateChats(roomId, batch);
    this.pending.delete(roomId);
    if (!fresh.length) {
      this.log({
        roomId, status: 'skipped', inputCount: batch.length,
        message: `本轮 ${batch.length} 条弹幕均为重复或 ${c.duplicateWindowSec} 秒内已处理，已忽略`,
      });
      return;
    }
    if (duplicates) {
      this.log({ roomId, status: 'tool', inputCount: batch.length, message: `已忽略 ${duplicates} 条重复/近期已处理的弹幕` });
    }

    const recent = (this.recent.get(roomId) ?? []).slice(-c.count);
    if (!recent.length) return;

    this.running.add(roomId);
    this.log({ roomId, status: 'checking', inputCount: batch.length, message: `正在判断最近 ${recent.length} 条弹幕（本轮新弹幕 ${fresh.length} 条）` });
    let lastSources: string[] = [];
    let lastSteps: string[] = [];
    try {
      const composed = await this.composeReply(roomId, fresh, recent, (summary, sources, steps) => {
        lastSources = sources;
        lastSteps = steps;
        this.log({ roomId, status: 'tool', inputCount: batch.length, message: summary, sources, steps });
      });
      if (composed.skipped || !composed.replies.length) {
        // 即使模型判断无需回复，也记住这些内容，避免同一批刷屏弹幕反复触发判断
        this.markHandledChats(roomId, fresh);
        this.log({
          roomId, status: 'skipped', inputCount: batch.length, output: composed.raw,
          message: composed.skipReason === 'empty' ? '未生成有效回复' : '判断无需回复',
          sources: composed.sources, steps: composed.steps,
        });
        return;
      }

      const total = composed.replies.length;
      this.log({
        roomId, status: 'checking', inputCount: batch.length,
        output: composed.replies.map((item) => item.player ? `${item.player}：${item.content}` : item.content).join('；'),
        message: `已生成 ${total} 条回复，正在逐条发送（间隔 ${(c.replyIntervalMs / 1000).toFixed(1)} 秒）`,
        sources: composed.sources, steps: composed.steps,
      });
      const sentPlayers = new Set<string>();
      let sentAny = false;
      for (const [index, item] of composed.replies.entries()) {
        if (!this.config.enabled) {
          this.log({
            roomId, status: 'skipped', inputCount: batch.length,
            message: `自动回复已关闭，停止发送剩余回复（${index}/${total}）`,
            sources: composed.sources, steps: composed.steps,
          });
          break;
        }
        const label = item.player ? `回复观众「${item.player}」` : '发送回复';
        try {
          await this.collector.sendChat(roomId, item.content);
          sentAny = true;
          if (item.player) sentPlayers.add(normalizePlayerName(item.player));
          this.log({
            roomId, status: 'sent', inputCount: batch.length, output: item.content,
            player: item.player || undefined,
            message: `${label}（${index + 1}/${total}）`,
            sources: composed.sources, steps: composed.steps,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.log({
            roomId, status: 'error', inputCount: batch.length, output: item.content,
            player: item.player || undefined,
            message: `${label}失败（${index + 1}/${total}）：${message}`,
            sources: composed.sources, steps: composed.steps,
          });
        }
        if (index < total - 1 && c.replyIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, c.replyIntervalMs));
        }
      }
      if (sentAny) {
        // 只记住已成功回复的观众发过的弹幕；发送失败的留下，下一轮还能重试
        const handled = sentPlayers.size
          ? fresh.filter((ev) => sentPlayers.has(normalizePlayerName(ev.user?.nickname)))
          : fresh;
        this.markHandledChats(roomId, handled);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log({ roomId, status: 'error', inputCount: batch.length, message, sources: lastSources, steps: lastSteps });
      console.error(`[dyhub] AI 发言失败 (${roomId}):`, message);
    } finally {
      this.running.delete(roomId);
      // 发送期间进来的弹幕留在 pending 里，这里补排下一轮，避免丢消息
      if ((this.pending.get(roomId)?.length ?? 0) > 0) this.schedule(roomId);
    }
  }

  /**
   * 生成回复的核心流程：预检索 → 构建提示词 → Agent（含工具）→ 清洗输出。
   * 正式发言与调试面板共用，区别只在于调用方是否把结果发送到直播间。
   */
  private async composeReply(
    roomId: string,
    pending: ChatEvent[],
    recent: ChatEvent[],
    onStep?: (summary: string, sources: string[], steps: string[]) => void,
  ): Promise<ComposedReply> {
    const c = this.config;
    const sources = new Set<string>();
    const steps: string[] = [];
    const promptPath = join(PROMPT_DIR, c.promptFile);
    const style = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : DEFAULT_PROMPT;

    // 先按本轮弹幕做一次本地预检索。这样即使模型不支持 function calling
    // （或者选择不调用工具），提示词里也已经带着知识库内容，不会出现
    // “文档写好了但 AI 完全没用上”的情况。模型仍可在参考不足时调用工具。
    let reference = '';
    if (c.knowledgeEnabled) {
      try {
        const prefetched = await this.prefetchKnowledge(pending);
        if (prefetched.length) {
          reference = formatKnowledgeSnippets(prefetched);
          for (const hit of prefetched) sources.add(hit.doc);
          const docs = [...new Set(prefetched.map((hit) => hit.doc))].join('、');
          const summary = `预检索知识库：命中 ${prefetched.length} 段（${docs}）`;
          steps.push(summary);
          onStep?.(summary, [...sources], [...steps]);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        steps.push(`预检索知识库失败：${message}`);
      }
    }

    const messages: AgentMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(style, c) },
      { role: 'user', content: this.buildUserPrompt(pending, recent, reference) },
    ];
    const tools: AgentTool[] = [];
    if (c.knowledgeEnabled) tools.push(this.knowledgeTool());
    if (c.suggestionEnabled) tools.push(this.recordSuggestionTool(pending));
    // 模型可能一次回复多个观众，输出预算随本轮弹幕数增加，避免 JSON 被截断
    const replyBudget = Math.max(1, Math.min(MAX_REPLIES_PER_ROUND, pending.length));
    const llm = {
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: c.model,
      temperature: 0.7,
      maxTokens: Math.min(2400, Math.max(300, c.replyMaxChars * replyBudget + 150)),
    };
    const onToolCall = (step: AgentStep) => {
      let summary: string;
      if (step.tool === 'record_suggestion') {
        summary = describeSuggestionStep(step);
      } else {
        const hits = extractKnowledgeHits(step.result);
        for (const hit of hits) sources.add(hit.doc);
        summary = step.error
          ? `调用 ${step.tool} 失败：${step.error}`
          : `检索知识库「${String(step.args.query ?? '')}」：${hits.length ? `命中 ${hits.length} 段（${[...new Set(hits.map((h) => h.doc))].join('、')}）` : '无命中'}`;
      }
      steps.push(summary);
      onStep?.(summary, [...sources], [...steps]);
    };
    let result: Awaited<ReturnType<typeof runAgent>>;
    try {
      result = await runAgent({ llm, messages, tools, maxRounds: c.maxRounds, context: { roomId }, onToolCall });
    } catch (e) {
      // 有些 OpenAI 兼容服务不支持 tools / function calling，会直接返回 400。
      // 此时退回“只用预检索资料 + 普通对话”的一次调用，保证知识库仍然生效。
      if (!tools.length || !isToolCapabilityError(e)) throw e;
      const message = e instanceof Error ? e.message : String(e);
      const summary = `模型不支持工具调用（${message.slice(0, 80)}），改用预检索资料直接回答`;
      steps.push(summary);
      onStep?.(summary, [...sources], [...steps]);
      result = await runAgent({ llm, messages, tools: [], maxRounds: 1, context: { roomId } });
    }

    const raw = result.content.trim();
    const parsed = parseReplies(raw, pending.slice(-30), c.replyMaxChars);
    return {
      raw,
      replies: parsed.replies,
      skipped: parsed.skipped,
      skipReason: parsed.skipReason,
      sources: [...sources],
      steps,
      rounds: result.rounds,
    };
  }

  /**
   * 调试面板入口：模拟一条或多条观众弹幕，走完知识库预检索、Agent（含工具调用）
   * 和回复清洗，但不发送到直播间，也不写入正式 AI 日志。
   * 多行输入时每行按「昵称：弹幕」拆分；没有冒号的行按“测试观众”处理。
   */
  async testReply(text: string): Promise<AiDebugReply> {
    const started = Date.now();
    const content = String(text ?? '').trim();
    const fail = (error: string): AiDebugReply => ({
      ok: false, skipped: false, reply: '', replies: [], duplicates: 0,
      replyIntervalMs: this.config.replyIntervalMs, raw: '', sources: [], steps: [], rounds: 0,
      elapsedMs: Date.now() - started, error,
    });
    if (!content) return fail('请输入弹幕内容');
    if (content.length > 2000) return fail('弹幕内容不能超过 2000 字');
    if (!this.config.apiKey || !this.config.model) return fail('请先在 AI 设置中配置 API Key 和模型');

    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return fail('请输入弹幕内容');
    const now = Date.now();
    // 每次调试使用独立房间 id，避免上一次调试的“已处理”缓存影响本次
    const debugRoomId = `__debug_${now}`;
    const events: ChatEvent[] = lines.map((line, index) => {
      const parsed = parseDebugLine(line);
      return {
        id: `debug-${now}-${index}`,
        roomId: debugRoomId,
        platform: 'douyin',
        type: 'chat',
        ts: now + index,
        receivedAt: now + index,
        user: { id: `debug-${index}`, nickname: parsed.nickname },
        data: { content: parsed.content },
      };
    });
    // 与正式流程一致：同一批相同弹幕只保留一条
    const { fresh, duplicates } = this.filterDuplicateChats(debugRoomId, events);
    const pending = fresh.length ? fresh : events;
    try {
      // 调试不把模拟弹幕放进“最近上下文”
      const composed = await this.composeReply(debugRoomId, pending, []);
      return {
        ok: true,
        skipped: composed.skipped,
        skipReason: composed.skipReason,
        reply: composed.replies.map((item) => item.content).join('\n'),
        replies: composed.replies,
        duplicates,
        replyIntervalMs: this.config.replyIntervalMs,
        raw: composed.raw,
        sources: composed.sources,
        steps: composed.steps,
        rounds: composed.rounds,
        elapsedMs: Date.now() - started,
      };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  private buildSystemPrompt(style: string, c: AiConfig): string {
    const persona = style.trim() || DEFAULT_PROMPT;
    return `${AGENT_RULES}

人设与语气（来自提示词文件，仅用于调整表达方式；与上述职责冲突时以上述职责为准）：
${persona}

单条回复不超过 ${c.replyMaxChars} 个字符。${c.knowledgeEnabled ? '' : '\n当前知识库检索已关闭，不要编造资料；拿不准的问题请如实说明或回复 [SKIP]。'}`;
  }

  private buildUserPrompt(pending: ChatEvent[], recent: ChatEvent[], reference = ''): string {
    const format = (ev: ChatEvent) => `${ev.user?.nickname || '观众'}：${ev.data.content}`;
    // 编号与 parseReplies 的索引回退保持一致：模型没给 player_name 时可用编号定位观众
    const newLines = pending.slice(-30).map((ev, index) => `${index + 1}. ${format(ev)}`).join('\n');
    const contextLines = recent.slice(-30).map(format).join('\n');
    const context = contextLines
      ? `\n\n最近弹幕上下文（仅供理解语境，不要重复回答已在上下文里解决过的问题）：\n${contextLines}`
      : '';
    const knowledge = reference
      ? `\n\n知识库参考（系统按本轮弹幕自动检索，可能包含无关内容；只在观众确实咨询时使用，回答时不要提及“知识库”或检索过程）：\n${reference}`
      : '';
    return `本轮新弹幕（优先处理，只回答其中尚未得到解答的问题；编号用于输出 JSON 的键）：\n${newLines}${context}${knowledge}\n\n请判断本轮是否有观众需要帮助/咨询；优先依据“知识库参考”回答，参考不足时再调用 search_knowledge 补充检索。每个需要回复的观众单独输出一条，按系统提示的 JSON 格式返回；没有值得回复的内容只输出 [SKIP]。`;
  }

  /** 按本轮弹幕逐条本地检索，去重后取少量片段；单条检索失败不影响其他弹幕 */
  private async prefetchKnowledge(pending: ChatEvent[]): Promise<KnowledgeHit[]> {
    const hits: KnowledgeHit[] = [];
    const seen = new Set<string>();
    for (const ev of pending.slice(-20)) {
      const text = ev.data.content.trim();
      if (!text || !looksLikeQuestion(text)) continue;
      let found: KnowledgeHit[];
      try { found = await this.knowledge.search(text, 2); } catch { continue; }
      for (const hit of found) {
        const key = `${hit.doc}\u0000${hit.heading ?? ''}\u0000${hit.content.slice(0, 60)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(hit);
        if (hits.length >= 6) return hits;
      }
    }
    return hits;
  }

  private knowledgeTool(): AgentTool {
    return {
      name: 'search_knowledge',
      description: '检索直播间知识库（产品资料、使用方法、价格、售后、物流、活动规则等）。当观众提出咨询或求助时调用；回答必须基于返回内容，不得编造。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索关键词。保留观众问题中的名词和动作，例如「退款 流程」「会员 价格」「怎么连接设备」。',
          },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const query = String(args.query ?? '').trim();
        if (!query) return { results: [] };
        const hits = await this.knowledge.search(query, 4);
        return {
          results: hits.map((hit): KnowledgeToolHit => ({
            doc: hit.doc,
            section: hit.heading,
            content: hit.content,
          })),
        };
      },
    };
  }

  /**
   * 游戏改进建议工具：模型从弹幕中识别出对游戏的改进建议后调用，
   * 写入 data/ai-suggestions.json（按房间隔离、内容去重）。
   */
  private recordSuggestionTool(pending: ChatEvent[]): AgentTool {
    return {
      name: 'record_suggestion',
      description: '记录观众对游戏改进的具体建议（玩法、平衡、数值、功能、操作体验、性能、BUG 等）。弹幕明确提出可执行的改进点或反馈问题时调用；闲聊、单纯抱怨、咨询不记录。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '提炼后的建议：说明现状/问题与期望改进，保留关键细节（如玩法名、数值、操作步骤），不要照抄整句弹幕。',
          },
          player: {
            type: 'string',
            description: '提出建议的观众昵称；不确定时留空，系统会尝试从弹幕中匹配。',
          },
          category: {
            type: 'string',
            enum: ['玩法', '平衡', '功能', '体验', '性能', 'bug', '其他'],
            description: '建议分类。',
          },
          original: {
            type: 'string',
            description: '原始弹幕内容，便于回溯；可省略。',
          },
        },
        required: ['content'],
      },
      execute: async (args, context) => {
        // 调试面板的模拟弹幕不写入正式建议库
        if (context.roomId.startsWith('__debug_')) {
          return { ok: false, skipped: true, reason: '调试模式不记录建议' };
        }
        const content = String(args.content ?? '').trim();
        if (!content) return { ok: false, error: '建议内容为空' };
        const original = String(args.original ?? '').trim();
        const player = normalizePlayerName(args.player) || findSuggestionPlayer(pending, original, content);
        const { added, record } = this.suggestions.add({
          roomId: context.roomId,
          player,
          category: String(args.category ?? ''),
          content,
          original: original || undefined,
        });
        return {
          ok: true,
          added,
          id: record.id,
          category: record.category,
          content: record.content,
          message: added ? '已记录' : '已有相同建议，未重复记录',
        };
      },
    };
  }

  close() {
    this.bus.unsubscribe(this.subscription);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }
}

/** 把配置里的知识库目录解析成绝对路径：支持 ~、相对运行目录、Windows/Unix 绝对路径 */
function resolveKnowledgeDir(input: string | undefined): string {
  const raw = String(input ?? '').trim() || 'data/knowledge';
  const expanded = raw === '~'
    ? homedir()
    : raw.startsWith('~/') || raw.startsWith('~\\')
      ? join(homedir(), raw.slice(2))
      : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/** 兼容模型常见的“不回复”写法：[SKIP] / SKIP / 无需回复 */
function isSkip(text: string): boolean {
  return !text || /^(?:\[SKIP\]|SKIP|无需回复|不需要回复)[。.!！]?$/i.test(text.trim());
}

interface ParsedReplies {
  replies: AiReplyItem[];
  skipped: boolean;
  skipReason?: 'skip' | 'empty';
}

/** 从 JSON 中拆出来的一条原始回复（index 是提示词里的弹幕编号） */
interface RawReplyEntry {
  index?: number;
  player: string;
  content: string;
}

const REPLY_TEXT_KEYS = ['content', 'reply', 'text', 'message', 'answer'] as const;
const REPLY_NAME_KEYS = ['player_name', 'playerName', 'nickname', 'name', 'player', 'user'] as const;

/**
 * 解析模型输出。模型应返回按观众分条的 JSON：
 * {"1":{"player_name":"张三","content":"..."},"2":{...}}
 * 同时兼容数组、单条对象、包一层 data/replies 的外壳，以及旧版纯文本回复。
 */
function parseReplies(raw: string, pending: ChatEvent[], maxChars: number): ParsedReplies {
  const text = raw.trim();
  if (!text || isSkip(text)) return { replies: [], skipped: true, skipReason: 'skip' };

  const parsed = parseLooseJson(text);
  if (parsed === undefined) {
    // 明显是坏掉的 JSON 时不要把整段 JSON 当弹幕发出去
    if (/^[\[{`]/.test(text)) return { replies: [], skipped: true, skipReason: 'empty' };
    // 兼容旧版“只返回一句弹幕”的模型输出
    const content = sanitizeReply(text, maxChars);
    return content
      ? { replies: [{ player: '', content }], skipped: false }
      : { replies: [], skipped: true, skipReason: 'empty' };
  }

  const replies: AiReplyItem[] = [];
  const seen = new Set<string>();
  for (const entry of collectReplyEntries(parsed)) {
    let player = normalizePlayerName(entry.player);
    // 模型只写了编号时，用提示词里的编号反查观众昵称
    if (!player && entry.index !== undefined) {
      player = normalizePlayerName(pending[entry.index - 1]?.user?.nickname);
    }
    const content = sanitizeReply(entry.content, maxChars);
    if (!content) continue;
    const key = player ? `p:${player}` : `c:${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    replies.push({ player, content });
    if (replies.length >= MAX_REPLIES_PER_ROUND) break;
  }
  return replies.length
    ? { replies, skipped: false }
    : { replies: [], skipped: true, skipReason: 'empty' };
}

/** 尽力从模型输出里取出 JSON（容忍代码块、前后说明、尾逗号、中文逗号/引号） */
function parseLooseJson(text: string): unknown | undefined {
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.search(/[\[{]/);
  if (start < 0) return undefined;
  const endChar = candidate[start] === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(endChar);
  if (end <= start) return undefined;
  const slice = candidate.slice(start, end + 1);
  // 优先按原样解析：正文里出现中文引号“”时不能被替换掉，否则会破坏字符串。
  // 只有解析失败才逐级尝试容错修复（尾逗号、全角逗号、中文引号）。
  const attempts = [
    slice,
    slice.replace(/,\s*([}\]])/g, '$1'),
    slice
      .replace(/[“”]/g, '"')
      .replace(/(["}\]])，\s*(?=")/g, '$1,')
      .replace(/,\s*([}\]])/g, '$1'),
  ];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // 继续尝试下一种修复
    }
  }
  return undefined;
}

function collectReplyEntries(parsed: unknown): RawReplyEntry[] {
  if (typeof parsed === 'string') return [{ player: '', content: parsed }];
  if (Array.isArray(parsed)) {
    return parsed.map((item) => entryFromValue(undefined, item)).filter((item): item is RawReplyEntry => item !== null);
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;

  // 兼容 {"replies":[...]} / {"data":{...}} 这类包一层的外壳
  for (const wrapper of ['replies', 'data', 'result', 'results']) {
    const value = obj[wrapper];
    if (value && typeof value === 'object' && !isReplyEntry(value)) {
      const nested = collectReplyEntries(value);
      if (nested.length) return nested;
    }
  }
  // 顶层本身就是一条回复 {player_name, content}
  if (isReplyEntry(obj)) {
    const entry = entryFromValue(undefined, obj);
    return entry ? [entry] : [];
  }
  // 常规格式：键是弹幕编号或观众昵称
  const entries: RawReplyEntry[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const entry = entryFromValue(key, value);
    if (entry) entries.push(entry);
  }
  return entries;
}

function isReplyEntry(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return [...REPLY_NAME_KEYS, ...REPLY_TEXT_KEYS].some((key) => key in obj);
}

function entryFromValue(key: string | undefined, value: unknown): RawReplyEntry | null {
  if (typeof value === 'string') {
    return { index: numericIndex(key), player: playerFromKey(key), content: value };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  let player = '';
  for (const nameKey of REPLY_NAME_KEYS) {
    const candidate = obj[nameKey];
    if (typeof candidate === 'string' && candidate.trim()) { player = candidate; break; }
  }
  if (!player.trim()) player = playerFromKey(key);
  let content = '';
  for (const textKey of REPLY_TEXT_KEYS) {
    const candidate = obj[textKey];
    if (typeof candidate === 'string' && candidate.trim()) { content = candidate; break; }
  }
  return content ? { index: numericIndex(key), player, content } : null;
}

function numericIndex(key: string | undefined): number | undefined {
  if (key === undefined || !/^\d+$/.test(key)) return undefined;
  const value = Number(key);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

function playerFromKey(key: string | undefined): string {
  if (!key || numericIndex(key) !== undefined) return '';
  return normalizePlayerName(key);
}

function normalizePlayerName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^['"“”「」]+|['"“”「」]+$/g, '')
    .trim()
    .slice(0, 40);
}

/**
 * 重复弹幕判定用的归一化文本：全角转半角，去掉空白、标点和零宽字符。
 * 这样「这游戏叫什么？」「这游戏叫什么」「这 游戏 叫什么！」会被视为同一条。
 */
function chatSignature(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\s\u200b-\u200d\ufeff]/g, '')
    .replace(/\p{P}/gu, '')
    .toLowerCase();
}

/** Parse one debug input line: "nickname: message"; no colon means a default viewer. */
function parseDebugLine(line: string): { nickname: string; content: string } {
  const match = line.match(/^([^：:]{1,30})[：:]\s*(.+)$/u);
  if (match) {
    const nickname = match[1].trim();
    const content = match[2].trim();
    if (nickname && content) return { nickname, content };
  }
  return { nickname: '测试观众', content: line.trim() };
}

/**
 * 判断一句弹幕是否像咨询/求助。预检索只处理问题句，避免把整批闲聊
 * 都拿去做关键词匹配，导致无关文档片段混进提示词。
 */
function looksLikeQuestion(text: string): boolean {
  if (/[?？]/.test(text)) return true;
  if (/(?:吗|呢|怎么|如何|多少|能不能|可不可以|有没有|是不是|哪里|哪个|为什么|什么时候|多久|咋|求|咨询|客服|退款|退货|换货|价格|优惠|链接|地址|教程|用法|咋用)/.test(text)) return true;
  return /\b(?:how|what|why|when|where|which|can|price|refund|help|order|link|support)\b/i.test(text);
}

/** 把预检索片段拼进提示词，限制总长度，避免上下文过长 */
function formatKnowledgeSnippets(hits: KnowledgeHit[]): string {
  let budget = 3000;
  const parts: string[] = [];
  for (const [i, hit] of hits.entries()) {
    const head = `【${i + 1}】${hit.doc}${hit.heading ? ` / ${hit.heading}` : ''}`;
    const body = hit.content.length > 900 ? `${hit.content.slice(0, 900)}…` : hit.content;
    const part = `${head}\n${body}`;
    if (part.length > budget) break;
    parts.push(part);
    budget -= part.length;
  }
  return parts.join('\n\n');
}

/** 是否为“服务端不支持 tools / function calling”这类可降级错误 */
function isToolCapabilityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!/HTTP (?:400|404|422)/.test(error.message)) return false;
  return /(?:tool|function|function_call)/i.test(error.message);
}

function extractKnowledgeHits(result: unknown): KnowledgeToolHit[] {
  if (!result || typeof result !== 'object') return [];
  const results = (result as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.filter((item): item is KnowledgeToolHit =>
    Boolean(item) && typeof item === 'object' && typeof (item as KnowledgeToolHit).doc === 'string');
}

/** record_suggestion 工具结果的可读摘要（用于 AI 日志 / 调试面板） */
function describeSuggestionStep(step: AgentStep): string {
  if (step.error) return `调用 ${step.tool} 失败：${step.error}`;
  const result = (step.result && typeof step.result === 'object' ? step.result : null) as
    { ok?: boolean; added?: boolean; skipped?: boolean; reason?: string; error?: string; content?: string; category?: string } | null;
  if (result?.skipped) return `未记录建议：${result.reason ?? '已跳过'}`;
  if (result?.ok === false) return `记录建议失败：${result?.error ?? '未知错误'}`;
  const text = String(result?.content ?? step.args.content ?? '').trim();
  const label = result?.category ? `[${result.category}] ` : '';
  return result?.added === false
    ? `建议已存在，跳过重复记录：${label}${text}`
    : `记录游戏改进建议：${label}${text}`;
}

/** 模型没给昵称时，从本轮弹幕里按原文/内容包含关系反查提出者 */
function findSuggestionPlayer(pending: ChatEvent[], original: string, content: string): string {
  const pick = (text: string) => text.trim();
  const targetOriginal = pick(original);
  const targetContent = pick(content);
  for (const ev of pending) {
    const text = pick(ev.data.content);
    if (!text) continue;
    if (targetOriginal ? text === targetOriginal : targetContent.includes(text)) {
      return normalizePlayerName(ev.user?.nickname);
    }
  }
  if (targetOriginal) {
    for (const ev of pending) {
      if (pick(ev.data.content).includes(targetOriginal)) return normalizePlayerName(ev.user?.nickname);
    }
  }
  return '';
}

/** 清理模型输出：去包裹引号、合并换行、截断到配置长度 */
function sanitizeReply(raw: string, maxChars: number): string {
  let text = raw
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```$/, '')
    .replace(/^(回复|答|管理员|AI)\s*[:：]\s*/i, '')
    .replace(/^['"“”「」]+|['"“”「」]+$/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (text.length > maxChars) text = text.slice(0, maxChars).trim();
  return text;
}
