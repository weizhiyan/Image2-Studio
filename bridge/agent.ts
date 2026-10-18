import type { ModelProfile } from './settings.js';
import { callTextModel } from './textApi.js';

/**
 * Agent 调用链：给语言模型挂上 generate_image 工具，让它自己判断
 * 「直接回复 / 追问 / 调工具」。一次调用 = 一个回合（turn）。
 *
 * 两条协议路径：
 *  1. chat 格式原生 tools（/chat/completions，流式）：主路径，工具调用最可靠；
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

export interface AskUserQuestion {
  id: string;
  title: string;
  description?: string;
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
    if (!title || options.length < 2) return [];
    const type = String(item.type || item.kind || item.mode || '').toLowerCase();
    return [{
      id: String(item.id || `question_${questionIndex + 1}`).trim().slice(0, 80) || `question_${questionIndex + 1}`,
      title,
      ...(String(item.description || item.hint || '').trim() ? { description: String(item.description || item.hint).trim().slice(0, 320) } : {}),
      multiple: item.multiple === true || ['multiple', 'multi', 'checkbox'].includes(type),
      options,
    }];
  });
}

export function askUserToolDef(): AgentToolDef {
  return {
    name: 'ask_user',
    description: '当用户表达了视觉设计/生图意图，但尚未明确要求立即生成，而且关键创作选择存在实质歧义时，向用户发起结构化澄清。一次提出 1 到 4 个互不重复、能影响结果的问题（如主体、用途、风格、参考图用途、画面文字或构图）；已有信息不要重复询问。闲聊、纯分析和用户已明确要求立即生成时不要调用。收到答案后继续本轮对话，不直接调用提示词优化逻辑。',
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
              type: { type: 'string', enum: ['single', 'multiple'] },
              options: {
                type: 'array',
                minItems: 2,
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
            required: ['title', 'options'],
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
  tools: AgentToolDef[];
  maxTokens?: number;
  /** 流式文字增量（chat 格式可用时逐段回调）。 */
  onTextDelta?: (chunk: string) => void;
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
          description: '把多轮对话中已经确认的设计意图、主体、风格、构图、比例，以及“保留什么 / 修改什么”写清楚，作为提示词优化器的输入；不要堆砌过度细节，也不要写「不要出现什么」。',
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
}

