/**
 * 对话面板的消息渲染：占位 / 媒体格 / 定位按钮 / 工具过程卡 / 上下文徽标 / 空态。
 *
 * zustand 的 SSR 快照取 getInitialState()，renderToStaticMarkup therefore 永远渲染
 * 初始态（setState 看不见），所以这里 mock 掉 store——组件「给定状态渲染成什么样」
 * 由本测试覆盖，store 自身逻辑由 chatStore.test.ts 覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

const CHAT_CSS = readFileSync(new URL('../src/components/chat/ChatPanel.css', import.meta.url), 'utf8');
const GLOBAL_CSS = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const CHAT_PANEL_SOURCE = readFileSync(new URL('../src/components/chat/ChatPanel.tsx', import.meta.url), 'utf8');
const CHAT_MESSAGE_LIST_SOURCE = readFileSync(new URL('../src/components/chat/ChatMessageList.tsx', import.meta.url), 'utf8');

interface MockState {
  threads: Array<Record<string, unknown>>;
  activeThreadId: string;
  activeCanvasId: string;
  open: boolean;
  draft: string;
  draftAttachments: Array<Record<string, unknown>>;
  draftBase: Record<string, unknown> | null;
  activeRun: { runId: string; threadId: string; messageId: string } | null;
  activeRoleId: string;
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
    activeRoleId: '',
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
  state.activeRoleId = '';
});

describe('clarification and cost controls', () => {
  it('keeps memory automatic while displaying restored image confirmation with unknown cost', async () => {
    const { default: Panel } = await import('@/components/chat/ChatPanel');
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: 'request' });
    (state as any).activeRun = { runId: 'r', threadId: 'thread-1', messageId: 'a', pendingConfirmation: { callId: 'c', prompt: 'image prompt', model: 'image-model', size: '1024x1024', count: 3, totalCount: 4, cost: 'unknown', expiresAt: '2099-01-01T00:00:00Z' } };
    const html = renderToStaticMarkup(<Panel onSend={noop} onStop={noop} onLocate={noop} onPreview={noop} onRetry={noop} onAnswerClarification={async () => true} />);
    expect(html).not.toContain('对话记忆');
    expect(html).toContain('本次 3 张');
    expect(html).toContain('累计 4 张');
    expect(html).toContain('费用未知');
    expect(html).toContain('确认生成');
    expect(html).toContain('取消生成');
  });
  it('renders an open text question without forced choices and distinguishes optional skip from cancelling run', async () => {
    const { default: Modal } = await import('@/components/chat/ClarificationModal');
    const html = renderToStaticMarkup(<Modal request={{ callId: 'ask', questions: [{ id: 'q', title: '精确文字', type: 'text', optional: true, multiple: false, options: [] }] }} onSubmit={async () => true} onCancel={async () => true} />);
    expect(html).toContain('<textarea');
    expect(html).not.toContain('radiogroup');
    expect(html).toContain('跳过此题');
    expect(html).toContain('取消任务');
  });
  it('serializes text and optional empty answers without adding phantom options', async () => {
    const { serializeClarificationAnswers } = await import('@/components/chat/ClarificationModal');
    expect(serializeClarificationAnswers([
      { id: 'text', title: 'text', type: 'text', multiple: false, options: [] },
      { id: 'skip', title: 'skip', optional: true, multiple: false, options: [] },
    ], {}, { text: '  exact words  ' })).toEqual({ text: ['exact words'], skip: [] });
  });
  it('renders single/multiple explicit types and recommended choices', async () => {
    const { default: Modal } = await import('@/components/chat/ClarificationModal');
    const html = renderToStaticMarkup(<Modal request={{ callId: 'ask', questions: [{ id: 'q', title: '风格', type: 'multiple', multiple: false, options: [{ value: 'v', label: '推荐风格', recommended: true }] }] }} onSubmit={async () => true} onCancel={async () => true} />);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('推荐');
  });
});

describe('ChatMessageList', () => {
  it('空线程渲染引导文案', () => {
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('和 AI 对话，把图改出来');
    expect(html).toContain('点击画布图片即可引用');
  });

  it('角色名称与头像随消息悬停一起出现，不要求再悬停头像', () => {
    expect(CHAT_CSS).toMatch(/\.hb-chat-msg-role-name\s*\{[^}]*white-space:\s*nowrap/s);
    expect(CHAT_CSS).not.toMatch(/\.hb-chat-msg-role:hover \.hb-chat-msg-role-name/);
    expect(CHAT_CSS).not.toMatch(/\.hb-chat-msg-role-name\s*\{[^}]*opacity:\s*0/s);
  });

  it('助手消息带 reasoning 时渲染可折叠的思考过程，且与正文分开', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '生成一张海报' });
    useChatStore.getState().appendMessage('thread-1', {
      role: 'assistant',
      content: '海报已经生成。',
      reasoning: '先确认画幅和主色，再整理提示词。',
      status: 'done',
    });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('hb-chat-reasoning');
    expect(html).toContain('思考过程');
    expect(html).toContain('先确认画幅和主色');
    expect(html).toContain('海报已经生成。');
    expect(html.indexOf('先确认画幅和主色')).toBeLessThan(html.indexOf('海报已经生成。'));
  });

  it('哪一条回答用了角色，就在该条消息的操作排标出对应角色', () => {
    useChatStore.getState().appendMessage('thread-1', {
      role: 'user',
      content: '帮我做一个界面概念图',
      agentRole: {
        id: 'role-1',
        name: '创意发散',
        avatarUrl: '/avatars/dog.png',
        systemPrompt: '',
        skills: [],
      },
    });
    useChatStore.getState().appendMessage('thread-1', {
      role: 'assistant',
      content: '概念图已经生成。',
      status: 'done',
    });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('hb-chat-msg-role');
    expect(html).toContain('创意发散');
    expect(html.indexOf('hb-chat-text-actions')).toBeLessThan(html.indexOf('hb-chat-msg-role'));
  });

  it('助手自身角色快照优先于最近用户，澄清摘要不串角色', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '需求', agentRole: { id: 'old', name: '错误的最近角色', systemPrompt: '', skills: [] } });
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '已回答', askResponse: { title: '补充', questions: [] } });
    useChatStore.getState().appendMessage('thread-1', { role: 'assistant', content: '续答', status: 'done', agentRole: { id: 'own', name: '实际运行角色', systemPrompt: '', skills: [] } });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('实际运行角色');
    expect(html).not.toContain('错误的最近角色');
  });

  it('之后点击角色不会追溯改变旧回复的归属', () => {
    useChatStore.getState().appendMessage('thread-1', {
      role: 'user',
      content: '帮我做一个界面概念图',
    });
    useChatStore.getState().appendMessage('thread-1', {
      role: 'assistant',
      content: '概念图已经生成。',
      status: 'done',
    });
    useChatStore.setState({ activeRoleId: 'role-1' });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).not.toContain('hb-chat-msg-role');
    expect(html).not.toContain('应用为视频节点');
  });

  it('隐藏旧版 AI 回复中的 DSML 工具源码，保留普通文字', () => {
    useChatStore.getState().appendMessage('thread-1', {
      role: 'assistant',
      content: [
        '我按刚确认的方案直接生成。',
        '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="generate_image">',
        '<｜｜DSML｜｜ parameter name="args" string="false">{"prompt":"test"}</｜｜DSML｜｜ parameter>',
        '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>',
      ].join(''),
      status: 'done',
    });

    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('我按刚确认的方案直接生成。');
    expect(html).not.toContain('DSML');
    expect(html).not.toContain('generate_image');
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
    expect(html).toContain('style="width:240px;height:240px"');
  });

  it('单图按生成比例固定尺寸并靠左，不再跟随面板拉伸', () => {
    expect(CHAT_CSS).not.toContain('aspect-ratio: 16 / 10');
    expect(CHAT_CSS).toMatch(/\.hb-chat-media\s*\{[^}]*justify-content:\s*start/s);
    expect(CHAT_CSS).toMatch(/\.hb-chat-media\.is-single\s*\{[^}]*display:\s*flex/s);
    expect(CHAT_CSS).toMatch(/\.hb-chat-media-cell img\s*\{[^}]*object-fit:\s*contain/s);
    expect(CHAT_MESSAGE_LIST_SOURCE).toContain('const SINGLE_MEDIA_MAX = 240;');
    expect(CHAT_MESSAGE_LIST_SOURCE).toContain('const GRID_MEDIA_MAX = 136;');
  });

  it('行内引用默认无背景，悬停或聚焦时展示大图预览', () => {
    expect(CHAT_CSS).toMatch(/\.hb-chat-msg-inline-ref\s*\{[^}]*background:\s*transparent/s);
    expect(CHAT_CSS).toMatch(/\.hb-chat-msg-inline-ref:hover\s*\{[^}]*background:\s*var\(--color-ui-control-hover\)/s);
    expect(CHAT_CSS).toMatch(/\.hb-chat-msg-inline-ref-preview\s*\{[^}]*opacity:\s*0/s);
    expect(CHAT_CSS).toMatch(/\.hb-chat-msg-inline-ref:hover \.hb-chat-msg-inline-ref-preview,[^{]*\.hb-chat-msg-inline-ref:focus-visible \.hb-chat-msg-inline-ref-preview\s*\{[^}]*opacity:\s*1/s);
    expect(CHAT_MESSAGE_LIST_SOURCE).toContain('className="hb-chat-msg-inline-ref-preview"');
  });

  it('对话标题复用画布选择器结构：标题重命名、箭头切换、顶部新建', () => {
    expect(CHAT_PANEL_SOURCE).toContain('className="hb-chat-title-control"');
    expect(CHAT_PANEL_SOURCE).toContain('className="hb-chat-title-name"');
    expect(CHAT_PANEL_SOURCE).toContain('className={`hb-chat-title-menu-btn');
    expect(CHAT_PANEL_SOURCE).toContain('useChatStore.getState().renameThread(thread.id, title);');
    expect(CHAT_PANEL_SOURCE).toContain('className="hb-chat-thread-new"');
    expect(CHAT_PANEL_SOURCE).not.toContain('PencilGlyphIcon');
    expect(CHAT_PANEL_SOURCE).not.toContain('hb-chat-thread-rename');
    expect(CHAT_PANEL_SOURCE).toContain('<CollapseRightGlyphIcon />');
    expect(CHAT_CSS).toMatch(/\.hb-chat-thread-new\s*\{[^}]*justify-content:\s*center/s);
    expect(CHAT_CSS).toMatch(/\.hb-chat-thread-menu\s*\{[^}]*animation:\s*fade-in var\(--motion-slow\) var\(--ease-out\)/s);
    expect(CHAT_CSS).not.toMatch(/\.hb-chat-thread-menu\s*\{[^}]*grid-template-rows/s);
    expect(CHAT_CSS).toMatch(/\.hb-chat-thread-list\s*\{[^}]*max-height:\s*min\(298px/s);
    expect(CHAT_PANEL_SOURCE).not.toContain('className="hb-chat-thread-reveal"');
    expect(CHAT_CSS).toMatch(/\.hb-chat-title-control\s*\{[^}]*border:\s*0/s);
  });

  it('点击标题区外任意位置关闭历史菜单，标题左右 hover 联动与画布选择器一致', () => {
    expect(CHAT_PANEL_SOURCE).toContain('const titleWrapRef = useRef<HTMLDivElement>(null);');
    expect(CHAT_PANEL_SOURCE).toContain('<div className="hb-chat-title-wrap" ref={titleWrapRef}>');
    expect(CHAT_PANEL_SOURCE).toContain("document.addEventListener('pointerdown', onPointerDown, true);");
    expect(CHAT_PANEL_SOURCE).toContain('titleWrapRef.current?.contains(event.target as Node)');
    expect(CHAT_CSS).toMatch(
      /\.hb-chat-title-control:has\(\.hb-chat-title-name:hover\) \.hb-chat-title-menu-btn,[\s\S]*?background:\s*var\(--color-interaction-subtle\)/s,
    );
  });

  it('拖拽收起与展开动画时长可分别调整', () => {
    expect(CHAT_CSS).toMatch(/--hb-chat-drag-collapse-duration:\s*var\(--motion-fast\)/);
    expect(CHAT_CSS).toMatch(/--hb-chat-drag-expand-duration:\s*var\(--motion-fast\)/);
    expect(CHAT_CSS).toMatch(/\.hb-chat-panel\.is-drag-collapsing\s*\{[^}]*animation:\s*hb-chat-panel-leave var\(--hb-chat-drag-collapse-duration\)/s);
    expect(CHAT_CSS).toMatch(/\.hb-chat-panel\.is-drag-expanding\s*\{[^}]*animation:\s*hb-chat-panel-enter var\(--hb-chat-drag-expand-duration\)/s);
  });

  it('拖拽调宽时顶栏右侧控件取消缓动并逐帧跟随', () => {
    expect(GLOBAL_CSS).toMatch(
      /\.image-canvas-page:has\(\.hb-chat-panel\.is-resizing\) \.hb-topbar\s*\{[^}]*transition:\s*none/s,
    );
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

  it('工具失败时默认保持折叠，但错误原因仍然常驻可见', () => {
    useChatStore.getState().appendMessage('thread-1', { role: 'user', content: '生成图片' });
    useChatStore.getState().appendMessage('thread-1', {
      role: 'assistant',
      content: '',
      status: 'error',
      error: '上游接口超时',
      toolCalls: [{
        id: 'c-error',
        name: 'generate_image',
        args: { prompt: '一只猫', count: 1 },
        status: 'error',
        error: '上游接口超时',
        steps: ['正在调用生图工具'],
      }],
    });
    const html = renderToStaticMarkup(<ChatMessageList {...handlers} />);
    expect(html).toContain('上游接口超时');
    expect(html).not.toContain('"prompt": "一只猫"');
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
