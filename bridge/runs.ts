import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { MEDIA_DIR } from './paths.js';
import { imageExtensionOf } from './files.js';
import { pushImage } from './hub.js';
import { findProfile, readSettings, resolveTextModel, resolveTextProfile, normalizeChatRuntimeSettings, type ModelProfile } from './settings.js';
import { generateImages, IMAGE_GENERATION_TIMEOUT_MESSAGE, IMAGE_GENERATION_TIMEOUT_MS } from './imageApi.js';
import { detectReferenceUsage, enhancePromptDetailed, fidelityForUsage, buildVisualPromptRules, callTextModel, type EnhanceParams, type PromptEnhancementResult } from './textApi.js';
import { applyMemoryCompaction, buildMemoryContext, memoryPromptBlock, type MemoryMessage, type PersistedMemory } from './chatMemory.js';
import { appendCanvasImageNodes, readCanvasDoc, type CanvasNodeRecord } from './http.js';
import { readChatThreads, readChatThread, writeClientThread, writeRunThread } from './chat.js';
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

export type RunStatus = 'running' | 'stopping' | 'done' | 'stopped' | 'error';

export interface ImageConfirmation {
  callId: string;
  prompt: string;
  model: string;
  size: string;
  count: number;
  totalCount: number;
  cost: 'unknown';
  expiresAt: string;
}

export interface RunSnapshot {
  type: 'snapshot';
  runId: string;
  messageId: string;
  seq: number;
  status: RunStatus;
  thread: ThreadSnapshot;
  generation: number;
  pendingConfirmation?: ImageConfirmation;
}

type RunEventPayload =
  | { type: 'message_delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'clarification_requested'; callId: string; questions: AskUserQuestion[] }
  | { type: 'clarification_answered'; callId: string; answers: Record<string, string[]> }
  | { type: 'confirmation_requested'; confirmation: ImageConfirmation }
  | { type: 'confirmation_resolved'; callId: string; approved: boolean }
  | { type: 'tool_started'; callId: string; name: string; args: Record<string, unknown>; model?: string; profileName?: string; size?: string; startedAt?: string }
  | { type: 'tool_progress'; callId: string; step: string }
  | { type: 'memory_updated'; memory: PersistedMemory }
  | { type: 'context_updated'; context: ChatRunContext }
  | { type: 'image_completed'; callId: string; media: GeneratedMedia }
  | { type: 'tool_finished'; callId: string; status: 'done' | 'error' | 'stopped'; error?: string; durationMs?: number; finishedAt?: string }
  | { type: 'message_done'; messageId?: string; status: 'done' | 'stopped' | 'error'; message?: Record<string, unknown>; thread?: ThreadSnapshot }
  | { type: 'error'; message: string };

export type RunEvent = RunEventPayload & { seq?: number; runId?: string; messageId?: string };

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
export interface ThreadSnapshot {
  id: string;
  revision?: number;
  generation?: number;
  canvasId?: string;
  title: string;
  messages: Array<Record<string, unknown>>;
  memory?: PersistedMemory;
  createdAt: string;
  updatedAt: string;
}

export interface StartRunRequest {
  requestId?: string;
  threadRevision?: number;
  generation?: number;
  answers?: Record<string, string[]>;
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
  modelSelection?: { textProfileId?: string; textModel?: string; imageProfileId?: string; imageModel?: string };
  /** 发送时选中的角色快照；未选择时不注入任何角色或 Skill。 */
  agentRole?: PromptRoleSnapshot;
}

interface ChatRun {
  id: string;
  threadId: string;
  canvasId: string;
  assistantMessageId: string;
  status: RunStatus;
  events: RunEvent[];
  eventSeq: number;
  clients: Set<ServerResponse>;
  abort: AbortController;
  createdAt: string;
  request: StartRunRequest;
  generation: number;
  ownedMessageIds: Set<string>;
  readiness: Promise<void>;
  finish?: Promise<void>;
  memoryRevision: number;
  pendingConfirmation?: { value: ImageConfirmation; resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> };
  pendingQuestion?: {
    callId: string;
    questions: AskUserQuestion[];
    resolve: (answers: Record<string, string[]> | null) => void;
  };
}

const runs = new Map<string, ChatRun>();
/** 事件缓冲上限：防失控线程把内存撑爆。 */
const MAX_BUFFERED_EVENTS = 500;
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

function currentRunMessage(run: ChatRun): Record<string, unknown> | undefined {
  return run.request.thread.messages.find((message) => message.id === run.assistantMessageId);
}

function materializeEvent(run: ChatRun, event: RunEvent): void {
  const message = currentRunMessage(run);
  if (!message) return;
  const calls = (message.toolCalls || []) as Array<Record<string, unknown>>;
  switch (event.type) {
    case 'message_delta': message.content = `${String(message.content || '')}${event.text}`; break;
    case 'thinking': message.reasoning = `${String(message.reasoning || '')}${event.text}`; break;
    case 'clarification_requested':
      message.status = 'awaiting_input';
      message.clarifications = [...((message.clarifications || []) as Array<Record<string, unknown>>).filter((item) => item.callId !== event.callId), { callId: event.callId, questions: event.questions, status: 'awaiting_input' }];
      break;
    case 'clarification_answered':
      for (const item of run.request.thread.messages) {
        const questions = item.clarifications as Array<Record<string, unknown>> | undefined;
        if (questions) item.clarifications = questions.map((question) => question.callId === event.callId ? { ...question, status: 'answered', answers: event.answers } : question);
      }
      message.status = 'running';
      break;
    case 'tool_started':
      if (!calls.some((call) => call.id === event.callId)) message.toolCalls = [...calls, { id: event.callId, name: event.name, args: event.args, status: 'running', steps: [], model: event.model, profileName: event.profileName, startedAt: event.startedAt }];
      break;
    case 'tool_progress':
      message.toolCalls = calls.map((call) => call.id === event.callId ? { ...call, steps: [...((call.steps || []) as string[]), event.step] } : call);
      break;
    case 'image_completed': {
      const append = (items: GeneratedMedia[]) => items.some((item) => item.versionId === event.media.versionId) ? items : [...items, event.media];
      message.media = append((message.media || []) as GeneratedMedia[]);
      message.toolCalls = calls.map((call) => call.id === event.callId ? { ...call, media: append((call.media || []) as GeneratedMedia[]), model: event.media.model, size: event.media.size } : call);
      break;
    }
    case 'tool_finished':
      message.toolCalls = calls.map((call) => call.id === event.callId ? { ...call, status: event.status, error: event.error, finishedAt: event.finishedAt, durationMs: event.durationMs } : call);
      break;
    case 'context_updated': message.context = event.context; break;
    case 'memory_updated': run.request.thread.memory = event.memory; break;
    case 'error': message.status = 'error'; message.error = event.message; break;
    case 'message_done': message.status = event.status; break;
  }
}

function emit(run: ChatRun, event: RunEvent): void {
  if (run.status === 'stopped' && event.type !== 'message_done') return;
  materializeEvent(run, event);
  const sequenced: RunEvent = { ...event, runId: run.id, messageId: event.messageId || run.assistantMessageId, seq: ++run.eventSeq };
  run.events.push(sequenced);
  if (run.events.length > MAX_BUFFERED_EVENTS) run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS);
  const data = `event: ${sequenced.type}\nid: ${sequenced.seq}\ndata: ${JSON.stringify(sequenced)}\n\n`;
  for (const client of [...run.clients]) {
    try { client.write(data); } catch { run.clients.delete(client); }
  }
}

