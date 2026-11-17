import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import type { ChatImageRef, ChatMessage, ChatThread } from '@/types';
import { createId } from '@/lib/id';
import { ChatConflictError, clearChatThread, deleteChatThread, putChatThread, type ChatRunEvent, type ChatRunConfirmation } from '@/lib/bridge';
import { mergeAuthoritativeThread, reduceChatRunEvent, type ChatRunState } from '@/lib/chatRunEvents';
import { useCanvasStore } from './canvasStore';

type ChatDraft = { draft: string; draftAttachments: ChatImageRef[]; draftBase: ChatImageRef | null };
type ThreadMetadata = Partial<Pick<ChatThread, 'title' | 'textProfileId' | 'textModel' | 'imageProfileId' | 'imageModel'>>;
const emptyDraft = (): ChatDraft => ({ draft: '', draftAttachments: [], draftBase: null });
const draftScope = (canvasId: string, threadId: string) => threadId ? `thread:${threadId}` : `canvas:${canvasId}`;
const currentDraft = (state: ChatState): ChatDraft => ({ draft: state.draft, draftAttachments: state.draftAttachments, draftBase: state.draftBase });
const savedDrafts = (state: ChatState) => state.activeCanvasId || state.activeThreadId
  ? { ...state.draftsByScope, [draftScope(state.activeCanvasId, state.activeThreadId)]: currentDraft(state) }
  : state.draftsByScope;

/**
 * 对话状态：线程按画布归属，activeThreadId 指向当前画布的线程。
 *
 * 数据分工——消息只存 nodeId / versionId 引用，图片本体在画布节点上；
 * 本地（localStorage，本 store）是工作副本，bridge 的 chat-docs.json 是第二拷贝，
 * 线程变更后 600ms 防抖上桥（与 putCanvasDoc 同一节拍）。
 * 服务端 revision 决定消息合并，运行中的增量和待保存元数据单独保护。
 *
 * 持久化版本 3：保留旧线程实体，按画布/线程保存活动对话与草稿。
 */

/** 运行中的 agent run：刷新后靠它判断"运行状态未知"，不伪装成完成。 */
export interface ChatActiveRun {
  runId: string;
  threadId: string;
  messageId: string;
  seq?: number;
  pendingConfirmation?: ChatRunConfirmation;
}

/** 草稿引用的唯一键：同一节点的不同版本算不同引用。 */
export function draftKeyOf(ref: Pick<ChatImageRef, 'nodeId' | 'versionId'>): string {
  return `${ref.nodeId}@${ref.versionId || 'current'}`;
}

interface ChatState {
  threads: ChatThread[];
  activeThreadId: string;
  /** 当前画布 id：筛选历史对话、恢复草稿并确定新对话归属。 */
  activeCanvasId: string;
  activeThreadByCanvas: Record<string, string>;
  draftsByScope: Record<string, ChatDraft>;
  pendingMetadata: Record<string, ThreadMetadata>;
  setThreadDraft: (threadId: string, draft: ChatDraft) => void;
  consumeThreadDraft: (threadId: string, expected: ChatDraft) => void;
  flushThreadMetadata: (threadId: string) => Promise<boolean>;
  removeCanvasThreads: (canvasId: string) => void;
  /** 面板是否展开（右下角 AI 按钮控制）。 */
  open: boolean;
  /** 当前会话选中的角色 id；会话态，不持久化，刷新后恢复未选择角色。 */
  activeRoleId: string;
  draft: string;
  draftAttachments: ChatImageRef[];
  /** 「继续编辑」钉住的基准图草稿：下一轮生成以它为续接源（edit 语义）。 */
  draftBase: ChatImageRef | null;
  /** 刷新前的在途 run：恢复时若 bridge 已丢则该 run，消息标记"运行状态未知"。 */
  activeRun: ChatActiveRun | null;
  /** 收起期间出了新结果：FAB 上的状态点。 */
  unread: boolean;
  /** 消息区滚动位置：收起 / 展开不丢（会话内有效）。 */
  messageScrollTop: number;
  setActiveCanvas: (canvasId: string) => void;
  setOpen: (open: boolean) => void;
  setActiveRole: (roleId: string) => void;
  clearActiveRole: () => void;
  setDraft: (text: string) => void;
  addDraftAttachment: (ref: ChatImageRef) => void;
  setDraftAttachments: (refs: ChatImageRef[]) => void;
  removeDraftAttachment: (key: string) => void;
  /** chips 换序：keys 是 draftKeyOf 全量有序列表。 */
  reorderDraftAttachments: (keys: string[]) => void;
  clearDraft: () => void;
  setDraftBase: (ref: ChatImageRef | null) => void;
  markUnread: () => void;
  clearUnread: () => void;
  setMessageScrollTop: (top: number) => void;
  createThread: (canvasId?: string, options?: {
    textProfileId?: string;
    textModel?: string;
    imageProfileId?: string;
    imageModel?: string;
    preserveDraft?: boolean;
  }) => string;
  setThreadTextProfile: (threadId: string, textProfileId: string, textModel?: string) => boolean;
  /** Agent 出图模型：对话开始后仍可随时切换。 */
  setThreadImageModel: (threadId: string, imageProfileId: string, imageModel?: string) => boolean;
  switchThread: (threadId: string) => void;
  renameThread: (threadId: string, title: string) => void;
  /** 删线程：只删对话，不碰画布节点。 */
  deleteThread: (threadId: string) => Promise<void>;
  /** 清空线程消息：线程本身与画布图片都保留。 */
  clearThread: (threadId: string) => Promise<void>;
  appendMessage: (threadId: string, message: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string }) => string;
  patchMessage: (threadId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  /** 启动被拒：丢掉本次 request 未被服务端接管的本地占位，避免留下无回复的孤儿消息。 */
  discardRequest: (threadId: string, requestId: string) => void;
  patchThread: (threadId: string, patch: Partial<ChatThread>, options?: { save?: boolean }) => void;
  applyRunEvents: (threadId: string, events: ChatRunEvent[]) => boolean;
  syncError: string;
  runEventCursors: Record<string, number>;
  setActiveRun: (run: ChatActiveRun | null) => void;
  mergeRemoteThreads: (remote: ChatThread[]) => void;
}

