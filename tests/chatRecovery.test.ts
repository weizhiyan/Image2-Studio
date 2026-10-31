import { afterEach, describe, expect, it, vi } from 'vitest';
import * as events from '@/lib/chatRunEvents';
import type { ChatThread } from '@/types';
import * as bridge from '@/lib/bridge';
import type { ChatRunEvent } from '@/lib/bridge';

const thread = (content = 'partial'): ChatThread => ({ id: 't', title: 'test', messages: [
  { id: 'u', role: 'user', content: 'original', createdAt: 'now' },
  { id: 'a', role: 'assistant', content, status: 'running', createdAt: 'now' },
], createdAt: 'now', updatedAt: 'now' });
const initial = () => ({ thread: thread(), activeRun: { runId: 'r', threadId: 't', messageId: 'a', seq: 4 } });
const event = (payload: Record<string, unknown>) => ({ runId: 'r', messageId: 'a', ...payload }) as ChatRunEvent;
// Namespace lookup lets RED fail on the missing behavior rather than an import error.
const reduce = (state: ReturnType<typeof initial>, value: ChatRunEvent) => (events as any).reduceChatRunEvent(state, value);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('chat bridge recovery contract', () => {
  it('exposes a conflict thread instead of swallowing CAS rejection', async () => {
    const remote = thread('server assistant');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: remote, msg: 'conflict' }), { status: 409 })));
    await expect(bridge.putChatThread(thread(), { metadataOnly: true })).rejects.toMatchObject({ status: 409, current: remote });
  });
  it('treats only GET run 404 as missing, not a failed connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect(await (bridge as any).getChatRun('r')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect((bridge as any).getChatRun('r')).rejects.toThrow('offline');
  });
  it('retries an ambiguous run POST using the exact same idempotency request', async () => {
    const request = { requestId: 'stable', threadId: 't', canvasId: 'c', thread: thread(), references: [], assistantMessageId: 'a' };
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('connection lost after accept')).mockResolvedValueOnce(new Response(JSON.stringify({ data: { runId: 'only-run' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await bridge.startChatRun(request)).toBe('only-run');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  });
  it('a rejected confirmation only posts approved=false to the run endpoint', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await bridge.confirmChatRun('r', 'c', false)).toBe(true);
    expect(fetcher.mock.calls).toMatchObject([['/api/chat/runs/r/confirm', { method: 'POST', body: JSON.stringify({ callId: 'c', approved: false }) }]]);
  });
  it('uses explicit memory CAS endpoints and returns updated thread', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: thread() }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await (bridge as any).saveChatThreadMemory('t', { summary: 'manual' }, 9);
    expect(fetcher.mock.calls[0]).toMatchObject(['/api/chat/threads/t/memory', { method: 'PATCH', body: JSON.stringify({ memory: { summary: 'manual' }, expectedRevision: 9 }) }]);
    await (bridge as any).clearChatThreadMemory('t', 10);
    expect(fetcher.mock.calls[1]).toMatchObject(['/api/chat/threads/t/memory?revision=10', { method: 'DELETE' }]);
  });
});
describe('client persistence ownership', () => {
  it('does not push streamed assistant or run placeholders back to the server', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: thread() }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const { useChatStore } = await import('@/stores/chatStore');
    useChatStore.setState({ threads: [thread()], activeRun: null });
    useChatStore.getState().appendMessage('t', { role: 'user', content: 'new send' });
    useChatStore.getState().appendMessage('t', { role: 'assistant', content: '', status: 'running' });
    useChatStore.getState().patchMessage('t', 'a', { content: 'streaming entire reply' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('metadata CAS conflict merges authoritative assistant and keeps unsent user', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: { ...thread('server final'), revision: 2 } }), { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    const { useChatStore } = await import('@/stores/chatStore');
    const local = thread('old');
    local.messages.push({ id: 'unsent', role: 'user', content: 'not accepted', createdAt: 'now' });
    useChatStore.setState({ threads: [local] });
    useChatStore.getState().renameThread('t', 'new title');
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ metadataOnly: true, messages: [] });
    const merged = useChatStore.getState().threads[0];
    expect(merged.messages.find((m) => m.id === 'a')?.content).toBe('server final');
    expect(merged.messages.at(-1)?.id).toBe('unsent');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('metadata acknowledgement never regresses a newer in-memory run message', async () => {
    const { useChatStore } = await import('@/stores/chatStore');
    const local = { ...thread('latest stream'), revision: 1 };
    local.messages[1].runId = 'r';
    useChatStore.setState({ threads: [local], activeRun: initial().activeRun, runEventCursors: {} });
    const acknowledgement = { ...thread('persisted prefix'), revision: 2, title: 'renamed' };
    acknowledgement.messages[1].runId = 'r';
    useChatStore.getState().mergeRemoteThreads([acknowledgement]);
    expect(useChatStore.getState().threads[0].messages[1].content).toBe('latest stream');
    expect(useChatStore.getState().threads[0].title).toBe('renamed');
  });
  it('persists terminal cursor ownership so stale snapshots cannot overwrite final output', async () => {
    const { useChatStore } = await import('@/stores/chatStore');
    useChatStore.setState({ threads: [thread()], activeRun: initial().activeRun, runEventCursors: {} });
    useChatStore.getState().applyRunEvents('t', [event({ type: 'snapshot', seq: 100, status: 'done', thread: thread('final'), generation: 0 })]);
    useChatStore.getState().applyRunEvents('t', [event({ type: 'snapshot', seq: 50, status: 'done', thread: thread('old partial'), generation: 0 })]);
    expect(useChatStore.getState().threads[0].messages[1].content).toBe('final');
    expect(useChatStore.getState().activeRun).toBeNull();
  });
  it('scroll events do not serialize threads and local persistence is throttled until flush', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const writes = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: writes, removeItem: vi.fn() });
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    const store = await import('@/stores/chatStore');
    store.useChatStore.setState({ threads: [thread()] });
    store.flushChatPersistence();
    writes.mockClear();
    for (let index = 0; index < 100; index++) store.useChatStore.getState().setMessageScrollTop(index);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).not.toHaveBeenCalled();
    for (let index = 0; index < 100; index++) store.useChatStore.getState().patchMessage('t', 'a', { content: String(index) });
    expect(writes).not.toHaveBeenCalled();
    store.flushChatPersistence();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes.mock.calls[0][1]).state.threads[0].messages[1].content).toBe('99');
  });
});