export function getChatRunSnapshot(runId: string): RunSnapshot | null {
  const run = runs.get(runId);
  return run ? {
    type: 'snapshot', runId: run.id, messageId: run.assistantMessageId, seq: run.eventSeq,
    status: run.status, thread: structuredClone(run.request.thread), generation: run.generation,
    ...(run.pendingConfirmation ? { pendingConfirmation: { ...run.pendingConfirmation.value } } : {}),
  } : null;
}

function broadcastRunSnapshot(run: ChatRun): void {
  run.eventSeq += 1;
  const snapshot = getChatRunSnapshot(run.id)!;
  for (const client of [...run.clients]) {
    try { client.write(`event: snapshot\nid: ${snapshot.seq}\ndata: ${JSON.stringify(snapshot)}\n\n`); }
    catch { run.clients.delete(client); }
  }
}

function closeRunClients(run: ChatRun): void {
  for (const client of run.clients) client.end();
  run.clients.clear();
  const timer = setTimeout(() => runs.delete(run.id), 30 * 60_000);
  timer.unref();
}

export function startChatRun(request: StartRunRequest): string {
  if (request.requestId) {
    const existing = [...runs.values()].find((run) => run.request.requestId === request.requestId && run.threadId === request.threadId);
    if (existing) return existing.id;
  }
  const active = [...runs.values()].find((run) => run.threadId === request.threadId && (run.status === 'running' || run.status === 'stopping'));
  if (active) throw new Error('该对话已有在途任务，请先停止或等待完成');
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const requestCopy = structuredClone(request);
  const initialAssistant = requestCopy.thread.messages.find((message) => message.id === requestCopy.assistantMessageId);
  const originalUser = [...requestCopy.thread.messages].reverse().find((message) => message.role === 'user');
  if (initialAssistant) Object.assign(initialAssistant, {
    runId, agentRole: requestCopy.agentRole, modelSelection: requestCopy.modelSelection,
    retrySource: { content: String(originalUser?.content || ''), attachments: originalUser?.attachments, agentRole: requestCopy.agentRole, modelSelection: requestCopy.modelSelection, answers: requestCopy.answers },
  });
  const run: ChatRun = {
    id: runId, threadId: requestCopy.threadId, canvasId: requestCopy.canvasId,
    assistantMessageId: requestCopy.assistantMessageId, status: 'running', events: [], eventSeq: 0,
    clients: new Set(), abort: new AbortController(), createdAt: new Date().toISOString(), request: requestCopy,
    generation: Number(requestCopy.generation ?? requestCopy.thread.generation ?? 0),
    ownedMessageIds: new Set([requestCopy.assistantMessageId]), memoryRevision: Number(requestCopy.thread.memory?.memoryRevision || 0),
    readiness: Promise.resolve(),
  };
  runs.set(runId, run);
  run.readiness = (async () => {
    const stored = await writeClientThread(requestCopy.thread, requestCopy.threadRevision ?? requestCopy.thread.revision);
    if (!stored) throw new Error('对话已删除，请新建对话');
    const currentIdentity = requestCopy.thread.messages.find((message) => message.id === run.assistantMessageId);
    requestCopy.thread = {
      ...stored,
      messages: stored.messages.map((message) => message.id === run.assistantMessageId ? { ...message, ...currentIdentity } : message),
    } as unknown as ThreadSnapshot;
    run.generation = Number(stored.generation || 0);
    run.memoryRevision = Number(stored.memory?.memoryRevision || 0);
  })();
  void run.readiness.then(() => executeRun(run, requestCopy)).catch(async (err: unknown) => {
    if (run.status !== 'running') return;
    const message = err instanceof Error ? err.message : 'Agent 运行失败';
    emit(run, { type: 'error', message });
    await finishRun(run, 'error').catch(() => undefined);
  });
  return runId;
}