/** 线程标题：取首条用户消息的第一行，超长截断；空内容退回默认名。 */
function deriveTitle(content: string): string {
  const firstLine = String(content || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  if (!firstLine) return '新对话';
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
}

function safeCanvasId(value: unknown): string | undefined {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id !== '[object Object]' ? id : undefined;
}

/** 最近更新的线程；updatedAt 相同用数组顺序兜底（后创建的在后）。 */
function mostRecentThread(threads: ChatThread[]): ChatThread | undefined {
  return [...threads].sort((left, right) => {
    const updatedDelta = Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || '');
    if (updatedDelta !== 0) return updatedDelta;
    return threads.indexOf(right) - threads.indexOf(left);
  })[0];
}

function normalizeLocalImageRef(raw: unknown): ChatImageRef | null {
  const item = raw as Partial<ChatImageRef> | null;
  if (!item || typeof item !== 'object') return null;
  const nodeId = String(item.nodeId || '').trim();
  if (!nodeId) return null;
  return {
    canvasId: safeCanvasId(item.canvasId) || '',
    nodeId,
    ...(String(item.versionId || '').trim() ? { versionId: String(item.versionId).trim() } : {}),
    ...(String(item.url || '').trim() ? { url: String(item.url).trim() } : {}),
    ...(String(item.title || '').trim() ? { title: String(item.title).trim() } : {}),
    ...(Number.isInteger(item.position) && Number(item.position) >= 0 ? { position: Number(item.position) } : {}),
  };
}

function normalizeLocalMessage(raw: unknown): ChatMessage | null {
  const item = raw as Partial<ChatMessage> | null;
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').trim();
  if (!id) return null;
  const attachments = Array.isArray(item.attachments)
    ? item.attachments.map(normalizeLocalImageRef).filter((entry): entry is ChatImageRef => entry !== null)
    : undefined;
  const media = Array.isArray(item.media)
    ? item.media
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => {
        const mediaItem = entry as NonNullable<ChatMessage['media']>[number];
        const canvasId = safeCanvasId(mediaItem.canvasId);
        const { canvasId: _ignoredCanvasId, ...mediaWithoutCanvas } = mediaItem;
        return {
          ...mediaWithoutCanvas,
          nodeId: String(mediaItem.nodeId || '').trim(),
          versionId: String(mediaItem.versionId || '').trim(),
          ...(canvasId ? { canvasId } : {}),
        };
      })
      .filter((entry) => entry.nodeId && entry.versionId)
    : undefined;
  return {
    ...item,
    id,
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item.content || ''),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(media && media.length > 0 ? { media } : {}),
    createdAt: String(item.createdAt || new Date().toISOString()),
  } as ChatMessage;
}

