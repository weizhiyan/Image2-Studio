import type { ModelProfile } from './settings.js';
import { callTextModel, isUnsupportedTemperatureError } from './textApi.js';

/** 角色温度统一收口到 0-1；旧快照里的越界值不直接发给上游。 */
function normalizeRoleTemperature(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/**
 * Agent 调用链：给语言模型挂上 generate_image 工具，让它自己判断
 * 「直接回复 / 追问 / 调工具」。一次调用 = 一个回合（turn）。
 *
 * 两条协议路径：
 *  1. 按配置使用 chat / responses 原生 tools，结构化读取工具名与参数；
 *  2. JSON 指令回落（任意格式可用）：provider 不支持 tools 时，让模型输出
 *     结构化 JSON 表达"我要调工具"，解析执行。保证不挑供应商。
 */

export interface AgentToolDef {
  name: string;
  description: string;
  /** JSON Schema（OpenAI tools 的 parameters）。 */
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** user 消息附带的参考图（dataURL，按编号顺序 = 用户说的「图 N」）。 */
  images?: string[];
  /** assistant 消息里发起的工具调用（回填历史用）。 */
  toolCalls?: AgentToolCall[];
  /** tool 消息对应哪次调用。 */
  toolCallId?: string;
}

export interface AgentTurn {
  text: string;
  toolCalls: AgentToolCall[];
  /** 走了哪条协议：排障用。 */
  protocol: 'tools' | 'json';
}

const AGENT_MAX_OUTPUT_TOKENS = 4096;
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

function networkErrorCode(error: unknown): string {
  const value = error as { code?: unknown; cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } } | null;
  const direct = value?.code;
  const cause = value?.cause?.code;
  const nested = value?.cause?.errors?.[0]?.code;
  return String(cause || nested || direct || '');
}

function isTransientNetworkError(error: unknown): boolean {
  const code = networkErrorCode(error);
  if (TRANSIENT_NETWORK_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error || '');
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_(?:CONNECT|HEADERS|SOCKET)/i.test(message);
}

function networkErrorMessage(error: unknown): string {
  const code = networkErrorCode(error);
  return `语言模型请求失败：无法连接上游或代理${code ? `（${code}）` : ''}。请检查模型 Base URL、系统代理和网络后重试。`;
}

/** 只对请求建立阶段的瞬时网络失败重试一次；流中断与已收到响应的情况不在这里重试。 */
async function fetchAgent(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted || !isTransientNetworkError(error)) throw error;
    await new Promise<void>((resolve, reject) => {
      if (init.signal?.aborted) { reject(error); return; }
      const timer = setTimeout(resolve, 500);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(error);
      }, { once: true });
    });
    try {
      return await fetch(url, init);
    } catch (retryError) {
      const wrapped = new Error(networkErrorMessage(retryError)) as Error & { networkFailure?: boolean };
      wrapped.networkFailure = true;
      throw wrapped;
    }
  }
}

class AgentToolProtocolError extends Error {}

function parseToolArguments(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AgentToolProtocolError('语言模型返回的工具参数不完整或不是有效 JSON，本次未提交生成。请重试。');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentToolProtocolError('语言模型返回的工具参数必须是对象，本次未提交生成。请重试。');
  }
  return parsed as Record<string, unknown>;
}

export interface AskUserQuestion {
  id: string;
  title: string;
  description?: string;
  type?: 'single' | 'multiple' | 'text';
  optional?: boolean;
  multiple: boolean;
  options: Array<{ label: string; value: string; description?: string; recommended?: boolean }>;
}

