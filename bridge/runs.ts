import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { MEDIA_DIR } from './paths.js';
import { imageExtensionOf } from './files.js';
import { pushImage } from './hub.js';
import { findProfile, readSettings, resolveTextProfile, type ModelProfile } from './settings.js';
import { generateImages, IMAGE_GENERATION_TIMEOUT_MESSAGE, IMAGE_GENERATION_TIMEOUT_MS } from './imageApi.js';
import { detectReferenceUsage, enhancePromptDetailed, fidelityForUsage, type EnhanceParams, type PromptEnhancementResult } from './textApi.js';
import { buildMemoryContext, memoryPromptBlock, type MemoryMessage, type PersistedMemory } from './chatMemory.js';
import { appendCanvasImageNodes, readCanvasDoc, type CanvasNodeRecord } from './http.js';
import { putChatThread, readChatThreads } from './chat.js';
import { askUserToolDef, callAgentModel, generateImageToolDef, normalizeAskUserQuestions, type AgentMessage, type AgentToolCall, type AskUserQuestion } from './agent.js';
import { normalizePromptRoleSnapshot, promptRoleContext, type PromptRoleSnapshot } from './skills.js';

/**
 * Agent 运行循环（方案 §12/§13）：
 *   POST /api/chat/runs 起一个 run → bridge 内部跑「语言模型 ⇄ generate_image 工具」循环，
 *   全程经 SSE 推事件（message_delta / tool_started / tool_progress / image_completed /
 *   tool_finished / message_done / error），刷新后凭 runId 重连补发缓冲事件。
 *
 * 分工：前端负责界面与画布状态，bridge 负责模型调用、生图工具执行、节点落盘与持久化。
 * 生图节点由 bridge 统一创建（与 MCP 推图同一条写入链，保证浏览器关掉也不丢），
 * 图片持久化后立即推给画布和对话，消息只存 nodeId + versionId 引用。
 */

/* ── 事件 ── */

export type RunEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'clarification_requested'; callId: string; questions: AskUserQuestion[] }
  | { type: 'clarification_answered'; callId: string; answers: Record<string, string[]> }
  | { type: 'tool_started'; callId: string; name: string; args: Record<string, unknown>; model?: string; profileName?: string; size?: string; startedAt?: string }
  | { type: 'tool_progress'; callId: string; step: string }
  | { type: 'memory_updated'; memory: PersistedMemory }
  | { type: 'context_updated'; context: ChatRunContext }
  | { type: 'image_completed'; callId: string; media: GeneratedMedia }
  | { type: 'tool_finished'; callId: string; status: 'done' | 'error' | 'stopped'; error?: string; durationMs?: number; finishedAt?: string }
  | { type: 'message_done'; messageId: string; status: 'done' | 'stopped' }
  | { type: 'error'; message: string };

export interface GeneratedMedia {
  url: string;
  fileName: string;
  nodeId: string;
  versionId: string;
  canvasId: string;
  originalPrompt: string;
  enhancedPrompt: string;
  prompt: string;
  referenceUsage: 'style' | 'edit';
  enhancementWarning?: string;
  model: string;
  size: string;
}

/** 本轮实际送入生图链路的上下文状态，前端用于显示可验证的上下文徽标。 */
export interface ChatRunContext {
  baseVersionId?: string;
  responseId?: string;
  referenceCount: number;
  resetReason?: string;
}

export interface ChatPromptCompilation {
  prompt: string;
  enhancedPrompt: string;
  usage: 'style' | 'edit';
  warning?: string;
}

export async function compileChatPrompt(
  profile: ModelProfile,
  input: EnhanceParams & { usage: 'style' | 'edit'; referenceDataUrls: string[] },
  enhance: (model: ModelProfile, params: EnhanceParams) => Promise<PromptEnhancementResult> = enhancePromptDetailed,
): Promise<ChatPromptCompilation> {
  try {
    const result = await enhance(profile, input);
    return { prompt: result.prompt, enhancedPrompt: result.prompt, usage: input.usage };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知错误';
    return {
      prompt: input.prompt,
      enhancedPrompt: '',
      usage: input.usage,
      warning: `提示词优化失败，已按原文生成：${reason}`,
    };
  }
}

/** 前端消息快照形状（本模块只读不依赖 src/types，bridge 侧自成体系）。 */
interface ThreadSnapshot {
  id: string;
  canvasId?: string;
  title: string;
  messages: Array<Record<string, unknown>>;
  memory?: PersistedMemory;
  createdAt: string;
  updatedAt: string;
}

export interface StartRunRequest {
  threadId: string;
  canvasId: string;
  /** 前端权威快照：含已追加的用户消息与占位 assistant 消息（status: 'running'）。 */
  thread: ThreadSnapshot;
  /** 本轮引用的画布图片（版本级）。 */
  references: Array<{ canvasId?: string; nodeId: string; versionId?: string }>;
  /** 线程里最后一张生成图的版本：默认续接源。 */
  previousVersionId?: string;
  previousCanvasId?: string;
  /** 占位 assistant 消息 id：事件与最终落盘都认它。 */
  assistantMessageId: string;
  modelSelection?: { textProfileId?: string; imageProfileId?: string; imageModel?: string };
  /** 发送时选中的角色快照；未选择时不注入任何角色或 Skill。 */
  agentRole?: PromptRoleSnapshot;
}

interface ChatRun {
  id: string;
  threadId: string;
  canvasId: string;
  assistantMessageId: string;
  status: 'running' | 'done' | 'stopped' | 'error';
  events: RunEvent[];
  clients: Set<ServerResponse>;
  abort: AbortController;
  createdAt: string;
  request: StartRunRequest;
  pendingQuestion?: {
    callId: string;
    questions: AskUserQuestion[];
    resolve: (answers: Record<string, string[]> | null) => void;
  };
}