export function normalizeLocalThread(raw: unknown): ChatThread | null {
  const item = raw as Partial<ChatThread> | null;
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').trim();
  if (!id) return null;
  const canvasId = safeCanvasId(item.canvasId);
  const messages = Array.isArray(item.messages)
    ? item.messages.map(normalizeLocalMessage).filter((entry): entry is ChatMessage => entry !== null)
    : [];
  const { canvasId: _ignoredCanvasId, ...threadWithoutCanvas } = item;
  return {
    ...threadWithoutCanvas,
    id,
    ...(canvasId ? { canvasId } : {}),
    title: String(item.title || '新对话'),
    messages,
    createdAt: String(item.createdAt || new Date().toISOString()),
    updatedAt: String(item.updatedAt || item.createdAt || new Date().toISOString()),
  } as ChatThread;
}

type PersistedChat = Pick<ChatState, 'threads' | 'draft' | 'draftAttachments' | 'draftBase' | 'activeRun' | 'runEventCursors' | 'activeCanvasId' | 'activeThreadId' | 'activeThreadByCanvas' | 'draftsByScope' | 'pendingMetadata'>;
let pendingPersistence: { key: string; value: StorageValue<PersistedChat> } | undefined;
let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
let persistedReferences: PersistedChat | undefined;
const memoryStorage = new Map<string, string>();

/** JSON serialization is throttled too, not just localStorage.setItem. */
export function flushChatPersistence(): void {
  if (persistenceTimer !== undefined) clearTimeout(persistenceTimer);
  persistenceTimer = undefined;
  if (!pendingPersistence) return;
  const { key, value } = pendingPersistence;
  pendingPersistence = undefined;
  try {
    const serialized = JSON.stringify(value);
    if (typeof localStorage === 'undefined') memoryStorage.set(key, serialized);
    else localStorage.setItem(key, serialized);
  } catch {
    useChatStore.setState({ syncError: '本地对话缓存写入失败，请勿关闭页面；服务器中的已接纳消息仍保留。' });
  }
}
const chatPersistence: PersistStorage<PersistedChat> = {
  getItem: (key) => {
    try {
      const value = typeof localStorage === 'undefined' ? memoryStorage.get(key) : localStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch { return null; }
  },
  removeItem: (key) => {
    if (pendingPersistence?.key === key) pendingPersistence = undefined;
    if (typeof localStorage === 'undefined') memoryStorage.delete(key);
    else localStorage.removeItem(key);
  },
  setItem: (key, value) => {
    const next = value.state;
    if (persistedReferences && Object.keys(next).every((key) => next[key as keyof PersistedChat] === persistedReferences![key as keyof PersistedChat])) return;
    persistedReferences = next;
    pendingPersistence = { key, value };
    if (persistenceTimer === undefined) persistenceTimer = setTimeout(flushChatPersistence, 500);
  },
};
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushChatPersistence);

const scrollPositions = new Map<string, number>();
function readScroll(threadId: string): number {
  try { return scrollPositions.get(threadId) ?? Number(sessionStorage.getItem(`huiban:chat-scroll:${threadId}`) || 0); }
  catch { return scrollPositions.get(threadId) || 0; }
}
function writeScroll(threadId: string, top: number): void {
  scrollPositions.set(threadId, top);
  try { sessionStorage.setItem(`huiban:chat-scroll:${threadId}`, String(top)); } catch { /* session-only fallback */ }
}

/** Only explicit metadata actions queue writes; never an SSE patch or run placeholder. */
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pushes = new Map<string, Promise<boolean>>();
function cancelPush(threadId: string): void {
  const timer = pushTimers.get(threadId);
  if (timer !== undefined) clearTimeout(timer);
  pushTimers.delete(threadId);
}
function schedulePush(threadId: string, patch: ThreadMetadata): void {
  if (!threadId) return;
  const state = useChatStore.getState();
  useChatStore.setState({ pendingMetadata: { ...state.pendingMetadata, [threadId]: { ...state.pendingMetadata[threadId], ...patch } } });
  cancelPush(threadId);
  pushTimers.set(threadId, setTimeout(() => {
    pushTimers.delete(threadId);
    void flushThreadMetadata(threadId);
  }, 600));
}

