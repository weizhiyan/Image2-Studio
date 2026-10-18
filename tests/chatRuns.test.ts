import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { normalizeAskUserQuestions, type AgentTurn } from '../bridge/agent';
import { answerChatRun, startChatRun, subscribeChatRun, type StartRunRequest } from '../bridge/runs';

const mocks = vi.hoisted(() => ({
  pushImage: vi.fn(),
  appendCanvasImageNodes: vi.fn(async () => true),
  callAgentModel: vi.fn(),
  putChatThread: vi.fn(async () => true),
}));

vi.mock('../bridge/hub.js', () => ({ pushImage: mocks.pushImage }));
vi.mock('../bridge/http.js', () => ({
  appendCanvasImageNodes: mocks.appendCanvasImageNodes,
  readCanvasDoc: vi.fn(async () => ({ nodes: [] })),
}));
vi.mock('../bridge/chat.js', () => ({
  putChatThread: mocks.putChatThread,
  readChatThreads: vi.fn(async () => []),
}));
vi.mock('../bridge/agent.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../bridge/agent')>(),
  callAgentModel: mocks.callAgentModel,
}));
vi.mock('../bridge/imageApi.js', () => ({
  generateImages: vi.fn(async () => [
    { url: '/api/files/first.png', fileName: 'first.png' },
    { url: '/api/files/second.png', fileName: 'second.png' },
  ]),
}));
vi.mock('../bridge/textApi.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../bridge/textApi')>(),
  enhancePromptDetailed: vi.fn(async () => ({ prompt: '优化后的测试提示词', usage: 'style' })),
}));
vi.mock('../bridge/settings.js', () => {
  const common = {
    baseUrl: 'https://example.com/v1', apiKey: 'test-key',
    defaultSize: '1024x1024', models: [], enabledModels: [],
  };
  const image = { ...common, id: 'image', name: '测试生图', model: 'image-model', kind: 'image' };
  const text = { ...common, id: 'text', name: '测试语言', model: 'text-model', kind: 'text', textFormat: 'chat' };
  return {
    readSettings: vi.fn(async () => ({
      profiles: [image, text], direct: true, enhanceLevel: 'balanced',
      preferences: { enabled: false, entries: [] },
    })),
    findProfile: vi.fn(() => image),
    resolveTextProfile: vi.fn(() => text),
  };
});

