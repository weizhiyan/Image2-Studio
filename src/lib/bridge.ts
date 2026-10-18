import type { CanvasDoc, ChatClarificationQuestion, ChatModelSelection, ChatThread, ChatThreadMemory, EnhanceLevel, GenerateOutcome, HistoryItem, ImageApiMode, MediaSettings, PreferenceEntry, PreferenceProfile } from '@/types';

/** 画布注册表：让 Codex 侧的工具能列出/选择画布。 */
export async function registerCanvas(canvasId: string, name: string): Promise<void> {
  await fetch(`/api/canvases/${encodeURIComponent(canvasId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).catch(() => undefined);
}

/** 生成历史：全部画布的出图汇总，按完成时间新的在前。 */
export async function getHistory(): Promise<HistoryItem[]> {
  const res = await fetch('/api/history');
  if (!res.ok) throw new Error('读取生成历史失败');
  const body = await res.json() as { data?: HistoryItem[] };
  return body.data || [];
}

/** 服务端全量画布文档：换浏览器/新 profile 打开链接时靠它还原，不是只存名字。 */
export async function getCanvases(): Promise<CanvasDoc[]> {
  const res = await fetch('/api/canvases');
  if (!res.ok) throw new Error('读取画布失败');
  const body = await res.json() as { data?: Array<{ id: string; name: string; nodes?: CanvasDoc['nodes']; edges?: CanvasDoc['edges']; viewport?: CanvasDoc['viewport']; updatedAt?: string }> };
  return (body.data || []).map((item) => ({
    id: item.id,
    name: item.name,
    nodes: item.nodes || [],
    edges: item.edges || [],
    ...(item.viewport ? { viewport: item.viewport } : {}),
    updatedAt: item.updatedAt || '',
  }));
}

const CANVAS_CLIENT_ID_KEY = 'huiban:canvas-client-id:v1';
let canvasClientId = '';

function getCanvasClientId(): string {
  if (canvasClientId) return canvasClientId;
  try {
    const existing = sessionStorage.getItem(CANVAS_CLIENT_ID_KEY);
    if (existing) return (canvasClientId = existing);
    const created = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(CANVAS_CLIENT_ID_KEY, created);
    return (canvasClientId = created);
  } catch {
    return (canvasClientId = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  }
}

/** 整文档快照上桥：localStorage 之外的第二份拷贝，跨浏览器/跨设备都能续上。 */
export async function putCanvasDoc(doc: CanvasDoc): Promise<void> {
  const nodes = doc.nodes.map((node) => {
    const persistent = { ...node } as typeof node & {
      selected?: boolean;
      dragging?: boolean;
      className?: string;
    };
    delete persistent.selected;
    delete persistent.dragging;
    delete persistent.className;
    return persistent;
  });
  await fetch(`/api/canvases/${encodeURIComponent(doc.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: doc.name, nodes, edges: doc.edges, viewport: doc.viewport, updatedAt: doc.updatedAt, originId: getCanvasClientId() }),
  }).catch(() => undefined);
}

export async function deleteCanvasDoc(canvasId: string): Promise<void> {
  await fetch(`/api/canvases/${encodeURIComponent(canvasId)}`, { method: 'DELETE' }).catch(() => undefined);
}

/** 把浏览器图片落到 bridge 媒体目录，画布只保存轻量 /api/files 引用。 */
export async function saveImageDataUrl(dataUrl: string): Promise<{ url: string; fileName: string }> {
  const res = await fetch('/api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  const body = await res.json().catch(() => null) as { data?: { url?: string; fileName?: string }; msg?: string } | null;
  if (!res.ok || !body?.data?.url) throw new Error(body?.msg || `图片保存失败（HTTP ${res.status}）`);
  return { url: body.data.url, fileName: body.data.fileName || '' };
}

export async function deleteImageIfUnused(fileName: string): Promise<boolean> {
  const res = await fetch('/api/files/delete-if-unused', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName }),
  });
  if (!res.ok) return false;
  const body = await res.json().catch(() => null) as { data?: { deleted?: boolean } } | null;
  return body?.data?.deleted === true;
}

/* ── 对话线程（实体，一张画布多条）：localStorage 之外的第二份拷贝，与画布同款双份 ── */

