/**
 * 文档知识库 —— AI 助手的外部知识来源
 *
 * 当前实现：`data/knowledge/` 下的 `.md` / `.txt` 文档，按标题与段落切块，
 * 用中文二元词 + 英文/数字词的 BM25 简化算法做本地检索，无需向量库或额外依赖。
 *
 * 扩展点：`KnowledgeRetriever` 定义了检索协议。后续接入向量库 / 远程知识服务时，
 * 只需实现该接口并替换 `ChatAssistant` 里的实例，Agent 工具层无需改动。
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const KNOWLEDGE_DIR = join(process.cwd(), 'data', 'knowledge');
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_CHARS = 700;
const CHUNK_OVERLAP = 100;

export interface KnowledgeDocMeta {
  name: string;
  size: number;
  updatedAt: number;
}

export interface KnowledgeDoc extends KnowledgeDocMeta {
  content: string;
}

export interface KnowledgeHit {
  doc: string;
  heading?: string;
  content: string;
  score: number;
}

/** 检索协议：文档库 / 向量库 / 远程知识服务都实现这一层，Agent 只依赖它 */
export interface KnowledgeRetriever {
  search(query: string, limit?: number): Promise<KnowledgeHit[]>;
}

/** 文档存储协议：控制台通过它管理知识文档 */
export interface KnowledgeDocumentStore {
  list(): KnowledgeDocMeta[];
  get(name: string): KnowledgeDoc;
  save(name: string, content: string): KnowledgeDoc;
  remove(name: string): boolean;
}

interface Chunk {
  doc: string;
  heading?: string;
  content: string;
  termFreq: Map<string, number>;
  length: number;
}

interface Index {
  signature: string;
  chunks: Chunk[];
  avgLength: number;
  idf: Map<string, number>;
}

/**
 * 规范化并校验文档名：
 * - 去掉路径部分（`basename`）与首尾空白，阻止通过 `../` 跳出知识库目录；
 * - 拒绝 Windows 非法字符、控制字符、隐藏文件（开头点）；结尾的点会被自动去掉；
 * - 必须以 `.md` / `.txt` 结尾。
 * 除上述限制外的常见字符（中文、括号、方括号、#、+ 等）都允许，避免用户从外部
 * 复制来的正常文档名无法在控制台打开。
 */
const INVALID_DOC_NAME_CHARS = /[\/\\:*?"<>|\x00-\x1f\x7f]/;
export const INVALID_NAME_MESSAGE = '文档名不能包含 / \\ : * ? " < > | 等字符，且必须以 .md / .txt 结尾';
export function sanitizeDocName(name: unknown): string | null {
  const value = basename(String(name ?? '')).trim().replace(/[. ]+$/, '');
  if (!value || value.length > 80) return null;
  if (INVALID_DOC_NAME_CHARS.test(value)) return null;
  if (value.startsWith('.')) return null;
  return /\.(md|txt)$/i.test(value) ? value : null;
}

/**
 * 切词：中文按二元词（bigram）切分，英文/数字按单词切分。
 * 例：「怎么退款」→ 怎么 / 么退 / 退款；「iPhone 15」→ iphone / 15。
 * 不引入分词依赖，足够支撑直播间常见咨询的检索。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const match of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(match[0]);
  for (const match of lower.matchAll(/[㐀-鿿]+/g)) {
    const run = match[0];
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

/** 按 Markdown 标题分组，再把长段落切成带重叠的块 */
function chunkDocument(doc: string, raw: string): Omit<Chunk, 'termFreq' | 'length'>[] {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const sections: { heading?: string; body: string[] }[] = [{ body: [] }];
  let current = sections[0];
  for (const line of text.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (heading) {
      current = { heading: heading[1].trim(), body: [] };
      sections.push(current);
    } else {
      current.body.push(line);
    }
  }
  const chunks: Omit<Chunk, 'termFreq' | 'length'>[] = [];
  for (const section of sections) {
    const body = section.body.join('\n').trim();
    if (!body) continue;
    for (const content of splitText(body, MAX_CHUNK_CHARS, CHUNK_OVERLAP)) {
      chunks.push({ doc, heading: section.heading, content });
    }
  }
  return chunks;
}

function splitText(text: string, maxLen: number, overlap: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  let current = '';
  const flush = () => { if (current.trim()) pieces.push(current.trim()); current = ''; };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxLen) {
      flush();
      pieces.push(...hardSplit(paragraph, maxLen, overlap));
      continue;
    }
    if (current && current.length + 2 + paragraph.length > maxLen) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return pieces;
}

function hardSplit(text: string, maxLen: number, overlap: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxLen);
    if (end < text.length) {
      const window = text.slice(start, end);
      const cut = Math.max(
        window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
        window.lastIndexOf('\n'), window.lastIndexOf('. '),
      );
      if (cut > maxLen * 0.5) end = start + cut + 1;
    }
    const piece = text.slice(start, end).trim();
    if (piece) pieces.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return pieces;
}

