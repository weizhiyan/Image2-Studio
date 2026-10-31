import type { ChatMessage, ChatThread } from '@/types';
import type { ChatRunConfirmation, ChatRunEvent } from './bridge';
import { getChatRun, subscribeChatRunEvents } from './bridge';
import { mergeChatRunMedia } from './chatRunMedia';

export interface RunEventCursor { runId: string; seq: number }
export interface RecoverableChatRun extends RunEventCursor {
  threadId: string;
  messageId: string;
  pendingConfirmation?: ChatRunConfirmation;
}
export interface ChatRunState {
  thread: ChatThread;
  activeRun: (Omit<RecoverableChatRun, 'seq'> & { seq?: number }) | null;
  cursor?: RunEventCursor;
  needsSnapshot?: boolean;
}
const terminal = (status?: string) => status === 'done' || status === 'stopped' || status === 'error';

export function nextRunEventCursor(cursor: RunEventCursor, runId: string, event: ChatRunEvent): RunEventCursor | null {
  if (typeof event.seq !== 'number') return cursor;
  if (cursor.runId === runId && event.seq <= cursor.seq) return null;
  return { runId, seq: event.seq };
}

/** Server messages win by ID, never by browser time. Only unsent local users survive. */
export function mergeAuthoritativeThread(local: ChatThread | undefined, remote: ChatThread): ChatThread {
  if (!local) return remote;
  if ((local.generation ?? 0) > (remote.generation ?? 0) || (local.revision ?? 0) > (remote.revision ?? 0)) return local;
  const ids = new Set(remote.messages.map((message) => message.id));
  const sameGeneration = (local.generation ?? 0) === (remote.generation ?? 0);
  // 只保留真正尚未提交的本地用户消息：带 requestId 的发送若服务端没有、本地也没有
  // 对应助手占位，说明它已被拒绝（如 409），不能当成未发送消息永久留在对话里。
  const unsent = sameGeneration ? local.messages.filter((message) => {
    if (message.role !== 'user' || message.runId || ids.has(message.id)) return false;
    if (!message.requestId) return true;
    return local.messages.some((entry) => entry.role === 'assistant' && entry.requestId === message.requestId);
  }) : [];
  return { ...remote, messages: [...remote.messages, ...unsent] };
}

/** A pure atomic reducer: text and its cursor are always committed together. */
export function reduceChatRunEvent(state: ChatRunState, event: ChatRunEvent): ChatRunState {
  const runId = event.runId || state.activeRun?.runId || state.cursor?.runId;
  if (!runId || (state.activeRun && state.activeRun.runId !== runId)) return state;
  const cursor = state.cursor || (state.activeRun ? { runId, seq: state.activeRun.seq ?? 0 } : undefined);
  const seq = event.seq ?? cursor?.seq ?? 0;
  if (cursor?.runId === runId && (seq < cursor.seq || (seq === cursor.seq && event.type !== 'snapshot'))) return state;
  if (event.type === 'snapshot') {
    if (event.thread.id !== state.thread.id || event.generation < (state.thread.generation ?? 0)) return state;
    const remote = { ...event.thread, generation: event.generation };
    const newerMetadata = (state.thread.revision ?? 0) > (remote.revision ?? 0);
    const merged = newerMetadata
      ? {
        ...state.thread,
        messages: [
          ...remote.messages.map((message) => {
            const local = state.thread.messages.find((item) => item.id === message.id);
            return message.runId === runId || local?.runId === runId || message.id === event.messageId ? message : local || message;
          }),
          ...state.thread.messages.filter((message) => message.role === 'user'
            && !message.runId
            && !remote.messages.some((item) => item.id === message.id)
            && (!message.requestId || state.thread.messages.some((entry) => entry.role === 'assistant' && entry.requestId === message.requestId))),
        ],
      }
      : mergeAuthoritativeThread(state.thread, remote);
    const messages = merged.messages.map((message) => {
      const previous = state.thread.messages.find((item) => item.id === message.id);
      if (message.id === event.messageId && terminal(event.status)) return { ...message, status: event.status as 'done' | 'stopped' | 'error' };
      return previous && terminal(previous.status) && !terminal(message.status) ? previous : message;
    });
    const thread = { ...merged, messages };
    const activeMessage = messages.find((message) => message.id === event.messageId);
    return {
      thread,
      cursor: { runId, seq },
      needsSnapshot: false,
      activeRun: terminal(event.status) || (!state.activeRun && terminal(activeMessage?.status)) || activeMessage?.status === 'stopped' || activeMessage?.status === 'done' ? null : {
        runId, threadId: thread.id, messageId: event.messageId, seq,
        ...(event.pendingConfirmation ? { pendingConfirmation: event.pendingConfirmation } : {}),
      },
    };
  }
  if (!state.activeRun) return state;
  if (typeof event.seq === 'number' && seq > (cursor?.seq ?? 0) + 1) return { ...state, needsSnapshot: true };
  if (state.needsSnapshot) return state;
  const messageId = event.messageId || state.activeRun.messageId;
  const original = state.thread.messages.find((item) => item.id === messageId);
  // Error/stop/done may correct a prior terminal event, but a delta never revives it.
  if (terminal(original?.status) && event.type !== 'message_done') return state;
  let message: ChatMessage = original || { id: messageId, role: 'assistant', content: '', status: 'running', createdAt: state.thread.updatedAt };
  let thread = state.thread;
  let activeRun: ChatRunState['activeRun'] = { ...state.activeRun, messageId, seq };
  switch (event.type) {
    case 'message_delta': message = { ...message, content: message.content + event.text }; break;
    case 'clarification_requested': message = { ...message, status: 'awaiting_input', clarifications: [...(message.clarifications || []).filter((item) => item.callId !== event.callId), { callId: event.callId, questions: event.questions, status: 'awaiting_input' }] }; break;
    case 'clarification_answered': message = { ...message, status: 'running', clarifications: (message.clarifications || []).map((item) => item.callId === event.callId ? { ...item, status: 'answered', answers: event.answers } : item) }; break;
    case 'confirmation_requested': activeRun.pendingConfirmation = event.confirmation; break;
    case 'confirmation_resolved': if (activeRun.pendingConfirmation?.callId === event.callId) activeRun.pendingConfirmation = undefined; break;
    case 'tool_started': message = { ...message, toolCalls: [...(message.toolCalls || []).filter((call) => call.id !== event.callId), { id: event.callId, name: event.name, args: event.args, status: 'running', steps: [], model: event.model, size: event.size, profileName: event.profileName, startedAt: event.startedAt }] }; break;
    case 'tool_progress': message = { ...message, toolCalls: (message.toolCalls || []).map((call) => call.id === event.callId ? { ...call, steps: [...call.steps, event.step] } : call) }; break;
    case 'image_completed':
      message = { ...message, media: mergeChatRunMedia(message.media || [], event.media), toolCalls: (message.toolCalls || []).map((call) => call.id === event.callId ? { ...call, media: mergeChatRunMedia(call.media || [], event.media), model: event.media.model || call.model, size: event.media.size || call.size } : call) };
      if (event.media.canvasId) thread = { ...thread, canvasId: event.media.canvasId };
      break;
    case 'context_updated': message = { ...message, context: event.context }; break;
    case 'memory_updated': thread = { ...thread, memory: event.memory }; break;
    case 'tool_finished': message = { ...message, toolCalls: (message.toolCalls || []).map((call) => call.id === event.callId ? { ...call, status: event.status, error: event.error, durationMs: event.durationMs, finishedAt: event.finishedAt } : call) }; break;
    case 'message_done':
      if (event.thread) thread = mergeAuthoritativeThread(thread, event.thread);
      message = { ...message, ...event.message, status: original?.status === 'error' ? 'error' : event.status };
      activeRun = null;
      break;
    case 'error': message = { ...message, status: 'error', error: event.message }; break;
    case 'thinking': message = { ...message, reasoning: `${message.reasoning || ''}${event.text}` }; break;
  }
  const messages = original ? thread.messages.map((item) => item.id === messageId ? message : item) : [...thread.messages, message];
  return { thread: { ...thread, messages }, activeRun, cursor: { runId, seq }, needsSnapshot: false };
}

