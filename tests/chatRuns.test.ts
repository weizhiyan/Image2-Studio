import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAskUserQuestions, type AgentTurn } from '../bridge/agent';
import { answerChatRun, confirmChatRun, getChatRunSnapshot, startChatRun, stopChatRun, subscribeChatRun, type StartRunRequest } from '../bridge/runs';

const mocks = vi.hoisted(() => ({
  pushImage: vi.fn(),
  appendCanvasImageNodes: vi.fn(async () => true),
  readCanvasDoc: vi.fn(async () => ({ nodes: [] as Array<Record<string, unknown>> })),
  callAgentModel: vi.fn(),
  generateImages: vi.fn(),
  savedThreads: new Map<string, import('../bridge/chat').ChatThreadRecord>(),
  writeClientThread: vi.fn(),
  writeRunThread: vi.fn(),
}));

vi.mock('../bridge/hub.js', () => ({ pushImage: mocks.pushImage }));
vi.mock('../bridge/http.js', () => ({
  appendCanvasImageNodes: mocks.appendCanvasImageNodes,
  readCanvasDoc: mocks.readCanvasDoc,
}));
// In-memory persistence adapter: exercise the runner's CAS/owned-message contract
// without reading or writing the user's ~/.huiban directory.
vi.mock('../bridge/chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bridge/chat')>();
  mocks.writeClientThread.mockImplementation(async (raw, expectedRevision) => {
    const normalized = actual.normalizeChatThread(raw)!;
    const current = mocks.savedThreads.get(normalized.id);
    if (current && (expectedRevision ?? raw.revision ?? 0) !== current.revision) throw new actual.ChatConflictError(current);
    const existingIds = new Set(current?.messages.map((message) => message.id));
    const saved = {
      ...normalized, revision: (current?.revision || 0) + 1, generation: current?.generation || 0,
      messages: current ? [...current.messages, ...normalized.messages.filter((message) => !existingIds.has(message.id))] : normalized.messages,
      ...(current?.memory ? { memory: current.memory } : {}),
    };
    mocks.savedThreads.set(saved.id, structuredClone(saved));
    return structuredClone(saved);
  });
  mocks.writeRunThread.mockImplementation(async (raw, options) => {
    const current = mocks.savedThreads.get(raw.id);
    if (!current || current.generation !== options.generation) return null;
    const normalized = actual.normalizeChatThread(raw)!;
    const owned = new Set(options.messageIds);
    const updates = new Map(normalized.messages.filter((message) => owned.has(message.id) && message.role === 'assistant').map((message) => [message.id, message]));
    const messages = current.messages.map((message) => {
      const update = updates.get(message.id);
      updates.delete(message.id);
      return update && message.role === 'assistant' ? { ...message, ...update } : message;
    });
    messages.push(...updates.values());
    const saved = { ...current, messages, revision: current.revision + 1, ...(normalized.canvasId ? { canvasId: normalized.canvasId } : {}) };
    if (normalized.memory && options.memoryRevision === Number(current.memory?.memoryRevision || 0)) saved.memory = { ...normalized.memory, memoryRevision: options.memoryRevision + 1 };
    mocks.savedThreads.set(saved.id, structuredClone(saved));
    return structuredClone(saved);
  });
  return {
    ...actual,
    writeClientThread: mocks.writeClientThread,
    writeRunThread: mocks.writeRunThread,
    readChatThread: vi.fn(async (id: string) => structuredClone(mocks.savedThreads.get(id) || null)),
    readChatThreads: vi.fn(async () => structuredClone([...mocks.savedThreads.values()])),
  };
});
vi.mock('../bridge/agent.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../bridge/agent')>(),
  callAgentModel: mocks.callAgentModel,
}));
vi.mock('../bridge/imageApi.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../bridge/imageApi')>(),
  generateImages: mocks.generateImages,
}));
vi.mock('../bridge/textApi.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../bridge/textApi')>(),
  enhancePromptDetailed: vi.fn(async () => ({ prompt: '优化后的测试提示词', usage: 'style' })),
}));
vi.mock('../bridge/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bridge/settings')>();
  const common = {
    baseUrl: 'https://example.com/v1', apiKey: 'test-key',
    defaultSize: '1024x1024', models: [], enabledModels: [],
  };
  const image = { ...common, id: 'image', name: '测试生图', model: 'image-model', kind: 'image' };
  const text = { ...common, id: 'text', name: '测试语言', model: 'text-model', kind: 'text', textFormat: 'chat' };
  return {
    ...actual,
    readSettings: vi.fn(async () => ({
      profiles: [image, text], direct: true, enhanceLevel: 'balanced',
      preferences: { enabled: false, entries: [] },
    })),
    findProfile: vi.fn(() => image),
    resolveTextProfile: vi.fn(() => text),
    resolveTextModel: vi.fn((profile: { model: string; enabledModels?: string[] }, requested?: string) => (
      requested && profile.enabledModels?.includes(requested) ? requested : profile.model
    )),
  };
});

