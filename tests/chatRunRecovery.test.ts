import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callAgentModel: vi.fn(),
  generateImages: vi.fn(),
  appendCanvasImageNodes: vi.fn(async () => true),
  saved: [] as Array<Record<string, any>>,
  threads: new Map<string, Record<string, any>>(),
}));
vi.mock('../bridge/settings.js', () => {
  const text = { id: 'text', kind: 'text', model: 'text', enabledModels: [], models: [], apiKey: 'mock', baseUrl: 'https://example.test', textFormat: 'chat' };
  const image = { ...text, id: 'image', kind: 'image', model: 'default-image', enabledModels: ['chosen-image'], defaultSize: '1024x1024' };
  return {
    readSettings: async () => ({ profiles: [text, image], direct: true, enhanceLevel: 'balanced', preferences: { enabled: false, entries: [] }, chatMemory: { enabled: false }, chatRuntime: { maxModelRounds: 4, maxToolCalls: 2, maxImagesPerRun: 4, confirmImagesAbove: 1, maxOutputTokens: 4096 } }),
    resolveTextProfile: () => text,
    resolveTextModel: () => text.model,
    findProfile: () => image,
    normalizeChatRuntimeSettings: (value: unknown) => value,
  };
});
vi.mock('../bridge/agent.js', async (original) => ({ ...await original<typeof import('../bridge/agent')>(), callAgentModel: mocks.callAgentModel }));
vi.mock('../bridge/imageApi.js', async (original) => ({ ...await original<typeof import('../bridge/imageApi')>(), generateImages: mocks.generateImages }));
vi.mock('../bridge/http.js', () => ({ appendCanvasImageNodes: mocks.appendCanvasImageNodes, readCanvasDoc: async () => ({ nodes: [] }) }));
vi.mock('../bridge/hub.js', () => ({ pushImage: async () => {} }));
vi.mock('../bridge/chat.js', () => ({
  readChatThreads: async () => [],
  readChatThread: async (id: string) => mocks.threads.get(id) || null,
  writeClientThread: async (thread: Record<string, any>) => {
    const stored = { ...structuredClone(thread), revision: 1, generation: 0 };
    mocks.threads.set(thread.id, stored);
    return stored;
  },
  writeRunThread: async (thread: Record<string, any>, options: { generation: number; messageIds: string[] }) => {
    const previous = mocks.threads.get(thread.id);
    if (!previous || previous.generation !== options.generation) return null;
    const incoming = new Map(thread.messages.map((message: any) => [message.id, message]));
    const merged = { ...previous, messages: previous.messages.map((message: any) => options.messageIds.includes(message.id) ? incoming.get(message.id) || message : message), revision: previous.revision + 1 };
    mocks.threads.set(thread.id, structuredClone(merged));
    mocks.saved.push(structuredClone(merged));
    return merged;
  },
  putChatThread: async (thread: Record<string, any>) => { mocks.saved.push(structuredClone(thread)); return thread; },
}));

const runner = await import('../bridge/runs');
function request(id: string): import('../bridge/runs').StartRunRequest {
  return {
    threadId: id, canvasId: 'canvas', assistantMessageId: `a-${id}`, references: [],
    modelSelection: { imageModel: 'chosen-image' },
    thread: { id, title: 'mock', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', messages: [
      { id: `u-${id}`, role: 'user', content: '生成', createdAt: '2026-10-30T00:00:00Z' },
      { id: `a-${id}`, role: 'assistant', content: '', status: 'running', createdAt: '2026-10-30T00:00:00Z' },
    ] },
  };
}
beforeEach(() => {
  mocks.callAgentModel.mockReset(); mocks.generateImages.mockReset(); mocks.appendCanvasImageNodes.mockClear(); mocks.saved.length = 0;
});

describe('run 权威快照与提交栅栏', () => {
  it('超过500条增量后重连仍先拿到完整正文快照', async () => {
    mocks.callAgentModel.mockImplementationOnce(async (_profile, params) => {
      for (let index = 0; index < 650; index++) params.onTextDelta('字');
      return { text: '字'.repeat(650), toolCalls: [], protocol: 'tools' };
    });
    const runId = runner.startChatRun(request('long'));
    await vi.waitFor(() => expect(mocks.saved.length).toBeGreaterThan(0));
    const chunks: string[] = [];
    const response = Object.assign(new EventEmitter(), { writeHead() {}, write: (chunk: string) => chunks.push(chunk), end() {} });
    runner.subscribeChatRun(runId, response as unknown as ServerResponse);
    const snapshot = chunks.find((chunk) => chunk.startsWith('event: snapshot'));
    expect(snapshot).toBeDefined();
    const event = JSON.parse(snapshot!.split('\ndata: ')[1]);
    expect(event.thread.messages.find((message: any) => message.role === 'assistant').content).toBe('字'.repeat(650));
    expect(event.seq).toBeGreaterThan(650);
  });

  it('停止后迟到的模型回复不会再改消息或写第二次终态', async () => {
    let release!: (value: unknown) => void;
    mocks.callAgentModel.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const runId = runner.startChatRun(request('stop'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await runner.stopChatRun(runId);
    await vi.waitFor(() => expect(mocks.saved.at(-1)?.messages.at(-1)?.status).toBe('stopped'));
    const count = mocks.saved.length;
    release({ text: '迟到内容', toolCalls: [], protocol: 'tools' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.saved).toHaveLength(count);
    expect(mocks.saved.at(-1)?.messages.at(-1)?.content).not.toContain('迟到内容');
  });

  it('多图生成在服务端确认之前不调用付费接口，取消后不生成', async () => {
    mocks.callAgentModel.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'many', name: 'generate_image', args: { prompt: '候选', count: 3 } }], protocol: 'tools' });
    const runId = runner.startChatRun(request('budget'));
    await vi.waitFor(() => expect(runner.getChatRunSnapshot(runId)?.pendingConfirmation?.count).toBe(3));
    expect(mocks.generateImages).not.toHaveBeenCalled();
    expect(runner.confirmChatRun(runId, 'many', false)).toBe(true);
    await vi.waitFor(() => expect(runner.getChatRunSnapshot(runId)?.status).toBe('stopped'));
    expect(mocks.generateImages).not.toHaveBeenCalled();
  });
});