const runs = new Map<string, ChatRun>();
/** 事件缓冲上限：防失控线程把内存撑爆。 */
const MAX_BUFFERED_EVENTS = 500;
/** 单轮 agent 循环的模型回合数 / 生图次数上限（方案 §12：单轮最多 2 次生图）。 */
const MAX_MODEL_ROUNDS = 4;
const MAX_TOOL_CALLS_PER_RUN = 2;
const IMAGE_TOOL_TIMEOUT_MS = IMAGE_GENERATION_TIMEOUT_MS;

function withImageToolTimeout<T>(run: ChatRun, task: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      run.abort.abort();
      reject(new Error(IMAGE_GENERATION_TIMEOUT_MESSAGE));
    }, IMAGE_TOOL_TIMEOUT_MS);
    task.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch((error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function emit(run: ChatRun, event: RunEvent): void {
  run.events.push(event);
  if (run.events.length > MAX_BUFFERED_EVENTS) run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS);
  const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of [...run.clients]) {
    try {
      client.write(data);
    } catch {
      run.clients.delete(client);
    }
  }
}

export function startChatRun(request: StartRunRequest): string {
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const run: ChatRun = {
    id: runId,
    threadId: request.threadId,
    canvasId: request.canvasId,
    assistantMessageId: request.assistantMessageId,
    status: 'running',
    events: [],
    clients: new Set(),
    abort: new AbortController(),
    createdAt: new Date().toISOString(),
    request,
  };
  runs.set(runId, run);
  void executeRun(run, request).catch((err: unknown) => {
    if (run.status !== 'running') return;
    run.status = 'error';
    const message = err instanceof Error ? err.message : 'Agent 运行失败';
    emit(run, { type: 'error', message });
    finalizeMessage(request, [], [], '', 'error', undefined, message);
    emit(run, { type: 'message_done', messageId: request.assistantMessageId, status: 'done' });
    void persistThread(request.thread);
  });
  return runId;
}

/** SSE 订阅：先把缓冲事件补发给晚到的连接（刷新重连靠这个），再转实时推送。 */
export function subscribeChatRun(runId: string, res: ServerResponse): boolean {
  const run = runs.get(runId);
  if (!run) return false;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  for (const event of run.events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  if (run.status !== 'running') {
    res.write('event: run_closed\ndata: {}\n\n');
    res.end();
    return true;
  }
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  run.clients.add(res);
  res.on('close', () => {
    clearInterval(heartbeat);
    run.clients.delete(res);
  });
  return true;
}

export function stopChatRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  run.status = 'stopped';
  run.abort.abort();
  run.pendingQuestion?.resolve(null);
  run.pendingQuestion = undefined;
  emit(run, { type: 'message_done', messageId: run.assistantMessageId, status: 'stopped' });
  return true;
}

/** 唤起追问弹窗的答案由当前 run 消费；同一个问题不能重复提交。 */
export function answerChatRun(
  runId: string,
  callId: string,
  input: {
    answers?: Record<string, unknown>;
    cancel?: boolean;
    userMessage?: Record<string, unknown>;
    assistantMessage?: Record<string, unknown>;
  },
): boolean {
  const run = runs.get(runId);
  const pending = run?.pendingQuestion;
  if (!run || run.status !== 'running' || !pending || pending.callId !== callId) return false;
  if (input.cancel) {
    run.pendingQuestion = undefined;
    pending.resolve(null);
    return true;
  }
  const rawAnswers = input.answers && typeof input.answers === 'object' ? input.answers : {};
  const answers: Record<string, string[]> = {};
  for (const question of pending.questions) {
    const raw = rawAnswers[question.id];
    const values = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const permitted = new Set(question.options.map((option) => option.value));
    const filtered = values.filter((value) => (
      value.startsWith('其他：') ? Boolean(value.slice('其他：'.length).trim()) : permitted.has(value)
    ));
    const selected = question.multiple ? [...new Set(filtered)] : filtered.slice(0, 1);
    if (selected.length === 0) return false;
    answers[question.id] = selected;
  }
  const userMessage = continuationMessage(input.userMessage, 'user');
  const assistantMessage = continuationMessage(input.assistantMessage, 'assistant');
  if (userMessage && assistantMessage) {
    const previousAssistant = run.request.thread.messages.find((message) => String(message.id || '') === run.assistantMessageId);
    if (previousAssistant) previousAssistant.status = 'done';
    const existingIds = new Set(run.request.thread.messages.map((message) => String(message.id || '')));
    if (!existingIds.has(userMessage.id)) run.request.thread.messages.push(userMessage);
    if (!existingIds.has(assistantMessage.id)) run.request.thread.messages.push(assistantMessage);
    run.assistantMessageId = assistantMessage.id;
    run.request.assistantMessageId = assistantMessage.id;
  }
  run.pendingQuestion = undefined;
  pending.resolve(answers);
  return true;
}

function continuationMessage(raw: Record<string, unknown> | undefined, role: 'user' | 'assistant'): (Record<string, unknown> & { id: string }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const message: Record<string, unknown> & { id: string } = {
    id,
    role,
    content: String(raw.content || ''),
    createdAt: String(raw.createdAt || new Date().toISOString()),
  };
  if (role === 'assistant') {
    message.status = 'running';
  } else {
    const response = raw.askResponse as Record<string, unknown> | undefined;
    if (response && typeof response === 'object' && Array.isArray(response.questions)) {
      const questions = response.questions.slice(0, 4).flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const value = item as Record<string, unknown>;
        const questionId = String(value.id || '').trim();
        const title = String(value.title || '').trim();
        const answers = Array.isArray(value.answers)
          ? value.answers.map((answer) => String(answer || '').trim()).filter(Boolean).slice(0, 8)
          : [];
        return questionId && title ? [{ id: questionId, title, answers }] : [];
      });
      const title = String(response.title || '已回答询问').trim();
      if (title && questions.length > 0) message.askResponse = { title, questions };
    }
  }
  return message;
}

/* ── 工具执行 ── */

