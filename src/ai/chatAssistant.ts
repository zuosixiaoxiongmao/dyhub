import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ChatEvent } from '../types/events.js';
import type { EventBus } from '../pipeline/eventBus.js';
import type { Collector } from '../collector/collector.js';
import type { RoomMeta } from '../collector/roomMeta.js';
import { DocumentKnowledgeBase, type KnowledgeDoc, type KnowledgeDocMeta, type KnowledgeHit } from './knowledgeBase.js';
import { runAgent, type AgentMessage, type AgentStep, type AgentTool } from './agent.js';

const DATA_DIR = join(process.cwd(), 'data');
const FILE = join(DATA_DIR, 'ai-chat.json');
const PROMPT_DIR = join(DATA_DIR, 'prompts');
const LEGACY_DEFAULT_PROMPT = '你是直播间的一名普通观众。根据最近的观众弹幕，自然地参与聊天。只输出一句简短中文弹幕，不要引号、解释或扮演主播。';
const DEFAULT_PROMPT = '你是本直播间的管理员兼咨询助手，语气自然、专业、有耐心，像真人管理员在弹幕里回复观众。';

/** read_knowledge 返回的单篇文档 */
interface KnowledgeDocResult {
  name: string;
  content?: string;
  truncated?: boolean;
  error?: string;
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

// ---- 知识库索引 / 文档读取 ----
/** README 索引文件名：列出每个知识文档的书名与关键字，第一次请求时附带 */
const KNOWLEDGE_INDEX_NAME = 'README.md';
/** 回答规范文件名：模型读取文档后，第二次请求时附带 */
const KNOWLEDGE_RULES_NAME = '00-回答规范.md';
/** 一次工具调用最多读取几篇文档 */
const MAX_DOCS_PER_READ = 4;
/** 单篇文档注入提示词的最大字符数 */
const MAX_DOC_READ_CHARS = 4000;
/** 一次工具调用注入的文档总字符预算（agent.ts 会把工具结果截断到 12000 字符，留出 JSON 转义余量） */
const MAX_DOC_READ_TOTAL_CHARS = 10_000;
/** README 索引与回答规范的最大字符数 */
const MAX_INDEX_CHARS = 4000;
const MAX_RULES_CHARS = 4000;

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
  maxRounds: 3,
  replyMaxChars: 180,
  replyIntervalMs: DEFAULT_REPLY_INTERVAL_MS,
  duplicateWindowSec: 300,
};