const events = (chunks: string[]) => chunks.flatMap((chunk) => {
  const event = chunk.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
  const data = chunk.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
  return event && data ? [{ event, payload: JSON.parse(data) as Record<string, any> }] : [];
});
const hasEvent = (chunks: string[], event: string) => events(chunks).some((entry) => entry.event === event);
const savedMessage = (threadId: string, messageId: string) => mocks.savedThreads.get(threadId)?.messages.find((message) => message.id === messageId);
async function approvePendingImages(runId: string, callId: string): Promise<void> {
  await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.pendingConfirmation?.callId).toBe(callId));
  expect(getChatRunSnapshot(runId)?.pendingConfirmation).toMatchObject({ count: 2, totalCount: 2, cost: 'unknown' });
  expect(mocks.generateImages).not.toHaveBeenCalled();
  expect(confirmChatRun(runId, callId, true)).toBe(true);
}

describe('chat run image delivery', () => {
  beforeEach(() => {
    mocks.savedThreads.clear();
    mocks.writeClientThread.mockClear();
    mocks.callAgentModel.mockReset();
    mocks.appendCanvasImageNodes.mockClear();
    mocks.readCanvasDoc.mockReset().mockResolvedValue({ nodes: [] });
    mocks.pushImage.mockClear();
    mocks.writeRunThread.mockClear();
    mocks.generateImages.mockReset().mockResolvedValue([
      { url: '/api/files/first.png', fileName: 'first.png' },
      { url: '/api/files/second.png', fileName: 'second.png' },
    ]);
  });

  it('显式引用的参考图既作为连线起点，结果也摆在它右侧', async () => {
    const referenceImage = 'data:image/png;base64,dGVzdC1yZWY=';
    mocks.readCanvasDoc.mockResolvedValue({
      nodes: [{
        id: 'ref-node', type: 'flow-image', position: { x: 100, y: 100 },
        data: { kind: 'image', size: '1024x1024', imageUrl: referenceImage, versions: [{ id: 'ver-ref', imageUrl: referenceImage }] },
      }],
    });
    mocks.generateImages.mockReset().mockResolvedValue([{ url: '/api/files/one.png', fileName: 'one.png' }]);
    mocks.callAgentModel.mockReset()
      .mockResolvedValueOnce({
        text: '', protocol: 'tools',
        toolCalls: [{ id: 'call-ref', name: 'generate_image', args: { prompt: '按参考图生成', referenceImages: [1], referenceUsage: 'edit', count: 1 } }],
      })
      .mockResolvedValueOnce({ text: '已完成。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    startChatRun({
      threadId: 'thread-ref-edge', canvasId: 'canvas-ref-edge', assistantMessageId: 'assistant-ref-edge',
      references: [{ canvasId: 'canvas-ref-edge', nodeId: 'ref-node', versionId: 'ver-ref' }],
      thread: {
        id: 'thread-ref-edge', canvasId: 'canvas-ref-edge', title: '参考图连线', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-ref-edge', role: 'user', content: '按这张参考图生成', createdAt: now },
          { id: 'assistant-ref-edge', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    });
    await vi.waitFor(() => expect(mocks.appendCanvasImageNodes).toHaveBeenCalled());
    const [, nodes, options] = mocks.appendCanvasImageNodes.mock.calls[0] as unknown as [string, Array<{ id: string; position: { x: number; y: number } }>, { connectFrom: string[] }];
    expect(options.connectFrom).toEqual(['ref-node']);
    expect(nodes[0].position).toEqual({ x: 540, y: 100 });
    await vi.waitFor(() => expect(mocks.writeRunThread).toHaveBeenCalled());
  });

  it('继续编辑上一版时，从上一版节点连线并摆在它右侧', async () => {
    const baseImage = 'data:image/png;base64,dGVzdC1iYXNl';
    mocks.readCanvasDoc.mockResolvedValue({
      nodes: [{
        id: 'base-node', type: 'flow-image', position: { x: 200, y: 150 },
        data: { kind: 'image', size: '1024x1024', imageUrl: baseImage, versions: [{ id: 'ver-base', imageUrl: baseImage }] },
      }],
    });
    mocks.generateImages.mockReset().mockResolvedValue([{ url: '/api/files/next.png', fileName: 'next.png' }]);
    mocks.callAgentModel.mockReset()
      .mockResolvedValueOnce({
        text: '', protocol: 'tools',
        toolCalls: [{ id: 'call-continue', name: 'generate_image', args: { prompt: '继续改，竖版', referenceUsage: 'edit', count: 1 } }],
      })
      .mockResolvedValueOnce({ text: '已完成。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    startChatRun({
      threadId: 'thread-continue', canvasId: 'canvas-continue', assistantMessageId: 'assistant-continue',
      references: [], previousVersionId: 'ver-base', previousCanvasId: 'canvas-continue',
      thread: {
        id: 'thread-continue', canvasId: 'canvas-continue', title: '继续改', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-continue', role: 'user', content: '继续改，竖版', createdAt: now },
          { id: 'assistant-continue', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    });
    await vi.waitFor(() => expect(mocks.appendCanvasImageNodes).toHaveBeenCalled());
    const [, nodes, options] = mocks.appendCanvasImageNodes.mock.calls[0] as unknown as [string, Array<{ id: string; position: { x: number; y: number } }>, { connectFrom: string[] }];
    expect(options.connectFrom).toEqual(['base-node']);
    expect(nodes[0].position).toEqual({ x: 640, y: 150 });
    await vi.waitFor(() => expect(mocks.writeRunThread).toHaveBeenCalled());
  });

  it('把当前轮次引用的图片作为 Agent 视觉上下文传入', async () => {
    mocks.callAgentModel.mockReset().mockResolvedValueOnce({
      text: '我看到了引用图片。', toolCalls: [], protocol: 'json',
    });
    mocks.writeRunThread.mockClear();
    const image = 'data:image/png;base64,dGVzdC1pbWFnZQ==';
    const now = new Date().toISOString();
    const request: StartRunRequest = {
      threadId: 'thread-vision', canvasId: 'canvas-vision', assistantMessageId: 'assistant-vision', references: [],
      thread: {
        id: 'thread-vision', canvasId: 'canvas-vision', title: '图像识别', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-vision', role: 'user', content: '请描述这张图', attachments: [{ canvasId: 'canvas-vision', nodeId: 'reference-vision', url: image }], createdAt: now },
          { id: 'assistant-vision', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    };

    startChatRun(request);
    await vi.waitFor(() => expect(mocks.writeRunThread).toHaveBeenCalled());

    expect(mocks.callAgentModel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      visualContext: [expect.objectContaining({ id: expect.any(String), label: expect.any(String), url: image })],
    }));
    mocks.callAgentModel.mockClear();
  });

  it('只注入本轮选中的角色及其 Skill，不复活历史消息里的其他角色', async () => {
    mocks.callAgentModel.mockReset().mockResolvedValueOnce({
      text: '按当前角色处理。', toolCalls: [], protocol: 'json',
    });
    mocks.writeRunThread.mockClear();
    const now = new Date().toISOString();
    const request: StartRunRequest = {
      threadId: 'thread-role', canvasId: 'canvas-role', assistantMessageId: 'assistant-role', references: [],
      agentRole: {
        id: 'role-current',
        name: '创意设计',
        category: '视觉',
        systemPrompt: '先拆解目标，再给三个方向。',
        skills: [{ id: 'skill-current', name: '品牌语气', content: '克制、具体、避免套话。' }],
        temperature: 0.9,
      },
      thread: {
        id: 'thread-role', canvasId: 'canvas-role', title: '角色测试', createdAt: now, updatedAt: now,
        messages: [
          {
            id: 'user-old',
            role: 'user',
            content: '上一轮',
            createdAt: now,
            agentRole: {
              id: 'role-old',
              name: '旧角色',
              systemPrompt: '不应注入的旧提示词',
              skills: [],
            },
          },
          { id: 'assistant-role', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    };

    mocks.writeRunThread.mockClear();
    startChatRun(request);
    await vi.waitFor(() => expect(mocks.callAgentModel).toHaveBeenCalled());
    await vi.waitFor(() => expect(mocks.writeRunThread).toHaveBeenCalled());
    const options = mocks.callAgentModel.mock.calls[0][1] as { systemSpec: string; temperature?: number };
    expect(options.temperature).toBe(0.9);
    expect(options.systemSpec).toContain('当前对话角色：创意设计（视觉）');
    expect(options.systemSpec).toContain('先拆解目标，再给三个方向。');
    expect(options.systemSpec).toContain('## Skill: 品牌语气');
    expect(options.systemSpec).toContain('克制、具体、避免套话。');
    expect(options.systemSpec).not.toContain('旧角色');
    expect(options.systemSpec).not.toContain('不应注入的旧提示词');
  });

  it('通用模式不注入角色上下文', async () => {
    mocks.callAgentModel.mockReset().mockResolvedValueOnce({
      text: '通用回复。', toolCalls: [], protocol: 'json',
    });
    mocks.writeRunThread.mockClear();
    const now = new Date().toISOString();
    startChatRun({
      threadId: 'thread-general', canvasId: 'canvas-general', assistantMessageId: 'assistant-general', references: [],
      thread: {
        id: 'thread-general', canvasId: 'canvas-general', title: '通用', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-general', role: 'user', content: '你好', createdAt: now },
          { id: 'assistant-general', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    });
    await vi.waitFor(() => expect(mocks.callAgentModel).toHaveBeenCalled());
    await vi.waitFor(() => expect(mocks.writeRunThread).toHaveBeenCalled());
    const options = mocks.callAgentModel.mock.calls[0][1] as { systemSpec: string; temperature?: number };
    expect(options.temperature).toBeUndefined();
    expect(options.systemSpec).not.toContain('当前对话角色：');
  });

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
      await approvePendingImages(runId, 'call-test');
      await vi.waitFor(() => expect(mocks.callAgentModel).toHaveBeenCalledTimes(2));
      expect(mocks.appendCanvasImageNodes).toHaveBeenCalledTimes(1);
      expect(mocks.pushImage).toHaveBeenCalledTimes(2);
      expect(mocks.appendCanvasImageNodes.mock.invocationCallOrder[0]).toBeLessThan(mocks.pushImage.mock.invocationCallOrder[0]);
      expect(mocks.pushImage.mock.calls.map(([payload]) => payload.fileName)).toEqual(['first.png', 'second.png']);
      expect(mocks.pushImage.mock.calls[0][0]).toMatchObject({ canvasId: 'canvas-test', source: 'chat', jobId: runId });
      expect(events(chunks).filter((entry) => entry.event === 'image_completed')).toHaveLength(2);
      expect(hasEvent(chunks, 'message_done')).toBe(false);
      expect(getChatRunSnapshot(runId)?.thread.messages[1].status).toBe('running');
      releaseReply({ text: '图片已经生成', toolCalls: [], protocol: 'tools' });
      await vi.waitFor(() => expect(hasEvent(chunks, 'message_done')).toBe(true));
      expect(mocks.pushImage).toHaveBeenCalledTimes(2);
      expect(getChatRunSnapshot(runId)?.thread.messages[1]).toMatchObject({ status: 'done', content: '图片已经生成' });
      expect(savedMessage('thread-test', 'assistant-test')).toMatchObject({ status: 'done', content: '图片已经生成' });
      expect(request.thread.messages[1]).toMatchObject({ status: 'running', content: '' });
      const eventPayloads = events(chunks).map((entry) => entry.payload);
      const seqs = eventPayloads.map((event) => event.seq).filter((seq): seq is number => typeof seq === 'number');
      expect(seqs.length).toBeGreaterThan(0);
      expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally {
      releaseReply({ text: '', toolCalls: [], protocol: 'tools' });
      client.emit('close');
    }
  });

  it('生图后把候选图与编号回喂给模型', async () => {
    mocks.generateImages.mockResolvedValueOnce([
      { url: 'data:image/png;base64,AAA', fileName: 'a.png' },
      { url: 'data:image/png;base64,BBB', fileName: 'b.png' },
    ]);
    mocks.callAgentModel
      .mockResolvedValueOnce({
        text: '', protocol: 'tools', toolCalls: [{
          id: 'call-feed', name: 'generate_image', args: { prompt: '两版', count: 2 },
        }],
      })
      .mockResolvedValueOnce({ text: '两版都生成了', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    const request: StartRunRequest = {
      threadId: 'thread-feed', canvasId: 'canvas-feed', assistantMessageId: 'assistant-feed', references: [],
      thread: {
        id: 'thread-feed', canvasId: 'canvas-feed', title: '回喂', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-feed', role: 'user', content: '来两版', createdAt: now },
          { id: 'assistant-feed', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    };
    const runId = startChatRun(request);
    await approvePendingImages(runId, 'call-feed');
    await vi.waitFor(() => expect(mocks.callAgentModel).toHaveBeenCalledTimes(2));

    const second = mocks.callAgentModel.mock.calls[1][1] as {
      visualContext?: Array<{ id: string; label: string; url: string }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(second.visualContext).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'data:image/png;base64,AAA', label: expect.stringContaining('候选 1') }),
      expect.objectContaining({ url: 'data:image/png;base64,BBB', label: expect.stringContaining('候选 2') }),
    ]));
    const toolMessage = second.messages.find((message) => (
      message.role === 'tool' && String(message.content).includes('候选 1')
    ));
    expect(toolMessage?.content).toContain('候选 2');
    expect(toolMessage?.content).toContain('call-feed');
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('done'));
    expect(savedMessage('thread-feed', 'assistant-feed')).toMatchObject({ status: 'done' });
  });

  it('同一线程已有在途 run 时拒绝再起一个', async () => {
    let release!: (turn: AgentTurn) => void;
    const pending = new Promise<AgentTurn>((resolve) => { release = resolve; });
    mocks.callAgentModel.mockImplementationOnce(() => pending);
    const now = new Date().toISOString();
    const request: StartRunRequest = {
      threadId: 'thread-lock', canvasId: 'canvas-lock', assistantMessageId: 'assistant-lock', references: [],
      thread: {
        id: 'thread-lock', canvasId: 'canvas-lock', title: '锁', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-lock', role: 'user', content: '第一轮', createdAt: now },
          { id: 'assistant-lock', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    };
    const runId = startChatRun(request);
    await vi.waitFor(() => expect(mocks.callAgentModel).toHaveBeenCalled());
    expect(() => startChatRun({ ...request, assistantMessageId: 'assistant-lock-2' })).toThrow(/在途/);

    const stopping = stopChatRun(runId);
    release({ text: '', toolCalls: [], protocol: 'tools' });
    expect(await stopping).toBe(true);
    expect(savedMessage('thread-lock', 'assistant-lock')).toMatchObject({ status: 'stopped' });
  });

  it('工具协议解析失败时保存错误状态，不伪装完成或提交生图', async () => {
    mocks.callAgentModel.mockRejectedValueOnce(new Error('模型返回的工具调用不完整或格式无法识别，本次未提交生成。请重试。'));
    const now = new Date().toISOString();
    const request: StartRunRequest = {
      threadId: 'thread-protocol', canvasId: 'canvas-protocol', assistantMessageId: 'assistant-protocol', references: [],
      thread: {
        id: 'thread-protocol', canvasId: 'canvas-protocol', title: '协议失败', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-protocol', role: 'user', content: '再来一个4×4宫格', createdAt: now },
          { id: 'assistant-protocol', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    };
    const runId = startChatRun(request);
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('error'));
    expect(savedMessage('thread-protocol', 'assistant-protocol')).toMatchObject({ status: 'error', error: expect.stringContaining('本次未提交生成') });
    expect(mocks.appendCanvasImageNodes).not.toHaveBeenCalled();
    expect(mocks.pushImage).not.toHaveBeenCalled();
    expect(mocks.callAgentModel).toHaveBeenCalledTimes(1);
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
      await vi.waitFor(() => expect(hasEvent(chunks, 'clarification_requested')).toBe(true));
      const payload = events(chunks).find((entry) => entry.event === 'clarification_requested')!.payload;
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
      await vi.waitFor(() => expect(hasEvent(chunks, 'message_done')).toBe(true));
      expect(mocks.callAgentModel).toHaveBeenCalledTimes(2);
      const snapshot = getChatRunSnapshot(runId)!;
      expect(snapshot.messageId).toBe('assistant-follow-up');
      expect(snapshot.thread.messages[1]).toMatchObject({ status: 'done' });
      expect(snapshot.thread.messages[2]).toMatchObject({ id: 'user-answer', askResponse: { title: '补充几个信息' } });
      expect(snapshot.thread.messages[3]).toMatchObject({ id: 'assistant-follow-up', status: 'done', content: '已确认主体，接下来可以继续。' });
      expect(savedMessage('thread-ask', 'assistant-follow-up')).toMatchObject({ status: 'done', content: '已确认主体，接下来可以继续。' });
      expect(request.assistantMessageId).toBe('assistant-ask');
      expect(request.thread.messages).toHaveLength(2);
    } finally {
      client.emit('close');
    }
  });
});
