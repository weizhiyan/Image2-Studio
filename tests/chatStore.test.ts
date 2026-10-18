/**
 * 对话 store（全局线程版）：线程独立于画布、消息只增补不拥有数据、草稿引用版本级去重、
 * 启动合并按 updatedAt 取新的一侧、删除线程不碰画布节点。
 * 图片本体在画布节点上，这里只存引用。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { activeThreadOf, allThreads, normalizeLocalThread, useChatStore } from '@/stores/chatStore';
import type { ChatThread } from '@/types';

const emptyState = {
  threads: [] as ChatThread[],
  activeThreadId: '',
  activeCanvasId: '',
  open: false,
  draft: '',
  draftAttachments: [],
  draftBase: null,
  activeRun: null,
  unread: false,
  messageScrollTop: 0,
};

beforeEach(() => {
  useChatStore.setState(emptyState);
});

describe('chatStore 线程与消息', () => {
  it('首条消息建线程并按内容起标题', () => {
    const id = useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '画一个咖啡杯 logo\n第二行忽略' });
    expect(id).toBeTruthy();
    const thread = useChatStore.getState().threads[0];
    expect(thread.title).toBe('画一个咖啡杯 logo');
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].role).toBe('user');
  });

  it('appendMessage 返回 id，patchMessage 按 id 补 media / 清 running', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '第一轮' });
    const pending = useChatStore.getState().appendMessage('thread-1', { role: 'assistant', content: '', status: 'running' });
    useChatStore.getState().patchMessage('thread-1', pending, {
      status: 'done',
      media: [{ url: '/api/files/a.png', fileName: 'a.png', nodeId: 'composer-1', versionId: 'ver-1', prompt: '第一轮', model: 'm', size: '1K' }],
      context: { referenceCount: 0 },
    });
    const message = useChatStore.getState().threads[0].messages.find((item) => item.id === pending);
    expect(message?.status).toBe('done');
    expect(message?.media?.[0].versionId).toBe('ver-1');
  });

  it('patchMessage 对不存在的 id 是空操作', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: 'x' });
    const before = useChatStore.getState().threads[0];
    useChatStore.getState().patchMessage('thread-1', 'no-such-id', { error: 'boom' });
    expect(useChatStore.getState().threads[0]).toBe(before);
  });

  it('clearThread 清空消息但留线程；deleteThread 整条删', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: 'x' });
    useChatStore.getState().clearThread('thread-1');
    expect(useChatStore.getState().threads[0].messages).toHaveLength(0);
    useChatStore.setState({
      activeThreadId: 'thread-1',
      draft: '残留草稿',
      draftAttachments: [{ canvasId: 'canvas-1', nodeId: 'n1', url: '/api/files/a.png' }],
      draftBase: { canvasId: 'canvas-1', nodeId: 'n1', versionId: 'v1', url: '/api/files/a.png' },
      messageScrollTop: 120,
    });
    useChatStore.getState().deleteThread('thread-1');
    expect(useChatStore.getState().threads).toHaveLength(0);
    expect(useChatStore.getState().draft).toBe('');
    expect(useChatStore.getState().draftAttachments).toHaveLength(0);
    expect(useChatStore.getState().draftBase).toBeNull();
    expect(useChatStore.getState().messageScrollTop).toBe(0);
  });

  it('删当前线程后落到最近更新的线程', () => {
    useChatStore.getState().appendMessage('thread-a', { role: 'user', content: 'a' });
    useChatStore.getState().appendMessage('thread-b', { role: 'user', content: 'b' });
    useChatStore.setState({ activeThreadId: 'thread-a' });
    useChatStore.getState().deleteThread('thread-a');
    expect(useChatStore.getState().activeThreadId).toBe('thread-b');
  });

  it('renameThread 改标题，空标题拒绝', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: 'x' });
    useChatStore.getState().renameThread('thread-1', '咖啡杯迭代');
    expect(useChatStore.getState().threads[0].title).toBe('咖啡杯迭代');
    useChatStore.getState().renameThread('thread-1', '   ');
    expect(useChatStore.getState().threads[0].title).toBe('咖啡杯迭代');
  });
});

describe('chatStore 本地历史迁移', () => {
  it('清理线程、附件和媒体中的异常画布标识', () => {
    const normalized = normalizeLocalThread({
      id: 'thread-dirty',
      canvasId: '[object Object]',
      title: '旧对话',
      messages: [{
        id: 'm1',
        role: 'user',
        content: '继续修改',
        attachments: [{ canvasId: '[object Object]', nodeId: 'n1', versionId: 'v1' }],
        media: [{ canvasId: '[object Object]', nodeId: 'n1', versionId: 'v1', url: '/api/files/a.png', fileName: 'a.png', prompt: 'p', model: 'm', size: '1K' }],
      }],
    });
    expect(normalized?.canvasId).toBeUndefined();
    expect(normalized?.messages[0].attachments?.[0].canvasId).toBe('');
    expect(normalized?.messages[0].media?.[0].canvasId).toBeUndefined();
  });
});

describe('chatStore 全局线程', () => {
  it('刷新后切入画布会恢复最近更新的历史线程', () => {
    const store = useChatStore.getState();
    const oldThread = store.createThread('canvas-old');
    store.appendMessage(oldThread, { role: 'user', content: '旧对话' });
    const latestThread = store.createThread('canvas-latest');
    store.appendMessage(latestThread, { role: 'user', content: '最新对话' });
    useChatStore.setState({ activeThreadId: '' });
    store.setActiveCanvas('canvas-current');
    expect(useChatStore.getState().activeThreadId).toBe(latestThread);
  });

  it('切换画布不切换当前线程', () => {
    const store = useChatStore.getState();
    const t1 = store.createThread('canvas-1');
    const t2 = store.createThread('canvas-2');
    store.appendMessage(t1, { role: 'user', content: '画布1的话' });
    store.appendMessage(t2, { role: 'user', content: '画布2的话' });
    useChatStore.getState().switchThread(t1);
    useChatStore.getState().setActiveCanvas('canvas-2');
    expect(useChatStore.getState().activeThreadId).toBe(t1);
    expect(activeThreadOf(useChatStore.getState())?.messages[0].content).toBe('画布1的话');
  });

  it('activeThreadOf 不要求线程属于当前画布', () => {
    const t1 = useChatStore.getState().createThread('canvas-1');
    useChatStore.getState().appendMessage(t1, { role: 'user', content: 'x' });
    useChatStore.getState().setActiveCanvas('canvas-2');
    expect(activeThreadOf(useChatStore.getState())?.id).toBe(t1);
  });

  it('切换画布保留明确引用及图片基准', () => {
    const store = useChatStore.getState();
    store.createThread('canvas-1');
    store.addDraftAttachment({ canvasId: 'canvas-1', nodeId: 'n1', versionId: 'v1', url: '/api/files/a.png' });
    store.setDraftBase({ canvasId: 'canvas-1', nodeId: 'n1', versionId: 'v1', url: '/api/files/a.png' });
    store.setActiveCanvas('canvas-2');
    expect(useChatStore.getState().draftAttachments).toHaveLength(1);
    expect(useChatStore.getState().draftBase?.canvasId).toBe('canvas-1');
  });

	it('历史列表跨画布按更新时间排序', () => {
    const store = useChatStore.getState();
    const t1 = store.createThread('canvas-1');
    const t2 = store.createThread('canvas-2');
    const t3 = store.createThread();
    store.appendMessage(t1, { role: 'user', content: 'old' });
    store.appendMessage(t2, { role: 'user', content: 'new' });
    store.appendMessage(t3, { role: 'user', content: 'newest' });
    // 同一毫秒内 updatedAt 会打平：显式把 t2 推新，验证排序口径
    useChatStore.setState({
      threads: useChatStore.getState().threads.map((item) => (
        item.id === t1 ? { ...item, updatedAt: '2026-10-14T00:00:00.000Z' }
          : item.id === t2 ? { ...item, updatedAt: '2026-10-14T00:00:02.000Z' }
            : { ...item, updatedAt: '2026-10-14T00:00:01.000Z' }
      )),
    });
    const list = allThreads(useChatStore.getState());
    expect(list.map((item) => item.id)).toEqual([t2, t3, t1]);
  });

  it('新建线程可脱离画布并清空草稿上下文', () => {
    const store = useChatStore.getState();
    store.setDraft('旧对话草稿');
    store.addDraftAttachment({ canvasId: 'canvas-1', nodeId: 'n1', versionId: 'v1', url: '/api/files/a.png' });
    store.setDraftBase({ canvasId: 'canvas-1', nodeId: 'n1', versionId: 'v1', url: '/api/files/a.png' });
    const id = store.createThread('');
    const thread = useChatStore.getState().threads.find((item) => item.id === id);
    expect(thread?.canvasId).toBeUndefined();
    expect(useChatStore.getState().draft).toBe('');
    expect(useChatStore.getState().draftAttachments).toHaveLength(0);
    expect(useChatStore.getState().draftBase).toBeNull();
  });
});

describe('chatStore 草稿引用', () => {
  it('同节点换版本替换、同节点同版本去重、不同节点新增', () => {
    const store = useChatStore.getState();
    store.addDraftAttachment({ canvasId: 'canvas-1', nodeId: 'n1', versionId: 'v1', url: '/api/files/a.png', title: '图A' });
    store.addDraftAttachment({ canvasId: 'canvas-1', nodeId: 'n1', versionId: 'v1', url: '/api/files/a.png', title: '图A' });
    expect(useChatStore.getState().draftAttachments).toHaveLength(1);
    // 同一节点换了版本：替换，chip 永远指向选中的那个版本
    store.addDraftAttachment({ canvasId: 'canvas-1', nodeId: 'n1', versionId: 'v2', url: '/api/files/b.png', title: '图B' });
    let drafts = useChatStore.getState().draftAttachments;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].versionId).toBe('v2');
    // 不同节点不同图才收
    store.addDraftAttachment({ canvasId: 'canvas-1', nodeId: 'n2', url: '/api/files/c.png', title: '图C' });
    drafts = useChatStore.getState().draftAttachments;
    expect(drafts).toHaveLength(2);
  });

  it('reorderDraftAttachments 按 key 全量重排', () => {
    const store = useChatStore.getState();
    store.addDraftAttachment({ canvasId: 'canvas-1', nodeId: 'n1', url: '/api/files/a.png' });
    store.addDraftAttachment({ canvasId: 'canvas-1', nodeId: 'n2', url: '/api/files/b.png' });
    useChatStore.getState().reorderDraftAttachments(['n2@current', 'n1@current']);
    const drafts = useChatStore.getState().draftAttachments;
    expect(drafts[0].nodeId).toBe('n2');
    expect(drafts[1].nodeId).toBe('n1');
  });

  it('removeDraftAttachment 按 key 摘除；clearDraft 连文本带附件一起清', () => {
    const store = useChatStore.getState();
    store.addDraftAttachment({ canvasId: 'canvas-1', nodeId: 'n1', url: '/api/files/a.png' });
    useChatStore.getState().setDraft('写点啥');
    useChatStore.getState().removeDraftAttachment('n1@current');
    expect(useChatStore.getState().draftAttachments).toHaveLength(0);
    useChatStore.getState().addDraftAttachment({ canvasId: 'canvas-1', nodeId: 'n1', url: '/api/files/a.png' });
    useChatStore.getState().clearDraft();
    expect(useChatStore.getState().draft).toBe('');
    expect(useChatStore.getState().draftAttachments).toHaveLength(0);
  });

  it('draftBase：设置与清除', () => {
    useChatStore.getState().setDraftBase({ canvasId: 'canvas-1', nodeId: 'n1', versionId: 'v1', url: '/api/files/a.png', title: '基准' });
    expect(useChatStore.getState().draftBase?.nodeId).toBe('n1');
    useChatStore.getState().setDraftBase(null);
    expect(useChatStore.getState().draftBase).toBeNull();
  });
});

describe('chatStore 运行态与未读', () => {
  it('setActiveRun / setOpen 联动清未读', () => {
    useChatStore.getState().markUnread();
    expect(useChatStore.getState().unread).toBe(true);
    useChatStore.getState().setOpen(true);
    expect(useChatStore.getState().unread).toBe(false);
    useChatStore.getState().setActiveRun({ runId: 'r1', threadId: 'thread-1', messageId: 'm1' });
    expect(useChatStore.getState().activeRun?.runId).toBe('r1');
    useChatStore.getState().setActiveRun(null);
    expect(useChatStore.getState().activeRun).toBeNull();
  });
});

describe('chatStore 启动合并', () => {
  it('本地没有的线程直接采用', () => {
    useChatStore.getState().mergeRemoteThreads([
      { id: 't-9', canvasId: 'canvas-1', title: '远端', messages: [], createdAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:00:00.000Z' },
    ]);
    expect(useChatStore.getState().threads).toHaveLength(1);
    expect(useChatStore.getState().threads[0].title).toBe('远端');
  });

  it('远端更新覆盖本地', () => {
    useChatStore.getState().appendMessage('t-1', { role: 'user', content: '本地旧' });
    const localAt = useChatStore.getState().threads[0].updatedAt;
    useChatStore.getState().mergeRemoteThreads([
      {
        id: 't-1', canvasId: 'canvas-1', title: '远端新',
        messages: [{ id: 'm1', role: 'user', content: '远端新', createdAt: '2026-10-13T10:00:00.000Z' }],
        createdAt: '2026-10-13T10:00:00.000Z',
        updatedAt: new Date(Date.parse(localAt) + 60_000).toISOString(),
      },
    ]);
    expect(useChatStore.getState().threads[0].messages[0].content).toBe('远端新');
  });

  it('本地更新不被远端旧快照冲掉', () => {
    useChatStore.getState().appendMessage('t-1', { role: 'user', content: '本地新' });
    useChatStore.getState().mergeRemoteThreads([
      {
        id: 't-1', canvasId: 'canvas-1', title: '远端旧',
        messages: [{ id: 'm1', role: 'user', content: '远端旧', createdAt: '2026-01-01T00:00:00.000Z' }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(useChatStore.getState().threads[0].messages[0].content).toBe('本地新');
  });

  it('空数组是空操作', () => {
    useChatStore.getState().appendMessage('t-1', { role: 'user', content: 'x' });
    const before = useChatStore.getState().threads;
    useChatStore.getState().mergeRemoteThreads([]);
    expect(useChatStore.getState().threads).toBe(before);
  });
});