/** Preserve individual seqs; coalesce store commits rather than inventing delta ranges. */
export function createRunEventBatcher(receive: (events: ChatRunEvent[]) => void, delay = 40) {
  let pending: ChatRunEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!pending.length) return;
    const events = pending;
    pending = [];
    receive(events);
  };
  return {
    push(event: ChatRunEvent) {
      if (event.type !== 'message_delta') { flush(); receive([event]); return; }
      pending.push(event);
      if (timer === undefined) timer = setTimeout(flush, delay);
    },
    flush,
    dispose: flush,
  };
}

/** Each setup owns its own cleanup, including StrictMode's second setup. */
export function recoverChatRun(
  run: Omit<RecoverableChatRun, 'seq'> & { seq?: number },
  handlers: {
    apply: (events: ChatRunEvent[]) => boolean;
    getRun: () => (Omit<RecoverableChatRun, 'seq'> & { seq?: number }) | null;
    onMissing: () => void;
    onError: (error: unknown) => void;
  },
): (() => void) & { flush: () => void } {
  let disposed = false;
  let subscription: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  const batch = createRunEventBatcher((events) => {
    if (disposed) return;
    const gap = handlers.apply(events);
    if (gap) {
      subscription?.();
      // Reconnect atomically through SSE's snapshot-first contract, not GET+subscribe.
      queueMicrotask(() => { if (!disposed) connect(); });
    }
  });
  const checkStatus = async () => {
    if (disposed || checking) return;
    checking = true;
    try {
      const snapshot = await getChatRun(run.runId);
      if (disposed) return;
      if (!snapshot) { subscription?.(); handlers.onMissing(); return; }
      batch.push({ ...snapshot, type: 'snapshot' });
    } catch (error) {
      if (!disposed) handlers.onError(error);
    } finally { checking = false; }
  };
  const connect = () => {
    const current = handlers.getRun();
    if (disposed || current?.runId !== run.runId) return;
    subscription = subscribeChatRunEvents(run.runId, (event) => batch.push(event), undefined, current.seq ?? 0, () => {
      void checkStatus();
    });
  };
  connect();
  // GET only distinguishes 404 from offline. SSE remains the authoritative handoff.
  void checkStatus();
  retryTimer = setInterval(() => { void checkStatus(); }, 15_000);
  const cleanup = () => {
    // flush before disabling ownership so the last delta's seq is persisted too.
    batch.flush();
    disposed = true;
    batch.dispose();
    subscription?.();
    if (retryTimer !== undefined) clearInterval(retryTimer);
  };
  return Object.assign(cleanup, { flush: batch.flush });
}

/** Continuations and retries use the original request, not the visible answer summary. */
export function retrySourceForMessage(thread: ChatThread, messageId: string): ChatMessage['retrySource'] | undefined {
  const index = thread.messages.findIndex((message) => message.id === messageId);
  const target = thread.messages[index];
  if (!target) return undefined;
  if (target.retrySource) return target.retrySource;
  for (let i = index - 1; i >= 0; i--) {
    const message = thread.messages[i];
    if (message.retrySource) return message.retrySource;
    if (message.role === 'user' && !message.askResponse) return { content: message.content, attachments: message.attachments, modelSelection: message.modelSelection, agentRole: message.agentRole };
  }
  return undefined;
}
