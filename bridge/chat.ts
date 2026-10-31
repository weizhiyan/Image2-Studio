import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CHAT_DOCS_FILE } from './paths.js';
import { stripChatMediaReferences, type HistoryDeleteTarget } from './history.js';
import { normalizePromptRoleSnapshot } from './skills.js';

/**
 * 对话线程的第二份拷贝：浏览器 localStorage 是工作副本，这里是整文档落盘
 * （~/.huiban/chat-docs.json），换浏览器 / 换机器打开链接时对话历史要能续上。
 *
 * 存储形态：Record<threadId, ChatThreadRecord> + 保留键 __tombstones。
 * 线程是全局独立实体，canvasId 仅为可选落点。
 * 旧版（v1）是按 canvasId 为键的「一画布一条线程」，readChatThreads 读取时整批迁移成
 * 默认线程（id = thread_<canvasId>），保留原 canvasId 作为历史结果落点，历史消息不丢。
 *
 * 写路径：进程内串行化 + 滚动备份 + 同目录临时文件原子替换。
 * 正式 client/run 写使用 revision/generation 和消息所有权；时间戳仅兼容 legacy put。
 */

/** 单条消息里的图片引用 / 生成结果：只存可持久化的引用，禁存大 dataURL（体积炸 localStorage）。 */
const MAX_INLINE_DATA_URL = 64 * 1024;
/** 单线程消息数上限：防失控增长把 JSON 撑爆。 */
const MAX_MESSAGES_PER_THREAD = 500;
/** 单消息工具调用数 / 步骤数上限。 */
const MAX_TOOL_CALLS = 8;
const MAX_TOOL_STEPS = 20;
/** 单消息引用图数上限。 */
const MAX_REFERENCES = 12;
const MAX_MEMORY_LIST = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function revisionOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedText(value: unknown, limit = 160): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function sanitizeModelSelection(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Record<string, string> = {};
  for (const key of ['textProfileId', 'textModel', 'imageProfileId', 'imageModel']) {
    const text = boundedText(raw[key]);
    if (text) result[key] = text;
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizeAnswers(raw: unknown): Record<string, string[]> | undefined {
  if (!isRecord(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw).slice(0, 8).flatMap(([key, value]) => {
    const id = boundedText(key);
    if (!id || !Array.isArray(value)) return [];
    return [[id, value.map((answer) => boundedText(answer, 2_000)).filter(Boolean).slice(0, 12)]];
  }));
}

function sanitizeRetrySource(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const source: Record<string, unknown> = { content: typeof raw.content === 'string' ? raw.content.slice(0, 100_000) : '' };
  if (Array.isArray(raw.attachments)) source.attachments = raw.attachments.map(sanitizeRef).filter(Boolean).slice(0, MAX_REFERENCES);
  const modelSelection = sanitizeModelSelection(raw.modelSelection);
  const agentRole = normalizePromptRoleSnapshot(raw.agentRole);
  const answers = sanitizeAnswers(raw.answers);
  if (modelSelection) source.modelSelection = modelSelection;
  if (agentRole) source.agentRole = agentRole;
  if (answers) source.answers = answers;
  return source;
}

function sanitizeUrl(url: unknown): string {
  const value = String(url || '').trim();
  if (!value) return '';
  // dataURL 只留小的（上传参考图的小图）；大的媒体文件一律走 /api/files/ 引用
  if (value.startsWith('data:') && value.length > MAX_INLINE_DATA_URL) return '';
  return value;
}

function sanitizeCanvasId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id !== '[object Object]' ? id : '';
}

function sanitizeRef(raw: unknown): { canvasId: string; nodeId: string; versionId?: string; url?: string; title?: string; position?: number } | null {
  const item = raw as Record<string, unknown> | null;
  if (!item || typeof item !== 'object') return null;
  const nodeId = String(item.nodeId || '').trim();
  if (!nodeId) return null;
  const ref: { canvasId: string; nodeId: string; versionId?: string; url?: string; title?: string; position?: number } = {
    canvasId: sanitizeCanvasId(item.canvasId),
    nodeId,
  };
  const versionId = String(item.versionId || '').trim();
  if (versionId) ref.versionId = versionId;
  const url = sanitizeUrl(item.url);
  if (url) ref.url = url;
  const title = String(item.title || '').trim();
  if (title) ref.title = title;
  if (Number.isInteger(item.position) && Number(item.position) >= 0) ref.position = Number(item.position);
  return ref;
}

function sanitizeMedia(raw: unknown): Record<string, unknown> | null {
  const item = raw as Record<string, unknown> | null;
  if (!item || typeof item !== 'object') return null;
  const url = sanitizeUrl(item.url);
  const nodeId = String(item.nodeId || '').trim();
  if (!url || !nodeId) return null;
  const media: Record<string, unknown> = { url, nodeId };
  const canvasId = sanitizeCanvasId(item.canvasId);
  if (canvasId) media.canvasId = canvasId;
  const fileName = String(item.fileName || '').trim();
  if (fileName) media.fileName = fileName;
  const versionId = String(item.versionId || '').trim();
  if (versionId) media.versionId = versionId;
  const prompt = String(item.prompt || '');
  if (prompt) media.prompt = prompt;
  const originalPrompt = String(item.originalPrompt || '');
  if (originalPrompt) media.originalPrompt = originalPrompt;
  const enhancedPrompt = String(item.enhancedPrompt || '');
  if (enhancedPrompt) media.enhancedPrompt = enhancedPrompt;
  const referenceUsage = item.referenceUsage === 'edit' || item.referenceUsage === 'style' ? item.referenceUsage : '';
  if (referenceUsage) media.referenceUsage = referenceUsage;
  const enhancementWarning = String(item.enhancementWarning || '').trim();
  if (enhancementWarning) media.enhancementWarning = enhancementWarning;
  const model = String(item.model || '');
  if (model) media.model = model;
  const size = String(item.size || '');
  if (size) media.size = size;
  return media;
}

function sanitizeToolCall(raw: unknown): Record<string, unknown> | null {
  const item = raw as Record<string, unknown> | null;
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').trim();
  if (!id) return null;
  const status = item.status === 'running' || item.status === 'error' || item.status === 'stopped' ? item.status : 'done';
  const call: Record<string, unknown> = {
    id,
    name: String(item.name || 'generate_image'),
    args: (item.args && typeof item.args === 'object' ? item.args : {}) as Record<string, unknown>,
    status,
    steps: (Array.isArray(item.steps) ? item.steps : []).map((step) => String(step || '')).filter(Boolean).slice(0, MAX_TOOL_STEPS),
  };
  if (Array.isArray(item.media)) {
    const media = item.media.map(sanitizeMedia).filter((entry): entry is Record<string, unknown> => entry !== null);
    if (media.length > 0) call.media = media;
  }
  const error = String(item.error || '').trim();
  if (error) call.error = error;
  return call;
}

function sanitizeMemory(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const item = raw;
  const memory: Record<string, unknown> = {
    version: Number(item.version) || 1,
    memoryRevision: revisionOf(item.memoryRevision),
  };
  for (const key of ['summaryThroughMessageId', 'clearedThroughMessageId']) {
    const text = boundedText(item[key]);
    if (text) memory[key] = text;
  }
  for (const key of ['windowMessageCount', 'windowEstimatedTokens']) {
    if (typeof item[key] === 'number' && Number.isFinite(item[key]) && Number(item[key]) >= 0) {
      memory[key] = Math.min(1_000_000, Math.floor(Number(item[key])));
    }
  }
  if (['idle', 'pending', 'complete', 'failed'].includes(String(item.compactionStatus))) memory.compactionStatus = item.compactionStatus;
  const warning = boundedText(item.warning, 2_000);
  if (warning) memory.warning = warning;
  const summary = String(item.summary || '').trim();
  if (summary) memory.summary = summary.slice(0, 12_000);
  const summaryMessageCount = Number(item.summaryMessageCount);
  if (Number.isFinite(summaryMessageCount) && summaryMessageCount > 0) memory.summaryMessageCount = Math.floor(summaryMessageCount);
  const summaryUpdatedAt = String(item.summaryUpdatedAt || '').trim();
  if (summaryUpdatedAt) memory.summaryUpdatedAt = summaryUpdatedAt;
  const lastCompactionAt = String(item.lastCompactionAt || '').trim();
  if (lastCompactionAt) memory.lastCompactionAt = lastCompactionAt;

  const goal = item.goal as Record<string, unknown> | undefined;
  if (goal && typeof goal === 'object') {
    const cleanList = (value: unknown) => Array.isArray(value)
      ? value.map((entry) => boundedText(entry, 2_000)).filter(Boolean).slice(-MAX_MEMORY_LIST)
      : [];
    memory.goal = {
      mode: String(goal.mode || '').trim() || undefined,
      statement: String(goal.statement || '').trim().slice(0, 1_000) || undefined,
      deliverable: String(goal.deliverable || '').trim().slice(0, 300) || undefined,
      confirmed: cleanList(goal.confirmed),
      preserve: cleanList(goal.preserve),
      change: cleanList(goal.change),
      rejected: cleanList(goal.rejected),
      openQuestions: cleanList(goal.openQuestions),
      updatedAt: String(goal.updatedAt || '').trim() || undefined,
    };
  }
  const workingSet = item.visualWorkingSet as Record<string, unknown> | undefined;
  if (workingSet && typeof workingSet === 'object') {
    const cleanRef = (value: unknown): Record<string, unknown> | null => {
      if (!isRecord(value)) return null;
      const ref = value;
      const result: Record<string, unknown> = {};
      for (const key of ['canvasId', 'nodeId', 'versionId', 'title', 'source']) {
        const text = boundedText(ref[key], key === 'title' ? 1_000 : 160);
        if (text) result[key] = text;
      }
      const url = sanitizeUrl(ref.url);
      if (url) result.url = url;
      return Object.keys(result).length > 0 ? result : null;
    };
    memory.visualWorkingSet = {
      base: cleanRef(workingSet.base) || undefined,
      sourceAnchor: cleanRef(workingSet.sourceAnchor) || undefined,
      references: Array.isArray(workingSet.references) ? workingSet.references.map(cleanRef).filter((entry): entry is Record<string, unknown> => Boolean(entry)).slice(-MAX_MEMORY_LIST) : [],
      recentOutputs: Array.isArray(workingSet.recentOutputs) ? workingSet.recentOutputs.map(cleanRef).filter((entry): entry is Record<string, unknown> => Boolean(entry)).slice(-MAX_MEMORY_LIST) : [],
      inheritMode: workingSet.inheritMode === 'new' || workingSet.inheritMode === 'edit' ? workingSet.inheritMode : 'auto',
      explicitNewRequest: Boolean(workingSet.explicitNewRequest),
    };
  }
  return memory;
}

const MESSAGE_STATUSES = new Set(['running', 'awaiting_input', 'done', 'error', 'stopped', 'unknown']);

function sanitizeMessage(raw: unknown): Record<string, unknown> | null {
  const item = raw as Record<string, unknown> | null;
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').trim();
  if (!id) return null;
  const message: Record<string, unknown> = {
    id,
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item.content || ''),
    createdAt: String(item.createdAt || new Date().toISOString()),
  };
  if (Array.isArray(item.attachments)) {
    const attachments = item.attachments.map(sanitizeRef).filter((entry): entry is NonNullable<ReturnType<typeof sanitizeRef>> => entry !== null).slice(0, MAX_REFERENCES);
    if (attachments.length > 0) message.attachments = attachments;
  }
  if (Array.isArray(item.media)) {
    const media = item.media.map(sanitizeMedia).filter((entry): entry is Record<string, unknown> => entry !== null);
    if (media.length > 0) message.media = media;
  }
  if (Array.isArray(item.toolCalls)) {
    const toolCalls = item.toolCalls.map(sanitizeToolCall).filter((entry): entry is Record<string, unknown> => entry !== null).slice(0, MAX_TOOL_CALLS);
    if (toolCalls.length > 0) message.toolCalls = toolCalls;
  }
  if (Array.isArray(item.clarifications)) {
    const clarifications = item.clarifications.slice(0, 4).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const value = raw as Record<string, unknown>;
      const questions = Array.isArray(value.questions) ? value.questions.slice(0, 4) : [];
      if (questions.length === 0) return [];
      return [{
        callId: String(value.callId || '').slice(0, 100),
        questions,
        ...(value.answers && typeof value.answers === 'object' ? { answers: value.answers } : {}),
        status: value.status === 'answered' || value.status === 'cancelled' ? value.status : 'awaiting_input',
      }];
    });
    if (clarifications.length > 0) message.clarifications = clarifications;
  }
  const askResponse = item.askResponse as Record<string, unknown> | undefined;
  if (askResponse && typeof askResponse === 'object' && Array.isArray(askResponse.questions)) {
    const questions = askResponse.questions.slice(0, 4).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const value = raw as Record<string, unknown>;
      const id = String(value.id || '').trim();
      const title = String(value.title || '').trim();
      const answers = Array.isArray(value.answers)
        ? value.answers.map((answer) => String(answer || '').trim()).filter(Boolean).slice(0, 8)
        : [];
      return id && title ? [{ id, title, answers }] : [];
    });
    const title = String(askResponse.title || '已回答询问').trim();
    if (title && questions.length > 0) message.askResponse = { title, questions };
  }
  const modelSelection = sanitizeModelSelection(item.modelSelection);
  const agentRole = normalizePromptRoleSnapshot(item.agentRole);
  const retrySource = sanitizeRetrySource(item.retrySource);
  if (modelSelection) message.modelSelection = modelSelection;
  if (agentRole) message.agentRole = agentRole;
  if (retrySource) message.retrySource = retrySource;
  for (const key of ['runId', 'requestId', 'retryOfMessageId', 'retryOfRunId', 'userMessageId']) {
    const text = boundedText(item[key]);
    if (text) message[key] = text;
  }
  const memory = sanitizeMemory(item.memory);
  if (memory) message.memory = memory;
  const context = item.context as Record<string, unknown> | undefined;
  if (context && typeof context === 'object') {
    message.context = {
      baseVersionId: String(context.baseVersionId || '') || undefined,
      responseId: String(context.responseId || '') || undefined,
      referenceCount: Number(context.referenceCount) || 0,
      resetReason: String(context.resetReason || '') || undefined,
    };
  }
  const status = String(item.status || '');
  if (MESSAGE_STATUSES.has(status)) message.status = status;
  const error = String(item.error || '').trim();
  if (error) message.error = error;
  const reasoning = typeof item.reasoning === 'string' ? item.reasoning.slice(0, 64 * 1024) : '';
  if (reasoning.trim()) message.reasoning = reasoning;
  return message;
}