/** 全部线程：启动时与本地工作副本按 updatedAt 合并。 */
export async function getChatThreads(): Promise<ChatThread[]> {
  const res = await fetch('/api/chat/threads');
  if (!res.ok) throw new Error('读取对话失败');
  const body = await res.json() as { data?: ChatThread[] };
  return Array.isArray(body.data) ? body.data : [];
}

/** 整线程上桥（upsert）：线程变更后防抖调用（与 putCanvasDoc 同一节拍）。 */
export async function putChatThread(thread: ChatThread): Promise<void> {
  await fetch('/api/chat/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(thread),
  }).catch(() => undefined);
}

/** 删一条线程（幂等）：只删对话，不碰画布节点。 */
export async function deleteChatThread(threadId: string): Promise<void> {
  await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE' }).catch(() => undefined);
}

export async function getSettings(): Promise<MediaSettings> {
  const res = await fetch('/api/settings', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('读取配置失败');
  const body = await res.json() as { data: MediaSettings };
  return body.data;
}

/** 按需读取当前配置的 Key；普通设置读取始终只返回 keyConfigured。 */
export async function revealSavedApiKey(profileId: string): Promise<string> {
  const res = await fetch('/api/settings/reveal-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ profileId }),
  });
  const body = await res.json().catch(() => null) as { data?: { apiKey?: string }; msg?: string } | null;
  if (!res.ok || !body?.data?.apiKey) throw new Error(body?.msg || `读取 API Key 失败（HTTP ${res.status}）`);
  return body.data.apiKey;
}

export interface ModelProfileInput {
  id?: string;
  name: string;
  baseUrl: string;
  /** 空串表示不修改已保存的 Key。 */
  apiKey: string;
  model: string;
  defaultSize: string;
  models?: string[];
  enabledModels?: string[];
  kind?: 'image' | 'text';
  imageApiMode?: ImageApiMode;
  responsesModel?: string;
  enabled?: boolean;
}

/** 带超时的请求：中转站不响应时不能让你一直对著「获取模型」转圈。 */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface SettingsInput {
  /** 缺省 = 保持已存配置不动（节点工具栏只翻「直连」时走这条）。 */
  profiles?: ModelProfileInput[];
  activeProfileId?: string;
  /** 兼容旧字段：true = Image API；false = Responses 智能生成。 */
  direct?: boolean;
  promptOptimizationEnabled?: boolean;
  /** 优化提示词用的语言模型 id。 */
  textProfileId?: string;
  /** 提示词整理强度：高遵循 / 均衡 / 创意。 */
  enhanceLevel?: EnhanceLevel;
}

/** 偏好档案操作：加（灯箱手动录入）/ 归纳 / 删一条 / 清空 / 开关注入。 */
export async function postPreferenceAction(
  action: 'add' | 'distill' | 'remove' | 'clear' | 'toggle',
  payload: { prompt?: string; model?: string; size?: string; id?: string; enabled?: boolean } = {},
): Promise<PreferenceProfile> {
  const res = await fetch('/api/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => null) as { data?: PreferenceProfile; msg?: string } | null;
  if (!res.ok || !body?.data) throw new Error(body?.msg || `偏好档案操作失败（HTTP ${res.status}）`);
  return body.data;
}

/** 偏好档案注入预览：和 bridge 发送时收到的内容一致，便于在界面上核对。 */
export function preferenceBlockText(entries: PreferenceEntry[]): string {
  if (entries.length === 0) return '';
  return [
    '用户长期偏好（仅在他本次没有明确要求时才遵循，冲突时以本次要求为准）：',
    ...entries.map((entry) => `- ${entry.text}`),
  ].join('\n');
}

export async function saveSettings(input: SettingsInput): Promise<MediaSettings> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null) as { data?: MediaSettings; msg?: string } | null;
  if (!res.ok || !body?.data) throw new Error(body?.msg || `保存配置失败（HTTP ${res.status}）`);
  return body.data;
}