function toChatMessages(systemSpec: string, messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: systemSpec }];
  for (const message of messages) {
    if (message.role === 'user') {
      const images = message.images || [];
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

/** 解析 chat 流式块：文字增量 + tool_calls 增量（按 index 归并）。 */
function applyChatChunk(
  chunk: unknown,
  text: { value: string },
  calls: Map<number, { id: string; name: string; args: string }>,
): void {
  const choices = (chunk as { choices?: Array<{ delta?: Record<string, unknown> }> })?.choices;
  const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
  if (!delta) return;
  const content = delta.content;
  if (typeof content === 'string' && content) text.value += content;
  const toolCalls = delta.tool_calls as ChatToolCallDelta[] | undefined;
  if (Array.isArray(toolCalls)) {
    for (const item of toolCalls) {
      const index = Number(item.index) || 0;
      const current = calls.get(index) || { id: '', name: '', args: '' };
      if (item.id) current.id = item.id;
      if (item.name) current.name += item.name;
      if (item.arguments) current.args += item.arguments;
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
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: toChatMessages(params.systemSpec, params.messages),
      tools: params.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: 'auto',
      temperature: 0.6,
      max_tokens: params.maxTokens || 1600,
      stream: true,
    }),
    signal: params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`模型接口报错（HTTP ${response.status}）：${detail.slice(0, 300) || '无响应内容'}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  // 流式读取：文字增量回调 + tool_calls 归并
  const text = { value: '' };
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const before = text.value.length;
      applyChatChunk(chunk, text, calls);
      if (text.value.length > before && params.onTextDelta) {
        params.onTextDelta(text.value.slice(before));
      }
    }
  }
  const toolCalls: AgentToolCall[] = [];
  for (const call of calls.values()) {
    if (!call.name) continue;
    let args: Record<string, unknown> = {};
    try {
      args = call.args ? JSON.parse(call.args) as Record<string, unknown> : {};
    } catch {
      args = {};
    }
    toolCalls.push({ id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: call.name, args });
  }
  return { text: text.value.trim(), toolCalls, protocol: 'tools' };
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
    '```json',
    '{"action": "generate_image", "args": {"prompt": "整理后的用户设计意图与修改要求", "referenceImages": [1], "referenceUsage": "style", "ratio": "1:1", "count": 1}}',
    '```',
    'prompt 是提示词优化器的输入：写清楚已确认的需求与修改项，不要自行扩写成最终长提示词；生图前 bridge 会统一优化一次。',
    '需要澄清时使用以下结构，questions 必须是 1-4 个问题，每题至少 2 个选项：',
    '```json',
    '{"action":"ask_user","args":{"questions":[{"id":"subject","title":"画面主体是什么？","type":"single","options":[{"label":"产品本身"},{"label":"使用场景"}]}]}}',
    '```',
    'referenceImages 是用户提供的参考图编号（从 1 开始）。不需要追问或生图时正常文字回复，不要输出 JSON。',
  ].join('\n');
}

async function callWithJsonProtocol(
  profile: ModelProfile,
  params: AgentCallParams,
): Promise<AgentTurn> {
  const history = params.messages
    .map((message) => {
      if (message.role === 'user') {
        const images = message.images || [];
        const head = images.length > 0
          ? `${message.content}\n（附 ${images.length} 张参考图：${images.map((_, index) => `图 ${index + 1}`).join('、')}）`
          : message.content;
        return `用户：${head}`;
      }
      if (message.role === 'assistant') {
        const calls = (message.toolCalls || []).map((call) => `调用工具 ${call.name}：${JSON.stringify(call.args)}`).join('\n');
        return `你：${message.content}${calls ? `\n${calls}` : ''}`;
      }
      return `工具结果：${message.content}`;
    })
    .join('\n\n');
  const userText = history || '（无历史）';
  const reply = await callTextModel(profile, {
    systemSpec: `${params.systemSpec}\n\n${jsonProtocolSpec()}`,
    userText,
    imageUrls: [],
    maxTokens: params.maxTokens || 1600,
    signal: params.signal,
  });
  const action = extractJsonAction(reply);
  if (action && (action.action === 'generate_image' || action.action === 'ask_user')) {
    const args = (action.args && typeof action.args === 'object' ? action.args : {}) as Record<string, unknown>;
    // 剥掉 JSON 块才是给用户看的文字；非流式路径整段补一次 delta，前端才收得到
    const text = stripJsonAction(reply);
    if (text && params.onTextDelta) params.onTextDelta(text);
    const name = action.action === 'ask_user' ? 'ask_user' : 'generate_image';
    return { text, toolCalls: [{ id: `call_${Math.random().toString(36).slice(2, 10)}`, name, args }], protocol: 'json' };
  }
  const text = reply.trim();
  if (text && params.onTextDelta) params.onTextDelta(text);
  return { text, toolCalls: [], protocol: 'json' };
}

/* ── 对外主入口 ── */

/**
 * 一个 agent 回合：优先 chat 格式原生 tools（流式）；
 * 遇到 tools 不支持 / 路由错误时回落 JSON 指令协议（复用 textApi 的格式回落链）。
 */
export async function callAgentModel(profile: ModelProfile, params: AgentCallParams): Promise<AgentTurn> {
  const preferResponses = profile.textFormat === 'responses';
  if (!preferResponses) {
    try {
      return await callChatWithTools(profile, params);
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      const message = err instanceof Error ? err.message : '';
      // 5xx / 超时 / 解析失败（无状态码）值得换协议重来；
      // 400 里只有「不支持 tools」一类才回落，鉴权 / 参数错误换了也是同样结果
      const retriable = status === undefined || status >= 500 || (status === 400 && /tool/i.test(message));
      if (!retriable) throw err;
    }
  }
  return callWithJsonProtocol(profile, params);
}