export interface ChatThreadRecord {
  id: string;
  /** Server-owned CAS version; absent legacy records normalize to zero. */
  revision: number;
  /** Clear barrier, captured by each run before it may write. */
  generation: number;
  canvasId?: string;
  textProfileId?: string;
  textModel?: string;
  imageProfileId?: string;
  imageModel?: string;
  title: string;
  messages: Array<Record<string, unknown>>;
  memory?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** 收线程入库前过一遍：剥大 dataURL、截断超长消息数、补默认时间戳。 */
export function normalizeChatThread(raw: unknown, fallbackCanvasId?: string): ChatThreadRecord | null {
  const doc = raw as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') return null;
  const messages = (Array.isArray(doc.messages) ? doc.messages : [])
    .map(sanitizeMessage)
    .filter((message): message is Record<string, unknown> => message !== null)
    .slice(-MAX_MESSAGES_PER_THREAD);
  const rawCanvasId = typeof doc.canvasId === 'string'
    ? doc.canvasId.trim()
    : (typeof fallbackCanvasId === 'string' ? fallbackCanvasId.trim() : '');
  const canvasId = sanitizeCanvasId(rawCanvasId);
  const textProfileId = typeof doc.textProfileId === 'string' ? doc.textProfileId.trim().slice(0, 160) : '';
  const textModel = typeof doc.textModel === 'string' ? doc.textModel.trim().slice(0, 160) : '';
  const imageProfileId = typeof doc.imageProfileId === 'string' ? doc.imageProfileId.trim().slice(0, 160) : '';
  const imageModel = typeof doc.imageModel === 'string' ? doc.imageModel.trim().slice(0, 160) : '';
  const memory = sanitizeMemory(doc.memory);
  const now = new Date().toISOString();
  return {
    id: String(doc.id || '').trim(),
    revision: revisionOf(doc.revision),
    generation: revisionOf(doc.generation),
    ...(canvasId ? { canvasId } : {}),
    ...(textProfileId ? { textProfileId } : {}),
    ...(textModel ? { textModel } : {}),
    ...(imageProfileId ? { imageProfileId } : {}),
    ...(imageModel ? { imageModel } : {}),
    title: String(doc.title || '新对话'),
    messages,
    ...(memory ? { memory } : {}),
    createdAt: String(doc.createdAt || now),
    updatedAt: String(doc.updatedAt || now),
  };
}

/**
 * 旧版（v1，按 canvasId 为键、记录无 id）→ 新版实体线程。
 * 只在读取时做形态迁移，不主动重写文件——下一次写入自然落成新形态。
 */
function migrateLegacyDocs(docs: Record<string, unknown>): Record<string, ChatThreadRecord> {
  const result: Record<string, ChatThreadRecord> = Object.create(null);
  for (const [key, value] of Object.entries(docs)) {
    if (key === '__tombstones') continue;
    if (!isRecord(value)) throw new Error(`Invalid chat document: ${key}`);
    const doc = value;
    if (String(doc.id || '').trim()) {
      // 已是新形态：原样保留（字段清洗交给 normalizeChatThread）
      const normalized = normalizeChatThread(doc);
      if (normalized) result[normalized.id] = normalized;
      continue;
    }
    // 旧形态：key 就是 canvasId，记录里的 canvasId 字段冗余
    const canvasId = (typeof doc.canvasId === 'string' ? doc.canvasId.trim() : '') || key;
    const normalized = normalizeChatThread({ ...doc, canvasId, id: `thread_${canvasId}` });
    if (normalized) result[normalized.id] = normalized;
  }
  return result;
}

interface ChatTombstone {
  generation: number;
  revision: number;
  deletedAt: string;
}
interface ChatDocs {
  threads: Record<string, ChatThreadRecord>;
  tombstones: Record<string, ChatTombstone>;
}

/** Only a missing file means an empty store. Parse/I/O failures must stop writes. */
async function readChatDocs(): Promise<ChatDocs> {
  let text: string;
  try {
    text = await fs.readFile(CHAT_DOCS_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { threads: Object.create(null), tombstones: Object.create(null) };
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('Invalid chat document store');
  const tombstones: Record<string, ChatTombstone> = Object.create(null);
  if (Object.hasOwn(parsed, '__tombstones')) {
    if (!isRecord(parsed.__tombstones)) throw new Error('Invalid chat tombstones');
    for (const [id, value] of Object.entries(parsed.__tombstones)) {
      if (!isRecord(value)) throw new Error('Invalid chat tombstone');
      tombstones[id] = { generation: revisionOf(value.generation), revision: revisionOf(value.revision), deletedAt: boundedText(value.deletedAt) };
    }
  }
  const threads = migrateLegacyDocs(parsed);
  for (const id of Object.keys(tombstones)) delete threads[id];
  return { threads, tombstones };
}

export async function readChatThreads(): Promise<ChatThreadRecord[]> {
  return Object.values((await readChatDocs()).threads);
}

export async function readChatThread(threadId: string): Promise<ChatThreadRecord | null> {
  return (await readChatDocs()).threads[String(threadId || '').trim()] || null;
}

/** 删除生成历史时同步清掉线程里的结果图、引用图与视觉记忆，避免对话继续指向已删版本。 */
export async function removeChatMediaReferences(targets: HistoryDeleteTarget[]): Promise<string[]> {
  if (targets.length === 0) return [];
  return withChatWriteLock(async () => {
    const docs = await readChatDocs();
    const changedIds: string[] = [];
    const now = new Date().toISOString();
    for (const [id, thread] of Object.entries(docs.threads)) {
      const result = stripChatMediaReferences(thread, targets);
      if (!result.changed) continue;
      docs.threads[id] = {
        ...result.thread,
        revision: (thread.revision || 0) + 1,
        updatedAt: now,
      };
      changedIds.push(id);
    }
    if (changedIds.length > 0) await writeChatDocs(docs);
    return changedIds;
  });
}

/** 对话文档写队列：与 canvas-docs 同理，读-改-写整份 JSON 必须串成一条链。 */
let chatWriteChain: Promise<unknown> = Promise.resolve();
function withChatWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = chatWriteChain.then(task, task);
  chatWriteChain = run.catch(() => undefined);
  return run;
}

/** 写前留一份滚动备份：和画布同款，最多留 5 份。 */
async function backupChatDocs(): Promise<void> {
  try {
    const current = await fs.readFile(CHAT_DOCS_FILE, 'utf8');
    const dir = path.join(path.dirname(CHAT_DOCS_FILE), 'backups');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(dir, `chat-docs-${stamp}.json`), current, 'utf8');
    const names = (await fs.readdir(dir)).filter((name) => name.startsWith('chat-docs-')).sort();
    for (const stale of names.slice(0, Math.max(0, names.length - 5))) {
      await fs.unlink(path.join(dir, stale)).catch(() => undefined);
    }
  } catch {
    /* 备份失败不阻断主流程 */
  }
}

async function writeChatDocs(docs: ChatDocs): Promise<void> {
  await fs.mkdir(path.dirname(CHAT_DOCS_FILE), { recursive: true });
  await backupChatDocs();
  const temporary = `${CHAT_DOCS_FILE}.${randomUUID()}.tmp`;
  try {
    const contents = { ...docs.threads, __tombstones: docs.tombstones };
    await fs.writeFile(temporary, JSON.stringify(contents, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, CHAT_DOCS_FILE);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function isThreadId(id: string): boolean {
  return Boolean(id) && id !== '__tombstones';
}

export class ChatConflictError extends Error {
  readonly status = 409;
  constructor(readonly thread: ChatThreadRecord) {
    super('对话已更新，请先获取最新版本');
    this.name = 'ChatConflictError';
  }
}

function assertRevision(previous: ChatThreadRecord, expectedRevision: unknown): void {
  if (expectedRevision === undefined && previous.revision === 0) return;
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision !== previous.revision) {
    throw new ChatConflictError(previous);
  }
}

function nextThread(previous: ChatThreadRecord): ChatThreadRecord {
  return { ...previous, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
}

function clientPlaceholder(message: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { id: message.id, role: 'assistant', content: '', status: 'running', createdAt: message.createdAt };
  for (const key of ['agentRole', 'modelSelection', 'runId', 'requestId', 'retryOfMessageId', 'retryOfRunId', 'userMessageId', 'retrySource']) {
    if (message[key] !== undefined) result[key] = message[key];
  }
  return result;
}

/**
 * Client CAS path: import an absent legacy thread once, then append only new user
 * messages / assistant placeholders. Existing messages and memory are server-owned.
 * Only explicitly supplied title/model fields may update metadata after CAS.
 */
export async function writeClientThread(raw: unknown, expectedRevision?: number): Promise<ChatThreadRecord | null> {
  const normalized = normalizeChatThread(raw);
  if (!normalized || !isThreadId(normalized.id) || !isRecord(raw)) return null;
  return withChatWriteLock(async () => {
    const docs = await readChatDocs();
    if (docs.tombstones[normalized.id]) return null;
    const previous = docs.threads[normalized.id];
    if (!previous) {
      const created = { ...normalized, revision: 1, generation: 0, updatedAt: new Date().toISOString() };
      docs.threads[created.id] = created;
      await writeChatDocs(docs);
      return created;
    }
    assertRevision(previous, expectedRevision === undefined ? raw.revision : expectedRevision);
    // A stale generation must never be accepted even if a caller copies a newer revision.
    if ((raw.generation ?? 0) !== previous.generation) throw new ChatConflictError(previous);
    const updated = nextThread(previous);
    const ids = new Set(previous.messages.map((message) => message.id));
    const additions = normalized.messages.filter((message) => {
      if (ids.has(message.id)) return false;
      ids.add(message.id);
      return true;
    }).map((message) => message.role === 'assistant' ? clientPlaceholder(message) : message);
    updated.messages = [...previous.messages, ...additions].slice(-MAX_MESSAGES_PER_THREAD);
    if (Object.hasOwn(raw, 'title')) updated.title = normalized.title;
    for (const key of ['canvasId', 'textProfileId', 'textModel', 'imageProfileId', 'imageModel'] as const) {
      if (!Object.hasOwn(raw, key)) continue;
      const value = normalized[key];
      if (value) updated[key] = value;
      else delete updated[key];
    }
    docs.threads[updated.id] = updated;
    await writeChatDocs(docs);
    return updated;
  });
}

export interface RunThreadWriteOptions {
  generation: number;
  messageIds: string[];
  /** Memory is separately owned; stale summaries are ignored without losing run messages. */
  memoryRevision?: number;
}

/** Runs merge only their listed assistant IDs; never create a missing/deleted thread. */
export async function writeRunThread(raw: unknown, options: RunThreadWriteOptions): Promise<ChatThreadRecord | null> {
  const normalized = normalizeChatThread(raw);
  if (!normalized || !isThreadId(normalized.id)) return null;
  return withChatWriteLock(async () => {
    const docs = await readChatDocs();
    const previous = docs.threads[normalized.id];
    if (!previous || docs.tombstones[normalized.id] || previous.generation !== options.generation) return null;
    const owned = new Set(options.messageIds);
    const incoming = new Map(normalized.messages.filter((message) => owned.has(String(message.id)) && message.role === 'assistant').map((message) => [message.id, message]));
    const updated = nextThread(previous);
    // raw is a server-owned run snapshot here; a run may select its result canvas.
    if (normalized.canvasId) updated.canvasId = normalized.canvasId;
    updated.messages = previous.messages.map((message) => {
      const update = incoming.get(message.id);
      incoming.delete(message.id);
      if (!update || message.role !== 'assistant') return message;
      // The sending role/model/retry identity is immutable, even across clarification.
      const merged = { ...message, ...update };
      for (const key of ['agentRole', 'modelSelection', 'runId', 'requestId', 'retryOfMessageId', 'retryOfRunId', 'userMessageId', 'retrySource']) {
        if (message[key] !== undefined) merged[key] = message[key];
      }
      return merged;
    });
    updated.messages.push(...incoming.values());
    updated.messages = updated.messages.slice(-MAX_MESSAGES_PER_THREAD);
    if (normalized.memory && options.memoryRevision !== undefined && options.memoryRevision === revisionOf(previous.memory?.memoryRevision)) {
      updated.memory = { ...normalized.memory, memoryRevision: options.memoryRevision + 1 };
    }
    docs.threads[updated.id] = updated;
    await writeChatDocs(docs);
    return updated;
  });
}

/** Manual memory edits/clear use their own revision, not the frequently changing thread revision. */
export async function updateChatMemory(threadId: string, memory: unknown, expectedMemoryRevision: number): Promise<ChatThreadRecord | null> {
  const id = String(threadId || '').trim();
  if (!isThreadId(id)) return null;
  return withChatWriteLock(async () => {
    const docs = await readChatDocs();
    const previous = docs.threads[id];
    if (!previous || docs.tombstones[id]) return null;
    if (!Number.isSafeInteger(expectedMemoryRevision) || expectedMemoryRevision !== revisionOf(previous.memory?.memoryRevision)) throw new ChatConflictError(previous);
    const updated = nextThread(previous);
    updated.memory = { ...sanitizeMemory(memory), memoryRevision: expectedMemoryRevision + 1 };
    docs.threads[id] = updated;
    await writeChatDocs(docs);
    return updated;
  });
}

/** Clear retains thread identity/metadata and advances the run and memory barriers. */
export async function clearChatThread(threadId: string, expectedRevision: number): Promise<ChatThreadRecord | null> {
  const id = String(threadId || '').trim();
  if (!isThreadId(id)) return null;
  return withChatWriteLock(async () => {
    const docs = await readChatDocs();
    const previous = docs.threads[id];
    if (!previous || docs.tombstones[id]) return null;
    assertRevision(previous, expectedRevision);
    const updated = nextThread(previous);
    updated.generation += 1;
    updated.messages = [];
    const lastId = previous.messages.at(-1)?.id || previous.memory?.clearedThroughMessageId;
    updated.memory = { version: 1, memoryRevision: revisionOf(previous.memory?.memoryRevision) + 1, ...(lastId ? { clearedThroughMessageId: lastId } : {}) };
    docs.threads[id] = updated;
    await writeChatDocs(docs);
    return updated;
  });
}

/**
 * Legacy snapshot upsert kept for current integrations/tests. Timestamp arbitration
 * is intentionally not the official client/run path; deletion barriers still apply.
 */
export async function putChatThread(thread: unknown): Promise<ChatThreadRecord | null> {
  const normalized = normalizeChatThread(thread);
  if (!normalized || !isThreadId(normalized.id)) return null;
  return withChatWriteLock(async () => {
    const docs = await readChatDocs();
    if (docs.tombstones[normalized.id]) return null;
    const previous = docs.threads[normalized.id];
    // Once the official CAS path owns a record, legacy whole snapshots are read-only.
    // Otherwise they could roll back a clear generation or authoritative run output.
    if (previous?.revision) return previous;
    if (previous && Date.parse(previous.updatedAt || '') > Date.parse(normalized.updatedAt || '')) return previous;
    docs.threads[normalized.id] = normalized;
    await writeChatDocs(docs);
    return normalized;
  });
}

/** Persistent id tombstones intentionally never expire: delayed requests cannot resurrect deletion. */
export async function deleteChatThread(threadId: string): Promise<void> {
  const id = String(threadId || '').trim();
  if (!isThreadId(id)) return;
  await withChatWriteLock(async () => {
    const docs = await readChatDocs();
    if (docs.tombstones[id]) return;
    const previous = docs.threads[id];
    docs.tombstones[id] = { revision: (previous?.revision || 0) + 1, generation: (previous?.generation || 0) + 1, deletedAt: new Date().toISOString() };
    delete docs.threads[id];
    await writeChatDocs(docs);
  });
}

