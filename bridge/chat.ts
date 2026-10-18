import fs from 'node:fs/promises';
import path from 'node:path';
import { CHAT_DOCS_FILE } from './paths.js';

/**
 * 对话线程的第二份拷贝：浏览器 localStorage 是工作副本，这里是整文档落盘
 * （~/.huiban/chat-docs.json），换浏览器 / 换机器打开链接时对话历史要能续上。
 *
 * 存储形态：Record<threadId, ChatThreadRecord>——线程是全局独立实体，canvasId 仅为可选落点。
 * 旧版（v1）是按 canvasId 为键的「一画布一条线程」，readChatThreads 读取时整批迁移成
 * 默认线程（id = thread_<canvasId>），保留原 canvasId 作为历史结果落点，历史消息不丢。
 *
 * 写路径与 canvas-docs 同款三条保险：进程内写串行化 + 滚动备份 + 单调时间戳
 * （旧快照不能覆盖新数据）。
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
  const item = raw as Record<string, unknown> | null;
  if (!item || typeof item !== 'object') return undefined;
  const memory: Record<string, unknown> = {
    version: Number(item.version) || 1,
  };
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
      ? value.map((entry) => String(entry || '').trim()).filter(Boolean).slice(-MAX_MEMORY_LIST)
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
      const ref = value as Record<string, unknown> | null;
      if (!ref || typeof ref !== 'object') return null;
      const result: Record<string, unknown> = {};
      for (const key of ['canvasId', 'nodeId', 'versionId', 'url', 'title', 'source']) {
        const text = String(ref[key] || '').trim();
        if (text) result[key] = text;
      }
      return Object.keys(result).length > 0 ? result : null;
    };
    memory.visualWorkingSet = {
      base: cleanRef(workingSet.base) || undefined,
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
  return message;
}

export interface ChatThreadRecord {
  id: string;
  canvasId?: string;
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
  const memory = sanitizeMemory(doc.memory);
  const now = new Date().toISOString();
  return {
    id: String(doc.id || '').trim(),
    ...(canvasId ? { canvasId } : {}),
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
  const result: Record<string, ChatThreadRecord> = {};
  for (const [key, value] of Object.entries(docs)) {
    const doc = value as Record<string, unknown> | null;
    if (!doc || typeof doc !== 'object') continue;
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

export async function readChatThreads(): Promise<ChatThreadRecord[]> {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await fs.readFile(CHAT_DOCS_FILE, 'utf8')) as Record<string, unknown>;
    if (raw && typeof raw === 'object') parsed = raw;
  } catch {
    return [];
  }
  return Object.values(migrateLegacyDocs(parsed));
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

async function writeChatDocs(docs: Record<string, ChatThreadRecord>): Promise<void> {
  await backupChatDocs();
  await fs.writeFile(CHAT_DOCS_FILE, JSON.stringify(docs, null, 2), 'utf8');
}

/**
 * 写入单条线程（upsert）。
 * 单调时间戳防线：只有 incoming.updatedAt 不旧于已存版本才落盘——
 * 两个标签页同时改同一线程时，先到的那份不会被后到的旧快照冲掉。
 */
export async function putChatThread(thread: unknown): Promise<ChatThreadRecord | null> {
  const normalized = normalizeChatThread(thread);
  if (!normalized || !normalized.id) return null;
  return withChatWriteLock(async () => {
    const docs = await readChatThreads().then((threads) => Object.fromEntries(threads.map((item) => [item.id, item])));
    const previous = docs[normalized.id];
    if (previous && Date.parse(previous.updatedAt || '') > Date.parse(normalized.updatedAt || '')) {
      return previous;
    }
    docs[normalized.id] = normalized;
    await writeChatDocs(docs);
    return normalized;
  });
}

/** 删一条线程（画布节点不受影响；幂等）。 */
export async function deleteChatThread(threadId: string): Promise<void> {
  const id = String(threadId || '').trim();
  if (!id) return;
  await withChatWriteLock(async () => {
    const threads = await readChatThreads();
    if (!threads.some((item) => item.id === id)) return;
    const docs = Object.fromEntries(threads.map((item) => [item.id, item]));
    delete docs[id];
    await writeChatDocs(docs);
  });
}

