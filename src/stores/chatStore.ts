import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import type { ChatImageRef, ChatMessage, ChatThread } from '@/types';
import { createId } from '@/lib/id';
import { ChatConflictError, clearChatThread, deleteChatThread, putChatThread, type ChatRunEvent, type ChatRunConfirmation } from '@/lib/bridge';
import { mergeAuthoritativeThread, reduceChatRunEvent, type ChatRunState } from '@/lib/chatRunEvents';

/**
 * 对话状态：全局独立线程（threads 是实体数组，activeThreadId 指向当前线程）。
 *
 * 数据分工——消息只存 nodeId / versionId 引用，图片本体在画布节点上；
 * 本地（localStorage，本 store）是工作副本，bridge 的 chat-docs.json 是第二拷贝，
 * 线程变更后 600ms 防抖上桥（与 putCanvasDoc 同一节拍）。
 * 启动时 mergeRemoteThreads 按 updatedAt 合并：本地缺 / 本地旧的采用远端，
 * 本地更新的保留并回推（last-writer-wins per thread，MVP 不做多标签页实时同步）。
 *
 * 持久化版本 2：v1 是「一画布一条线程」（threads 以 canvasId 为键），
 * migrate 会把旧数据整批迁移成默认线程（id = thread_<canvasId>），历史消息不丢。
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
  /** 当前画布 id：用于新对话默认落点及当前画布图片选择，不用于筛选线程。 */
  activeCanvasId: string;
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
  /** 未开始对话的线程可以换语言模型；已有消息时锁定并返回 false。 */
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

type PersistedChat = Pick<ChatState, 'threads' | 'draft' | 'draftAttachments' | 'draftBase' | 'activeRun' | 'runEventCursors'>;
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
function cancelPush(threadId: string): void {
  const timer = pushTimers.get(threadId);
  if (timer !== undefined) clearTimeout(timer);
  pushTimers.delete(threadId);
}
function schedulePush(threadId: string): void {
  if (!threadId) return;
  cancelPush(threadId);
  pushTimers.set(threadId, setTimeout(() => {
    pushTimers.delete(threadId);
    const thread = useChatStore.getState().threads.find((item) => item.id === threadId);
    if (!thread) return;
    void putChatThread(thread, { metadataOnly: true }).then((remote) => {
      useChatStore.getState().mergeRemoteThreads([remote]);
    }).catch((error) => {
      if (error instanceof ChatConflictError && error.current) useChatStore.getState().mergeRemoteThreads([error.current]);
      useChatStore.setState({ syncError: error instanceof Error ? error.message : '对话保存失败，请重试' });
    });
  }, 600));
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
        const hasActiveThread = Boolean(get().activeThreadId && get().threads.some((item) => item.id === get().activeThreadId));
        if (get().activeCanvasId === canvasId && hasActiveThread) return;
        // 线程是全局实体；切画布只更新默认结果落点，不切换对话或丢弃明确引用。
        if (hasActiveThread) {
          set({ activeCanvasId: canvasId });
          return;
        }
        // 刷新后 activeThreadId 是会话态，不持久化；有历史时恢复最近更新的一条，
        // 让用户重新打开面板就能看到上次的对话，而不是误显示空态。即使画布 id 没变
        // 也要补选：远端线程可能是在 setActiveCanvas 之后才合并进来的。
        const latestThread = mostRecentThread(get().threads);
        set({ activeCanvasId: canvasId, activeThreadId: latestThread?.id || '' });
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
        // 新对话开始一份干净上下文，避免草稿文字或上一线程的基准图串入；
        // 换模型触发的「新建对话」要保留用户已经打好的草稿。
        set({
          threads: [...get().threads, thread],
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
        if (!thread || thread.messages.length > 0 || !nextProfileId) return false;
        const nextModel = String(textModel || '').trim();
        set({
          threads: get().threads.map((item) => (
            item.id === threadId
              ? {
                ...item,
                textProfileId: nextProfileId,
                ...(nextModel ? { textModel: nextModel } : {}),
                updatedAt: new Date().toISOString(),
              }
              : item
          )),
        });
        schedulePush(threadId);
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
                ...(nextModel ? { imageModel: nextModel } : {}),
                updatedAt: new Date().toISOString(),
              }
              : item
          )),
        });
        schedulePush(threadId);
        return true;
      },

      switchThread: (threadId) => {
        const thread = get().threads.find((item) => item.id === threadId);
        if (!thread) return;
        flushChatPersistence();
        set({ activeThreadId: threadId, activeRoleId: '', draft: '', draftAttachments: [], draftBase: null, messageScrollTop: readScroll(threadId) });
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
        schedulePush(threadId);
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
          ? ([...rest].sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))[0]?.id || '')
          : get().activeThreadId;
        const deletingActive = get().activeThreadId === threadId;
        const activeRun = get().activeRun;
        set({
          threads: rest,
          activeThreadId: nextActive,
          ...(deletingActive ? {
            activeRoleId: '',
            draft: '',
            draftAttachments: [],
            draftBase: null,
            messageScrollTop: 0,
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
                ...(get().activeCanvasId ? { canvasId: get().activeCanvasId } : {}),
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
        if (options?.save) schedulePush(threadId);
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
          set({ threads: get().threads.map((item) => item.id === threadId ? state.thread : item), activeRun: state.activeRun, runEventCursors: Object.fromEntries(entries.slice(-128)) });
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
            next[index] = merged;
          }
        }
        const activeThreadId = get().activeThreadId;
        const keepActive = Boolean(activeThreadId && next.some((item) => item.id === activeThreadId));
        // 首次打开或本地副本为空时，远端线程合并后要补选最近一条；否则头部会停在
        // “新对话”，记忆等线程级入口因 thread 为空而不可用。
        const nextActiveThreadId = keepActive ? activeThreadId : mostRecentThread(next)?.id || '';
        set({
          threads: next,
          ...(nextActiveThreadId !== activeThreadId ? { activeThreadId: nextActiveThreadId } : {}),
        });
      },
    }),
    {
      name: 'huiban-chat-v1',
      version: 2,
      storage: chatPersistence,
      migrate: (persisted) => {
        const state = (persisted || {}) as Record<string, unknown>;
        return {
          // open / activeCanvasId / activeRoleId 是会话态不持久化；线程、草稿与在途 run 要跨刷新保留。
          // 旧版草稿附件没有 canvasId / versionId 字段，一次性迁移时丢弃（草稿本是暂态）
          threads: migrateThreads(persisted),
          draft: typeof state.draft === 'string' ? state.draft : '',
          draftAttachments: [],
          draftBase: null,
          activeRun: (state.activeRun as ChatActiveRun | null) || null,
          runEventCursors: {},
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
      }),
    },
  ),
);

/** 当前线程：activeThreadId 命中的全局线程。 */
export function activeThreadOf(state: ChatState): ChatThread | undefined {
  if (!state.activeThreadId) return undefined;
  return state.threads.find((item) => item.id === state.activeThreadId);
}

/** 全部对话线程，按更新时间新的在前。 */
export function allThreads(state: ChatState): ChatThread[] {
  return [...state.threads]
    .filter((thread) => thread.messages.length > 0)
    .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
}