/** 本地媒体文件 → dataURL：bridge 侧读盘，不走浏览器 fetch。 */
async function mediaFileToDataUrl(fileName: string): Promise<string> {
  const safe = path.basename(String(fileName || ''));
  if (!safe) throw new Error('空文件名');
  const data = await fs.readFile(path.join(MEDIA_DIR, safe));
  const extension = imageExtensionOf(data, path.extname(safe).slice(1));
  return `data:image/${extension};base64,${data.toString('base64')}`;
}

/** 外部语言模型只接受完整 data URL；对话历史中的 /api/files 相对地址必须先在 bridge 侧展开。 */
async function hydrateAgentHistoryImages(messages: AgentMessage[]): Promise<void> {
  await Promise.all(messages.map(async (message) => {
    if (!message.images || message.images.length === 0) return;
    const resolved = await Promise.all(message.images.map(async (url) => (
      url.startsWith('/api/files/')
        ? mediaFileToDataUrl(url.slice('/api/files/'.length)).catch(() => '')
        : url
    )));
    message.images = resolved.filter(Boolean);
  }));
}

interface CanvasNodeLike {
  id: string;
  position?: { x?: number; y?: number };
  data?: Record<string, unknown>;
}

/** 在全画布范围内按版本 id 找版本（续接与 baseVersionId 都靠它）。 */
function findVersionOnCanvas(nodes: CanvasNodeLike[], versionId: string): Record<string, unknown> | undefined {
  const target = String(versionId || '');
  if (!target) return undefined;
  for (const node of nodes) {
    const versions = Array.isArray(node.data?.versions) ? node.data!.versions as Array<Record<string, unknown>> : [];
    const found = versions.find((item) => String(item.id || '') === target);
    if (found) return found;
  }
  return undefined;
}