describe('authoritative run recovery', () => {
  it('replaces snapshot text without replaying its baseline, retaining an unsent user', () => {
    const state = initial();
    state.thread.messages.push({ id: 'unsent', role: 'user', content: 'local draft', createdAt: 'now' });
    const next = reduce(state, event({ type: 'snapshot', seq: 900, status: 'running', thread: thread('all 900 events'), generation: 0 }));
    expect(next.thread.messages.find((m: any) => m.id === 'a').content).toBe('all 900 events');
    expect(next.thread.messages.at(-1).id).toBe('unsent');
    expect(reduce(next, event({ type: 'message_delta', seq: 899, text: 'duplicate' }))).toBe(next);
    expect(next.activeRun.seq).toBe(900);
  });
  it('applies higher run seq output even when metadata revision is newer, retaining that metadata', () => {
    const state = initial();
    Object.assign(state.thread, { revision: 9, title: 'new metadata', memory: { summary: 'manual memory', memoryRevision: 4 } });
    state.thread.messages[1].runId = 'r';
    const remote = thread('latest streamed text');
    remote.messages[1].runId = 'r';
    Object.assign(remote, { revision: 2, title: 'old metadata', memory: { summary: 'old', memoryRevision: 1 } });
    const next = reduce(state, event({ type: 'snapshot', seq: 50, status: 'running', thread: remote, generation: 0 }));
    expect(next.thread.messages[1].content).toBe('latest streamed text');
    expect(next.thread.title).toBe('new metadata');
    expect(next.thread.revision).toBe(9);
    expect(next.thread.memory.summary).toBe('manual memory');
  });
  it('never revives a terminal message from a late running snapshot', () => {
    const state = initial();
    state.thread.messages[1].status = 'stopped';
    const done = reduce(state, event({ type: 'snapshot', seq: 5, status: 'running', thread: thread('late partial'), generation: 0 }));
    expect(done.thread.messages[1].status).toBe('stopped');
    expect(done.activeRun).toBeNull();
  });
  it('restores confirmation from snapshot and resolves only the matching call', () => {
    const confirmation = { callId: 'c', prompt: 'p', model: 'm', size: 's', count: 2, totalCount: 2, cost: 'unknown', expiresAt: 'future' };
    const next = reduce(initial(), event({ type: 'snapshot', seq: 10, status: 'running', thread: thread(), generation: 0, pendingConfirmation: confirmation }));
    expect(next.activeRun.pendingConfirmation).toEqual(confirmation);
    expect(reduce(next, event({ type: 'confirmation_resolved', callId: 'other', seq: 11, approved: true })).activeRun.pendingConfirmation).toEqual(confirmation);
    expect(reduce(next, event({ type: 'confirmation_resolved', callId: 'c', seq: 11, approved: false })).activeRun.pendingConfirmation).toBeUndefined();
  });
  it('does not apply a gap and requests an authoritative resubscription', () => {
    const next = reduce(initial(), event({ type: 'message_delta', seq: 6, text: 'lost prefix' }));
    expect(next.needsSnapshot).toBe(true);
    expect(next.thread.messages[1].content).toBe('partial');
    expect(next.activeRun.seq).toBe(4);
  });
  it('routes clarification continuation by envelope messageId', () => {
    const state = initial();
    state.thread.messages.push({ id: 'b', role: 'assistant', content: '', status: 'running', createdAt: 'now' });
    const next = reduce(state, event({ type: 'message_delta', messageId: 'b', seq: 5, text: 'continuation' }));
    expect(next.thread.messages[1].content).toBe('partial');
    expect(next.thread.messages[2].content).toBe('continuation');
    expect(next.activeRun.messageId).toBe('b');
  });
  it('adopts done thread revision so the next run uses the accepted baseline', () => {
    const remote = { ...thread('final'), revision: 12, generation: 2 };
    remote.messages[1].status = 'done';
    const done = reduce(initial(), event({ type: 'message_done', seq: 5, status: 'done', message: remote.messages[1], thread: remote }));
    expect(done.thread.revision).toBe(12);
    expect(done.thread.generation).toBe(2);
    expect(done.thread.messages[1].content).toBe('final');
  });
  it('does not release an erroring run on a running snapshot before terminal persistence', () => {
    const failed = reduce(initial(), event({ type: 'error', seq: 5, message: 'failed' }));
    const pending = reduce(failed, event({ type: 'snapshot', seq: 5, status: 'running', thread: thread('persisting error'), generation: 0 }));
    expect(pending.activeRun?.runId).toBe('r');
    expect(pending.thread.messages[1].status).toBe('error');
  });
  it('retains run ownership through error notification until final message content arrives', () => {
    const failed = reduce(initial(), event({ type: 'error', seq: 5, message: 'failed' }));
    expect(failed.activeRun?.runId).toBe('r');
    expect(failed.thread.messages[1].status).toBe('error');
    const done = reduce(failed, event({ type: 'message_done', seq: 6, status: 'error', message: { ...thread().messages[1], status: 'error', content: 'complete final' } }));
    expect(done.activeRun).toBeNull();
    expect(done.thread.messages[1].content).toBe('complete final');
  });
  it('keeps error final content and ignores late delta, while allowing a newer snapshot correction', () => {
    const done = reduce(initial(), event({ type: 'message_done', seq: 5, status: 'error', message: { ...thread().messages[1], content: 'final error text', status: 'error', error: 'failed' } }));
    expect(done.activeRun).toBeNull();
    expect(done.thread.messages[1]).toMatchObject({ content: 'final error text', status: 'error' });
    const late = reduce(done, event({ type: 'message_delta', seq: 6, text: 'late' }));
    expect(late.thread.messages[1].content).toBe('final error text');
    const corrected = reduce(late, event({ type: 'snapshot', seq: 7, status: 'error', thread: thread('corrected'), generation: 0 }));
    expect(corrected.thread.messages[1].content).toBe('corrected');
    expect(corrected.activeRun).toBeNull();
  });
  it('retries from original request and effective answers, not clarification summary', () => {
    const t = thread();
    const source = { content: 'original requirement', agentRole: { id: 'r', name: 'original role', systemPrompt: '', skills: [] }, modelSelection: { textModel: 'original model' }, answers: { q: ['yes'] } };
    t.messages.push({ id: 'answer', role: 'user', content: '已回答：补充几个信息', askResponse: { title: '补充', questions: [] }, createdAt: 'now' });
    t.messages.push({ id: 'continued', role: 'assistant', content: 'failed', status: 'error', retrySource: source, createdAt: 'now' });
    expect(events.retrySourceForMessage(t, 'continued')).toEqual(source);
    delete t.messages[3].retrySource;
    expect(events.retrySourceForMessage(t, 'continued')?.content).toBe('original');
  });
  it('StrictMode setup-cleanup-setup keeps one live subscription and never clears partial content', async () => {
    const { useChatStore } = await import('@/stores/chatStore');
    const { recoverChatRun } = events as any;
    class Source extends EventTarget {
      static all: Source[] = [];
      close = vi.fn();
      constructor(readonly url: string) { super(); Source.all.push(this); }
      emit(data: unknown) { this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(data) })); }
    }
    vi.stubGlobal('EventSource', Source);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    useChatStore.setState({ threads: [thread()], activeRun: initial().activeRun, runEventCursors: {} });
    const handlers = { apply: (values: ChatRunEvent[]) => useChatStore.getState().applyRunEvents('t', values), getRun: () => useChatStore.getState().activeRun, onMissing: vi.fn(), onError: vi.fn() };
    const first = recoverChatRun(initial().activeRun, handlers);
    first();
    const second = recoverChatRun(initial().activeRun, handlers);
    await Promise.resolve(); await Promise.resolve();
    expect(Source.all.filter((source) => !source.close.mock.calls.length)).toHaveLength(1);
    expect(useChatStore.getState().threads[0].messages[1].content).toBe('partial');
    expect(handlers.onMissing).not.toHaveBeenCalled();
    Source.all.at(-1)!.emit(event({ type: 'snapshot', seq: 500, status: 'done', thread: thread('complete'), generation: 0 }));
    expect(useChatStore.getState().threads[0].messages[1].content).toBe('complete');
    expect(useChatStore.getState().activeRun).toBeNull();
    second();
  });
  it('batches 100 deltas and flushes all text before a final snapshot', () => {
    vi.useFakeTimers();
    const receive = vi.fn();
    const batch = (events as any).createRunEventBatcher(receive);
    for (let seq = 1; seq <= 100; seq++) batch.push(event({ type: 'message_delta', seq, text: 'x' }));
    expect(receive).not.toHaveBeenCalled();
    batch.push(event({ type: 'snapshot', seq: 100, status: 'done', thread: thread('x'.repeat(100)), generation: 0 }));
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls[0][0]).toHaveLength(100);
    batch.dispose();
    vi.runAllTimers();
    expect(receive).toHaveBeenCalledTimes(2);
  });
});