async function flushThreadMetadata(threadId: string): Promise<boolean> {
  cancelPush(threadId);
  const inFlight = pushes.get(threadId);
  if (inFlight) {
    if (!await inFlight) return false;
    return flushThreadMetadata(threadId);
  }
  const patch = useChatStore.getState().pendingMetadata[threadId];
  if (!patch || Object.keys(patch).length === 0) return true;
  const operation = (async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const thread = useChatStore.getState().threads.find((item) => item.id === threadId);
      if (!thread) return false;
      try {
        const remote = await putChatThread(thread, { metadataOnly: thread.revision !== undefined, metadata: patch });
        if (!useChatStore.getState().threads.some((item) => item.id === threadId)) return false;
        const pending = { ...useChatStore.getState().pendingMetadata[threadId] };
        for (const key of Object.keys(patch) as Array<keyof ThreadMetadata>) {
          if (pending[key] === patch[key]) delete pending[key];
        }
        useChatStore.setState({ pendingMetadata: { ...useChatStore.getState().pendingMetadata, [threadId]: pending }, syncError: '' });
        useChatStore.getState().mergeRemoteThreads([remote]);
        return true;
      } catch (error) {
        if (error instanceof ChatConflictError && error.current) {
          if (!useChatStore.getState().threads.some((item) => item.id === threadId)) return false;
          useChatStore.getState().mergeRemoteThreads([error.current]);
          if (attempt < 3) continue;
        }
        useChatStore.setState({ syncError: '模型或标题尚未保存，发送时会重试；请检查服务连接。' });
        return false;
      }
    }
    return false;
  })();
  pushes.set(threadId, operation);
  const success = await operation;
  pushes.delete(threadId);
  return success ? flushThreadMetadata(threadId) : false;
}

