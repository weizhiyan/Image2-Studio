import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import type { ChatImageRef, ChatMessage, ChatThread } from '@/types';
import { createId } from '@/lib/id';
import { deleteChatThread, putChatThread, stopChatRun } from '@/lib/bridge';

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
  createThread: (canvasId?: string) => string;
  switchThread: (threadId: string) => void;
  renameThread: (threadId: string, title: string) => void;
  /** 删线程：只删对话，不碰画布节点。 */
  deleteThread: (threadId: string) => void;
  /** 清空线程消息：线程本身与画布图片都保留。 */
  clearThread: (threadId: string) => void;
  appendMessage: (threadId: string, message: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string }) => string;
  patchMessage: (threadId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  patchThread: (threadId: string, patch: Partial<ChatThread>) => void;
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

/** node / vitest 环境没有 localStorage：回落内存存储，保证 store 在测试里可用。 */
function chatStorage(): StateStorage {
  if (typeof localStorage !== 'undefined') {
    return {
      getItem: (key) => localStorage.getItem(key),
      removeItem: (key) => localStorage.removeItem(key),
      setItem: (key, value) => {
        try {
          localStorage.setItem(key, value);
        } catch (error) {
          const name = (error as { name?: string } | null)?.name;
          if (name !== 'QuotaExceededError' && name !== 'NS_ERROR_DOM_QUOTA_REACHED') return;
          try {
            // 本地副本满时先丢掉草稿里的内嵌图；线程消息入库前已剥过大 dataURL，bridge 还有整份备份
            const parsed = JSON.parse(value) as { state?: Record<string, unknown> };
            if (parsed.state) {
              parsed.state.draftAttachments = [];
              parsed.state.draftBase = null;
              localStorage.setItem(key, JSON.stringify(parsed));
            }
          } catch {
            console.warn('[绘板] 本地对话缓存已满，已依赖 bridge 对话副本');
          }
        }
      },
    };
  }
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

/** 防抖上桥：同一线程连续变更只发最后一次，与画布文档同一节拍。 */
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePush(threadId: string): void {
  if (!threadId) return;
  const existing = pushTimers.get(threadId);
  if (existing) clearTimeout(existing);
  pushTimers.set(threadId, setTimeout(() => {
    pushTimers.delete(threadId);
    const thread = useChatStore.getState().threads.find((item) => item.id === threadId);
    if (!thread) return;
    void putChatThread(thread);
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
      draft: '',
      draftAttachments: [],
      draftBase: null,
      activeRun: null,
      unread: false,
      messageScrollTop: 0,

      setActiveCanvas: (canvasId) => {
        if (get().activeCanvasId === canvasId) return;
        // 线程是全局实体；切画布只更新默认结果落点，不切换对话或丢弃明确引用。
        const hasActiveThread = Boolean(get().activeThreadId && get().threads.some((item) => item.id === get().activeThreadId));
        if (hasActiveThread) {
          set({ activeCanvasId: canvasId });
          return;
        }
        // 刷新后 activeThreadId 是会话态，不持久化；有历史时恢复最近更新的一条，
        // 让用户重新打开面板就能看到上次的对话，而不是误显示空态。
        const threads = get().threads;
        const latestThread = [...threads]
          .sort((left, right) => {
            const updatedDelta = Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || '');
            if (updatedDelta !== 0) return updatedDelta;
            // 创建 / 发送发生在同一毫秒时，数组后面的线程才是最近创建的。
            return threads.indexOf(right) - threads.indexOf(left);
          })[0];
        set({ activeCanvasId: canvasId, activeThreadId: latestThread?.id || '' });
      },

      setOpen: (open) => set(open ? { open, unread: false } : { open }),

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

      setMessageScrollTop: (top) => set({ messageScrollTop: top }),

      createThread: (canvasId) => {
        const target = canvasId || get().activeCanvasId || undefined;
        const now = new Date().toISOString();
        const thread: ChatThread = { id: createId('thread'), ...(target ? { canvasId: target } : {}), title: '新对话', messages: [], createdAt: now, updatedAt: now };
        // 新对话开始一份干净上下文，避免草稿文字或上一线程的基准图串入。
        set({
          threads: [...get().threads, thread],
          activeThreadId: thread.id,
          open: true,
          draft: '',
          draftAttachments: [],
          draftBase: null,
          messageScrollTop: 0,
        });
        return thread.id;
      },

      switchThread: (threadId) => {
        const thread = get().threads.find((item) => item.id === threadId);
        if (!thread) return;
        set({ activeThreadId: threadId, draft: '', draftAttachments: [], draftBase: null, messageScrollTop: 0 });
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

      deleteThread: (threadId) => {
        const thread = get().threads.find((item) => item.id === threadId);
        if (!thread) return;
        const rest = get().threads.filter((item) => item.id !== threadId);
        // 删的是当前线程：落到最近更新的线程上，别让用户对着空面板。
        const nextActive = get().activeThreadId === threadId
          ? ([...rest].sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))[0]?.id || '')
          : get().activeThreadId;
        const deletingActive = get().activeThreadId === threadId;
        const activeRun = get().activeRun;
        if (activeRun?.threadId === threadId) void stopChatRun(activeRun.runId);
        set({
          threads: rest,
          activeThreadId: nextActive,
          ...(deletingActive ? {
            draft: '',
            draftAttachments: [],
            draftBase: null,
            messageScrollTop: 0,
          } : {}),
          ...(activeRun?.threadId === threadId ? { activeRun: null } : {}),
        });
        void deleteChatThread(threadId);
      },

      clearThread: (threadId) => {
        const thread = get().threads.find((item) => item.id === threadId);
        if (!thread || thread.messages.length === 0) return;
        set({
          threads: get().threads.map((item) => (
            item.id === threadId ? { ...item, messages: [], updatedAt: new Date().toISOString() } : item
          )),
        });
        schedulePush(threadId);
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
        set({
          threads: existing
            ? get().threads.map((item) => (item.id === threadId
              ? {
                ...item,
                ...(get().activeCanvasId ? { canvasId: get().activeCanvasId } : {}),
                messages,
                title,
                updatedAt: now,
              }
              : item))
            : [...get().threads, {
              id: threadId,
              ...(get().activeCanvasId ? { canvasId: get().activeCanvasId } : {}),
              title,
              messages,
              createdAt: now,
              updatedAt: now,
            }],
        });
        schedulePush(threadId);
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
        schedulePush(threadId);
      },

      patchThread: (threadId, patch) => {
        if (!threadId) return;
        if (!get().threads.some((item) => item.id === threadId)) return;
        set({
          threads: get().threads.map((item) => (
            item.id === threadId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item
          )),
        });
        schedulePush(threadId);
      },

      setActiveRun: (run) => set({ activeRun: run }),

      mergeRemoteThreads: (remote) => {
        if (!Array.isArray(remote) || remote.length === 0) return;
        const local = get().threads;
        const next = [...local];
        const pushUps: ChatThread[] = [];
        for (const item of remote) {
          const threadId = String(item?.id || '');
          if (!threadId) continue;
          const remoteAt = Date.parse(String(item.updatedAt || ''));
          const index = next.findIndex((candidate) => candidate.id === threadId);
          if (index < 0) {
            next.push(item);
            continue;
          }
          const localAt = Date.parse(String(next[index].updatedAt || ''));
          // 远端更新：采用远端；本地更新：保留本地并回推，让别的浏览器也看得到
          if (Number.isFinite(remoteAt) && remoteAt > localAt) {
            next[index] = item;
          } else {
            pushUps.push(next[index]);
          }
        }
        const changed = pushUps.length > 0 || next.length !== local.length
          || next.some((item, index) => item !== local[index]);
        if (changed) set({ threads: next });
        for (const thread of pushUps) void putChatThread(thread);
      },
    }),
    {
      name: 'huiban-chat-v1',
      version: 2,
      storage: createJSONStorage(() => chatStorage()),
      migrate: (persisted) => {
        const state = (persisted || {}) as Record<string, unknown>;
        return {
          // open / activeCanvasId / activeRun 是会话态不持久化；线程与草稿要跨刷新保留。
          // 旧版草稿附件没有 canvasId / versionId 字段，一次性迁移时丢弃（草稿本是暂态）
          threads: migrateThreads(persisted),
          draft: typeof state.draft === 'string' ? state.draft : '',
          draftAttachments: [],
        };
      },
      partialize: (state) => ({
        threads: state.threads,
        draft: state.draft,
        draftAttachments: state.draftAttachments,
        draftBase: state.draftBase,
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