/** 解析引用图 → dataURL 数组（顺序 = 用户消息里「图 N」的顺序）。 */
async function resolveReferenceDataUrls(
  references: Array<{ canvasId?: string; nodeId: string; versionId?: string }>,
  canvasId: string,
): Promise<{ urls: string[]; notes: string[] }> {
  const urls: string[] = [];
  const notes: string[] = [];
  if (references.length === 0) return { urls, notes };
  for (const reference of references) {
    const sourceCanvasId = String(reference.canvasId || canvasId).trim() || canvasId;
    const doc = await readCanvasDoc(sourceCanvasId).catch(() => null);
    const nodes = (Array.isArray(doc?.nodes) ? doc!.nodes : []) as CanvasNodeLike[];
    const node = nodes.find((item) => item.id === reference.nodeId);
    if (!node) {
      notes.push(`引用的图片 ${urls.length + 1} 已不在画布上，已跳过`);
      continue;
    }
    const versions = Array.isArray(node.data?.versions) ? node.data!.versions as Array<Record<string, unknown>> : [];
    const version = reference.versionId
      ? versions.find((item) => String(item.id || '') === reference.versionId)
      : versions[versions.length - 1];
    const url = String(version?.imageUrl || node.data?.imageUrl || node.data?.referenceDataUrl || '').trim();
    if (!url) {
      notes.push(`引用的图片 ${urls.length + 1} 没有可用内容，已跳过`);
      continue;
    }
    try {
      urls.push(url.startsWith('data:') ? url : await mediaFileToDataUrl(url.replace(/^\/api\/files\//, '')));
    } catch {
      notes.push(`引用的图片 ${urls.length + 1} 读取失败，已跳过`);
    }
  }
  return { urls, notes };
}

/** 比例字符串 → 生图尺寸（长边 1536，与节点工具栏 1K 档观感一致）。 */
function sizeForRatio(ratio: string | undefined): string | undefined {
  const text = String(ratio || '').trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*[:：x×/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const longEdge = 1536;
  const scale = longEdge / Math.max(width, height);
  return `${Math.round(width * scale / 8) * 8}x${Math.round(height * scale / 8) * 8}`;
}

interface ExecuteImageArgs {
  prompt: string;
  referenceImages?: number[];
  referenceUsage?: 'style' | 'edit';
  ratio?: string;
  count?: number;
  baseVersionId?: string;
}

/** 执行一次 generate_image：生图 → 建节点落画布 → SSE 推图 → 回传 media 引用。 */
async function executeGenerateImage(
  run: ChatRun,
  callId: string,
  args: ExecuteImageArgs,
  runContext: {
    canvasId: string;
    references: Array<{ canvasId?: string; nodeId: string; versionId?: string }>;
    previousVersionId?: string;
    previousCanvasId?: string;
    textProfile: ModelProfile;
    imageProfile?: ModelProfile;
    imageModel?: string;
  },
): Promise<{ media: GeneratedMedia[]; context: ChatRunContext }> {
  const settings = await readSettings();
  const profile = runContext.imageProfile?.kind === 'image'
    ? runContext.imageProfile
    : findProfile(settings, undefined);
  if (!profile) throw new Error('没有可用的生图配置：请在「生图设置」里添加并启用模型');
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('生图工具缺少 prompt 参数');

  // 参考图：模型只给编号（从 1 开始），bridge 解析成真实文件
  const picked = (Array.isArray(args.referenceImages) ? args.referenceImages : [])
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index) && index >= 1 && index <= runContext.references.length)
    .map((index) => runContext.references[index - 1]);
  const explicitUsage = args.referenceUsage === 'edit' || args.referenceUsage === 'style';
  let usage: 'style' | 'edit' = explicitUsage ? (args.referenceUsage as 'style' | 'edit') : detectReferenceUsage(prompt);
  const resolved = await resolveReferenceDataUrls(picked, runContext.canvasId);
  if (picked.length > 0) emit(run, { type: 'tool_progress', callId, step: `正在准备 ${picked.length} 张参考图` });
  for (const note of resolved.notes) emit(run, { type: 'tool_progress', callId, step: note });

  // 基准版本：模型显式指定 > 线程最后一张。只有 edit 语义才继承最近结果；
  // style / 新需求会切断上一张图的 Responses 链，避免“另一个需求”被错误续接。
  const explicitBaseId = String(args.baseVersionId || '').trim();
  if (explicitBaseId) usage = 'edit';
  const chainId = explicitBaseId || (picked.length === 0 && usage === 'edit' ? String(runContext.previousVersionId || '').trim() : '');
  const baseCanvasId = String(runContext.previousCanvasId || runContext.canvasId).trim() || runContext.canvasId;
  let baseVersion: Record<string, unknown> | undefined;
  if (chainId) {
    const doc = await readCanvasDoc(baseCanvasId).catch(() => null);
    const nodes = (Array.isArray(doc?.nodes) ? doc!.nodes : []) as CanvasNodeLike[];
    baseVersion = findVersionOnCanvas(nodes, chainId);
  }
  // 保留显式引用与编辑基准的来源，后续分别合并，避免把基准图重复传给提示词优化器。
  const explicitReferenceUrls = [...resolved.urls];
  let baseDataUrl = '';
  if (baseVersion && usage === 'edit') {
    const baseUrl = String(baseVersion.imageUrl || '').trim();
    if (baseUrl) {
      try {
        baseDataUrl = baseUrl.startsWith('data:') ? baseUrl : await mediaFileToDataUrl(baseUrl.replace(/^\/api\/files\//, ''));
        if (!resolved.urls.includes(baseDataUrl)) resolved.urls.unshift(baseDataUrl);
        emit(run, { type: 'tool_progress', callId, step: explicitBaseId ? '已带入基准图，在这张图上继续改' : '已继承上一张生成图，准备继续编辑' });
      } catch {
        emit(run, { type: 'tool_progress', callId, step: '基准图读取失败，按全新提示词生成' });
      }
    }
  }

  const count = Math.min(4, Math.max(1, Number(args.count) || 1));
  const size = sizeForRatio(args.ratio);
  const apiMode = settings.direct === false && profile.imageApiMode === 'responses' ? 'responses' : 'images';
  const enhancementReferences = Array.from(new Set([
    ...explicitReferenceUrls,
    ...(usage === 'edit' && baseDataUrl ? [baseDataUrl] : []),
  ]));
  emit(run, { type: 'tool_progress', callId, step: '正在优化提示词' });
  const compilation = await compileChatPrompt(runContext.textProfile, {
    prompt,
    size: size || profile.defaultSize,
    referenceDataUrls: enhancementReferences,
    usage,
    level: settings.enhanceLevel,
    preferences: settings.preferences.enabled ? settings.preferences.entries : [],
    signal: run.abort.signal,
  });
  const { prompt: usedPrompt, enhancedPrompt, warning: enhancementWarning } = compilation;
  if (enhancementWarning) emit(run, { type: 'tool_progress', callId, step: enhancementWarning });
  emit(run, { type: 'tool_progress', callId, step: '正在调用生图工具' });

  // responseId 续接与 redit 同口径：只续同一路配置、同一 Responses 主模型的版本
  const generationProfileId = String(baseVersion?.responseProfileId || '');
  const responseProfile = settings.profiles.find((item) => item.id === generationProfileId);
  const sameProfile = Boolean(responseProfile) && responseProfile!.id === profile.id;
  const sameModel = String(baseVersion?.responseModel || '') === String(profile.model || '')
    && String(baseVersion?.model || runContext.imageModel || profile.model || '') === String(runContext.imageModel || profile.model || '');
  const previousResponseId = usage === 'edit' && explicitReferenceUrls.length === 0 && apiMode === 'responses' && sameProfile && sameModel && baseVersion?.responseId
    ? String(baseVersion.responseId)
    : undefined;

  const images = await generateImages(profile, {
    prompt: usedPrompt,
    model: runContext.imageModel || profile.model,
    apiMode,
    size,
    n: count,
    referenceDataUrls: resolved.urls.length > 0 ? resolved.urls : undefined,
    inputFidelity: resolved.urls.length > 0 ? fidelityForUsage(usage) : undefined,
    previousResponseId,
    previousImageGenerationCallId: previousResponseId ? (String(baseVersion?.imageGenerationCallId || '') || undefined) : undefined,
    responseModel: apiMode === 'responses' ? profile.model : undefined,
    signal: run.abort.signal,
  });

  const runContextState: ChatRunContext = {
    baseVersionId: baseVersion?.id ? String(baseVersion.id) : undefined,
    responseId: String(images[0]?.responseId || previousResponseId || '') || undefined,
    referenceCount: picked.length,
    resetReason: baseVersion && !previousResponseId
      ? (sameProfile && sameModel
        ? '本轮使用了新的参考图或全新需求，上下文从这里重新开始'
        : '模型配置或接口模式变化，无法续接上一轮上下文')
      : undefined,
  };

  // 节点落盘：bridge 统一创建（与 MCP 推图同一条写入链），浏览器关掉也不丢。
  // 节点 id 由 runId + callId + 序号确定性生成：重复事件不会建出重复节点。
  const doc = await readCanvasDoc(runContext.canvasId).catch(() => null);
  const nodes = (Array.isArray(doc?.nodes) ? doc!.nodes : []) as CanvasNodeLike[];
  const rightmost = nodes.reduce<CanvasNodeLike | null>((best, node) => {
    const x = Number(node.position?.x ?? 0);
    const bestX = best ? Number(best.position?.x ?? 0) : -Infinity;
    return x > bestX ? node : best;
  }, null);
  const anchorX = rightmost ? Number(rightmost.position?.x ?? 0) + 420 : 80;
  const anchorY = rightmost ? Number(rightmost.position?.y ?? 0) : 80;
  const now = new Date().toISOString();
  const resolvedSize = size || String(profile.defaultSize || '');
  const media: GeneratedMedia[] = [];
  const nodeRecords: CanvasNodeRecord[] = [];

  images.forEach((image, index) => {
    const nodeId = `chat_${run.id}_${callId}_${index}`;
    const versionId = `ver_${nodeId}`;
    nodeRecords.push({
      id: nodeId,
      type: 'flow-image',
      position: { x: anchorX + index * 40, y: anchorY + index * 40 },
      data: {
        kind: 'image',
        label: 'AI 对话',
        cardWidth: 320,
        prompt,
        status: 'done',
        imageUrl: image.url,
        fileName: image.fileName,
        size: resolvedSize,
        model: profile.model,
        source: 'chat',
        createdAt: now,
        finishedAt: now,
        enhancedPrompt,
        originalPrompt: prompt,
        enhancementWarning: enhancementWarning || undefined,
        revisedPrompt: String(image.revisedPrompt || ''),
        responseId: image.responseId,
        imageGenerationCallId: image.imageGenerationCallId,
        responseModel: image.responseModel,
        responseProfileId: image.responseId ? profile.id : undefined,
        versions: [{
          id: versionId,
          imageUrl: image.url,
          fileName: image.fileName,
          prompt,
          model: profile.model,
          size: resolvedSize,
          createdAt: now,
          finishedAt: now,
          enhancedPrompt,
          originalPrompt: prompt,
          enhancementWarning: enhancementWarning || undefined,
          revisedPrompt: String(image.revisedPrompt || ''),
          baseVersionId: usage === 'edit' && baseVersion?.id ? String(baseVersion.id) : undefined,
          responseId: image.responseId,
          imageGenerationCallId: image.imageGenerationCallId,
          responseModel: image.responseModel,
          responseProfileId: image.responseId ? profile.id : undefined,
        }],
        activeVersionId: versionId,
      },
    } as unknown as CanvasNodeRecord);
    media.push({
      url: image.url,
      fileName: image.fileName,
      nodeId,
      versionId,
      canvasId: runContext.canvasId,
      originalPrompt: prompt,
      enhancedPrompt,
      prompt: usedPrompt,
      referenceUsage: usage,
      enhancementWarning: enhancementWarning || undefined,
      model: profile.model,
      size: resolvedSize,
    });
  });

  await appendCanvasImageNodes(runContext.canvasId, nodeRecords);
  for (const item of media) {
    pushImage({
      type: 'image',
      canvasId: runContext.canvasId,
      nodeId: item.nodeId,
      prompt,
      usedPrompt,
      model: item.model,
      size: item.size,
      fileName: item.fileName,
      url: item.url,
      jobId: run.id,
      source: 'chat',
    });
    emit(run, { type: 'image_completed', callId, media: item });
  }
  emit(run, { type: 'tool_progress', callId, step: `已生成 ${media.length} 张候选图，落在画布上` });
  emit(run, { type: 'context_updated', context: runContextState });
  return { media, context: runContextState };
}

/* ── 历史构建 ── */

/** 当前迭代只回喂最近一张生成结果，避免把一串高清图反复带进上下文。 */
const RECENT_MEDIA_FEED = 1;

/**
 * 把前端消息快照翻成模型上下文：
 *  - 用户消息带引用图（附件 url → images，编号 = 「图 N」）；
 *  - 最近生成的图垫在当前用户消息上，保证模型"看得见"产物；
 *  - 工具调用合成 assistant tool_calls + tool 结果消息（模型需要知道每次调用返回了什么）。
 */
export function buildAgentHistory(
  messages: Array<Record<string, unknown>>,
  options: { inheritMode?: 'auto' | 'edit' | 'new'; baseImageUrl?: string } = {},
): AgentMessage[] {
  const allMedia: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (Array.isArray(message.media)) allMedia.push(...(message.media as Array<Record<string, unknown>>));
    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls as Array<Record<string, unknown>>) {
        if (Array.isArray(call.media)) allMedia.push(...(call.media as Array<Record<string, unknown>>));
      }
    }
  }
  const seenMedia = new Set<string>();
  const recentUrls = allMedia.filter((item) => {
    const key = String(item.versionId || item.nodeId || item.url || '');
    if (!key || seenMedia.has(key)) return false;
    seenMedia.add(key);
    return true;
  }).slice(-RECENT_MEDIA_FEED).map((item) => String(item.url || '')).filter(Boolean);

  const history: AgentMessage[] = [];
  let lastUserIndex = -1;
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') lastUserIndex = index;
  });

  messages.forEach((message, index) => {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (role === 'user') {
      const attachments = Array.isArray(message.attachments) ? message.attachments as Array<Record<string, unknown>> : [];
      let images = attachments
        .map((attachment) => String(attachment.url || ''))
        .filter((url) => url.startsWith('data:') || url.startsWith('/api/files/'));
      // 用户显式引用时只看所选图片；无引用时默认带入当前任务最近结果。
      if (index === lastUserIndex && images.length === 0 && options.inheritMode !== 'new') {
        const candidate = options.baseImageUrl ? [options.baseImageUrl] : recentUrls;
        images = [...images, ...candidate.filter((url) => url.startsWith('data:') || url.startsWith('/api/files/'))];
      }
      const askResponse = message.askResponse as Record<string, unknown> | undefined;
      const askAnswers = askResponse && Array.isArray(askResponse.questions)
        ? askResponse.questions.map((question) => {
          const value = question as Record<string, unknown>;
          const answers = Array.isArray(value.answers) ? value.answers.map((answer) => String(answer || '')).filter(Boolean) : [];
          return `- ${String(value.title || '问题')}: ${answers.join('、') || '未选择'}`;
        }).join('\n')
        : '';
      const content = askAnswers
        ? `${String(message.content || '')}\n用户对结构化询问的回答：\n${askAnswers}`.trim()
        : String(message.content || '');
      history.push({ role: 'user', content, images: images.length > 0 ? images : undefined });
      return;
    }
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls as Array<Record<string, unknown>> : [];
    const clarificationCalls = Array.isArray(message.clarifications)
      ? (message.clarifications as Array<Record<string, unknown>>).map((clarification) => ({
        id: String(clarification.callId || ''),
        name: 'ask_user',
        args: { questions: clarification.questions || [] },
        clarification,
      })).filter((call) => call.id)
      : [];
    const historyCalls: Array<Record<string, unknown> & { kind: 'image' | 'clarification' }> = [
      ...toolCalls.map((call) => ({ ...call, kind: 'image' as const })),
      ...clarificationCalls.map((call) => ({ ...call, kind: 'clarification' as const })),
    ];
    const ownMedia = Array.isArray(message.media) ? message.media as Array<Record<string, unknown>> : [];
    const content = String(message.content || '');
    if (!content && historyCalls.length === 0 && ownMedia.length === 0) return;
    const mediaNote = ownMedia.length > 0 ? `${content}\n（本轮已在对话中展示 ${ownMedia.length} 张生成图）`.trim() : content;
    const toolCallsOut: AgentToolCall[] = historyCalls.map((call, callIndex) => ({
      id: String(call.id || `call_${callIndex}`),
      name: String(call.name || 'generate_image'),
      args: (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>,
    }));
    history.push({ role: 'assistant', content: mediaNote, toolCalls: toolCallsOut });
    for (const call of historyCalls) {
      if (call.kind === 'clarification') {
        const clarification = call.clarification as Record<string, unknown>;
        const status = String(clarification.status || 'awaiting_input');
        const answers = clarification.answers && typeof clarification.answers === 'object' ? clarification.answers : {};
        history.push({
          role: 'tool',
          toolCallId: String(call.id || ''),
          content: status === 'answered'
            ? JSON.stringify({ answers }, null, 2)
            : '用户取消了本次需求澄清。不要生成图片。',
        });
        continue;
      }
      const callMedia = Array.isArray(call.media) ? call.media as Array<Record<string, unknown>> : [];
      const status = String(call.status || 'done');
      const summary = status === 'error'
        ? `生图失败：${String(call.error || '未知错误')}`
        : status === 'stopped'
          ? '生图已被用户停止'
          : `已生成 ${callMedia.length} 张图：${callMedia.map((item) => `${item.fileName || item.url}（节点 ${item.nodeId}，版本 ${item.versionId}）`).join('；')}`;
      history.push({ role: 'tool', toolCallId: String(call.id || ''), content: summary });
    }
  });
  return history;
}

