import type { CanvasDoc, ChatClarificationQuestion, ChatModelSelection, ChatRoleSnapshot, ChatThread, ChatThreadMemory, CustomVideoApiConfig, EnhanceLevel, GenerateOutcome, HistoryItem, ImageApiMode, MediaSettings, PreferenceEntry, PreferenceProfile, ProfileKind, VideoApiMode, VideoModelInfo, VideoModelSchema, VideoRatio, VideoReferenceMode, VideoResolution, VideoTaskStatus } from '@/types';
import { subscribeEventStream } from './eventStream';

export interface AgentStatus {
  connected: boolean;
  lastSeenAt?: string;
  canvasId?: string;
  transport?: string;
  mcpEntry?: string;
  nodeCommand?: string;
}

/** 第三方 Agent 的最近连接状态；bridge 通过 MCP 活跃文件判断，不暴露工具参数。 */
export async function getAgentStatus(): Promise<AgentStatus> {
  const res = await fetch('/api/agent/status');
  if (!res.ok) throw new Error('读取 Agent 连接状态失败');
  const body = await res.json() as { data?: AgentStatus };
  return body.data || { connected: false };
}

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

export interface AssetFolder {
  id: string;
  name: string;
  createdAt: string;
}

export interface AssetItem {
  id: string;
  folderId: string;
  fileName: string;
  url: string;
  prompt: string;
  model: string;
  size: string;
  sourceKey: string;
  createdAt: string;
}

export interface AssetLibrary {
  folders: AssetFolder[];
  items: AssetItem[];
}

async function assetRequest<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pathname, init);
  const body = await response.json().catch(() => null) as { data?: T; msg?: string } | null;
  if (!response.ok || body?.data === undefined) throw new Error(body?.msg || `资产库请求失败（HTTP ${response.status}）`);
  return body.data;
}

export function getAssets(): Promise<AssetLibrary> {
  return assetRequest<AssetLibrary>('/api/assets');
}