describe('chat run image delivery', () => {
  it('追问 schema 限制为最多四题且过滤无效选项', () => {
    const questions = normalizeAskUserQuestions([
      { id: 'subject', title: '主体是什么？', options: ['商品', '场景'] },
      { title: '风格？', multiple: true, options: [{ label: '简约', recommended: true }, { label: '复古' }] },
      { title: '不完整问题', options: ['唯一选项'] },
      { title: '比例？', options: ['横向', '竖向'] },
      { title: '超出上限', options: ['A', 'B'] },
    ]);
    expect(questions).toHaveLength(3);
    expect(questions[1].multiple).toBe(true);
    expect(questions[1].options[0].recommended).toBe(true);
    expect(normalizeAskUserQuestions(null)).toEqual([]);
  });

  it('persists and pushes images before the final model reply, without pushing again on completion', async () => {
    let releaseReply!: (turn: AgentTurn) => void;
    const reply = new Promise<AgentTurn>((resolve) => { releaseReply = resolve; });
    mocks.callAgentModel.mockResolvedValueOnce({
      text: '', protocol: 'tools', toolCalls: [{
        id: 'call-test', name: 'generate_image',
        args: { prompt: '生成两张测试图片', count: 2, referenceUsage: 'style' },
      }],
    }).mockImplementationOnce(() => reply);
    const now = new Date().toISOString();
    const request: StartRunRequest = {
      threadId: 'thread-test', canvasId: 'canvas-test', assistantMessageId: 'assistant-test', references: [],
      thread: {
        id: 'thread-test', canvasId: 'canvas-test', title: '测试', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-test', role: 'user', content: '生成两张测试图片', createdAt: now },
          { id: 'assistant-test', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    };
    const chunks: string[] = [];
    const client = Object.assign(new EventEmitter(), {
      writeHead: vi.fn(), write: (chunk: string) => { chunks.push(chunk); }, end: vi.fn(),
    });
    const runId = startChatRun(request);
    expect(subscribeChatRun(runId, client as unknown as ServerResponse)).toBe(true);
    try {
      await vi.waitFor(() => expect(mocks.callAgentModel).toHaveBeenCalledTimes(2));
      expect(mocks.appendCanvasImageNodes).toHaveBeenCalledTimes(1);
      expect(mocks.pushImage).toHaveBeenCalledTimes(2);
      expect(mocks.appendCanvasImageNodes.mock.invocationCallOrder[0]).toBeLessThan(mocks.pushImage.mock.invocationCallOrder[0]);
      expect(mocks.pushImage.mock.calls.map(([payload]) => payload.fileName)).toEqual(['first.png', 'second.png']);
      expect(mocks.pushImage.mock.calls[0][0]).toMatchObject({ canvasId: 'canvas-test', source: 'chat', jobId: runId });
      expect(chunks.filter((chunk) => chunk.startsWith('event: image_completed'))).toHaveLength(2);
      expect(chunks.some((chunk) => chunk.startsWith('event: message_done'))).toBe(false);
      expect(request.thread.messages[1].status).toBe('running');
      releaseReply({ text: '图片已经生成', toolCalls: [], protocol: 'tools' });
      await vi.waitFor(() => expect(chunks.some((chunk) => chunk.startsWith('event: message_done'))).toBe(true));
      expect(mocks.pushImage).toHaveBeenCalledTimes(2);
      expect(request.thread.messages[1]).toMatchObject({ status: 'done', content: '图片已经生成' });
    } finally {
      releaseReply({ text: '', toolCalls: [], protocol: 'tools' });
      client.emit('close');
    }
  });

  it('结构化追问会暂停当前 run，提交答案后继续同一轮', async () => {
    mocks.callAgentModel.mockReset();
    mocks.appendCanvasImageNodes.mockClear();
    mocks.pushImage.mockClear();
    mocks.callAgentModel
      .mockResolvedValueOnce({
        text: '',
        protocol: 'tools',
        toolCalls: [{
          id: 'call-ask',
          name: 'ask_user',
          args: {
            questions: [{
              id: 'subject',
              title: '这张图的主体是什么？',
              type: 'single',
              options: [{ label: '产品本身', value: 'product' }, { label: '使用场景', value: 'scene' }],
            }],
          },
        }],
      })
      .mockResolvedValueOnce({ text: '已确认主体，接下来可以继续。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    const request: StartRunRequest = {
      threadId: 'thread-ask', canvasId: 'canvas-ask', assistantMessageId: 'assistant-ask', references: [],
      thread: {
        id: 'thread-ask', canvasId: 'canvas-ask', title: '测试追问', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-ask', role: 'user', content: '我想做一张产品主视觉', createdAt: now },
          { id: 'assistant-ask', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    };
    const chunks: string[] = [];
    const client = Object.assign(new EventEmitter(), {
      writeHead: vi.fn(), write: (chunk: string) => { chunks.push(chunk); }, end: vi.fn(),
    });
    const runId = startChatRun(request);
    expect(subscribeChatRun(runId, client as unknown as ServerResponse)).toBe(true);
    try {
      await vi.waitFor(() => expect(chunks.some((chunk) => chunk.startsWith('event: clarification_requested'))).toBe(true));
      const eventChunk = chunks.find((chunk) => chunk.startsWith('event: clarification_requested')) || '';
      const payload = JSON.parse(eventChunk.split('data: ')[1].trim()) as { callId: string };
      expect(await answerChatRun(runId, payload.callId, {
        answers: { subject: ['product'] },
        userMessage: {
          id: 'user-answer',
          role: 'user',
          content: '已回答：补充几个信息',
          askResponse: {
            title: '补充几个信息',
            questions: [{ id: 'subject', title: '这张图的主体是什么？', answers: ['产品本身'] }],
          },
        },
        assistantMessage: { id: 'assistant-follow-up', role: 'assistant', content: '', status: 'running' },
      })).toBe(true);
      await vi.waitFor(() => expect(chunks.some((chunk) => chunk.startsWith('event: message_done'))).toBe(true));
      expect(mocks.callAgentModel).toHaveBeenCalledTimes(2);
      expect(request.assistantMessageId).toBe('assistant-follow-up');
      expect(request.thread.messages[1]).toMatchObject({ status: 'done' });
      expect(request.thread.messages[2]).toMatchObject({ id: 'user-answer', askResponse: { title: '补充几个信息' } });
      expect(request.thread.messages[3]).toMatchObject({ id: 'assistant-follow-up', status: 'done', content: '已确认主体，接下来可以继续。' });
    } finally {
      client.emit('close');
    }
  });
});