export async function waitChatRunReady(runId: string): Promise<void> {
  const run = runs.get(runId);
  if (run) await run.readiness;
}

export function subscribeChatRun(runId: string, res: ServerResponse): boolean {
  const run = runs.get(runId);
  if (!run) return false;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const snapshot = getChatRunSnapshot(runId)!;
  res.write(`event: snapshot\nid: ${snapshot.seq}\ndata: ${JSON.stringify(snapshot)}\n\n`);
  if (run.status !== 'running' && run.status !== 'stopping') { res.end(); return true; }
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  run.clients.add(res);
  res.on('close', () => { clearInterval(heartbeat); run.clients.delete(res); });
  return true;
}

async function finishRun(run: ChatRun, status: 'done' | 'stopped' | 'error'): Promise<void> {
  if (run.finish) return run.finish;
  run.status = 'stopping';
  run.finish = (async () => {
    const message = currentRunMessage(run);
    if (message) {
      message.status = status;
      message.toolCalls = ((message.toolCalls || []) as Array<Record<string, unknown>>).map((call) => call.status === 'running' ? { ...call, status: status === 'done' ? 'done' : status, finishedAt: new Date().toISOString() } : call);
      message.clarifications = ((message.clarifications || []) as Array<Record<string, unknown>>).map((question) => question.status === 'awaiting_input' ? { ...question, status: 'cancelled' } : question);
    }
    await run.readiness;
    const stored = await writeRunThread(run.request.thread, { generation: run.generation, messageIds: [...run.ownedMessageIds], memoryRevision: run.memoryRevision });
    if (stored) {
      run.request.thread = stored as unknown as ThreadSnapshot;
      run.memoryRevision = Number(stored.memory?.memoryRevision || run.memoryRevision);
    }
    run.status = status;
    emit(run, { type: 'message_done', status, message: currentRunMessage(run), thread: run.request.thread });
    closeRunClients(run);
  })().catch((error: unknown) => {
    run.status = 'error';
    emit(run, { type: 'error', message: `对话保存失败：${error instanceof Error ? error.message : String(error)}` });
    closeRunClients(run);
    throw error;
  });
  return run.finish;
}

export async function stopChatRun(runId: string): Promise<boolean> {
  const run = runs.get(runId);
  if (!run || (run.status !== 'running' && run.status !== 'stopping')) return false;
  run.status = 'stopping';
  run.abort.abort();
  run.pendingQuestion?.resolve(null); run.pendingQuestion = undefined;
  if (run.pendingConfirmation) {
    clearTimeout(run.pendingConfirmation.timer);
    run.pendingConfirmation.resolve(false); run.pendingConfirmation = undefined;
  }
  await finishRun(run, 'stopped');
  return true;
}

export async function stopThreadRuns(threadId: string): Promise<void> {
  await Promise.all([...runs.values()].filter((run) => run.threadId === threadId && (run.status === 'running' || run.status === 'stopping')).map((run) => stopChatRun(run.id)));
}

export function confirmChatRun(runId: string, callId: string, approved: boolean): boolean {
  const run = runs.get(runId);
  const confirmation = run?.pendingConfirmation;
  if (!run || run.status !== 'running' || !confirmation || confirmation.value.callId !== callId) return false;
  clearTimeout(confirmation.timer);
  run.pendingConfirmation = undefined;
  const allowed = approved && Date.parse(confirmation.value.expiresAt) > Date.now();
  emit(run, { type: 'confirmation_resolved', callId, approved: allowed });
  confirmation.resolve(allowed);
  return true;
}

/** 唤起追问弹窗的答案由当前 run 消费；同一个问题不能重复提交。 */
export async function answerChatRun(
  runId: string,
  callId: string,
  input: {
    answers?: Record<string, unknown>;
    cancel?: boolean;
    userMessage?: Record<string, unknown>;
    assistantMessage?: Record<string, unknown>;
  },
): Promise<boolean> {
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
    const filtered = question.type === 'text' ? values.slice(0, 1).map((value) => value.slice(0, 4000)) : values.filter((value) => (
      value.startsWith('其他：') ? Boolean(value.slice('其他：'.length).trim()) : permitted.has(value)
    ));
    const selected = question.multiple ? [...new Set(filtered)] : filtered.slice(0, 1);
    if (selected.length === 0 && !question.optional) return false;
    answers[question.id] = selected;
  }
  const userMessage = continuationMessage(input.userMessage, 'user');
  const assistantMessage = continuationMessage(input.assistantMessage, 'assistant');
  run.pendingQuestion = undefined;
  if (userMessage && assistantMessage) {
    const previousAssistant = currentRunMessage(run);
    if (previousAssistant) previousAssistant.status = 'done';
    const retrySource = previousAssistant?.retrySource as Record<string, unknown> | undefined;
    Object.assign(userMessage, {
      agentRole: run.request.agentRole, modelSelection: run.request.modelSelection,
      attachments: retrySource?.attachments,
    });
    Object.assign(assistantMessage, {
      runId: run.id, agentRole: run.request.agentRole, modelSelection: run.request.modelSelection,
      retrySource: { ...retrySource, answers: { ...((retrySource?.answers || {}) as object), ...answers } },
    });
    const latest = await readChatThread(run.threadId);
    if (!latest || Number(latest.generation || 0) !== run.generation || run.status !== 'running') { pending.resolve(null); return false; }
    try {
      const stored = await writeClientThread({ ...latest, messages: [userMessage, assistantMessage] }, latest.revision);
      if (!stored || run.status !== 'running') { pending.resolve(null); return false; }
      run.request.thread.revision = stored.revision;
    } catch (error) {
      pending.resolve(null);
      await stopChatRun(run.id);
      throw error;
    }
    const existingIds = new Set(run.request.thread.messages.map((message) => String(message.id || '')));
    if (!existingIds.has(userMessage.id)) run.request.thread.messages.push(userMessage);
    if (!existingIds.has(assistantMessage.id)) run.request.thread.messages.push(assistantMessage);
    run.ownedMessageIds.add(userMessage.id);
    run.ownedMessageIds.add(assistantMessage.id);
    run.assistantMessageId = assistantMessage.id;
    run.request.assistantMessageId = assistantMessage.id;
  }
  run.pendingQuestion = undefined;
  emit(run, { type: 'clarification_answered', callId, answers });
  broadcastRunSnapshot(run);
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