/** Agent 系统提示词：定规矩——什么时候该聊、什么时候该生图（方案 §12）。 */
export function buildAgentSystemSpec(): string {
  return [
    '你是绘板（无限画布生图工具）里的设计助手，帮用户设计 Logo、海报、插画等视觉方案。',
    '',
    '工作方式：',
    '1. 用户表达了明确的视觉设计意图，但没有说要立即生成，且主体、用途、风格、参考图作用、文字或构图等关键信息会显著改变结果时，使用 ask_user 工具弹窗询问 1-4 个最关键的问题。一次集中询问，不要把可由常规设计判断补足的小细节也拿来追问。',
    '2. 对闲聊、分析、评价、比较或改文案请求直接正常回复，不要启动生图或弹出追问。',
    '3. 用户明确要求立即生成时，除非核心主体完全不明，否则优先用合理默认值生成，不要因细枝末节阻塞；需要澄清时仍可用 ask_user。',
    '4. ask_user 收到用户答案后，结合原始消息、图片和已确认答案继续本轮；不要重复问已回答的问题。用户未明确要求立即生成时，可先总结方案并征求是否开始生成；用户确认或明确要求生成后再调用 generate_image。',
    '5. 用户明确说「生成」「做一版」「按这个方向出图」或方案已聊透且用户认可时，调用 generate_image 工具。单轮最多调用 2 次生图工具。',
    '6. 用户消息里的「图 N」按引用图片的编号顺序对应；有显式引用时优先使用这些图片。没有显式引用且用户在当前任务上继续调整时，默认继承最近生成结果并用 referenceUsage=edit；用户明确提出新的生图需求时切断旧结果继承并用 style；只借鉴图片风格时也用 style。',
    '7. generate_image.prompt 只写从完整对话中提炼出的用户意图、明确修改项和需要保留的内容；不要重复扩写成冗长的终稿提示词，bridge 会调用统一提示词优化器整理一次。',
    '8. 生成后主动点评结果（好在哪、可调什么），并请用户提意见；不要说「我无法查看图片」——生成结果已在对话中展示。',
    '9. 对话记忆只用于延续当前任务；用户开启新对话时没有任何旧消息、旧摘要或旧图片上下文。',
    '',
    '回复要求：中文，简洁，可用基础 Markdown（段落 / 列表）。提示词要写成正面画面描述，不写「不要出现什么」。',
  ].join('\n');
}