/** 拉取服务端模型列表；baseUrl/apiKey 留空时 bridge 回落到已保存配置。 */
export async function fetchModels(input: { baseUrl: string; apiKey: string; profileId?: string }): Promise<string[]> {
  let res: Response;
  try {
    res = await fetchWithTimeout('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }, 25000);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('获取模型超时（25 秒）：服务端没有响应，请检查 Base URL 与网络后重试');
    }
    throw err;
  }
  const body = await res.json().catch(() => null) as { data?: string[]; msg?: string } | null;
  if (!res.ok || !body?.data) throw new Error(body?.msg || `获取模型列表失败（HTTP ${res.status}）`);
  return body.data;
}

/** 把网络图片链接转成本地参考图：bridge 代取代存，绕开浏览器 CORS。 */
export async function fetchImageAsReference(url: string): Promise<string> {
  const res = await fetch('/api/fetch-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const body = await res.json().catch(() => null) as { data?: { url: string }; msg?: string } | null;
  if (!res.ok || !body?.data) throw new Error(body?.msg || `图片获取失败（HTTP ${res.status}）`);
  return body.data.url;
}

/** 在系统文件管理器里定位这张图（Finder / 资源管理器），浏览器自己没这个权限。 */
export async function revealLocalFile(fileName: string): Promise<string> {
  const res = await fetch('/api/reveal-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName }),
  });
  const body = await res.json().catch(() => null) as { data?: { filePath: string }; msg?: string } | null;
  if (!res.ok || !body?.data) throw new Error(body?.msg || `打开本地文件失败（HTTP ${res.status}）`);
  return body.data.filePath;
}

/** 测试连接：生图模型会真实生成一张 1024×1024 的测试图（消耗额度）；语言模型只发一句最小对话。 */
export async function testConnection(input: { baseUrl: string; apiKey: string; model: string; profileId?: string; kind?: 'image' | 'text' }): Promise<string> {
  const res = await fetchWithTimeout('/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, 120000);
  const body = await res.json().catch(() => null) as { data?: { message: string }; msg?: string } | null;
  if (!res.ok || !body?.data) throw new Error(body?.msg || `连接测试失败（HTTP ${res.status}）`);
  return body.data.message;
}

export interface GenerateRequest {
  prompt: string;
  /** 关闭智能生成 = Image API；开启智能生成 = Responses API。 */
  apiMode?: ImageApiMode;
  /** 语言模型优化前的原始提示词：随生成记录一起落盘，灯箱里两份都看得到。 */
  originalPrompt?: string;
  /** 节点实际选择的模型；缺省才回落到 profile 默认模型。 */
  model?: string;
  quality?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  size?: string;
  referenceDataUrl?: string;
  /** 多张参考图：二次编辑时基准图在前、用户额外连过来的图在后。 */
  referenceDataUrls?: string[];
  canvasId: string;
  nodeId: string;
  /** 一次生成几张（1~8）：结果作为多个版本挂回同一节点。 */
  n?: number;
  /** 指定用哪一路生图配置；不传走当前生效的那一路。 */
  profileId?: string;
  /** Responses conversation link from the selected base image, when available. */
  previousResponseId?: string;
  /** Responses image_generation_call id from the selected base image. */
  previousImageGenerationCallId?: string;
  /** 提示词编排阶段判定的参考图用法，避免 provider 再用正则猜一次。 */
  referenceUsage?: 'style' | 'edit';
}

/** 发送前先经语言模型整理提示词；失败抛错，由调用方决定回退原文。 */
/** 参考图按顺序发：数组第 1 张就是用户说的「图 1」（与 composer chips 编号一致）。 */
export async function enhancePromptApi(input: {
  prompt: string;
  size?: string;
  referenceDataUrl?: string;
  referenceDataUrls?: string[];
  profileId?: string;
}): Promise<{ prompt: string; usage?: 'style' | 'edit' }> {
  const res = await fetch('/api/enhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...input,
      referenceDataUrls: (input.referenceDataUrls && input.referenceDataUrls.length > 0
        ? input.referenceDataUrls
        : (input.referenceDataUrl ? [input.referenceDataUrl] : [])),
    }),
  });
  const body = await res.json().catch(() => null) as { data?: { prompt: string; usage?: 'style' | 'edit' }; msg?: string } | null;
  if (!res.ok || !body?.data) throw new Error(body?.msg || `提示词优化失败（HTTP ${res.status}）`);
  return { prompt: String(body.data.prompt || ''), usage: body.data.usage };
}