/** 在全画布范围内按版本 id 找版本（续接与 baseVersionId 都靠它）；同时返回所属节点，便于连线与定位。 */
function findVersionOnCanvas(nodes: CanvasNodeLike[], versionId: string): { node: CanvasNodeLike; version: Record<string, unknown> } | undefined {
  const target = String(versionId || '');
  if (!target) return undefined;
  for (const node of nodes) {
    const versions = Array.isArray(node.data?.versions) ? node.data!.versions as Array<Record<string, unknown>> : [];
    const found = versions.find((item) => String(item.id || '') === target);
    if (found) return { node, version: found };
  }
  return undefined;
}

interface CanvasBox { x: number; y: number; width: number; height: number }

const CHAT_RESULT_GAP_X = 120;
const CHAT_RESULT_GAP_Y = 48;
const CHAT_RESULT_FALLBACK_GAP = 420;

/** 与前端 aspect.ts 同口径：优先位图宽高，其次 size，比例 = 宽 / 高。 */
function canvasNodeAspect(data: Record<string, unknown> | undefined): number {
  const width = Number(data?.width || 0);
  const height = Number(data?.height || 0);
  if (width > 0 && height > 0) return width / height;
  const size = /^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i.exec(String(data?.size || ''));
  if (size) {
    const w = Number(size[1]);
    const h = Number(size[2]);
    if (w > 0 && h > 0) return w / h;
  }
  return 1;
}

/** 与前端 nodeWidthForAspect 同档：横幅放宽、竖幅收窄。 */
function cardWidthForAspect(aspect: number): number {
  if (aspect >= 1.55) return 400;
  if (aspect <= 0.7) return 280;
  return 320;
}

/** 估算画布节点盒子；只用于聊天结果的摆放，不写回节点。 */
export function estimateCanvasBox(node: { position?: { x?: number; y?: number }; data?: Record<string, unknown> }): CanvasBox {
  const data = node.data || {};
  const x = Number(node.position?.x || 0);
  const y = Number(node.position?.y || 0);
  if (data.kind === 'text') {
    return {
      x,
      y,
      width: Math.min(600, Math.max(280, Number(data.cardWidth) || 320)),
      height: Math.min(620, Math.max(240, Number(data.nodeHeight) || 240)),
    };
  }
  const aspect = canvasNodeAspect(data);
  const width = cardWidthForAspect(aspect);
  return { x, y, width, height: Math.max(160, Math.round(width / aspect)) };
}

function boxesOverlap(a: CanvasBox, b: CanvasBox, padding: number): boolean {
  return a.x < b.x + b.width + padding
    && a.x + a.width + padding > b.x
    && a.y < b.y + b.height + padding
    && a.y + a.height + padding > b.y;
}

/** 结果连线来源：显式引用优先；继续编辑上一版时补上上一版结果节点。 */
export function chatResultConnectFrom(explicit: string[], usage: 'style' | 'edit', baseNodeId: string): string[] {
  const list = [...new Set(explicit.map((id) => String(id || '').trim()).filter(Boolean))];
  if (list.length === 0 && usage === 'edit' && baseNodeId) list.push(baseNodeId);
  return list;
}

/**
 * 新结果放在参考图（或上一版结果）右侧，按列向下排，避开已有节点；
 * 没有参考锚点时才沿用“最右节点右侧错开”的旧行为。
 */