/* ── 运行主循环 ── */

async function persistThread(thread: ThreadSnapshot): Promise<void> {
  try {
    await putChatThread(thread);
  } catch {
    /* 持久化失败不中断事件流：前端本地副本仍在 */
  }
}

/** 把运行结果写进快照里的占位 assistant 消息（前端本地副本经 SSE 已同样更新）。 */
function finalizeMessage(
  request: StartRunRequest,
  toolCalls: Array<Record<string, unknown>>,
  media: GeneratedMedia[],
  text: string,
  status: 'done' | 'error' | 'stopped',
  context?: ChatRunContext,
  error?: string,
  clarifications?: Array<{ callId: string; questions: AskUserQuestion[]; answers?: Record<string, string[]>; status: 'awaiting_input' | 'answered' | 'cancelled' }>,
): void {
  request.thread.messages = request.thread.messages.map((message) => {
    if (String(message.id || '') !== request.assistantMessageId) return message;
    const next: Record<string, unknown> = {
      ...message,
      role: 'assistant',
      content: text || String(message.content || ''),
      status,
    };
    if (toolCalls.length > 0) next.toolCalls = toolCalls;
    if (media.length > 0) next.media = media as unknown as Record<string, unknown>[];
    if (context) next.context = context;
    if (error) next.error = error;
    if (clarifications && clarifications.length > 0 && Array.isArray(message.clarifications)) {
      next.clarifications = clarifications;
    }
    return next;
  });
  request.thread.updatedAt = new Date().toISOString();
}