export function normalizeAskUserQuestions(value: unknown): AskUserQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).flatMap((raw, questionIndex) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const title = String(item.title || item.question || '').trim().slice(0, 240);
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    const options = rawOptions.slice(0, 8).flatMap((rawOption, optionIndex) => {
      const option = typeof rawOption === 'string'
        ? { label: rawOption, value: rawOption }
        : rawOption && typeof rawOption === 'object' ? rawOption as Record<string, unknown> : null;
      if (!option) return [];
      const label = String(option.label || option.title || option.text || option.value || '').trim().slice(0, 120);
      if (!label) return [];
      const optionValue = String(option.value || option.id || label).trim().slice(0, 160);
      return [{
        label,
        value: optionValue || `option_${optionIndex + 1}`,
        ...(String(option.description || '').trim() ? { description: String(option.description).trim().slice(0, 240) } : {}),
        ...(option.recommended === true || option.badge === '推荐' ? { recommended: true } : {}),
      }];
    });
    const rawType = String(item.type || item.kind || item.mode || '').toLowerCase();
    const multiple = item.multiple === true || ['multiple', 'multi', 'checkbox'].includes(rawType);
    const type: 'single' | 'multiple' | 'text' = rawType === 'text' ? 'text' : multiple ? 'multiple' : 'single';
    if (!title || (type !== 'text' && options.length < 2)) return [];
    return [{
      id: String(item.id || `question_${questionIndex + 1}`).trim().slice(0, 80) || `question_${questionIndex + 1}`,
      title,
      ...(String(item.description || item.hint || '').trim() ? { description: String(item.description || item.hint).trim().slice(0, 320) } : {}),
      type,
      ...(typeof item.optional === 'boolean' ? { optional: item.optional } : {}),
      multiple: type === 'multiple',
      options: type === 'text' ? [] : options,
    }];
  });
}

export function askUserToolDef(): AgentToolDef {
  return {
    name: 'ask_user',
    description: '普通歧义优先用自然语言追问；只有关键多项创作决策存在实质歧义时才向用户发起结构化澄清，一次 1 到 4 个互不重复的问题。type=single/multiple 时提供至少2个选项，type=text 为开放输入、不需要 options；optional=true 允许跳过本题，跳过不等于取消整个任务。已有信息不要重复询问；闲聊、纯分析和用户已明确要求立即生成时不要调用。收到答案后继续本轮对话。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string', description: '简短、具体的问题' },
              description: { type: 'string', description: '可选的补充说明' },
              type: { type: 'string', enum: ['single', 'multiple', 'text'] },
              optional: { type: 'boolean', description: '允许用户跳过本题，不取消整个任务' },
              options: {
                type: 'array',
                description: 'single/multiple 至少2个选项；text 开放输入可省略或为空',
                maxItems: 8,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    value: { type: 'string' },
                    description: { type: 'string' },
                    recommended: { type: 'boolean' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['title'],
          },
        },
      },
      required: ['questions'],
    },
  };
}

export interface AgentCallParams {
  systemSpec: string;
  messages: AgentMessage[];
  /** 当前视觉工作集，标签区分用户引用、生成候选与编辑基准；显式 [] 表示不发送图片。 */
  visualContext?: Array<{ id: string; label: string; url: string }>;
  /** 兼容旧调用方；新调用方应提供带身份和标签的 visualContext。 */
  visualContextImages?: string[];
  tools: AgentToolDef[];
  maxTokens?: number;
  /** 角色温度 0-1；chat 缺省 0.6，responses 仅在显式设置时发送。 */
  temperature?: number;
  /** 流式文字增量（chat 格式可用时逐段回调）。 */
  onTextDelta?: (chunk: string) => void;
  /** 上游显式返回的思考/推理增量；不伪造隐藏推理。 */
  onReasoningDelta?: (chunk: string) => void;
  signal?: AbortSignal;
}

/* ── 工具定义 ── */

export function generateImageToolDef(): AgentToolDef {
  return {
    name: 'generate_image',
    description: '调用绘板生图模型生成图片。仅在用户明确要求生成（如「生成」「做一版」「按这个方向出图」）或方案已聊透且用户认可时调用；用户只要分析、评价、比较时不要调用。单轮最多调用 2 次。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '由当前 Agent 按系统中的统一视觉规则直接整理的最终生图提示词，将原样交给生图模型，不再调用其它优化模型。完整保留多轮已确认的主体、风格、构图、精确图中文字、否定约束，以及必须保留和只修改的内容。',
        },
        originalPrompt: {
          type: 'string',
          description: '用户原始意图与本次修改要求，用于留档追溯；不要用它代替最终 prompt。',
        },
        referenceImages: {
          type: 'array',
          items: { type: 'number' },
          description: '要作为参考图的用户图片编号（从 1 开始，对应用户消息里「图 N」的顺序）。不传表示不参考任何图片。',
        },
        referenceUsage: {
          type: 'string',
          enum: ['style', 'edit'],
          description: 'edit = 修改用户引用的图片，或默认继续编辑本线程最近一张生成图；style = 只借鉴引用图风格，或用户明确开启全新生图需求。新需求不续接上一张图。',
        },
        ratio: {
          type: 'string',
          description: '画幅比例，如 1:1、16:9、3:2。用户没提就不传，按自动。',
        },
        count: {
          type: 'number',
          description: '生成几张候选图，1-4，默认 1。用户说「多几版」「几个方案」时才大于 1。',
        },
        baseVersionId: {
          type: 'string',
          description: '要接着迭代的历史生成图版本 id（只在用户明确指定某张历史图修改时传；同一线程无外部引用且判定为 edit 时，系统自动续接最近一张）。',
        },
      },
      required: ['prompt'],
    },
  };
}