/** Agent 固定工作流：人设可以换，职责与输出约束不随提示词文件漂移 */
const AGENT_RULES = `你的职责是解答直播间观众的问题、提供咨询帮助，并维护直播间的互动秩序。

工作流程：
1. 阅读“本轮新弹幕”，判断是否有观众在寻求帮助或咨询（产品、使用方法、价格、优惠、售后、物流、活动规则等）。
2. 遇到咨询类问题，先阅读用户消息里附带的“知识库索引”（README.md，列出每篇文档的书名与关键字），从中挑出与问题相关的文档，调用 read_knowledge 读取完整内容；只读相关文档，不要凭索引猜测答案。系统会在读取成功后附上“回答规范”，必须按规范作答，并严格依据文档内容；资料没有覆盖时如实说明“这个我不太确定”，不要编造。
3. 非咨询类内容（闲聊、打招呼、刷屏、无意义表情）一般不需要回复，也不要读取文档；没有值得处理的咨询或求助时只输出 [SKIP]。
4. 回答要完整、具体、可直接执行，像真人管理员在弹幕里解答：一般 2-4 句，把关键步骤或条件说清楚。
5. 不要提及知识库、检索、工具或 AI。
6. 可能同时有多个观众需要回复：每个需要回复的观众单独一条，不要合并成一条，也不要重复回复同一个人。只输出一个 JSON 对象，键使用“本轮新弹幕”前的编号，值为 {"player_name":"观众昵称","content":"要发送的弹幕正文"}；不要输出代码块、解释或 JSON 以外的文字。没有需要回复的观众时只输出 [SKIP]。
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
      // 主播自己的发言不进入 AI 上下文，也不触发回复，避免直播间出现“主播自答自话”
      if (isAnchorChatEvent(ev, this.collector.getRoomInfo(ev.roomId)?.meta)) return;
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
    const original = this.pending.get(roomId) ?? [];
    if (!original.length) return;
    // 主播信息是异步补全的：入队时可能还不知道谁是主播，这里在开口前再过滤一次
    const meta = this.collector.getRoomInfo(roomId)?.meta;
    const batch = meta ? original.filter((ev) => !isAnchorChatEvent(ev, meta)) : original;
    const anchorCount = original.length - batch.length;
    if (!batch.length) {
      this.pending.delete(roomId);
      this.log({
        roomId, status: 'skipped', inputCount: original.length,
        message: `本轮 ${anchorCount} 条弹幕来自主播本人，已忽略`,
      });
      return;
    }
    if (anchorCount) {
      this.log({ roomId, status: 'tool', inputCount: original.length, message: `已忽略 ${anchorCount} 条主播本人弹幕` });
    }
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

    const recent = (this.recent.get(roomId) ?? [])
      .filter((ev) => !meta || !isAnchorChatEvent(ev, meta))
      .slice(-c.count);
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
   * 生成回复的核心流程：附带 README 索引 → Agent 按需读取文档 →
   * 第二次请求附文档 + 回答规范 → 清洗输出。
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

    // 知识库采用「索引 → 读文档 → 回答」两段式，避免每轮把全部知识塞进提示词：
    // 第一次请求只附带 README.md（每篇文档的书名 + 关键字），模型按需调用
    // read_knowledge 读取相关文档；第二次请求再把文档和 00-回答规范.md 一起附上。
    const docNames = c.knowledgeEnabled ? this.knowledge.list().map((doc) => doc.name) : [];
    const hasReadableDocs = docNames.some((name) => !isSpecialKnowledgeDoc(name));
    const indexDoc = hasReadableDocs ? this.loadKnowledgeIndex(docNames) : null;
    const rules = hasReadableDocs ? this.loadKnowledgeRules(docNames) : null;
    if (indexDoc) {
      const summary = indexDoc.name
        ? `已附带知识库索引 ${indexDoc.name}`
        : `未找到 ${KNOWLEDGE_INDEX_NAME}，已自动生成知识库索引（${indexDoc.count} 篇文档）`;
      steps.push(summary);
      onStep?.(summary, [...sources], [...steps]);
    }
    if (c.knowledgeEnabled && !hasReadableDocs) {
      const summary = '知识库目录没有可用文档，本轮不附带索引';
      steps.push(summary);
      onStep?.(summary, [...sources], [...steps]);
    } else if (c.knowledgeEnabled && !rules) {
      steps.push(`未找到回答规范 ${KNOWLEDGE_RULES_NAME}，将按系统提示直接作答`);
    }

    const tools: AgentTool[] = [];
    if (indexDoc) tools.push(this.readKnowledgeTool(docNames));
    const messages: AgentMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(style, c) },
      { role: 'user', content: this.buildUserPrompt(pending, recent, indexDoc?.content ?? '', tools.length > 0) },
    ];
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
      const docs = extractKnowledgeDocs(step.result);
      const loaded = docs.filter((doc) => doc.content);
      for (const doc of loaded) sources.add(doc.name);
      const failed = docs.length - loaded.length;
      const summary = step.error
        ? `调用 ${step.tool} 失败：${step.error}`
        : loaded.length
          ? `读取知识文档：${loaded.map((doc) => doc.name).join('、')}${failed ? `（${failed} 篇失败）` : ''}`
          : `调用 ${step.tool} 未读到有效文档`;
      steps.push(summary);
      onStep?.(summary, [...sources], [...steps]);
    };
    // 工具结果回填后、第二次请求前附上回答规范
    const afterTools = rules
      ? () => {
        const summary = `已附带回答规范 ${rules.name}`;
        steps.push(summary);
        onStep?.(summary, [...sources], [...steps]);
        return [{
          role: 'user' as const,
          content: `回答规范（来自知识库 ${rules.name}，生成回复时必须遵守）：\n${rules.content}`,
        }];
      }
      : undefined;
    let result: Awaited<ReturnType<typeof runAgent>>;
    try {
      result = await runAgent({ llm, messages, tools, maxRounds: c.maxRounds, context: { roomId }, onToolCall, afterTools });
    } catch (e) {
      // 有些 OpenAI 兼容服务不支持 tools / function calling，会直接返回 400。
      // 此时退回“本地检索资料 + 回答规范 + 普通对话”的一次调用，保证知识库仍然生效。
      if (!tools.length || !isToolCapabilityError(e)) throw e;
      const message = e instanceof Error ? e.message : String(e);
      let reference = '';
      if (c.knowledgeEnabled) {
        try {
          const prefetched = await this.prefetchKnowledge(pending);
          if (prefetched.length) {
            reference = formatKnowledgeSnippets(prefetched);
            for (const hit of prefetched) sources.add(hit.doc);
          }
        } catch { /* 本地检索失败时仍可基于回答规范作答 */ }
      }
      const summary = `模型不支持工具调用（${message.slice(0, 80)}），改用本地检索资料直接回答`;
      steps.push(summary);
      onStep?.(summary, [...sources], [...steps]);
      const fallback = [
        this.buildUserPrompt(pending, recent, '', false),
        reference ? `\n\n知识库参考（系统按本轮弹幕自动检索，只在观众确实咨询时使用）：\n${reference}` : '',
        rules ? `\n\n回答规范（来自知识库 ${rules.name}，必须遵守）：\n${rules.content}` : '',
      ].join('');
      result = await runAgent({
        llm,
        messages: [
          { role: 'system', content: this.buildSystemPrompt(style, c) },
          { role: 'user', content: fallback },
        ],
        tools: [],
        maxRounds: 1,
        context: { roomId },
      });
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
   * 调试面板入口：模拟一条或多条观众弹幕，走完 README 索引、文档读取、
   * 回答规范注入和回复清洗，但不发送到直播间，也不写入正式 AI 日志。
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

  private buildUserPrompt(pending: ChatEvent[], recent: ChatEvent[], knowledgeIndex = '', allowTools = true): string {
    const format = (ev: ChatEvent) => `${ev.user?.nickname || '观众'}：${ev.data.content}`;
    // 编号与 parseReplies 的索引回退保持一致：模型没给 player_name 时可用编号定位观众
    const newLines = pending.slice(-30).map((ev, index) => `${index + 1}. ${format(ev)}`).join('\n');
    const contextLines = recent.slice(-30).map(format).join('\n');
    const context = contextLines
      ? `\n\n最近弹幕上下文（仅供理解语境，不要重复回答已在上下文里解决过的问题）：\n${contextLines}`
      : '';
    const knowledge = knowledgeIndex
      ? `\n\n知识库索引（每篇文档的书名与关键字；只在观众咨询时从中挑选相关文档，不要读取无关文档）：\n${knowledgeIndex}`
      : '';
    const instruction = allowTools
      ? '请判断本轮是否有观众需要帮助/咨询；涉及咨询时，先从“知识库索引”中挑选相关文档并调用 read_knowledge 读取全文，再依据文档内容和系统随后附上的“回答规范”作答；索引里没有相关文档或资料不足时如实说明不确定，不要编造。'
      : '请判断本轮是否有观众需要帮助/咨询；涉及咨询时优先依据“知识库参考”和“回答规范”作答，资料不足时如实说明不确定，不要编造。';
    return `本轮新弹幕（优先处理，只回答其中尚未得到解答的问题；编号用于输出 JSON 的键）：\n${newLines}${context}${knowledge}\n\n${instruction}每个需要回复的观众单独输出一条，按系统提示的 JSON 格式返回；没有值得回复的内容只输出 [SKIP]。`;
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
      // 索引和回答规范不是知识内容，降级检索时排除
      found = found.filter((hit) => !isSpecialKnowledgeDoc(hit.doc));
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

  /** 读取 README.md 索引；缺失时按实际文档名自动生成一个最小索引 */
  private loadKnowledgeIndex(names: string[]): { name?: string; content: string; count: number } | null {
    const indexName = names.find((name) => name.toLowerCase() === KNOWLEDGE_INDEX_NAME.toLowerCase());
    if (indexName) {
      try {
        const content = this.knowledge.get(indexName).content.trim();
        if (content) return { name: indexName, content: clipText(content, MAX_INDEX_CHARS), count: names.length };
      } catch { /* 读取失败时退回自动索引 */ }
    }
    const docs = names.filter((name) => !isSpecialKnowledgeDoc(name));
    if (!docs.length) return null;
    const listed = docs.slice(0, 50).map((name) => `- ${name}`);
    const rest = docs.length > listed.length ? `\n…还有 ${docs.length - listed.length} 篇未列出，请补全 ${KNOWLEDGE_INDEX_NAME}` : '';
    return {
      content: clipText(`可用知识文档（未找到 ${KNOWLEDGE_INDEX_NAME}，以下为文件名）：\n${listed.join('\n')}${rest}`, MAX_INDEX_CHARS),
      count: docs.length,
    };
  }

  /** 读取回答规范；模型读取文档后、第二次请求前附加 */
  private loadKnowledgeRules(names: string[]): { name: string; content: string } | null {
    const name = names.find((item) => item.toLowerCase() === KNOWLEDGE_RULES_NAME.toLowerCase());
    if (!name) return null;
    try {
      const content = this.knowledge.get(name).content.trim();
      return content ? { name, content: clipText(content, MAX_RULES_CHARS) } : null;
    } catch { return null; }
  }

  /** 按 README 索引读取完整知识文档的 Agent 工具 */
  private readKnowledgeTool(names: string[]): AgentTool {
    return {
      name: 'read_knowledge',
      description: `按知识库索引读取完整文档。当观众咨询或求助、且索引中有相关文档时调用；文档名必须是索引里出现的文件名，一次最多 ${MAX_DOCS_PER_READ} 篇，只读与问题相关的文档。`,
      parameters: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: `要读取的文档名，来自“知识库索引”，例如 ["07-玩家常见问题.md"]；一次最多 ${MAX_DOCS_PER_READ} 篇。`,
          },
        },
        required: ['names'],
      },
      execute: async (args) => {
        const requested = Array.isArray(args.names)
          ? args.names.map((item) => String(item ?? ''))
          : typeof args.names === 'string'
            ? [args.names]
            : typeof args.name === 'string' // 兼容模型把数组写成单个 name 的情况
              ? [args.name]
              : [];
        const documents: KnowledgeDocResult[] = [];
        const seen = new Set<string>();
        let loaded = 0;
        let budget = MAX_DOC_READ_TOTAL_CHARS;
        for (const raw of requested.slice(0, MAX_DOCS_PER_READ * 2)) {
          if (loaded >= MAX_DOCS_PER_READ || budget <= 0) break;
          const requestedName = raw.trim();
          const name = resolveKnowledgeDocName(requestedName, names);
          if (!name) {
            documents.push({ name: requestedName, error: '文档不存在，请从知识库索引中选择文件名' });
            continue;
          }
          if (isSpecialKnowledgeDoc(name)) {
            documents.push({ name, error: '索引与回答规范无需读取' });
            continue;
          }
          if (seen.has(name)) continue;
          seen.add(name);
          try {
            const content = this.knowledge.get(name).content.trim();
            if (!content) {
              documents.push({ name, error: '文档内容为空' });
              continue;
            }
            const take = Math.min(MAX_DOC_READ_CHARS, budget);
            const truncated = content.length > take;
            const body = truncated ? `${content.slice(0, take)}\n…（文档过长，已截断）` : content;
            budget = Math.max(0, budget - body.length);
            loaded++;
            documents.push({ name, content: body, ...(truncated ? { truncated: true } : {}) });
          } catch (e) {
            documents.push({ name, error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (!documents.length) return { documents: [], error: '没有可读取的文档，请检查知识库索引中的文件名' };
        return { documents };
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
 * 判断一条弹幕是否来自直播间主播本人。
 * 优先用 uid / secUid 精确比对；主播信息只解析到昵称时才退化为昵称比对。
 * 主播信息取不到时返回 false（不误伤普通观众）。
 */
function isAnchorChatEvent(ev: ChatEvent, meta: RoomMeta | null | undefined): boolean {
  if (!meta || !ev.user) return false;
  const uid = ev.user.id?.trim();
  if (meta.uid && uid) return meta.uid === uid;
  const secUid = ev.user.secUid?.trim();
  if (meta.secUid && secUid) return meta.secUid === secUid;
  const nickname = ev.user.nickname?.trim();
  return Boolean(meta.nickname && nickname && meta.nickname.trim() === nickname);
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
 * 判断一句弹幕是否像咨询/求助。工具调用降级时的本地检索只处理问题句，
 * 避免把整批闲聊都拿去做关键词匹配，导致无关文档片段混进提示词。
 */
function looksLikeQuestion(text: string): boolean {
  if (/[?？]/.test(text)) return true;
  if (/(?:吗|呢|怎么|如何|多少|能不能|可不可以|有没有|是不是|哪里|哪个|为什么|什么时候|多久|咋|求|咨询|客服|退款|退货|换货|价格|优惠|链接|地址|教程|用法|咋用)/.test(text)) return true;
  return /\b(?:how|what|why|when|where|which|can|price|refund|help|order|link|support)\b/i.test(text);
}

/** 把降级检索到的片段拼进提示词，限制总长度，避免上下文过长 */
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

function extractKnowledgeDocs(result: unknown): KnowledgeDocResult[] {
  if (!result || typeof result !== 'object') return [];
  const documents = (result as { documents?: unknown }).documents;
  if (!Array.isArray(documents)) return [];
  return documents.filter((item): item is KnowledgeDocResult =>
    Boolean(item) && typeof item === 'object' && typeof (item as KnowledgeDocResult).name === 'string');
}

/** README 索引与回答规范是流程文件，不参与“读取文档”和降级检索 */
function isSpecialKnowledgeDoc(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === KNOWLEDGE_INDEX_NAME.toLowerCase() || lower === KNOWLEDGE_RULES_NAME.toLowerCase();
}

/** 把模型给的文件名解析成知识库里的真实文件名（容忍大小写、缺扩展名、引号） */
function resolveKnowledgeDocName(raw: string, names: string[]): string | undefined {
  const value = basename(raw.trim().replace(/^['"“”「」]+|['"“”「」]+$/g, '')).trim();
  if (!value) return undefined;
  const exact = names.find((name) => name === value);
  if (exact) return exact;
  const lower = value.toLowerCase();
  const insensitive = names.find((name) => name.toLowerCase() === lower);
  if (insensitive) return insensitive;
  if (!/\.[a-z0-9]+$/i.test(value)) {
    for (const ext of ['.md', '.txt']) {
      const candidate = names.find((name) => name.toLowerCase() === `${lower}${ext}`);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（内容过长，已截断）` : text;
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
