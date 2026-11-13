/**
 * 轻量 Agent 工作流 —— OpenAI 兼容的 function calling 循环
 *
 * 流程：LLM 判断 → （可选）调用一个或多个工具 → 工具结果回填 → LLM 生成最终回复。
 * 当前只接入 knowledgeBase 一个工具，但循环本身与工具解耦：
 * 后续新增「查询订单」「读取商品列表」等能力，只需实现 `AgentTool` 并注册即可。
 *
 * 说明：只依赖 fetch，不引入 LangChain 等框架；轮数上限防止模型无限调用工具。
 */

export interface AgentToolContext {
  roomId: string;
}

/** 工具扩展接口：新增能力时实现它，再传给 runAgent 的 tools */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema（OpenAI tools.function.parameters） */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: AgentToolContext): Promise<unknown>;
}

export interface AgentToolCall {
  id: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
}

export interface AgentStep {
  round: number;
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface AgentLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentRunOptions {
  llm: AgentLlmConfig;
  messages: AgentMessage[];
  tools?: AgentTool[];
  maxRounds?: number;
  context?: AgentToolContext;
  signal?: AbortSignal;
  /** 每次工具执行后回调，便于实时日志 / 观测 */
  onToolCall?: (step: AgentStep) => void;
  /** 每轮 LLM 调用前回调 */
  onRound?: (round: number) => void;
  /**
   * 首轮工具结果回填后调用一次，返回需要追加到对话的消息。
   * 用于在第二次 LLM 请求前附上回答规范等上下文；只在模型确实调用过工具时触发。
   */
  afterTools?: () => AgentMessage[] | undefined;
}

export interface AgentRunResult {
  content: string;
  steps: AgentStep[];
  messages: AgentMessage[];
  rounds: number;
}

type LlmReply = { content: string | null; toolCalls: AgentToolCall[]; finishReason: string };

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { llm, tools = [], maxRounds = 3, context = { roomId: '' }, signal } = options;
  const messages: AgentMessage[] = [...options.messages];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const steps: AgentStep[] = [];
  let rounds = 0;
  let afterToolsAdded = false;

  while (rounds < maxRounds) {
    rounds++;
    options.onRound?.(rounds);
    const reply = await callLlm(llm, messages, tools, signal);
    messages.push({
      role: 'assistant',
      content: reply.content,
      ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
    });

    if (!reply.toolCalls.length) {
      return { content: normalizeContent(reply.content), steps, messages, rounds };
    }

    for (const call of reply.toolCalls) {
      const step: AgentStep = {
        round: rounds,
        tool: call.function.name,
        args: parseArguments(call.function.arguments),
      };
      const tool = byName.get(step.tool);
      if (!tool) {
        step.error = `未知工具：${step.tool}`;
      } else {
        try {
          step.result = await tool.execute(step.args, context);
        } catch (e) {
          step.error = e instanceof Error ? e.message : String(e);
        }
      }
      steps.push(step);
      options.onToolCall?.(step);
      const payload = JSON.stringify(step.error ? { error: step.error } : step.result ?? null);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: payload.slice(0, 12_000),
      });
    }

    // 第一次工具结果回填后，把回答规范等上下文附加到第二次请求里；只追加一次。
    if (!afterToolsAdded && options.afterTools) {
      afterToolsAdded = true;
      const extra = options.afterTools();
      if (extra?.length) messages.push(...extra);
    }
  }

  // 轮数用完仍在调工具：不带工具再问一次，强制收敛成最终回复。
  // 注意用 user 而不是 system：部分 OpenAI 兼容服务不接受非首位的 system 消息。
  const finalReply = await callLlm(
    llm,
    [...messages, { role: 'user', content: '已达到工具调用轮数上限，请直接基于已有信息给出最终回复；没有可用信息时只输出 [SKIP]。' }],
    [],
    signal,
  );
  messages.push({ role: 'assistant', content: finalReply.content });
  return { content: normalizeContent(finalReply.content), steps, messages, rounds };
}

async function callLlm(
  llm: AgentLlmConfig,
  messages: AgentMessage[],
  tools: AgentTool[],
  signal?: AbortSignal,
): Promise<LlmReply> {
  const budget = llm.maxTokens ?? 400;
  const reply = await requestLlm(llm, messages, tools, signal, budget);
  // 推理模型会把思维链 token 也计入 max_tokens，预算不足时正文会被截断成半截 JSON。
  // 检测到 finish_reason=length 时放大预算重试一次，避免整轮回复丢失。
  if (reply.finishReason !== 'length') return reply;
  const retryBudget = Math.min(8000, Math.max(budget * 2, 1200));
  if (retryBudget <= budget) return reply;
  return requestLlm(llm, messages, tools, signal, retryBudget);
}

async function requestLlm(
  llm: AgentLlmConfig,
  messages: AgentMessage[],
  tools: AgentTool[],
  signal: AbortSignal | undefined,
  maxTokens: number,
): Promise<LlmReply> {
  const body: Record<string, unknown> = {
    model: llm.model,
    messages,
    temperature: llm.temperature ?? 0.6,
    max_tokens: maxTokens,
  };
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = 'auto';
  }

  const response = await fetch(`${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const data: any = await response.json();
  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message) throw new Error('LLM 返回格式异常：缺少 choices[0].message');
  const finishReason = String(choice?.finish_reason ?? '');

  const content = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part: any) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
      : null;

  const rawCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: AgentToolCall[] = rawCalls.map((call, index) => ({
    id: String(call?.id ?? `call_${index}`),
    type: 'function',
    function: {
      name: String(call?.function?.name ?? ''),
      arguments: typeof call?.function?.arguments === 'string'
        ? call.function.arguments
        : JSON.stringify(call?.function?.arguments ?? {}),
    },
  }));

  return { content, toolCalls, finishReason };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeContent(content: string | null): string {
  return (content ?? '').trim();
}