/** 生图统一走 bridge：绕开浏览器直连中转站的 CORS，且和 Codex 路径同一出口。 */
export async function generate(input: GenerateRequest): Promise<GenerateOutcome> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null) as { data?: GenerateOutcome; msg?: string } | null;
  if (!res.ok || !body?.data) return { ok: false, error: body?.msg || `生图失败（HTTP ${res.status}）` };
  return body.data;
}

export interface PushedImageEvent {
  type: 'image';
  canvasId: string;
  nodeId: string;
  prompt: string;
  /** 实际发给生图模型的提示词（优化后才与 prompt 不同）。 */
  usedPrompt?: string;
  /** 生图模型服务端润色后的提示词。 */
  revisedPrompt?: string;
  model?: string;
  size?: string;
  responseId?: string;
  imageGenerationCallId?: string;
  responseModel?: string;
  responseProfileId?: string;
  fileName: string;
  url: string;
  jobId: string;
  /** mcp = Codex 推来的图；chat = 对话 agent 生图工具产的图。 */
  source?: 'mcp' | 'chat';
}

/** 订阅 Codex 推来的新图。EventSource 断线由浏览器自动重试。 */
export function subscribePushedImages(canvasId: string, onImage: (event: PushedImageEvent) => void): () => void {
  const source = new EventSource(`/api/events?canvasId=${encodeURIComponent(canvasId)}`);
  const handler = (event: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(event.data) as PushedImageEvent;
      if (parsed?.type === 'image' && parsed.canvasId === canvasId) onImage(parsed);
    } catch {
      /* 单条脏数据不该打断订阅 */
    }
  };
  source.addEventListener('image', handler as EventListener);
  return () => {
    source.removeEventListener('image', handler as EventListener);
    source.close();
  };
}

export interface CanvasUpdatedEvent {
  type: 'canvas-updated';
  canvasId: string;
  updatedAt: string;
  originId?: string;
}

/** 订阅同一画布的远端写入（局域网其他页面）：收到后拉最新文档合并，看到对方的上传与编辑。 */
export function subscribeCanvasUpdated(canvasId: string, onUpdate: (event: CanvasUpdatedEvent) => void): () => void {
  const source = new EventSource(`/api/events?canvasId=${encodeURIComponent(canvasId)}`);
  const handler = (event: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(event.data) as CanvasUpdatedEvent;
      if (parsed?.type === 'canvas-updated' && parsed.canvasId === canvasId && parsed.updatedAt) {
        if (parsed.originId === getCanvasClientId()) return;
        onUpdate(parsed);
      }
    } catch {
      /* 单条脏数据不该打断订阅 */
    }
  };
  source.addEventListener('canvas-updated', handler as EventListener);
  return () => {
    source.removeEventListener('canvas-updated', handler as EventListener);
    source.close();
  };
}

export interface PushedLocateEvent {
  type: 'locate';
  canvasId: string;
  nodeId: string;
  at: string;
  /** 生成后的自动定位：true 表示节点已在用户视口内就别挪镜头。 */
  onlyIfOffscreen?: boolean;
}

/**
 * 订阅 agent 发来的定位请求（MCP 工具 huiban_locate）。
 * 走不带画布过滤的广播流：定位本身常是跨画布操作，停在别的画布上的标签页也要能收到，
 * 由页面层决定切不切换。EventSource 断线由浏览器自动重试。
 */
export function subscribeCanvasLocate(onLocate: (event: PushedLocateEvent) => void): () => void {
  const source = new EventSource('/api/events');
  const handler = (event: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(event.data) as PushedLocateEvent;
      if (parsed?.type === 'locate' && parsed.nodeId) onLocate(parsed);
    } catch {
      /* 单条脏数据不该打断订阅 */
    }
  };
  source.addEventListener('locate', handler as EventListener);
  return () => {
    source.removeEventListener('locate', handler as EventListener);
    source.close();
  };
}

/* ── Agent 运行（方案 §12/§13）：起 run → SSE 推事件 → 可停止 ── */