/** 文档知识库：本地 Markdown / 文本文件 + BM25 简化检索 */
export class DocumentKnowledgeBase implements KnowledgeRetriever, KnowledgeDocumentStore {
  private index: Index | null = null;

  constructor(private readonly dir: string = KNOWLEDGE_DIR) {
    mkdirSync(this.dir, { recursive: true });
  }

  list(): KnowledgeDocMeta[] {
    const docs: KnowledgeDocMeta[] = [];
    for (const name of this.docNames()) {
      try {
        const stat = statSync(join(this.dir, name));
        docs.push({ name, size: stat.size, updatedAt: stat.mtimeMs });
      } catch { /* 文件刚好被删除 / 无权限：跳过，避免整个列表失败 */ }
    }
    return docs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  get(rawName: string): KnowledgeDoc {
    const name = sanitizeDocName(rawName);
    if (!name) throw new Error(INVALID_NAME_MESSAGE);
    const path = join(this.dir, name);
    if (!existsSync(path)) throw new Error('文档不存在');
    const stat = statSync(path);
    return { name, size: stat.size, updatedAt: stat.mtimeMs, content: readFileSync(path, 'utf8') };
  }

  save(rawName: string, content: string): KnowledgeDoc {
    const name = sanitizeDocName(rawName);
    if (!name) throw new Error(INVALID_NAME_MESSAGE);
    if (!content.trim()) throw new Error('文档内容不能为空');
    if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) throw new Error('文档不能超过 2MB');
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, name), content, 'utf8');
    this.index = null;
    return this.get(name);
  }

  remove(rawName: string): boolean {
    const name = sanitizeDocName(rawName);
    if (!name) throw new Error('文档名不合法');
    const path = join(this.dir, name);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    this.index = null;
    return true;
  }

  /** 检索相关文档片段（BM25 简化实现，同步构建索引，异步接口便于将来替换向量库） */
  async search(query: string, limit = 4): Promise<KnowledgeHit[]> {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const index = this.buildIndex();
    if (!index.chunks.length) return [];

    const qTokens = [...new Set(tokenize(q))];
    const k1 = 1.5;
    const b = 0.75;
    const qLower = q.toLowerCase();
    const hits: KnowledgeHit[] = [];

    for (const chunk of index.chunks) {
      let score = 0;
      for (const token of qTokens) {
        const tf = chunk.termFreq.get(token);
        if (!tf) continue;
        const idf = index.idf.get(token) ?? 0;
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * chunk.length / index.avgLength));
      }
      if (score <= 0) continue;
      const heading = chunk.heading ?? '';
      const haystack = `${heading}\n${chunk.content}`.toLowerCase();
      if (haystack.includes(qLower)) score *= 1.5;
      if (chunk.doc.toLowerCase().includes(qLower)) score *= 1.3;
      hits.push({ doc: chunk.doc, heading: chunk.heading, content: chunk.content, score });
    }

    // 分词未命中时退回整句子串匹配（例如知识库里写的是「退款」，观众问「能退吗」之外的整词场景）
    if (!hits.length && q.length >= 2) {
      for (const chunk of index.chunks) {
        const haystack = `${chunk.heading ?? ''}\n${chunk.content}`.toLowerCase();
        if (haystack.includes(qLower)) {
          hits.push({ doc: chunk.doc, heading: chunk.heading, content: chunk.content, score: 0.1 });
        }
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, limit));
  }

  private docNames(): string[] {
    if (!existsSync(this.dir)) return [];
    // 只返回 API 能按名访问的文件：外部复制进来的非法文件名不展示，避免
    // 下拉框里看得到、点开却 404 / 保存失败。
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name) && sanitizeDocName(entry.name) === entry.name)
      .map((entry) => entry.name);
  }

  private buildIndex(): Index {
    const names = this.docNames();
    const signature = names
      .map((name) => {
        const stat = statSync(join(this.dir, name));
        return `${name}:${stat.size}:${stat.mtimeMs}`;
      })
      .join('|');
    if (this.index?.signature === signature) return this.index;

    const chunks: Chunk[] = [];
    for (const name of names) {
      for (const piece of chunkDocument(name, readFileSync(join(this.dir, name), 'utf8'))) {
        const joined = piece.heading ? `${piece.heading}\n${piece.content}` : piece.content;
        const tokens = tokenize(joined);
        const termFreq = new Map<string, number>();
        for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
        chunks.push({ ...piece, termFreq, length: tokens.length || 1 });
      }
    }

    const docFreq = new Map<string, number>();
    for (const chunk of chunks) {
      for (const token of chunk.termFreq.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
    const total = chunks.length || 1;
    const idf = new Map<string, number>();
    for (const [token, freq] of docFreq) {
      idf.set(token, Math.log(1 + (total - freq + 0.5) / (freq + 0.5)));
    }
    const avgLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) / total || 1;

    this.index = { signature, chunks, avgLength, idf };
    return this.index;
  }
}