export function layoutChatResultPositions(options: {
  anchor?: CanvasBox | null;
  count: number;
  size?: string;
  existing?: CanvasBox[];
}): Array<{ x: number; y: number }> {
  const count = Math.max(0, Math.floor(options.count));
  if (count === 0) return [];
  const aspect = canvasNodeAspect({ size: options.size });
  const width = cardWidthForAspect(aspect);
  const height = Math.max(160, Math.round(width / aspect));
  const existing = (options.existing || []).filter((box) => Number.isFinite(box.x) && Number.isFinite(box.y));
  const anchor = options.anchor;
  if (anchor) {
    const positions: Array<{ x: number; y: number }> = [];
    let y = anchor.y;
    for (let index = 0; index < count; index += 1) {
      let candidate: CanvasBox = { x: anchor.x + anchor.width + CHAT_RESULT_GAP_X, y, width, height };
      // 与已有节点重叠时整列下移；迭代上限防止异常数据死循环。
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const blocker = existing
          .filter((box) => boxesOverlap(candidate, box, 24))
          .sort((a, b) => a.y - b.y)[0];
        if (!blocker) break;
        candidate = { ...candidate, y: blocker.y + blocker.height + CHAT_RESULT_GAP_Y };
      }
      positions.push({ x: candidate.x, y: candidate.y });
      y = candidate.y + height + CHAT_RESULT_GAP_Y;
    }
    return positions;
  }
  const rightmost = existing.reduce<CanvasBox | null>((best, box) => (!best || box.x > best.x ? box : best), null);
  const startX = rightmost ? rightmost.x + CHAT_RESULT_FALLBACK_GAP : 80;
  const startY = rightmost ? rightmost.y : 80;
  return Array.from({ length: count }, (_, index) => ({ x: startX + index * 40, y: startY + index * 40 }));
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
  originalPrompt?: string;
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
  if (run.status !== 'running' || run.abort.signal.aborted) throw new Error('生成已停止');
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
  // 用户显式引用的同画布节点，生成后每张结果都从它拉一条边；跨画布引用无法连线。
  const explicitConnectFrom = [...new Set(picked
    .filter((ref) => !ref.canvasId || ref.canvasId === runContext.canvasId)
    .map((ref) => String(ref.nodeId || '').trim())
    .filter(Boolean))];
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
  // 上一版结果所在节点：未显式引用时作为连线与摆放的参考锚点。
  let baseNodeId = '';
  if (chainId) {
    const doc = await readCanvasDoc(baseCanvasId).catch(() => null);
    const nodes = (Array.isArray(doc?.nodes) ? doc!.nodes : []) as CanvasNodeLike[];
    const found = findVersionOnCanvas(nodes, chainId);
    baseVersion = found?.version;
    if (found && baseCanvasId === runContext.canvasId) baseNodeId = String(found.node.id || '');
  }
  // 显式引用优先；没有显式引用、且本轮是继续编辑上一版时，把上一版结果节点也连上。
  const connectFrom = chatResultConnectFrom(explicitConnectFrom, usage, baseNodeId);
  // 摆放锚点：显式引用的第一张图 > 上一版结果节点。
  const anchorNodeId = explicitConnectFrom[0] || (usage === 'edit' ? baseNodeId : '');
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

  const count = Math.min(4, Math.max(1, Math.floor(Number(args.count) || 1)));
  const size = sizeForRatio(args.ratio);
  const apiMode = settings.direct === false && profile.imageApiMode === 'responses' ? 'responses' : 'images';
  const originalPrompt = String(args.originalPrompt || '').trim() || String((currentRunMessage(run)?.retrySource as Record<string, unknown> | undefined)?.content || prompt);
  const usedPrompt = prompt;
  const enhancedPrompt = prompt;
  const enhancementWarning: string | undefined = undefined;
  emit(run, { type: 'tool_progress', callId, step: 'Agent 已按统一规则整理提示词' });
  if (run.status !== 'running' || run.abort.signal.aborted) throw new Error('生成已停止');
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

  if (run.status !== 'running' || run.abort.signal.aborted) throw new Error('生成已停止');
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
  const now = new Date().toISOString();
  const resolvedSize = size || String(profile.defaultSize || '');
  const anchorNode = anchorNodeId ? nodes.find((node) => String(node.id || '') === anchorNodeId) : undefined;
  // 最新结果放在参考图（或上一版结果）右侧，按列向下排并避开已有节点。
  const positions = layoutChatResultPositions({
    anchor: anchorNode ? estimateCanvasBox(anchorNode) : null,
    count: images.length,
    size: resolvedSize,
    existing: nodes.map((node) => estimateCanvasBox(node)),
  });
  const media: GeneratedMedia[] = [];
  const nodeRecords: CanvasNodeRecord[] = [];

  images.forEach((image, index) => {
    const nodeId = `chat_${run.id}_${callId}_${index}`;
    const versionId = `ver_${nodeId}`;
    nodeRecords.push({
      id: nodeId,
      type: 'flow-image',
      position: positions[index] || { x: 80 + index * 40, y: 80 + index * 40 },
      data: {
        kind: 'image',
        label: 'AI 对话',
        cardWidth: 320,
        prompt,
        status: 'done',
        imageUrl: image.url,
        fileName: image.fileName,
        size: resolvedSize,
        model: runContext.imageModel || profile.model,
        source: 'chat',
        createdAt: now,
        finishedAt: now,
        enhancedPrompt,
        originalPrompt,
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
          model: runContext.imageModel || profile.model,
          size: resolvedSize,
          createdAt: now,
          finishedAt: now,
          enhancedPrompt,
          originalPrompt,
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
      originalPrompt,
      enhancedPrompt,
      prompt: usedPrompt,
      referenceUsage: usage,
      enhancementWarning: enhancementWarning || undefined,
      model: runContext.imageModel || profile.model,
      size: resolvedSize,
    });
  });

  if (run.status !== 'running' || run.abort.signal.aborted) throw new Error('生成已停止');
  const existingThread = await readChatThread(run.threadId);
  if (!existingThread || Number(existingThread.generation || 0) !== run.generation || run.status !== 'running') throw new Error('对话已清空或删除');
  if (!await appendCanvasImageNodes(runContext.canvasId, nodeRecords, { connectFrom })) throw new Error('结果画布已删除，未写入生成节点');
  if (run.status !== 'running' || run.abort.signal.aborted) return { media: [], context: runContextState };
  for (const item of media) {
    await pushImage({
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

/** 当前迭代回喂最近一次生图的候选图（最多 4 张），让模型能比较同批结果。 */
const MAX_RECENT_MEDIA = 4;

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
  const mediaGroups: Array<Array<Record<string, unknown>>> = [];
  for (const message of messages) {
    if (Array.isArray(message.media) && message.media.length > 0) {
      mediaGroups.push(message.media as Array<Record<string, unknown>>);
    }
    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls as Array<Record<string, unknown>>) {
        const callMedia = Array.isArray(call.media) ? call.media as Array<Record<string, unknown>> : [];
        if (callMedia.length > 0) mediaGroups.push(callMedia);
      }
    }
  }
  const seenMedia = new Set<string>();
  const recentUrls = (mediaGroups.at(-1) || []).filter((item) => {
    const key = String(item.versionId || item.nodeId || item.url || '');
    if (!key || seenMedia.has(key)) return false;
    seenMedia.add(key);
    return true;
  }).slice(-MAX_RECENT_MEDIA).map((item) => String(item.url || '')).filter(Boolean);

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
      let candidateNote = '';
      if (index === lastUserIndex && images.length === 0 && options.inheritMode !== 'new') {
        const candidate = [...recentUrls, ...(options.baseImageUrl && !recentUrls.includes(options.baseImageUrl) ? [options.baseImageUrl] : [])];
        images = [...images, ...candidate.filter((url) => url.startsWith('data:') || url.startsWith('/api/files/'))];
        const latestMedia = mediaGroups.at(-1) || [];
        candidateNote = images.map((url, visualIndex) => {
          const media = latestMedia.find((item) => item.url === url);
          return `视觉附件 ${visualIndex + 1}：候选 ${visualIndex + 1}，节点 ${String(media?.nodeId || '')}，版本 ${String(media?.versionId || '')}`;
        }).join('\n');
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
      history.push({ role: 'user', content: candidateNote ? `${content}\n${candidateNote}` : content, images: images.length > 0 ? images : undefined });
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
    '7. 你直接按统一视觉规则把完整对话提炼为 generate_image.prompt 的最终生图提示词，保留精确文字、硬约束、必须保留和明确排除。originalPrompt 保存原始需求；不再另调用优化模型。',
    '8. 生成后只基于本次真实视觉附件点评结果。附件读取失败或模型不支持视觉时要明确说明，不得仅看文件名和提示词假装看到了像素。',
    '9. 对话记忆只用于延续当前任务；用户开启新对话时没有任何旧消息、旧摘要或旧图片上下文。',
    '',
    '回复要求：中文，简洁，可用基础 Markdown（段落 / 列表）。提示词优先用正面描述，用户明确的否定约束不能删除或反转。',
    '篇幅要求：默认先给结论，正文控制在 300–400 字、最多 3 个要点，不主动罗列用户没问的扩展项；确实需要展开（完整评审、方案对比）时先问一句「要我展开吗」，或按用户要求展开。当前角色若明确要求详细输出，以角色要求为准。',
  ].join('\n');
}

/* ── 运行主循环 ── */

async function persistRunState(run: ChatRun): Promise<void> {
  const stored = await writeRunThread(run.request.thread, {
    generation: run.generation, messageIds: [...run.ownedMessageIds], memoryRevision: run.memoryRevision,
  });
  if (!stored) throw new Error('对话已清空或删除');
  run.request.thread.revision = stored.revision;
  run.memoryRevision = Number(stored.memory?.memoryRevision || run.memoryRevision);
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
  if (!textProfile) throw new Error('尚未配置语言模型：请在模型设置中添加语言模型');
  // 对话模型按线程选具体模型；配置的默认模型只作兜底。
  const agentTextProfile: ModelProfile = {
    ...textProfile,
    model: resolveTextModel(textProfile, request.modelSelection?.textModel),
  };

  const runtime = normalizeChatRuntimeSettings(settings.chatRuntime || { maxModelRounds: 4, maxToolCalls: 2, maxImagesPerRun: 4, confirmImagesAbove: 1, maxOutputTokens: 4096 });
  let memory = buildMemoryContext(request.thread.messages as unknown as MemoryMessage[], request.thread.memory || {}, settings.chatMemory);
  let compactionStatus: 'idle' | 'complete' | 'failed' = 'idle';
  let compactionWarning = '';
  if (memory.enabled && memory.shouldCompact) {
    try {
      const output = await callTextModel(agentTextProfile, {
        systemSpec: '你负责压缩创作对话记忆。只输出JSON {"summary":string,"goal":{"statement":string,"confirmed":string[],"preserve":string[],"change":string[],"rejected":string[],"openQuestions":string[]}}。保留用户精确文字、否定约束、已经做出决定的原因和未解决问题，最新明确要求优先，禁止把“不要改背景”当作删除背景。不要执行任何工具，不要回答创作需求。',
        userText: JSON.stringify({ previousSummary: memory.summary, goal: memory.goal, messages: memory.compactableMessages }),
        imageUrls: [], maxTokens: 1500, temperature: 0.2,
        signal: AbortSignal.any([run.abort.signal, AbortSignal.timeout(20_000)]),
      });
      if (run.status !== 'running') return;
      const parsed = JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { summary: string; goal?: Record<string, unknown> };
      if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('记忆摘要未返回有效内容');
      memory = applyMemoryCompaction(memory, { summary: parsed.summary, goal: parsed.goal }, new Date().toISOString());
      compactionStatus = 'complete';
    } catch (error) {
      if (run.status !== 'running' || run.abort.signal.aborted) return;
      compactionStatus = 'failed';
      compactionWarning = `记忆压缩失败，仍保留未压缩原文：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (memory.requiresPause) throw new Error(memory.warning || '上下文超过安全预算，请缩减输入或新建对话');
  const messages: AgentMessage[] = buildAgentHistory(
    memory.contextMessages as unknown as Array<Record<string, unknown>>,
    { inheritMode: memory.visualWorkingSet.inheritMode, baseImageUrl: memory.visualWorkingSet.base?.url },
  );
  if (request.answers && Object.keys(request.answers).length) messages.push({ role: 'user', content: `已确认的补充信息：${JSON.stringify(request.answers)}` });
  await hydrateAgentHistoryImages(messages);
  const currentUserMessage = [...messages].reverse().find((message) => message.role === 'user' && message.images?.length);
  const userVisualContextImages = currentUserMessage?.images || [];
  let visualContext = userVisualContextImages.map((url, index) => {
    const output = memory.visualWorkingSet.recentOutputs.find((item) => item.url === (memory.visualWorkingSet.references[index]?.url));
    return { id: output?.versionId || `reference-${index + 1}`, label: `视觉图 ${index + 1}${output?.versionId ? `，版本 ${output.versionId}` : ''}`, url };
  });
  const generatedVisuals: Array<{ id: string; label: string; url: string }> = [];
  if (memory.enabled) {
    request.thread.memory = {
      ...(request.thread.memory || {}), version: 1,
      summary: memory.summary,
      summaryMessageCount: compactionStatus === 'complete' ? memory.summaryMessageCount : request.thread.memory?.summaryMessageCount,
      summaryThroughMessageId: compactionStatus === 'complete' ? memory.summaryThroughMessageId : request.thread.memory?.summaryThroughMessageId,
      summaryUpdatedAt: memory.lastCompactionAt || request.thread.memory?.summaryUpdatedAt,
      goal: memory.goal, visualWorkingSet: memory.visualWorkingSet,
      lastCompactionAt: memory.lastCompactionAt || request.thread.memory?.lastCompactionAt,
      memoryRevision: run.memoryRevision,
      ...({ windowMessageCount: memory.contextMessages.length, windowEstimatedTokens: memory.estimatedContextTokens, compactionStatus, warning: compactionWarning || memory.warning } as object),
    };
    emit(run, { type: 'memory_updated', memory: request.thread.memory });
  }
  const toolCallRecords: Array<Record<string, unknown>> = [];
  const media: GeneratedMedia[] = [];
  let finalText = '';
  let toolCallCount = 0;
  let imageCount = 0;
  let clarificationCount = 0;
  const clarifications: Array<{ callId: string; questions: AskUserQuestion[]; answers?: Record<string, string[]>; status: 'awaiting_input' | 'answered' | 'cancelled' }> = [];
  let chainVersionId = memory.visualWorkingSet.inheritMode === 'new' ? '' : String(request.previousVersionId || '');
  let messageContext: ChatRunContext | undefined;
  // 生图失败就结束本轮：不再把错误喂回模型让它自动重试，用户要看错误自己点重试
  let failureMessage = '';

  try {
    for (let round = 0; round < runtime.maxModelRounds; round += 1) {
      if (run.status !== 'running') return;
      const finalRound = round === runtime.maxModelRounds - 1;
      const turn = await callAgentModel(agentTextProfile, {
        systemSpec: `${buildAgentSystemSpec()}\n\n${buildVisualPromptRules(imageProfile?.defaultSize || '', settings.enhanceLevel)}\n\n${memoryPromptBlock(memory)}${rolePrompt}${finalRound ? '\n这是最后一个回合。不要调用工具，简洁总结结果与未完成事项。' : ''}`,
        messages,
        visualContext,
        maxTokens: runtime.maxOutputTokens,
        tools: finalRound ? [] : [generateImageToolDef(), askUserToolDef()],
        temperature: request.agentRole?.temperature,
        onTextDelta: (chunk) => { if (run.status === 'running') emit(run, { type: 'message_delta', text: chunk }); },
        onReasoningDelta: (chunk) => { if (run.status === 'running') emit(run, { type: 'thinking', text: chunk }); },
        signal: run.abort.signal,
      });
      if (run.status !== 'running') return;
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
          await persistRunState(run);
          const answers = await answersPromise;
          run.pendingQuestion = undefined;
          if (run.status !== 'running') return;
          if (!answers) {
            clarification.status = 'cancelled';
            await stopChatRun(run.id);
            return;
          }
          clarification.status = 'answered';
          clarification.answers = answers;
          if (assistantMessage && request.assistantMessageId === String(assistantMessage.id || '')) {
            assistantMessage.status = 'running';
            assistantMessage.clarifications = clarifications;
          }
          finalText = '';
          toolCallRecords.length = 0;
          media.length = 0;
          messages.push({ role: 'assistant', content: '', toolCalls: [call] });
          messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify({ answers }, null, 2) });
          break;
        }
        if (call.name !== 'generate_image') {
          emit(run, { type: 'tool_finished', callId: call.id, status: 'error', error: `未知工具：${call.name}` });
          messages.push({ role: 'tool', toolCallId: call.id, content: `错误：未知工具 ${call.name}` });
          continue;
        }
        if (toolCallCount >= runtime.maxToolCalls) {
          messages.push({ role: 'assistant', content: '', toolCalls: [call] });
          messages.push({ role: 'tool', toolCallId: call.id, content: '单轮生图次数已达预算上限，请总结当前结果。' });
          continue;
        }
        const requestedCount = Math.min(4, Math.max(1, Math.floor(Number(call.args.count) || 1)));
        if (imageCount + requestedCount > runtime.maxImagesPerRun) {
          messages.push({ role: 'assistant', content: '', toolCalls: [call] });
          messages.push({ role: 'tool', toolCallId: call.id, content: `本轮最多允许 ${runtime.maxImagesPerRun} 张图，剩余 ${runtime.maxImagesPerRun - imageCount} 张；本次未生成。` });
          continue;
        }
        if (imageCount + requestedCount > runtime.confirmImagesAbove) {
          const approved = await new Promise<boolean>((resolve) => {
            const value: ImageConfirmation = {
              callId: call.id, prompt: String(call.args.prompt || '').slice(0, 300), model: imageModel || '',
              size: sizeForRatio(String(call.args.ratio || '')) || imageProfile?.defaultSize || '',
              count: requestedCount, totalCount: imageCount + requestedCount, cost: 'unknown',
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            };
            const timer = setTimeout(() => {
              if (run.pendingConfirmation?.value.callId !== call.id) return;
              run.pendingConfirmation = undefined; resolve(false);
            }, 10 * 60_000);
            timer.unref();
            run.pendingConfirmation = { value, resolve, timer };
            emit(run, { type: 'confirmation_requested', confirmation: value });
          });
          if (run.status !== 'running') return;
          if (!approved) { await stopChatRun(run.id); return; }
        }
        call.args.count = requestedCount;
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
            textProfile: agentTextProfile,
            imageProfile: imageProfile as ModelProfile | undefined,
            imageModel,
          }));
          if (run.status !== 'running') return;
          const generated = generatedResult.media;
          imageCount += generated.length;
          record.status = 'done';
          record.media = generated as unknown as Record<string, unknown>[];
          record.finishedAt = new Date().toISOString();
          record.durationMs = Math.max(0, Date.parse(String(record.finishedAt)) - Date.parse(startedAt));
          record.size = generated[0]?.size;
          if (generated[0]?.enhancementWarning) {
            record.steps = [...(Array.isArray(record.steps) ? record.steps : []), generated[0].enhancementWarning];
          }
          media.push(...generated);
          // 同一轮继续点评 / 再改时，把刚生成的候选图带回视觉上下文，模型才能真正看到结果。
          const generatedUrls = await Promise.all(generated.map(async (item) => {
            const url = String(item.url || '');
            if (url.startsWith('data:')) return url;
            if (url.startsWith('/api/files/')) {
              return mediaFileToDataUrl(url.slice('/api/files/'.length)).catch(() => '');
            }
            return '';
          }));
          for (const [index, url] of generatedUrls.entries()) {
            const item = generated[index];
            if (url) generatedVisuals.push({ id: item.versionId, label: `批次 ${call.id} 候选 ${index + 1}，节点 ${item.nodeId}，版本 ${item.versionId}`, url });
          }
          const selectedVisuals = generatedVisuals.slice(-MAX_RECENT_MEDIA);
          visualContext = [
            ...userVisualContextImages.map((url, index) => ({ id: `user-reference-${index + 1}`, label: `用户引用图 ${index + 1}`, url })),
            ...selectedVisuals,
          ];
          messageContext = generatedResult.context;
          if (generated[0]) chainVersionId = generated[0].versionId;
          emit(run, { type: 'tool_finished', callId: call.id, status: 'done', durationMs: record.durationMs as number, finishedAt: record.finishedAt as string });
          messages.push({ role: 'assistant', content: '', toolCalls: [call] });
          const candidateLines = generated.map((item, index) => (
            `候选 ${index + 1}：${item.fileName || item.url}（节点 ${item.nodeId}，版本 ${item.versionId}，模型 ${item.model}，尺寸 ${item.size}）`
          ));
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: `已生成 ${generated.length} 张候选图，批次 ${call.id}。只有提供的视觉附件实际可见时才能点评；缺失图片不得猜测。\n${candidateLines.join('\n')}\n最终提示词：${String(call.args.prompt || '')}`,
          });
        } catch (err) {
          if (run.status !== 'running') return;
          const message = err instanceof Error ? err.message : '生图失败';
          const stopped = run.abort.signal.aborted && message === 'This operation was aborted';
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

    if (run.status !== 'running') return;
    if (failureMessage) {
      finalizeMessage(request, toolCallRecords, media, finalText, 'error', messageContext, failureMessage, clarifications);
      emit(run, { type: 'error', message: failureMessage });
      await finishRun(run, 'error');
      return;
    }
    finalizeMessage(request, toolCallRecords, media, finalText, 'done', messageContext, undefined, clarifications);
    await finishRun(run, 'done');
  } catch (err) {
    if (run.status !== 'running') return;
    const message = err instanceof Error ? err.message : 'Agent 运行失败';
    finalizeMessage(request, toolCallRecords, media, finalText, 'error', messageContext, message, clarifications);
    emit(run, { type: 'error', message });
    await finishRun(run, 'error');
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
      await writeRunThread({ ...thread, messages, updatedAt: new Date().toISOString() }, {
        generation: Number(thread.generation || 0),
        messageIds: messages.filter((message) => message.status === 'unknown').map((message) => String(message.id || '')),
      });
    }
  }
}