async function executeRun(run: ChatRun, request: StartRunRequest): Promise<void> {
  request.agentRole = normalizePromptRoleSnapshot(request.agentRole);
  const rolePrompt = promptRoleContext(request.agentRole);
  const settings = await readSettings();
  const textProfile = resolveTextProfile(settings, request.modelSelection?.textProfileId);
  const imageProfile = findProfile(settings, request.modelSelection?.imageProfileId);
  const imageModel = imageProfile
    && request.modelSelection?.imageModel
    && imageProfile.enabledModels.includes(request.modelSelection.imageModel)
    ? request.modelSelection.imageModel
    : imageProfile?.model;
  if (!textProfile) {
    run.status = 'error';
    emit(run, { type: 'error', message: '尚未配置语言模型：请在「生图设置」里添加一路语言模型' });
    emit(run, { type: 'message_done', messageId: request.assistantMessageId, status: 'done' });
    return;
  }

  const memory = buildMemoryContext(request.thread.messages as unknown as MemoryMessage[], request.thread.memory || {});
  const messages: AgentMessage[] = buildAgentHistory(
    memory.shortTermMessages as unknown as Array<Record<string, unknown>>,
    { inheritMode: memory.visualWorkingSet.inheritMode, baseImageUrl: memory.visualWorkingSet.base?.url },
  );
  await hydrateAgentHistoryImages(messages);
  const currentUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  const visualContextImages = currentUserMessage?.images || [];
  const memoryUpdatedAt = new Date().toISOString();
  request.thread.memory = {
    ...(request.thread.memory || {}),
    version: 1,
    summary: memory.shouldCompact ? memory.summaryDraft : memory.summary,
    summaryMessageCount: memory.summaryMessageCount,
    summaryUpdatedAt: memory.shouldCompact ? memoryUpdatedAt : request.thread.memory?.summaryUpdatedAt,
    goal: memory.goal,
    visualWorkingSet: memory.visualWorkingSet,
    lastCompactionAt: memory.shouldCompact ? memoryUpdatedAt : request.thread.memory?.lastCompactionAt,
  };
  emit(run, { type: 'memory_updated', memory: request.thread.memory });
  const toolCallRecords: Array<Record<string, unknown>> = [];
  const media: GeneratedMedia[] = [];
  let finalText = '';
  let toolCallCount = 0;
  let clarificationCount = 0;
  const clarifications: Array<{ callId: string; questions: AskUserQuestion[]; answers?: Record<string, string[]>; status: 'awaiting_input' | 'answered' | 'cancelled' }> = [];
  let chainVersionId = memory.visualWorkingSet.inheritMode === 'new' ? '' : String(request.previousVersionId || '');
  let messageContext: ChatRunContext | undefined;
  // 生图失败就结束本轮：不再把错误喂回模型让它自动重试，用户要看错误自己点重试
  let failureMessage = '';

  try {
    for (let round = 0; round < MAX_MODEL_ROUNDS; round += 1) {
      if (run.status !== 'running') break;
      const turn = await callAgentModel(textProfile as ModelProfile, {
        systemSpec: `${buildAgentSystemSpec()}\n\n${memoryPromptBlock(memory)}${rolePrompt}`,
        messages,
        visualContextImages,
        tools: [generateImageToolDef(), askUserToolDef()],
        onTextDelta: (chunk) => emit(run, { type: 'message_delta', text: chunk }),
        signal: run.abort.signal,
      });
      if (turn.text) {
        finalText += (finalText ? '\n' : '') + turn.text;
        messages.push({ role: 'assistant', content: turn.text });
      }
      if (turn.toolCalls.length === 0) break;

      for (const call of turn.toolCalls) {
        if (run.status !== 'running') break;
        if (call.name === 'ask_user') {
          if (clarificationCount >= 2) {
            messages.push({ role: 'tool', toolCallId: call.id, content: '追问次数已达上限。请根据已有信息做出明确建议，再询问用户是否生成。' });
            continue;
          }
          const questions = normalizeAskUserQuestions(call.args.questions);
          if (questions.length === 0) {
            messages.push({ role: 'tool', toolCallId: call.id, content: '问题格式无效，请用简洁文字直接向用户追问。' });
            continue;
          }
          clarificationCount += 1;
          const clarification: {
            callId: string;
            questions: AskUserQuestion[];
            answers?: Record<string, string[]>;
            status: 'awaiting_input' | 'answered' | 'cancelled';
          } = { callId: call.id, questions, status: 'awaiting_input' };
          clarifications.push(clarification);
          const assistantMessage = request.thread.messages.find((message) => String(message.id || '') === request.assistantMessageId);
          if (assistantMessage) {
            assistantMessage.status = 'awaiting_input';
            assistantMessage.clarifications = clarifications;
          }
          const answersPromise = new Promise<Record<string, string[]> | null>((resolve) => {
            run.pendingQuestion = { callId: call.id, questions, resolve };
          });
          emit(run, { type: 'clarification_requested', callId: call.id, questions });
          await persistThread(request.thread);
          const answers = await answersPromise;
          run.pendingQuestion = undefined;
          if (!answers) {
            clarification.status = 'cancelled';
            if (assistantMessage) assistantMessage.clarifications = clarifications;
            run.status = 'stopped';
            run.abort.abort();
            messages.push({ role: 'assistant', content: '', toolCalls: [call] });
            messages.push({ role: 'tool', toolCallId: call.id, content: '用户取消了本次需求澄清。不要生成图片。' });
            break;
          }
          clarification.status = 'answered';
          clarification.answers = answers;
          if (assistantMessage && request.assistantMessageId === String(assistantMessage.id || '')) {
            assistantMessage.status = 'running';
            assistantMessage.clarifications = clarifications;
          }
          emit(run, { type: 'clarification_answered', callId: call.id, answers });
          messages.push({ role: 'assistant', content: '', toolCalls: [call] });
          messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify({ answers }, null, 2) });
          break;
        }
        if (call.name !== 'generate_image') {
          emit(run, { type: 'tool_finished', callId: call.id, status: 'error', error: `未知工具：${call.name}` });
          messages.push({ role: 'tool', toolCallId: call.id, content: `错误：未知工具 ${call.name}` });
          continue;
        }
        if (toolCallCount >= MAX_TOOL_CALLS_PER_RUN) {
          emit(run, { type: 'tool_finished', callId: call.id, status: 'error', error: '单轮生图次数已达上限（2 次），请开新一轮' });
          messages.push({ role: 'tool', toolCallId: call.id, content: '错误：单轮生图次数已达上限（2 次）' });
          continue;
        }
        toolCallCount += 1;
        const record: Record<string, unknown> = {
          id: call.id,
          name: call.name,
          args: call.args,
          status: 'running',
          steps: ['已理解你的方向'],
        };
        toolCallRecords.push(record);
        const startedAt = new Date().toISOString();
        record.startedAt = startedAt;
        record.model = imageModel || '';
        record.profileName = imageProfile?.name || '';
        emit(run, {
          type: 'tool_started',
          callId: call.id,
          name: call.name,
          args: call.args,
          model: imageModel,
          profileName: imageProfile?.name,
          startedAt,
        });
        try {
          const generatedResult = await withImageToolTimeout(run, executeGenerateImage(run, call.id, call.args as unknown as ExecuteImageArgs, {
            canvasId: request.canvasId,
            references: request.references,
            previousVersionId: chainVersionId,
            previousCanvasId: request.previousCanvasId,
            textProfile: textProfile as ModelProfile,
            imageProfile: imageProfile as ModelProfile | undefined,
            imageModel,
          }));
          const generated = generatedResult.media;
          record.status = 'done';
          record.media = generated as unknown as Record<string, unknown>[];
          record.finishedAt = new Date().toISOString();
          record.durationMs = Math.max(0, Date.parse(String(record.finishedAt)) - Date.parse(startedAt));
          record.size = generated[0]?.size;
          if (generated[0]?.enhancementWarning) {
            record.steps = [...(Array.isArray(record.steps) ? record.steps : []), generated[0].enhancementWarning];
          }
          media.push(...generated);
          messageContext = generatedResult.context;
          if (generated[0]) chainVersionId = generated[0].versionId;
          emit(run, { type: 'tool_finished', callId: call.id, status: 'done', durationMs: record.durationMs as number, finishedAt: record.finishedAt as string });
          messages.push({ role: 'assistant', content: '', toolCalls: [call] });
          messages.push({ role: 'tool', toolCallId: call.id, content: `已生成 ${generated.length} 张图，落在画布节点上，已在对话中展示。` });
        } catch (err) {
          const message = err instanceof Error ? err.message : '生图失败';
          const stopped = run.status !== 'running' || run.abort.signal.aborted && message === 'This operation was aborted';
          record.status = stopped ? 'stopped' : 'error';
          record.error = stopped ? '已停止' : message;
          record.finishedAt = new Date().toISOString();
          record.durationMs = Math.max(0, Date.parse(String(record.finishedAt)) - Date.parse(startedAt));
          emit(run, { type: 'tool_finished', callId: call.id, status: stopped ? 'stopped' : 'error', error: stopped ? '已停止' : message, durationMs: record.durationMs as number, finishedAt: record.finishedAt as string });
          messages.push({ role: 'tool', toolCallId: call.id, content: stopped ? '生图已停止' : `生图失败：${message}` });
          if (!stopped) failureMessage = message;
        }
      }
      if (failureMessage) break;
    }

    if (run.status !== 'running') {
      // 被停止：终态写 stopped，不再回写结果（终态不被晚到事件覆盖）
      finalizeMessage(request, toolCallRecords, media, finalText, 'stopped', messageContext, undefined, clarifications);
      emit(run, { type: 'message_done', messageId: request.assistantMessageId, status: 'stopped' });
      await persistThread(request.thread);
      return;
    }
    if (failureMessage) {
      // 生图失败：消息落 error 终态，错误留在对话里可回看，不伪装成完成
      finalizeMessage(request, toolCallRecords, media, finalText, 'error', messageContext, failureMessage, clarifications);
      run.status = 'error';
      emit(run, { type: 'message_done', messageId: request.assistantMessageId, status: 'done' });
      await persistThread(request.thread);
      return;
    }
    finalizeMessage(request, toolCallRecords, media, finalText, 'done', messageContext, undefined, clarifications);
    run.status = 'done';
    emit(run, { type: 'message_done', messageId: request.assistantMessageId, status: 'done' });
    await persistThread(request.thread);
  } catch (err) {
    if (run.status !== 'running') return;
    run.status = 'error';
    const message = err instanceof Error ? err.message : 'Agent 运行失败';
    emit(run, { type: 'error', message });
    finalizeMessage(request, toolCallRecords, media, finalText, 'error', messageContext, message, clarifications);
    emit(run, { type: 'message_done', messageId: request.assistantMessageId, status: 'done' });
    await persistThread(request.thread);
  }
}

/** 启动时把上次未结束的 run 标记掉：bridge 重启后 run 已丢失，消息不能伪装成完成。 */
export async function reconcileLostRuns(): Promise<void> {
  const threads = await readChatThreads().catch(() => []);
  for (const thread of threads) {
    let touched = false;
    const messages = thread.messages.map((message) => {
      if (message.status !== 'running' && message.status !== 'awaiting_input') return message;
      touched = true;
      return { ...message, status: 'unknown' as const };
    });
    if (touched) {
      await putChatThread({ ...thread, messages, updatedAt: new Date().toISOString() }).catch(() => null);
    }
  }
}