/* ── chat 格式原生 tools（流式） ── */

interface ChatToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
  function?: { name?: string; arguments?: string };
}

/** 三条协议共用同一当前视觉工作集；历史消息不重复携带旧图。 */
function prepareVisualMessages(params: AgentCallParams): {
  messages: AgentMessage[];
  visualIndex: number;
  visuals: Array<{ id: string; label: string; url: string }>;
} {
  const lastUserIndex = params.messages.map((message) => message.role).lastIndexOf('user');
  const legacyImages = params.visualContextImages ?? params.messages[lastUserIndex]?.images ?? [];
  const visuals = (params.visualContext ?? legacyImages.map((url, index) => ({
    id: `legacy-image-${index + 1}`,
    label: params.visualContextImages === undefined ? `用户引用图 ${index + 1}` : `当前视觉图片 ${index + 1}`,
    url,
  }))).filter((item) => /^(?:data:image\/|https?:\/\/)/i.test(item.url));
  const messages = params.messages.map(({ images: _images, ...message }) => ({ ...message }));
  if (visuals.length === 0) return { messages, visualIndex: -1, visuals };
  // 新生成候选发生在工具结果之后，不能写回之前的 user 消息，亦不能插进 tool_calls/results 中间。
  let visualIndex = lastUserIndex;
  if (lastUserIndex < 0 || messages.slice(lastUserIndex + 1).some((message) => message.role === 'tool' || message.toolCalls?.length)) {
    messages.push({ role: 'user', content: '当前视觉上下文（在上述工具结果之后提供）。' });
    visualIndex = messages.length - 1;
  }
  const note = [
    '视觉附件按以下顺序与图片一一对应；用户引用编号和生成候选编号是独立的，不得混用：',
    ...visuals.map((item, index) => `视觉附件 ${index + 1}：${item.label}；ID=${item.id}`),
    '请实际查看图片内容后再回答，不要仅凭文字描述推测。',
  ].join('\n');
  messages[visualIndex] = { ...messages[visualIndex], content: `${messages[visualIndex].content}\n\n${note}` };
  return { messages, visualIndex, visuals };
}

function toChatMessages(params: AgentCallParams): unknown[] {
  const { messages, visualIndex, visuals } = prepareVisualMessages(params);
  const out: unknown[] = [{ role: 'system', content: params.systemSpec }];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') {
      const images = index === visualIndex ? visuals.map((item) => item.url) : [];
      out.push({
        role: 'user',
        content: images.length > 0
          ? [{ type: 'text', text: message.content }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
          : message.content,
      });
      continue;
    }
    if (message.role === 'assistant') {
      const toolCalls = message.toolCalls || [];
      out.push({
        role: 'assistant',
        content: message.content || null,
        ...(toolCalls.length > 0
          ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          }
          : {}),
      });
      continue;
    }
    out.push({ role: 'tool', tool_call_id: message.toolCallId || '', content: message.content });
  }
  return out;
}

/** 解析 chat 流式块：文字增量 + 思考增量 + tool_calls 增量（按 index 归并）。 */
function applyChatChunk(
  chunk: unknown,
  text: { value: string },
  reasoning: { value: string },
  calls: Map<number, { id: string; name: string; args: string }>,
): void {
  const choices = (chunk as { choices?: Array<{ delta?: Record<string, unknown> }> })?.choices;
  const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
  if (!delta) return;
  const content = delta.content;
  if (typeof content === 'string' && content) text.value += content;
  const directReasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
  if (typeof directReasoning === 'string' && directReasoning) {
    reasoning.value += directReasoning;
  } else if (Array.isArray(delta.reasoning_details)) {
    for (const part of delta.reasoning_details) {
      if (!part || typeof part !== 'object') continue;
      const value = part as { text?: unknown; content?: unknown };
      const chunkText = typeof value.text === 'string' ? value.text : typeof value.content === 'string' ? value.content : '';
      if (chunkText) reasoning.value += chunkText;
    }
  }
  const toolCalls = delta.tool_calls as ChatToolCallDelta[] | undefined;
  if (Array.isArray(toolCalls)) {
    for (const item of toolCalls) {
      const index = Number(item.index) || 0;
      const current = calls.get(index) || { id: '', name: '', args: '' };
      if (item.id) current.id = item.id;
      const name = item.function?.name ?? item.name;
      const args = item.function?.arguments ?? item.arguments;
      if (name) current.name += name;
      if (args) current.args += args;
      calls.set(index, current);
    }
  }
}

