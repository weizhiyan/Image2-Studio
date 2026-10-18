/**
 * 对话面板的消息渲染：占位 / 媒体格 / 定位按钮 / 工具过程卡 / 上下文徽标 / 空态。
 *
 * zustand 的 SSR 快照取 getInitialState()，renderToStaticMarkup therefore 永远渲染
 * 初始态（setState 看不见），所以这里 mock 掉 store——组件「给定状态渲染成什么样」
 * 由本测试覆盖，store 自身逻辑由 chatStore.test.ts 覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

interface MockState {
  threads: Array<Record<string, unknown>>;
  activeThreadId: string;
  activeCanvasId: string;
  open: boolean;
  draft: string;
  draftAttachments: Array<Record<string, unknown>>;
  draftBase: Record<string, unknown> | null;
  activeRun: { runId: string; threadId: string; messageId: string } | null;
  unread: boolean;
  messageScrollTop: number;
}

const { state } = vi.hoisted(() => {
  const mockState: Record<string, unknown> = {
    threads: [],
    activeThreadId: '',
    activeCanvasId: 'canvas-1',
    open: true,
    draft: '',
    draftAttachments: [],
    draftBase: null,
    activeRun: null,
    unread: false,
    messageScrollTop: 0,
  };
  // zustand 的 actions 就在 state 里（getState().appendMessage 可直接调），mock 照此办理
  Object.assign(mockState, {
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const id = String(message.id || `msg_${Math.random().toString(36).slice(2, 8)}`);
      const full = { ...message, id, createdAt: String(message.createdAt || new Date().toISOString()) };
      const threads = mockState.threads as Array<Record<string, unknown>>;
      const index = threads.findIndex((item) => item.id === threadId);
      if (index < 0) {
        threads.push({ id: threadId, canvasId: mockState.activeCanvasId, title: '新对话', messages: [full], createdAt: full.createdAt, updatedAt: full.createdAt });
      } else {
        const thread = threads[index];
        thread.messages = [...(thread.messages as Array<unknown>), full];
        thread.updatedAt = full.createdAt;
      }
      mockState.activeThreadId = threadId;
      return id;
    },
    patchMessage: (threadId: string, messageId: string, patch: Record<string, unknown>) => {
      const threads = mockState.threads as Array<Record<string, unknown>>;
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) return;
      thread.messages = (thread.messages as Array<Record<string, unknown>>).map((item) => (
        item.id === messageId ? { ...item, ...patch } : item
      ));
    },
    addDraftAttachment: (attachment: Record<string, unknown>) => {
      const current = mockState.draftAttachments as Array<Record<string, unknown>>;
      mockState.draftAttachments = [...current, attachment];
    },
    createThread: (canvasId: string) => {
      const id = `thread_${Math.random().toString(36).slice(2, 8)}`;
      (mockState.threads as Array<unknown>).push({ id, canvasId, title: '新对话', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      mockState.activeThreadId = id;
      return id;
    },
  });
  return { state: mockState as unknown as MockState };
});

vi.mock('@/stores/chatStore', () => {
  const useBoundStore = (selector: (s: MockState) => unknown) => selector(state);
  Object.assign(useBoundStore, {
    getState: () => state,
    setState: (partial: unknown) => {
      Object.assign(state, typeof partial === 'function' ? (partial as (s: MockState) => unknown)(state) : partial);
    },
  });
  return {
    useChatStore: useBoundStore,
    activeThreadOf: (s: MockState) => (s.activeThreadId ? (s.threads as Array<Record<string, unknown>>).find((item) => item.id === s.activeThreadId) : undefined),
    allThreads: (s: MockState) => [...s.threads as Array<Record<string, unknown>>],
    draftKeyOf: (ref: { nodeId: string; versionId?: string }) => `${ref.nodeId}@${ref.versionId || 'current'}`,
  };
});

const { default: ChatMessageList } = await import('@/components/chat/ChatMessageList');
const { useChatStore } = await import('@/stores/chatStore');

const noop = () => undefined;
const handlers = { onLocate: noop, onPreview: noop, onReference: noop, onContinueEdit: noop, onRetry: noop };

beforeEach(() => {
  state.threads = [];
  state.activeThreadId = '';
  state.draft = '';
  state.draftAttachments = [];
  state.draftBase = null;
  state.activeRun = null;
  state.messageScrollTop = 0;
});

describe('ChatMessageList', () => {
  it('空线程渲染引导文案', () => {
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('和 AI 对话，把图改出来');
    expect(html).toContain('点击画布图片即可引用');
  });

  it('用户消息：引用 chips（版本级快照）+ 气泡', () => {
    useChatStore.getState().appendMessage('thread-1', {
      role: 'user',
      content: '把这个 logo 的圆角改大',
      attachments: [{ canvasId: 'canvas-1', nodeId: 'image-1', versionId: 'ver-2', url: '/api/files/a.png', title: 'logo 草图 V2' }],
    });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('hb-chat-bubble');
    expect(html).toContain('把这个 logo 的圆角改大');
    expect(html).toContain('logo 草图 V2');
    expect(html).toContain('src="/api/files/a.png"');
  });

  it('结构化询问回答：用户消息显示可展开的答案摘要', () => {
    useChatStore.getState().appendMessage('thread-1', {
      role: 'user',
      content: '已回答：补充几个信息',
      askResponse: {
        title: '补充几个信息',
        questions: [{ id: 'subject', title: '主体是什么？', answers: ['产品本身'] }],
      },
    });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('hb-chat-ask-response');
    expect(html).toContain('补充几个信息');
    expect(html).toContain('1 个问题');
  });

  it('运行中：占位消息出 dots，不出媒体格', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '画一个咖啡杯' });
    useChatStore.getState().appendMessage('thread-1', { role: 'assistant', content: '', status: 'running' });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('hb-chat-pending');
    expect(html).toContain('正在思考');
    expect(html).not.toContain('hb-chat-media');
  });

  it('生图工具运行中：显示与节点同源的生成动画区', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '画一个咖啡杯' });
    useChatStore.getState().appendMessage('thread-1', {
      role: 'assistant',
      content: '',
      status: 'running',
      toolCalls: [{
        id: 'c1', name: 'generate_image', args: { prompt: '咖啡杯' }, status: 'running', steps: ['正在调用生图工具'],
      }],
    });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('hb-chat-generation-stage');
    expect(html).toContain('正在生成图片');
  });

  it('出图：媒体格带编号，只保留定位动作', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '画一个咖啡杯' });
    useChatStore.getState().appendMessage('thread-1', {
      role: 'assistant',
      content: '',
      media: [{ url: '/api/files/a.png', fileName: 'a.png', nodeId: 'composer-1', versionId: 'ver-1', prompt: '画一个咖啡杯', model: 'm', size: '1K' }],
    });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('hb-chat-media');
    expect(html).toContain('图 1');
    expect(html).toContain('aria-label="定位第 1 张图到画布"');
    expect(html).not.toContain('aria-label="引用第 1 张图到输入框"');
    expect(html).not.toContain('aria-label="以第 1 张图为基准继续编辑"');
    expect(html).not.toContain('aria-label="预览第 1 张图"');
    expect(html).toContain('alt="画一个咖啡杯"');
  });

  it('工具过程卡：折叠态显示摘要，展开看参数与步骤', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '画一个咖啡杯' });
    useChatStore.getState().appendMessage('thread-1', {
      role: 'assistant',
      content: '好的，按这个方向来',
      toolCalls: [{
        id: 'c1', name: 'generate_image',
        args: { prompt: '简约咖啡杯 logo，暖红主色', count: 2, referenceImages: [1] },
        status: 'done', steps: ['已理解你的方向', '正在调用生图工具', '已生成 2 张候选图，落在画布上'],
      }],
    });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('hb-chat-tool');
    expect(html).toContain('简约咖啡杯 logo');
    expect(html).toContain('已完成');
  });

  it('上下文徽标：续接 / 重置两种文案', () => {
    useChatStore.getState().appendMessage('thread-1', {
      role: 'assistant',
      content: '',
      context: { baseVersionId: 'ver-1', responseId: 'resp-1', referenceCount: 2 },
    });
    const linked = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(linked).toContain('已续接上一轮上下文 · 参考图 2 张');

    useChatStore.getState().appendMessage('thread-1', {
      role: 'assistant',
      content: '',
      context: { referenceCount: 0, resetReason: '模型配置或接口模式变了，上下文从这里重新开始' },
    });
    const reset = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(reset).toContain('上下文已重置：模型配置或接口模式变了');
  });

  it('失败消息：错误原因 + 重试入口渲染在消息里（不只靠 toast）', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '画一个咖啡杯' });
    useChatStore.getState().appendMessage('thread-1', { role: 'assistant', content: '', status: 'error', error: '「默认配置」未配置 API Key' });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('hb-chat-error');
    expect(html).toContain('未配置 API Key');
    expect(html).toContain('重试');
  });

  it('停止消息：显示已停止，不给完成态', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '画一个咖啡杯' });
    useChatStore.getState().appendMessage('thread-1', { role: 'assistant', content: '一半', status: 'stopped' });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('已停止，结果未继续生成');
  });

  it('状态未知：刷新后 bridge 丢了 run，不伪装成完成', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '画一个咖啡杯' });
    useChatStore.getState().appendMessage('thread-1', { role: 'assistant', content: '', status: 'unknown' });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('运行状态未知');
  });
});