/** v1 旧数据（threads: Record<canvasId, 线程>）→ v2 实体线程数组。 */
function migrateThreads(persisted: unknown): ChatThread[] {
  const state = (persisted || {}) as { threads?: unknown };
  const raw = state.threads;
  if (Array.isArray(raw)) {
    return raw.map(normalizeLocalThread).filter((thread): thread is ChatThread => thread !== null);
  }
  if (!raw || typeof raw !== 'object') return [];
  const now = new Date().toISOString();
  return Object.entries(raw as Record<string, Partial<ChatThread> & { messages?: ChatMessage[] }>).map(([canvasId, thread]) => normalizeLocalThread({
    // 稳定 id：旧画布的线程 id 由 canvasId 推导，迁移后仍能对回同一条线程
    id: String(thread?.id || `thread_${canvasId}`),
    ...(safeCanvasId(thread?.canvasId || canvasId) ? { canvasId: safeCanvasId(thread?.canvasId || canvasId) } : {}),
    title: String(thread?.title || '新对话'),
    messages: Array.isArray(thread?.messages) ? thread!.messages! : [],
    createdAt: String(thread?.createdAt || now),
    updatedAt: String(thread?.updatedAt || now),
  })).filter((item): item is ChatThread => item !== null);
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      threads: [],
      activeThreadId: '',
      activeCanvasId: '',
      activeThreadByCanvas: {},
      draftsByScope: {},
      pendingMetadata: {},
      open: false,
      activeRoleId: '',
      draft: '',
      draftAttachments: [],
      draftBase: null,
      activeRun: null,
      unread: false,
      messageScrollTop: 0,
      syncError: '',
      runEventCursors: {},

      setActiveCanvas: (canvasId) => {
        const state = get();
        const candidates = state.threads.filter((item) => item.canvasId === canvasId);
        const remembered = state.activeCanvasId === canvasId ? state.activeThreadId : state.activeThreadByCanvas[canvasId];
        const threadId = candidates.find((item) => item.id === remembered)?.id || mostRecentThread(candidates)?.id || '';
        if (state.activeCanvasId === canvasId && state.activeThreadId === threadId) return;
        const drafts = savedDrafts(state);
        set({ activeCanvasId: canvasId, activeThreadId: threadId, activeRoleId: '',
          activeThreadByCanvas: { ...state.activeThreadByCanvas, [canvasId]: threadId }, draftsByScope: drafts,
          ...drafts[draftScope(canvasId, threadId)] || emptyDraft(), messageScrollTop: readScroll(threadId) });
        flushChatPersistence();
      },

      setThreadDraft: (threadId, draft) => set({
        draftsByScope: { ...get().draftsByScope, [draftScope('', threadId)]: draft },
        ...(get().activeThreadId === threadId ? draft : {}),
      }),

      consumeThreadDraft: (threadId, expected) => {
        const draft = get().activeThreadId === threadId ? currentDraft(get()) : get().draftsByScope[draftScope('', threadId)];
        if (JSON.stringify(draft) === JSON.stringify(expected)) get().setThreadDraft(threadId, emptyDraft());
      },

      flushThreadMetadata,

      removeCanvasThreads: (canvasId) => {
        const removed = get().threads.filter((thread) => thread.canvasId === canvasId);
        removed.forEach((thread) => cancelPush(thread.id));
        const draftsByScope = { ...get().draftsByScope };
        const pendingMetadata = { ...get().pendingMetadata };
        const activeThreadByCanvas = { ...get().activeThreadByCanvas };
        delete activeThreadByCanvas[canvasId];
        delete draftsByScope[draftScope(canvasId, '')];
        for (const thread of removed) {
          delete draftsByScope[draftScope('', thread.id)];
          delete pendingMetadata[thread.id];
        }
        set({ threads: get().threads.filter((thread) => thread.canvasId !== canvasId),
          draftsByScope, pendingMetadata, activeThreadByCanvas,
          ...(removed.some((thread) => thread.id === get().activeRun?.threadId) ? { activeRun: null } : {}),
          ...(get().activeCanvasId === canvasId ? { activeThreadId: '', ...emptyDraft() } : {}) });
      },

      setOpen: (open) => set(open ? { open, unread: false } : { open }),

      setActiveRole: (roleId) => set({ activeRoleId: String(roleId || '').trim() }),

      clearActiveRole: () => set({ activeRoleId: '' }),

      setDraft: (text) => set({ draft: text }),

      addDraftAttachment: (ref) => {
        const nodeId = String(ref.nodeId || '').trim();
        const url = String(ref.url || '').trim();
        if (!nodeId && !url) return;
        const key = draftKeyOf({ nodeId, versionId: ref.versionId });
        const current = get().draftAttachments;
        // 同一节点换了版本：替换 chip（引用永远指向选中的那个版本）
        const normalizedRef = {
          ...ref,
          nodeId,
          url,
          position: Number.isInteger(ref.position) && Number(ref.position) >= 0
            ? Number(ref.position)
            : String(get().draft || '').length,
        };
        const replaced = current.map((item) => (
          item.nodeId === nodeId ? { ...normalizedRef, position: ref.position ?? item.position } : item
        ));
        if (replaced.some((item, index) => item !== current[index])) {
          set({ draftAttachments: replaced });
          return;
        }
        // 同节点同版本重复引用：去重
        if (current.some((item) => draftKeyOf(item) === key)) return;
        set({ draftAttachments: [...current, normalizedRef] });
      },

      setDraftAttachments: (refs) => set({ draftAttachments: refs }),

      removeDraftAttachment: (key) => set({
        draftAttachments: get().draftAttachments.filter((item) => draftKeyOf(item) !== key),
      }),

      reorderDraftAttachments: (keys) => {
        const current = get().draftAttachments;
        if (keys.length !== current.length) return;
        const rank = new Map(keys.map((key, index) => [key, index] as [string, number]));
        const next = [...current].sort((left, right) => (
          (rank.get(draftKeyOf(left)) ?? 0) - (rank.get(draftKeyOf(right)) ?? 0)
        ));
        set({ draftAttachments: next });
      },

      clearDraft: () => set({ draft: '', draftAttachments: [] }),

      setDraftBase: (ref) => set({ draftBase: ref }),

      markUnread: () => set({ unread: true }),

      clearUnread: () => set({ unread: false }),

      setMessageScrollTop: (top) => {
        writeScroll(get().activeThreadId, top);
        set({ messageScrollTop: top });
      },

      createThread: (canvasId, options = {}) => {
        flushChatPersistence();
        const target = canvasId || get().activeCanvasId || undefined;
        const active = get().threads.find((item) => item.id === get().activeThreadId);
        const textProfileId = options.textProfileId || active?.textProfileId || '';
        const textModel = options.textModel || active?.textModel || '';
        const imageProfileId = options.imageProfileId || active?.imageProfileId || '';
        const imageModel = options.imageModel || active?.imageModel || '';
        const now = new Date().toISOString();
        const thread: ChatThread = {
          id: createId('thread'),
          ...(target ? { canvasId: target } : {}),
          ...(textProfileId ? { textProfileId } : {}),
          ...(textModel ? { textModel } : {}),
          ...(imageProfileId ? { imageProfileId } : {}),
          ...(imageModel ? { imageModel } : {}),
          title: '新对话',
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        const drafts = savedDrafts(get());
        if (options.preserveDraft && !get().activeThreadId) delete drafts[draftScope(get().activeCanvasId, '')];
        set({
          threads: [...get().threads, thread],
          draftsByScope: drafts,
          activeCanvasId: target || '',
          activeThreadByCanvas: { ...get().activeThreadByCanvas, [target || '']: thread.id },
          activeThreadId: thread.id,
          activeRoleId: '',
          open: true,
          ...(options.preserveDraft ? {} : { draft: '', draftAttachments: [], draftBase: null }),
          messageScrollTop: 0,
        });
        return thread.id;
      },

      setThreadTextProfile: (threadId, textProfileId, textModel) => {
        const thread = get().threads.find((item) => item.id === threadId);
        const nextProfileId = String(textProfileId || '').trim();
        if (!thread || !nextProfileId) return false;
        const nextModel = String(textModel || '').trim();
        set({
          threads: get().threads.map((item) => (
            item.id === threadId
              ? {
                ...item,
                textProfileId: nextProfileId,
                textModel: nextModel,
                updatedAt: new Date().toISOString(),
              }
              : item
          )),
        });
        schedulePush(threadId, { textProfileId: nextProfileId, textModel: nextModel });
        return true;
      },

      setThreadImageModel: (threadId, imageProfileId, imageModel) => {
        const thread = get().threads.find((item) => item.id === threadId);
        const nextProfileId = String(imageProfileId || '').trim();
        if (!thread || !nextProfileId) return false;
        const nextModel = String(imageModel || '').trim();
        set({
          threads: get().threads.map((item) => (
            item.id === threadId
              ? {
                ...item,
                imageProfileId: nextProfileId,
                imageModel: nextModel,
                updatedAt: new Date().toISOString(),
              }
              : item
          )),
        });
        schedulePush(threadId, { imageProfileId: nextProfileId, imageModel: nextModel });
        return true;
      },

      switchThread: (threadId) => {
        const thread = get().threads.find((item) => item.id === threadId);
        if (!thread || thread.canvasId !== get().activeCanvasId) return;
        flushChatPersistence();
        const drafts = savedDrafts(get());
        set({ activeThreadId: threadId, activeRoleId: '', draftsByScope: drafts,
          activeThreadByCanvas: { ...get().activeThreadByCanvas, [get().activeCanvasId]: threadId },
          ...(drafts[draftScope('', threadId)] || emptyDraft()), messageScrollTop: readScroll(threadId) });
        flushChatPersistence();
      },

      renameThread: (threadId, title) => {
        const trimmed = String(title || '').trim();
        if (!trimmed) return;
        set({
          threads: get().threads.map((item) => (
            item.id === threadId ? { ...item, title: trimmed, updatedAt: new Date().toISOString() } : item
          )),
        });
        schedulePush(threadId, { title: trimmed });
      },

      deleteThread: async (threadId) => {
        const thread = get().threads.find((item) => item.id === threadId);
        if (!thread) return;
        cancelPush(threadId);
        try { await deleteChatThread(threadId); }
        catch (error) { set({ syncError: error instanceof Error ? error.message : '删除对话失败' }); return; }
        const rest = get().threads.filter((item) => item.id !== threadId);
        // 删的是当前线程：落到最近更新的线程上，别让用户对着空面板。
        const nextActive = get().activeThreadId === threadId
          ? (mostRecentThread(rest.filter((item) => item.canvasId === get().activeCanvasId))?.id || '')
          : get().activeThreadId;
        const deletingActive = get().activeThreadId === threadId;
        const activeRun = get().activeRun;
        const draftsByScope = { ...get().draftsByScope };
        const pendingMetadata = { ...get().pendingMetadata };
        delete draftsByScope[draftScope('', threadId)];
        delete pendingMetadata[threadId];
        set({
          threads: rest,
          draftsByScope, pendingMetadata,
          activeThreadId: nextActive,
          activeThreadByCanvas: { ...get().activeThreadByCanvas, [get().activeCanvasId]: nextActive },
          ...(deletingActive ? {
            activeRoleId: '',
            ...(draftsByScope[draftScope(get().activeCanvasId, nextActive)] || emptyDraft()),
            messageScrollTop: readScroll(nextActive),
          } : {}),
          ...(activeRun?.threadId === threadId ? { activeRun: null } : {}),
        });
        flushChatPersistence();
      },

      clearThread: async (threadId) => {
        const thread = get().threads.find((item) => item.id === threadId);
        if (!thread) return;
        cancelPush(threadId);
        try {
          const remote = await clearChatThread(threadId, thread.revision);
          set({ threads: get().threads.map((item) => item.id === threadId ? remote : item),
            ...(get().activeRun?.threadId === threadId ? { activeRun: null } : {}) });
          flushChatPersistence();
        } catch (error) {
          if (error instanceof ChatConflictError && error.current) get().mergeRemoteThreads([error.current]);
          set({ syncError: error instanceof Error ? error.message : '清空对话失败' });
        }
      },

      appendMessage: (threadId, message) => {
        if (!threadId) return '';
        const id = message.id || createId('msg');
        const now = new Date().toISOString();
        const full: ChatMessage = { ...message, id, createdAt: now };
        const existing = get().threads.find((item) => item.id === threadId);
        const messages = existing ? [...existing.messages, full] : [full];
        const title = existing
          ? (existing.messages.length === 0 && full.role === 'user' ? deriveTitle(full.content) : existing.title)
          : deriveTitle(full.content);
        // 首条用户消息把本轮选中的对话模型 / Agent 生图模型固化到线程上；
        // 旧线程还没有记录时，也用下一条用户消息补上，避免一直回落到设置默认值。
        const adoptText = full.role === 'user'
          && (!existing || existing.messages.length === 0 || !existing.textProfileId);
        const adoptImage = full.role === 'user'
          && (!existing || existing.messages.length === 0 || !existing.imageProfileId);
        const textProfileId = adoptText
          ? String(full.modelSelection?.textProfileId || existing?.textProfileId || '').trim()
          : '';
        const textModel = adoptText
          ? String(full.modelSelection?.textModel || existing?.textModel || '').trim()
          : '';
        const imageProfileId = adoptImage
          ? String(full.modelSelection?.imageProfileId || existing?.imageProfileId || '').trim()
          : '';
        const imageModel = adoptImage
          ? String(full.modelSelection?.imageModel || existing?.imageModel || '').trim()
          : '';
        const modelFields = {
          ...(textProfileId ? { textProfileId } : {}),
          ...(textModel ? { textModel } : {}),
          ...(imageProfileId ? { imageProfileId } : {}),
          ...(imageModel ? { imageModel } : {}),
        };
        set({
          threads: existing
            ? get().threads.map((item) => (item.id === threadId
              ? {
                ...item,
                ...modelFields,
                messages,
                title,
                updatedAt: now,
              }
              : item))
            : [...get().threads, {
              id: threadId,
              ...(get().activeCanvasId ? { canvasId: get().activeCanvasId } : {}),
              ...modelFields,
              title,
              messages,
              createdAt: now,
              updatedAt: now,
            }],
        });
        const owner = existing?.canvasId || get().activeCanvasId;
        if (owner) useCanvasStore.getState().markCanvasChat(owner);
        return id;
      },

      patchMessage: (threadId, messageId, patch) => {
        const thread = get().threads.find((item) => item.id === threadId);
        if (!thread || !messageId) return;
        if (!thread.messages.some((item) => item.id === messageId)) return;
        set({
          threads: get().threads.map((item) => (
            item.id === threadId
              ? { ...item, messages: item.messages.map((msg) => (msg.id === messageId ? { ...msg, ...patch } : msg)), updatedAt: new Date().toISOString() }
              : item
          )),
        });
      },

      discardRequest: (threadId, requestId) => {
        if (!threadId || !requestId) return;
        const thread = get().threads.find((item) => item.id === threadId);
        if (!thread || !thread.messages.some((item) => item.requestId === requestId)) return;
        set({
          threads: get().threads.map((item) => (
            item.id === threadId
              ? {
                ...item,
                // 已被 run 接管的消息（带 runId）保留；只清理这次被拒请求的本地占位。
                messages: item.messages.filter((msg) => msg.requestId !== requestId || Boolean(msg.runId)),
                updatedAt: new Date().toISOString(),
              }
              : item
          )),
        });
      },

      patchThread: (threadId, patch, options) => {
        if (!threadId) return;
        if (!get().threads.some((item) => item.id === threadId)) return;
        set({
          threads: get().threads.map((item) => (
            item.id === threadId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item
          )),
        });
        if (options?.save) {
          const metadata: ThreadMetadata = {};
          for (const key of ['title', 'textProfileId', 'textModel', 'imageProfileId', 'imageModel'] as const) {
            if (patch[key] !== undefined) metadata[key] = patch[key];
          }
          schedulePush(threadId, metadata);
        }
      },

      applyRunEvents: (threadId, events) => {
        const thread = get().threads.find((item) => item.id === threadId);
        if (!thread) return false;
        const runId = events[0]?.runId || get().activeRun?.runId;
        const savedSeq = runId ? get().runEventCursors[runId] : undefined;
        let state: ChatRunState = { thread, activeRun: get().activeRun, ...(runId && savedSeq !== undefined ? { cursor: { runId, seq: savedSeq } } : {}) };
        for (const event of events) state = reduceChatRunEvent(state, event);
        if (state.thread !== thread || state.activeRun !== get().activeRun) {
          const entries = state.cursor ? [...Object.entries(get().runEventCursors).filter(([id]) => id !== state.cursor!.runId), [state.cursor.runId, state.cursor.seq]] : Object.entries(get().runEventCursors);
          set({ threads: get().threads.map((item) => item.id === threadId ? { ...state.thread, ...get().pendingMetadata[threadId] } : item), activeRun: state.activeRun, runEventCursors: Object.fromEntries(entries.slice(-128)) });
        }
        if (!state.activeRun) flushChatPersistence();
        return Boolean(state.needsSnapshot);
      },

      setActiveRun: (run) => set({ activeRun: run }),

      mergeRemoteThreads: (remote) => {
        if (!Array.isArray(remote) || !remote.length) return;
        const next = [...get().threads];
        for (const item of remote) {
          if (!item?.id) continue;
          const index = next.findIndex((candidate) => candidate.id === item.id);
          if (index < 0) next.push(item);
          else {
            const local = next[index];
            const merged = { ...mergeAuthoritativeThread(local, item) };
            const active = get().activeRun;
            // A metadata/list response has no run seq and may contain only a persisted prefix.
            // Only run snapshots may replace the current run's materialized messages.
            if (active?.threadId === item.id && (local.generation ?? 0) === (item.generation ?? 0)) {
              const owned = local.messages.filter((message) => message.runId === active.runId || message.id === active.messageId);
              const ids = new Set(owned.map((message) => message.id));
              merged.messages = [...merged.messages.map((message) => ids.has(message.id) ? owned.find((entry) => entry.id === message.id)! : message), ...owned.filter((message) => !merged.messages.some((entry) => entry.id === message.id))];
            }
            next[index] = { ...merged, ...get().pendingMetadata[item.id] };
          }
        }
        const activeThreadId = get().activeThreadId;
        const keepActive = Boolean(activeThreadId && next.some((item) => item.id === activeThreadId && item.canvasId === get().activeCanvasId));
        // 首次打开或本地副本为空时，远端线程合并后要补选最近一条；否则头部会停在
        // “新对话”，记忆等线程级入口因 thread 为空而不可用。
        const nextActiveThreadId = keepActive ? activeThreadId : mostRecentThread(next.filter((item) => item.canvasId === get().activeCanvasId))?.id || '';
        set({
          threads: next,
        });
        if (nextActiveThreadId !== activeThreadId) get().setActiveCanvas(get().activeCanvasId);
        for (const thread of next) if (thread.canvasId && thread.messages.length) useCanvasStore.getState().markCanvasChat(thread.canvasId);
      },
    }),
    {
      name: 'huiban-chat-v1',
      version: 3,
      storage: chatPersistence,
      migrate: (persisted): PersistedChat => {
        const state = (persisted || {}) as Record<string, unknown>;
        const legacyDraft = {
          draft: typeof state.draft === 'string' ? state.draft : '',
          draftAttachments: Array.isArray(state.draftAttachments)
            ? state.draftAttachments.map(normalizeLocalImageRef).filter((ref): ref is ChatImageRef => ref !== null) : [],
          draftBase: normalizeLocalImageRef(state.draftBase),
        };
        return {
          threads: migrateThreads(persisted),
          draft: '',
          draftAttachments: [],
          draftBase: null,
          activeRun: (state.activeRun as ChatActiveRun | null) || null,
          runEventCursors: {},
          activeCanvasId: '',
          activeThreadId: '',
          activeThreadByCanvas: {},
          draftsByScope: legacyDraft.draft || legacyDraft.draftAttachments.length || legacyDraft.draftBase ? { 'canvas:': legacyDraft } : {},
          pendingMetadata: {},
        };
      },
      partialize: (state) => ({
        threads: state.threads,
        draft: state.draft,
        draftAttachments: state.draftAttachments,
        draftBase: state.draftBase,
        // 刷新后要凭 runId 重连 SSE，否则生成中的消息会永远停在 running。
        activeRun: state.activeRun,
        runEventCursors: state.runEventCursors,
        activeCanvasId: state.activeCanvasId,
        activeThreadId: state.activeThreadId,
        activeThreadByCanvas: state.activeThreadByCanvas,
        draftsByScope: state.draftsByScope,
        pendingMetadata: state.pendingMetadata,
      }),
    },
  ),
);

/** 当前线程：activeThreadId 命中的当前画布线程。 */
export function activeThreadOf(state: ChatState): ChatThread | undefined {
  if (!state.activeThreadId) return undefined;
  return state.threads.find((item) => item.id === state.activeThreadId && item.canvasId === state.activeCanvasId);
}

/** 当前画布对话线程，按更新时间新的在前。 */
export function allThreads(state: ChatState): ChatThread[] {
  return [...state.threads]
    .filter((thread) => thread.messages.length > 0 && thread.canvasId === state.activeCanvasId)
    .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
}