/** run 请求快照：前端是线程内容的权威方，bridge 只认这份快照跑循环。 */
export interface ChatRunRequest {
  threadId: string;
  canvasId: string;
  thread: ChatThread;
  /** 本轮引用的画布图片（版本级，顺序 = 用户消息里「图 N」）。 */
  references: Array<{ canvasId?: string; nodeId: string; versionId?: string }>;
  /** 线程里最后一张生成图的版本：默认续接源。 */
  previousVersionId?: string;
  previousCanvasId?: string;
  /** 占位 assistant 消息 id。 */
  assistantMessageId: string;
  /** 本轮对话显式选择的语言模型和生图模型。 */
  modelSelection?: ChatModelSelection;
}

export type ChatRunEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'clarification_requested'; callId: string; questions: ChatClarificationQuestion[] }
  | { type: 'clarification_answered'; callId: string; answers: Record<string, string[]> }
  | { type: 'tool_started'; callId: string; name: string; args: Record<string, unknown>; model?: string; profileName?: string; size?: string; startedAt?: string }
  | { type: 'tool_progress'; callId: string; step: string }
  | { type: 'image_completed'; callId: string; media: { url: string; fileName: string; nodeId: string; versionId: string; canvasId?: string; originalPrompt?: string; enhancedPrompt?: string; prompt: string; referenceUsage?: 'style' | 'edit'; enhancementWarning?: string; model: string; size: string } }
  | { type: 'context_updated'; context: { baseVersionId?: string; responseId?: string; referenceCount: number; resetReason?: string } }
  | { type: 'memory_updated'; memory: ChatThreadMemory }
  | { type: 'tool_finished'; callId: string; status: 'done' | 'error' | 'stopped'; error?: string; durationMs?: number; finishedAt?: string }
  | { type: 'message_done'; messageId: string; status: 'done' | 'stopped' }
  | { type: 'error'; message: string };

/** 起一个 agent run：bridge 立即开始跑循环并缓冲事件。 */
export async function startChatRun(request: ChatRunRequest): Promise<string> {
  const res = await fetch('/api/chat/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await res.json().catch(() => null) as { data?: { runId?: string }; msg?: string } | null;
  if (!res.ok || !body?.data?.runId) throw new Error(body?.msg || `启动对话失败（HTTP ${res.status}）`);
  return body.data.runId;
}

/**
 * 订阅 run 的 SSE 事件。bridge 会先把缓冲事件补发给晚到的连接——
 * 刷新页面后凭 store 里留下的 runId 重连，不会丢中间过程。
 */
export function subscribeChatRunEvents(runId: string, onEvent: (event: ChatRunEvent) => void): () => void {
  const source = new EventSource(`/api/chat/runs/${encodeURIComponent(runId)}/events`);
  const types: Array<ChatRunEvent['type']> = [
    'message_delta', 'thinking', 'clarification_requested', 'clarification_answered', 'tool_started', 'tool_progress',
    'image_completed', 'context_updated', 'memory_updated', 'tool_finished', 'message_done', 'error',
  ];
  const listeners = types.map((type) => {
    const handler = (event: MessageEvent<string>) => {
      try {
        onEvent(JSON.parse(event.data) as ChatRunEvent);
      } catch {
        /* 单条脏数据不该打断订阅 */
      }
    };
    source.addEventListener(type, handler as EventListener);
    return { type, handler };
  });
  return () => {
    for (const { type, handler } of listeners) source.removeEventListener(type, handler as EventListener);
    source.close();
  };
}

/** 停止运行中的 run：中断在途的模型 / 生图请求。 */
export async function stopChatRun(runId: string): Promise<boolean> {
  const res = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }).catch(() => null);
  if (!res) return false;
  const body = await res.json().catch(() => null) as { data?: { stopped?: boolean } } | null;
  return Boolean(body?.data?.stopped);
}

export async function answerChatRun(
  runId: string,
  callId: string,
  answers: Record<string, string[]> | null,
  continuation?: {
    userMessage?: Record<string, unknown>;
    assistantMessage?: Record<string, unknown>;
  },
): Promise<boolean> {
  const res = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(answers
      ? { callId, answers, ...continuation }
      : { callId, cancel: true }),
  }).catch(() => null);
  if (!res) return false;
  const body = await res.json().catch(() => null) as { data?: { answered?: boolean } } | null;
  return Boolean(body?.data?.answered);
}