async function callChatWithTools(
  profile: ModelProfile,
  params: AgentCallParams,
): Promise<AgentTurn> {
  const base = profile.baseUrl.replace(/\/+$/, '');
  const model = String(profile.model || '').trim();
  if (!model) throw new Error(`语言模型「${profile.name}」还没填模型名`);
  const temperature = normalizeRoleTemperature(params.temperature) ?? 0.6;
  const body: Record<string, unknown> = {
    model,
    messages: toChatMessages(params),
    ...(params.tools.length > 0 ? {
      tools: params.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      tool_choice: 'auto',
    } : {}),
    temperature,
    max_tokens: params.maxTokens || AGENT_MAX_OUTPUT_TOKENS,
    stream: true,
  };
  const signal = params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const send = () => fetchAgent(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  let response = await send();
  let failureDetail = '';
  if (!response.ok) {
    failureDetail = await response.text().catch(() => '');
    if (response.status === 400 && isUnsupportedTemperatureError(failureDetail)) {
      delete body.temperature;
      response = await send();
      failureDetail = '';
    }
  }
  if (!response.ok || !response.body) {
    const detail = failureDetail || await response.text().catch(() => '');
    const error = new Error(`模型接口报错（HTTP ${response.status}）：${detail.slice(0, 300) || '无响应内容'}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  const text = { value: '' };
  const reasoning = { value: '' };
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  const applyLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { completed = true; return; }
    let chunk: { choices?: Array<{ finish_reason?: string }>; error?: unknown };
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new AgentToolProtocolError('语言模型流包含损坏的数据，本次未提交生成。请重试。');
    }
    if (!chunk || chunk.error) throw new AgentToolProtocolError('语言模型流返回错误，本次未提交生成。请重试。');
    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (finishReason === 'length' || finishReason === 'content_filter') {
      throw new AgentToolProtocolError(`语言模型输出被截断或过滤（finish_reason=${finishReason}），本次未提交生成。请重试。`);
    }
    if (finishReason === 'stop' || finishReason === 'tool_calls' || finishReason === 'function_call') completed = true;
    const before = text.value.length;
    const beforeReasoning = reasoning.value.length;
    applyChatChunk(chunk, text, reasoning, calls);
    if (reasoning.value.length > beforeReasoning) params.onReasoningDelta?.(reasoning.value.slice(beforeReasoning));
    if (text.value.length > before && !looksLikeToolSource(text.value)) params.onTextDelta?.(text.value.slice(before));
  };
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) applyLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) applyLine(buffer);
  } catch (error) {
    if (error instanceof AgentToolProtocolError || params.signal?.aborted) throw error;
    throw new AgentToolProtocolError(`语言模型流中断，输出不完整，本次未提交生成：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    reader.releaseLock();
  }
  if (!completed) throw new AgentToolProtocolError('语言模型流缺少结束标记，输出不完整，本次未提交生成。请重试。');
  const toolCalls: AgentToolCall[] = [];
  const availableTools = new Set(params.tools.map((tool) => tool.name));
  for (const call of calls.values()) {
    if (!call.name || !availableTools.has(call.name)) throw new AgentToolProtocolError('语言模型返回了不完整或不支持的工具调用，本次未提交生成。');
    const args = parseToolArguments(call.args);
    toolCalls.push({ id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: call.name, args });
  }
  if (looksLikeToolSource(text.value)) {
    const parsed = parseTextToolReply(text.value, { ...params, onTextDelta: undefined });
    if (toolCalls.length && parsed.toolCalls.length) throw new AgentToolProtocolError('语言模型混用了多套工具协议，本次未提交生成。');
    if (!toolCalls.length) return parsed;
  }
  if (!text.value.trim() && toolCalls.length === 0) throw new AgentToolProtocolError('语言模型未返回正文或完整工具调用，本次未提交生成。');
  return { text: text.value.trim(), toolCalls, protocol: 'tools' };
}

async function callResponsesWithTools(profile: ModelProfile, params: AgentCallParams): Promise<AgentTurn> {
  const base = profile.baseUrl.replace(/\/+$/, '');
  const model = String(profile.model || '').trim();
  if (!model) throw new Error(`语言模型「${profile.name}」还没填模型名`);
  const { messages, visualIndex, visuals } = prepareVisualMessages(params);
  const input: unknown[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === 'user') {
      input.push({
        role: 'user',
        content: [
          { type: 'input_text', text: message.content },
          ...(index === visualIndex ? visuals.map((item) => ({ type: 'input_image', image_url: item.url })) : []),
        ],
      });
      continue;
    }
    if (message.content) input.push({ role: 'assistant', content: message.content });
    for (const call of message.toolCalls || []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
    }
  }
  const requestSignal = params.signal
    ? AbortSignal.any([params.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  const temperature = normalizeRoleTemperature(params.temperature);
  const requestBody = (includeTemperature: boolean) => JSON.stringify({
    model,
    instructions: params.systemSpec,
    input,
    tools: params.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })),
    max_output_tokens: params.maxTokens || AGENT_MAX_OUTPUT_TOKENS,
    ...(includeTemperature && typeof temperature === 'number' ? { temperature } : {}),
  });
  let response = await fetchAgent(`${base}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
    body: requestBody(true),
    signal: requestSignal,
  });
  let failureDetail = '';
  if (!response.ok) {
    failureDetail = await response.text().catch(() => '');
    // 部分推理模型不接受 temperature：去掉后重试一次，别让角色温度把整轮打断。
    if (response.status === 400 && typeof temperature === 'number' && isUnsupportedTemperatureError(failureDetail)) {
      response = await fetchAgent(`${base}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
        body: requestBody(false),
        signal: requestSignal,
      });
      failureDetail = '';
    }
  }
  if (!response.ok) {
    const detail = failureDetail || await response.text().catch(() => '');
    const error = new Error(`模型接口报错（HTTP ${response.status}）：${detail.slice(0, 300) || '无响应内容'}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  const payload = await response.json() as {
    status?: string;
    error?: { message?: string };
    output_text?: string;
    output?: Array<{
      type?: string;
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: unknown;
      status?: string;
      summary?: Array<{ type?: string; text?: string }>;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
  if (payload.status === 'incomplete') {
    throw new AgentToolProtocolError('语言模型输出被截断，工具调用未完成，本次未提交生成。请重试。');
  }
  if (payload.status === 'failed' || payload.error) {
    throw new AgentToolProtocolError(`语言模型调用失败：${payload.error?.message || '未返回有效结果'}`);
  }
  const reasoning = (payload.output || [])
    .filter((item) => item.type === 'reasoning')
    .flatMap((item) => [
      ...(item.summary || []).map((part) => part.text || ''),
      ...(item.content || []).filter((part) => part.type === 'reasoning_text').map((part) => part.text || ''),
    ])
    .join('\n')
    .trim();
  if (reasoning) params.onReasoningDelta?.(reasoning);
  const availableTools = new Set(params.tools.map((tool) => tool.name));
  const toolCalls: AgentToolCall[] = [];
  for (const item of payload.output || []) {
    if (item.type !== 'function_call') continue;
    if (item.status === 'incomplete' || !item.name || !availableTools.has(item.name)) {
      throw new AgentToolProtocolError('语言模型返回了不完整或不支持的工具调用，本次未提交生成。');
    }
    toolCalls.push({
      id: item.call_id || item.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: item.name,
      args: parseToolArguments(item.arguments),
    });
  }
  const text = typeof payload.output_text === 'string' ? payload.output_text : (payload.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (toolCalls.length === 0) {
    if (!text.trim()) throw new AgentToolProtocolError('语言模型未返回正文或完整工具调用，本次未提交生成。');
    return parseTextToolReply(text, params);
  }
  if (looksLikeToolSource(text)) throw new AgentToolProtocolError('语言模型混用或截断了工具协议，本次未提交生成。');
  const visibleText = text.trim();
  if (visibleText) params.onTextDelta?.(visibleText);
  return { text: visibleText, toolCalls, protocol: 'tools' };
}

/* ── JSON 指令回落（任意格式） ── */

/** 在回复里容忍地抠出一个 JSON 动作块：```json 围栏 > 行首 { > 第一个完整 JSON 对象。 */
export function extractJsonAction(raw: string): Record<string, unknown> | null {
  return findJsonAction(raw)?.action ?? null;
}

/** 找 JSON 动作块并返回其在原文中的位置：剥离时按位置删，围栏内外都覆盖。 */
function findJsonAction(raw: string): { action: Record<string, unknown>; start: number; end: number } | null {
  const text = String(raw || '');
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  const candidates: Array<{ body: string; offset: number }> = [];
  if (fenced) {
    candidates.push({ body: fenced[1], offset: (fenced.index || 0) + fenced[0].indexOf(fenced[1]) });
  }
  candidates.push({ body: text, offset: 0 });
  for (const candidate of candidates) {
    const start = candidate.body.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = start; index < candidate.body.length; index += 1) {
      const char = candidate.body[index];
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(candidate.body.slice(start, index + 1)) as Record<string, unknown>;
            if (parsed && typeof parsed === 'object' && parsed.action) {
              return {
                action: parsed,
                start: candidate.offset + start,
                end: candidate.offset + index + 1,
              };
            }
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/** 把 JSON 动作块从回复里删掉，剩下的才是给用户看的文字（围栏与裸 JSON 都覆盖）。 */
function stripJsonAction(raw: string): string {
  const found = findJsonAction(raw);
  if (!found) return String(raw || '').trim();
  return `${String(raw || '').slice(0, found.start)}${String(raw || '').slice(found.end)}`.trim();
}

/** JSON 协议的系统提示增量：告诉模型怎么表达"我要调工具"。 */
export function jsonProtocolSpec(): string {
  return [
    '需要向用户结构化追问时，输出 ask_user JSON；决定生图时输出 generate_image JSON。每次只输出一个动作代码块。',
    '不要输出 XML、DSML 或其他工具调用源码；工具动作只使用下面的 JSON 格式。',
    '```json',
    '{"action": "generate_image", "args": {"prompt": "按统一视觉规则整理、可直接执行的最终生图提示词", "originalPrompt": "用户原始意图与本次修改要求", "referenceImages": [1], "referenceUsage": "style", "ratio": "1:1", "count": 1}}',
    '```',
    'prompt 是由当前 Agent 按系统统一视觉规则整理的最终生图提示词，原样提交生图模型，不再另调优化模型。完整保留精确图中文字、否定约束、必须保留项与修改边界；originalPrompt 可选，用于留档原始意图。',
    '普通歧义优先自然语言追问；仅关键多项决策使用 ask_user。questions 为1-4题；type=single/multiple 时至少2选项；type=text 为开放输入、可省略 options；optional=true 允许只跳过该题，不取消整个任务。',
    '```json',
    '{"action":"ask_user","args":{"questions":[{"id":"subject","title":"画面主体是什么？","type":"single","options":[{"label":"产品本身"},{"label":"使用场景"}]}]}}',
    '```',
    'referenceImages 是用户提供的参考图编号（从 1 开始）。不需要追问或生图时正常文字回复，不要输出 JSON。',
  ].join('\n');
}

const DSML_MARKER_CORE = String.raw`(?:\|{1,2}|｜{1,2})\s*DSML\s*(?:\|{1,2}|｜{1,2})`;
const DSML_OPEN_MARKER_PATTERN = String.raw`<\s*${DSML_MARKER_CORE}\s*>?`;
const DSML_MARKER_PATTERN = String.raw`<\s*/?\s*${DSML_MARKER_CORE}\s*>?`;

function dsmlAttribute(attributes: string, name: string): string {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function parseDsmlParameterValue(value: string, stringAttribute: string): unknown {
  const trimmed = value.trim();
  if (stringAttribute.toLowerCase() === 'true') return trimmed;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function parseDsmlArguments(body: string): Record<string, unknown> | null {
  const parameterPattern = new RegExp(
    `${DSML_OPEN_MARKER_PATTERN}\\s*parameter\\b([^>]*)>([\\s\\S]*?)${DSML_MARKER_PATTERN}\\s*parameter\\s*>`,
    'ig',
  );
  const values: Record<string, unknown> = {};
  let nestedArgs: Record<string, unknown> | null = null;
  let match: RegExpExecArray | null;
  while ((match = parameterPattern.exec(body))) {
    const name = dsmlAttribute(match[1], 'name');
    if (!name) continue;
    const value = parseDsmlParameterValue(match[2], dsmlAttribute(match[1], 'string'));
    if (/^(args|arguments|input)$/i.test(name)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) nestedArgs = value as Record<string, unknown>;
      continue;
    }
    values[name] = value;
  }
  if (nestedArgs) return nestedArgs;
  if (Object.keys(values).length > 0) return values;
  try {
    const parsed = JSON.parse(body.trim()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** 将模型意外输出的 DSML 调用规范化为内部工具调用，避免把协议源码展示给用户。 */
export function extractDsmlToolCalls(raw: string): { text: string; toolCalls: AgentToolCall[] } | null {
  const content = String(raw || '');
  const invokePattern = new RegExp(`${DSML_OPEN_MARKER_PATTERN}\\s*invoke\\b([^>]*)>`, 'ig');
  const closePattern = new RegExp(`${DSML_MARKER_PATTERN}\\s*invoke\\s*>`, 'ig');
  const callsOpenPattern = new RegExp(`${DSML_OPEN_MARKER_PATTERN}\\s*(?:calls|function_calls|tool_calls)\\s*>`, 'ig');
  const callsClosePattern = new RegExp(`${DSML_MARKER_PATTERN}\\s*(?:calls|function_calls|tool_calls)\\s*>`, 'ig');
  const toolCalls: AgentToolCall[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = invokePattern.exec(content))) {
    closePattern.lastIndex = invokePattern.lastIndex;
    const invokeClose = closePattern.exec(content);
    if (!invokeClose) return null;
    const name = dsmlAttribute(invokeMatch[1], 'name');
    const args = parseDsmlArguments(content.slice(invokePattern.lastIndex, invokeClose.index));
    if (!name || !args) return null;

    const callId = dsmlAttribute(invokeMatch[1], 'id') || `call_${Math.random().toString(36).slice(2, 10)}`;
    toolCalls.push({ id: callId, name, args });

    callsOpenPattern.lastIndex = 0;
    let callsOpen: RegExpExecArray | null;
    let callsStart = -1;
    while ((callsOpen = callsOpenPattern.exec(content)) && callsOpen.index < invokeMatch.index) {
      callsStart = callsOpen.index;
    }
    callsClosePattern.lastIndex = invokeClose.index + invokeClose[0].length;
    const callsClose = callsClosePattern.exec(content);
    if (callsStart >= 0 && !callsClose) return null;
    ranges.push({
      start: callsStart >= 0 ? callsStart : invokeMatch.index,
      end: callsClose ? callsClose.index + callsClose[0].length : invokeClose.index + invokeClose[0].length,
    });
    invokePattern.lastIndex = invokeClose.index + invokeClose[0].length;
  }

  if (toolCalls.length === 0) return null;
  ranges.sort((a, b) => a.start - b.start);
  const mergedRanges: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else mergedRanges.push({ ...range });
  }
  let text = '';
  let cursor = 0;
  for (const range of mergedRanges) {
    text += content.slice(cursor, range.start);
    cursor = range.end;
  }
  text += content.slice(cursor);
  return { text: text.trim(), toolCalls };
}

async function callWithJsonProtocol(
  profile: ModelProfile,
  params: AgentCallParams,
): Promise<AgentTurn> {
  const { messages, visuals } = prepareVisualMessages(params);
  const history = messages
    .map((message) => {
      if (message.role === 'user') return `用户：${message.content}`;
      if (message.role === 'assistant') {
        const calls = (message.toolCalls || []).map((call) => `调用工具 ${call.name}：${JSON.stringify(call.args)}`).join('\n');
        return `你：${message.content}${calls ? `\n${calls}` : ''}`;
      }
      return `工具结果：${message.content}`;
    })
    .join('\n\n');
  const userText = history || '（无历史）';
  const reply = await callTextModel(profile, {
    systemSpec: params.tools.length > 0 ? `${params.systemSpec}\n\n${jsonProtocolSpec()}` : params.systemSpec,
    userText,
    imageUrls: visuals.map((item) => item.url),
    maxTokens: params.maxTokens || AGENT_MAX_OUTPUT_TOKENS,
    temperature: normalizeRoleTemperature(params.temperature),
    signal: params.signal,
  });
  return parseTextToolReply(reply, params);
}

function looksLikeToolSource(text: string): boolean {
  return /<\s*\/?\s*(?:\|{1,2}|｜{1,2})\s*DSML/i.test(text)
    || /\{[\s\S]*?["']action["']\s*:/i.test(text)
    || /\{\s*["']act(?:i(?:o(?:n)?)?)?$/i.test(text);
}

function parseTextToolReply(reply: string, params: AgentCallParams): AgentTurn {
  const dsml = extractDsmlToolCalls(reply);
  if (dsml) {
    const availableTools = new Set(params.tools.map((tool) => tool.name));
    const toolCalls = dsml.toolCalls.filter((call) => availableTools.has(call.name));
    if (toolCalls.length !== dsml.toolCalls.length || new RegExp(DSML_MARKER_PATTERN, 'i').test(dsml.text)) {
      throw new AgentToolProtocolError('模型返回了不完整或不支持的工具调用，本次未提交生成。请重试。');
    }
    const text = dsml.text;
    if (text && params.onTextDelta) params.onTextDelta(text);
    return { text, toolCalls, protocol: 'json' };
  }
  if (new RegExp(DSML_MARKER_PATTERN, 'i').test(reply)) {
    throw new AgentToolProtocolError('模型返回的工具调用不完整或格式无法识别，本次未提交生成。请重试。');
  }
  const action = extractJsonAction(reply);
  if (action) {
    if (typeof action.action !== 'string' || !params.tools.some((tool) => tool.name === action.action)) {
      throw new AgentToolProtocolError('模型返回了不支持的工具调用，本次未提交生成。');
    }
    const args = parseToolArguments(action.args);
    // 剥掉 JSON 块才是给用户看的文字；非流式路径整段补一次 delta，前端才收得到
    const text = stripJsonAction(reply).replace(/```(?:json)?/gi, '').trim();
    if (looksLikeToolSource(text)) throw new AgentToolProtocolError('模型返回了额外或不完整的动作，本次未提交生成。');
    if (text && params.onTextDelta) params.onTextDelta(text);
    const name = action.action;
    return { text, toolCalls: [{ id: `call_${Math.random().toString(36).slice(2, 10)}`, name, args }], protocol: 'json' };
  }
  if (looksLikeToolSource(reply)) throw new AgentToolProtocolError('模型返回的动作不完整或不是有效 JSON，本次未提交生成。请重试。');
  const text = reply.trim();
  if (text && params.onTextDelta) params.onTextDelta(text);
  return { text, toolCalls: [], protocol: 'json' };
}

/* ── 对外主入口 ── */

/**
 * 一个 agent 回合：按配置优先使用 chat / responses 原生 tools；
 * 遇到 tools 不支持 / 路由错误时回落 JSON 指令协议（复用 textApi 的格式回落链）。
 */
function isUnsupportedToolsError(message: string): boolean {
  return /(?:tools?|function(?:_calling| calls?| calling)?)\b[\s'":=-]*(?:(?:is|are)\s+)?(?:not supported|unsupported|not allowed)|(?:does not support|not support)\s+(?:the\s+)?(?:tools?|function(?:_calling| calls?| calling)?)\b|(?:unsupported|unrecognized|unknown)\s+(?:parameter|argument|field)\s*:?\s*['"]?tools?\b/i.test(message);
}

export async function callAgentModel(profile: ModelProfile, params: AgentCallParams): Promise<AgentTurn> {
  const preferResponses = profile.textFormat === 'responses';
  if (preferResponses && params.tools.length > 0) {
    try {
      return await callResponsesWithTools(profile, params);
    } catch (error) {
      if (error instanceof AgentToolProtocolError || params.signal?.aborted) throw error;
      const status = (error as Error & { status?: number }).status;
      const message = error instanceof Error ? error.message : '';
      if (![404, 405, 501].includes(status || 0) && !(status === 400 && isUnsupportedToolsError(message))) throw error;
    }
  }
  if (!preferResponses) {
    try {
      return await callChatWithTools(profile, params);
    } catch (err) {
      if (err instanceof AgentToolProtocolError || params.signal?.aborted) throw err;
      const status = (err as Error & { status?: number }).status;
      const message = err instanceof Error ? err.message : '';
      // 5xx / 超时 / 解析失败（无状态码）值得换协议重来；
      // 400 里只有「不支持 tools」一类才回落，鉴权 / 参数错误换了也是同样结果。
      // 网络失败已经重试过且明确无法连接，不再换成 JSON 协议重复打一遍。
      const retriable = !(err as Error & { networkFailure?: boolean }).networkFailure
        && (status === undefined || status >= 500 || (status === 400 && isUnsupportedToolsError(message)));
      if (!retriable) throw err;
    }
  }
  try {
    return await callWithJsonProtocol(profile, params);
  } catch (error) {
    if (isTransientNetworkError(error)) throw new Error(networkErrorMessage(error));
    throw error;
  }
}