export function createAsset(input: {
  folderId?: string;
  fileName: string;
  prompt: string;
  model: string;
  size: string;
  sourceKey: string;
}): Promise<AssetItem> {
  return assetRequest<AssetItem>('/api/assets/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function createAssetFolder(name: string): Promise<AssetFolder> {
  return assetRequest<AssetFolder>('/api/assets/folders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
}

export function renameAssetFolder(id: string, name: string): Promise<AssetFolder> {
  return assetRequest<AssetFolder>(`/api/assets/folders/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
}

export async function deleteAssetFolder(id: string): Promise<void> {
  await assetRequest(`/api/assets/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function moveAssetToFolder(id: string, folderId: string): Promise<AssetItem> {
  return assetRequest<AssetItem>(`/api/assets/items/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId }),
  });
}

export async function removeAsset(id: string): Promise<void> {
  await assetRequest(`/api/assets/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface RoleSkill {
  id: string;
  name: string;
  content: string;
}

/** 角色与内嵌 Skill。沿用 /api/skills 的存储和接口名以兼容已有本机数据。 */
export interface PromptSkill {
  id: string;
  name: string;
  /** 旧版简介字段，仅兼容读取。 */
  description?: string;
  category: string;
  avatarUrl: string;
  content: string;
  skills: RoleSkill[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GeneralChatPrompt {
  name: string;
  description: string;
  content: string;
}

export async function getPromptSkills(): Promise<PromptSkill[]> {
  return assetRequest<PromptSkill[]>('/api/skills');
}

export async function getGeneralChatPrompt(): Promise<GeneralChatPrompt> {
  return assetRequest<GeneralChatPrompt>('/api/chat/general-prompt');
}

export function savePromptSkill(input: Partial<PromptSkill> & Pick<PromptSkill, 'name' | 'content'>): Promise<PromptSkill> {
  const id = String(input.id || '');
  return assetRequest<PromptSkill>(id ? `/api/skills/${encodeURIComponent(id)}` : '/api/skills', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deletePromptSkill(id: string): Promise<void> {
  await assetRequest(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null) as { data?: { url?: string; fileName?: string }; msg?: string } | null;
    if (!res.ok || !body?.data?.url) throw new Error(body?.msg || `图片保存失败（HTTP ${res.status}）`);
    return { url: body.data.url, fileName: body.data.fileName || '' };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('图片保存超时，请重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
  kind?: ProfileKind;
  imageApiMode?: ImageApiMode;
  videoApiMode?: VideoApiMode;
  videoCustomConfig?: CustomVideoApiConfig;
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
export async function testConnection(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  profileId?: string;
  kind?: ProfileKind;
  videoApiMode?: VideoApiMode;
  videoCustomConfig?: CustomVideoApiConfig;
}): Promise<string> {
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
  usage?: 'style' | 'edit';
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

export async function enhanceVideoPromptApi(input: {
  prompt: string;
  ratio?: VideoRatio;
  seconds?: number;
  resolution?: VideoResolution;
  referenceMode?: VideoReferenceMode;
  profileId?: string;
}): Promise<{ prompt: string }> {
  const res = await fetch('/api/enhance-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null) as { data?: { prompt?: string }; msg?: string } | null;
  if (!res.ok || !body?.data?.prompt) throw new Error(body?.msg || `视频脚本优化失败（HTTP ${res.status}）`);
  return { prompt: String(body.data.prompt).trim() };
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
  const handler = (event: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(event.data) as PushedImageEvent;
      if (parsed?.type === 'image' && parsed.canvasId === canvasId) onImage(parsed);
    } catch {
      /* 单条脏数据不该打断订阅 */
    }
  };
  return subscribeEventStream(`/api/events?canvasId=${encodeURIComponent(canvasId)}`, [
    { type: 'image', handler: handler as EventListener },
  ]);
}

/* ── 视频任务 ──
   一条视频会推多次：受理 → 进度(可能多条) → 完成 / 失败。
   前端按 taskId + nodeId 认出是同一条任务，分别更新节点上的进度条与成品。 */

export type VideoEventPhase = 'submitted' | 'progress' | 'download-failed' | 'done' | 'failed';

export interface PushedVideoEvent {
  type: 'video';
  phase: VideoEventPhase;
  canvasId: string;
  nodeId: string;
  taskId: string;
  status?: VideoTaskStatus;
  progress?: number;
  fileName?: string;
  url?: string;
  outputUrl?: string;
  error?: string;
  submissionUnknown?: boolean;
  recoverable?: boolean;
  finishedAt?: string;
}

/** 订阅视频任务事件。与推图同一条 SSE 流，事件名不同。 */
export function subscribePushedVideos(canvasId: string, onVideo: (event: PushedVideoEvent) => void): () => void {
  const handler = (event: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(event.data) as PushedVideoEvent;
      if (parsed?.type === 'video' && parsed.canvasId === canvasId) onVideo(parsed);
    } catch {
      /* 单条脏数据不该打断订阅 */
    }
  };
  return subscribeEventStream(`/api/events?canvasId=${encodeURIComponent(canvasId)}`, [
    { type: 'video', handler: handler as EventListener },
  ]);
}

/* ── 视频模型目录（media-v1 协议） ──
   中转站把每个模型的参数 schema 暴露成接口，界面据此动态渲染表单，
   不再写死「比例 / 画质 / 时长」三件套。 */

export interface VideoModelFetchResult {
  models: VideoModelInfo[];
  /** bridge 只读探测出的协议（media-v1 / openai-videos / xai-videos / grsai-generate） */
  protocol?: VideoApiMode;
  confidence?: 'high' | 'medium' | 'low' | string;
  evidence?: string;
}

export async function fetchVideoModels(input: {
  profileId?: string;
  baseUrl?: string;
  apiKey?: string;
  videoApiMode?: VideoApiMode;
}): Promise<VideoModelFetchResult> {
  const res = await fetch('/api/video-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null) as {
    data?: { models?: VideoModelInfo[]; protocol?: VideoApiMode; confidence?: string; evidence?: string };
    msg?: string;
  } | null;
  if (!res.ok || !body?.data) throw new Error(body?.msg || `拉取视频模型失败（HTTP ${res.status}）`);
  return {
    models: body.data.models || [],
    protocol: body.data.protocol,
    confidence: body.data.confidence,
    evidence: body.data.evidence,
  };
}

export async function fetchVideoModelSchema(profileId: string, model: string): Promise<VideoModelSchema> {
  const query = new URLSearchParams({ profileId, model }).toString();
  const res = await fetch(`/api/video-model?${query}`);
  const body = await res.json().catch(() => null) as { data?: { schema?: VideoModelSchema }; msg?: string } | null;
  if (!res.ok || !body?.data?.schema) throw new Error(body?.msg || `读取模型参数失败（HTTP ${res.status}）`);
  return body.data.schema;
}

export interface VideoPriceQuote {
  supported: boolean;
  balance?: number;
  unit?: string;
  billingMethod?: string;
  minimumUnitPrice?: number;
  minimumEstimate?: number;
  seconds: number;
  warning?: string;
}

export async function fetchVideoPriceQuote(profileId: string, model: string, seconds: number): Promise<VideoPriceQuote> {
  const query = new URLSearchParams({ profileId, model, seconds: String(seconds) }).toString();
  const res = await fetch(`/api/video-quote?${query}`);
  const body = await res.json().catch(() => null) as { data?: VideoPriceQuote; msg?: string } | null;
  if (!res.ok || !body?.data) throw new Error(body?.msg || `读取视频费用信息失败（HTTP ${res.status}）`);
  return body.data;
}

export interface VideoSubmitRequest {  nodeId: string;
  canvasId: string;
  prompt: string;
  profileId?: string;
  model?: string;
  seconds?: number;
  resolution?: VideoResolution;
  ratio?: VideoRatio;
  generateAudio?: boolean;
  watermark?: boolean;
  referenceMode?: VideoReferenceMode;
  /** 按模型 schema 选出的参数值，原样进上游的 params。 */
  params?: Record<string, unknown>;
  /** 承载参考图的参数名（images / img_url …）。 */
  imageParamName?: string;
  /** 已经上传图床拿到的公网地址。 */
  imageUrls?: string[];
  /** 本机 /api/files 文件名，由 bridge 负责过图床。 */
  imageFileNames?: string[];
}

export interface VideoSubmitResult {
  ok: boolean;
  taskId?: string;
  error?: string;
  submissionUnknown?: boolean;
}

/** 提交视频任务：受理即返回，不等结果；连接中断时保留“结果未知”以避免重复扣费。 */
export async function submitVideoTask(input: VideoSubmitRequest): Promise<VideoSubmitResult> {
  try {
    const res = await fetch('/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => null) as { data?: VideoSubmitResult; msg?: string } | null;
    if (!res.ok) {
      return {
        ok: false,
        error: body?.msg || `视频任务提交失败（HTTP ${res.status}）`,
        submissionUnknown: res.status >= 500 && res.status !== 502,
      };
    }
    if (!body?.data) {
      return { ok: false, error: '服务器未返回提交结果；请先核查服务商任务记录，避免重复提交', submissionUnknown: true };
    }
    return body.data;
  } catch (error) {
    const detail = error instanceof Error ? error.message : '本地视频服务连接中断';
    return {
      ok: false,
      error: `提交结果未知，本地连接中断，上游可能已收到请求。请先核查服务商任务记录，避免重复提交。（${detail}）`,
      submissionUnknown: true,
    };
  }
}

export interface VideoTaskRecord {
  taskId: string;
  nodeId: string;
  canvasId: string;
  prompt: string;
  model: string;
  seconds: number;
  resolution: string;
  ratio: string;
  referenceMode?: VideoReferenceMode;
  params?: Record<string, unknown>;
  imageParamName?: string;
  imageUrls: string[];
  status: VideoTaskStatus;
  progress: number;
  submissionUnknown?: boolean;
  fileName?: string;
  url?: string;
  outputUrl?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

/** 按节点查任务：刷新页面后靠它把「还在跑的任务」和画布节点重新对上。 */
export async function getVideoTaskByNode(nodeId: string): Promise<VideoTaskRecord | null> {
  const res = await fetch(`/api/videos/node/${encodeURIComponent(nodeId)}`);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as { data?: VideoTaskRecord } | null;
  return body?.data || null;
}

/** 重新接收已生成的视频文件；只下载既有 outputUrl，不会再次提交生成任务。 */
export async function recoverVideoDownload(nodeId: string): Promise<void> {
  const res = await fetch(`/api/videos/node/${encodeURIComponent(nodeId)}`, { method: 'POST' });
  const body = await res.json().catch(() => null) as { msg?: string } | null;
  if (!res.ok) throw new Error(body?.msg || `视频接收失败（HTTP ${res.status}）`);
}

/** 移除本地任务记录（上游任务未必取消，只是不再轮询）。 */
export async function dismissVideoTask(taskId: string): Promise<void> {
  await fetch(`/api/videos/${encodeURIComponent(taskId)}`, { method: 'DELETE' }).catch(() => undefined);
}

/** 按节点清掉任务记录：用于「提交结果未知」占位（taskId 为空，按 id 删不掉）。 */
export async function dismissVideoTasksByNode(nodeId: string): Promise<void> {
  await fetch(`/api/videos/node?nodeId=${encodeURIComponent(nodeId)}`, { method: 'DELETE' }).catch(() => undefined);
}

export interface ImageHostView {
  /** 用户是否自定义过图床。未自定义时图生视频使用内置临时图床。 */
  configured: boolean;
  /** true = 正在使用内置默认临时图床。 */
  usingDefault?: boolean;
  defaultPreset?: string;
  config: {
    uploadUrl: string;
    fileField: string;
    urlField: string;
    headers: Record<string, string>;
    extraFields: Record<string, string>;
  };
  presets: Record<string, Partial<{ uploadUrl: string; fileField: string; urlField: string; headers: Record<string, string>; extraFields: Record<string, string> }>>;
}

/** 读图床配置：图生视频的前提，没配的话界面要提示而不是静默失败。 */
export async function getImageHost(): Promise<ImageHostView> {
  const res = await fetch('/api/image-host');
  if (!res.ok) throw new Error('读取图床配置失败');
  const body = await res.json().catch(() => null) as { data?: ImageHostView } | null;
  return body?.data || { configured: false, config: { uploadUrl: '', fileField: 'file', urlField: '', headers: {}, extraFields: {} }, presets: {} };
}

export async function saveImageHost(config: ImageHostView['config']): Promise<ImageHostView> {
  const res = await fetch('/api/image-host', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const body = await res.json().catch(() => null) as { data?: ImageHostView; msg?: string } | null;
  if (!res.ok || !body?.data) throw new Error(body?.msg || '保存图床配置失败');
  return body.data;
}

export interface CanvasUpdatedEvent {
  type: 'canvas-updated';
  canvasId: string;
  updatedAt: string;
  originId?: string;
}

/** 订阅同一画布的远端写入（局域网其他页面）：收到后拉最新文档合并，看到对方的上传与编辑。 */
export function subscribeCanvasUpdated(canvasId: string, onUpdate: (event: CanvasUpdatedEvent) => void): () => void {
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
  return subscribeEventStream(`/api/events?canvasId=${encodeURIComponent(canvasId)}`, [
    { type: 'canvas-updated', handler: handler as EventListener },
  ]);
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
  const handler = (event: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(event.data) as PushedLocateEvent;
      if (parsed?.type === 'locate' && parsed.nodeId) onLocate(parsed);
    } catch {
      /* 单条脏数据不该打断订阅 */
    }
  };
  return subscribeEventStream('/api/events', [{ type: 'locate', handler: handler as EventListener }]);
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
  /** 本轮角色快照；没有选择角色时不发送。 */
  agentRole?: ChatRoleSnapshot;
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
  let cleanup = () => {};
  const types: Array<ChatRunEvent['type']> = [
    'message_delta', 'thinking', 'clarification_requested', 'clarification_answered', 'tool_started', 'tool_progress',
    'image_completed', 'context_updated', 'memory_updated', 'tool_finished', 'message_done', 'error',
  ];
  const listeners = types.map((type) => {
    const handler = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as ChatRunEvent;
        try {
          onEvent(parsed);
        } finally {
          if (parsed.type === 'message_done' || parsed.type === 'error') cleanup();
        }
      } catch {
        /* 单条脏数据不该打断订阅 */
      }
    };
    return { type, handler: handler as EventListener };
  });
  cleanup = subscribeEventStream(`/api/chat/runs/${encodeURIComponent(runId)}/events`, listeners);
  return cleanup;
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
