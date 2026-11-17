import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAskUserQuestions, type AgentTurn } from '../bridge/agent';
import { answerChatRun, buildAgentSystemSpec, confirmChatRun, getChatRunSnapshot, startChatRun, stopChatRun, subscribeChatRun, type StartRunRequest } from '../bridge/runs';
import { compileVisualDesign, type VisualDesign } from '../bridge/visualDesign';

const mocks = vi.hoisted(() => ({
  pushImage: vi.fn(),
  pushLocate: vi.fn(),
  pushNodeState: vi.fn(),
  upsertCanvasNodes: vi.fn(async () => true),
  readCanvasDoc: vi.fn(async () => ({ nodes: [] as Array<Record<string, unknown>> })),
  callAgentModel: vi.fn(),
  callTextModel: vi.fn(),
  generateImages: vi.fn(),
  savedThreads: new Map<string, import('../bridge/chat').ChatThreadRecord>(),
  writeClientThread: vi.fn(),
  writeRunThread: vi.fn(),
  imageProfileOverrides: {} as Record<string, unknown>,
  direct: true,
}));

vi.mock('../bridge/hub.js', () => ({
  pushImage: mocks.pushImage,
  pushLocate: mocks.pushLocate,
  pushNodeState: mocks.pushNodeState,
}));
vi.mock('../bridge/http.js', () => ({
  upsertCanvasNodes: mocks.upsertCanvasNodes,
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
  callTextModel: mocks.callTextModel,
  enhancePromptDetailed: vi.fn(async () => ({ prompt: '优化后的测试提示词', usage: 'style' })),
}));
vi.mock('../bridge/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bridge/settings')>();
  const common = {
    baseUrl: 'https://example.com/v1', apiKey: 'test-key',
    defaultSize: '1024x1024', models: [], enabledModels: [],
  };
  const image = { ...common, id: 'image', name: '测试生图', model: 'image-model', kind: 'image' };
  const text = { ...common, id: 'text', name: '测试语言', model: 'text-model', enabledModels: ['text-model', 'next-model'], kind: 'text', textFormat: 'chat' };
  return {
    ...actual,
    readSettings: vi.fn(async () => ({
      profiles: [{ ...image, ...mocks.imageProfileOverrides }, text], direct: mocks.direct, enhanceLevel: 'balanced',
      preferences: { enabled: false, entries: [] },
    })),
    findProfile: vi.fn(() => ({ ...image, ...mocks.imageProfileOverrides })),
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
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const savedMessage = (threadId: string, messageId: string) => mocks.savedThreads.get(threadId)?.messages.find((message) => message.id === messageId);
async function approvePendingImages(runId: string, callId: string): Promise<void> {
  await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.pendingConfirmation?.callId).toBe(callId));
  expect(getChatRunSnapshot(runId)?.pendingConfirmation).toMatchObject({ count: 2, totalCount: 2, cost: 'unknown' });
  expect(mocks.generateImages).not.toHaveBeenCalled();
  expect(confirmChatRun(runId, callId, true)).toBe(true);
}

describe('Agent 出图回复规则', () => {
  it('普通生图直接执行、完成后简短告知，同时保留方案讨论和必要追问', () => {
    const spec = buildAgentSystemSpec();
    expect(spec).toContain('普通生图或改图请求信息足够时，直接调用 `generate_image`');
    expect(spec).toContain('交互设计、UI 设计，或用户明确要求讨论、分析、比较方案时，可以先给简短方案');
    expect(spec).toContain('用户明确要求直接出图时仍直接生成');
    expect(spec).toContain('无法合理确定的必要事实');
    expect(spec).toContain('没写风格不等于必须反问');
    expect(spec).toContain('让 AI 决定');
    expect(spec).toContain('以上直接出图与简短回复规则也适用于当前角色及其 Skill');
    expect(spec).toContain('生成成功后默认只用一句简短告知');
    expect(spec).toContain('生成失败、部分完成或仍有阻塞时如实简短说明');
    expect(spec).toContain('清楚的单轮需求可以原样提交');
    expect(spec).not.toContain('主体、场景、构图、光线、色彩、材质、风格');
    expect(spec).not.toContain('300-400 字');
  });
});

describe('chat run image delivery', () => {
  beforeEach(() => {
    mocks.imageProfileOverrides = {};
    mocks.direct = true;
    mocks.savedThreads.clear();
    mocks.writeClientThread.mockClear();
    mocks.callAgentModel.mockReset();
    mocks.callTextModel.mockReset();
    mocks.upsertCanvasNodes.mockClear();
    mocks.readCanvasDoc.mockReset().mockResolvedValue({ nodes: [] });
    mocks.pushImage.mockClear();
    mocks.pushLocate.mockClear();
    mocks.pushNodeState.mockClear();
    mocks.writeRunThread.mockClear();
    mocks.generateImages.mockReset().mockResolvedValue([
      { url: '/api/files/first.png', fileName: 'first.png' },
      { url: '/api/files/second.png', fileName: 'second.png' },
    ]);
  });

  it('默认链路将无需改写的原文原样提交，不再调用独立优化器', async () => {
    const prompt = '为“山间来信”设计咖啡馆Logo，安静、温暖，没有具体造型想法，最多两种颜色，不要咖啡杯图案，只要标志。画幅1:1。';
    mocks.callAgentModel
      .mockResolvedValueOnce({ text: '', protocol: 'tools', toolCalls: [{ id: 'unchanged', name: 'generate_image', args: { prompt, originalPrompt: prompt, ratio: '1:1', count: 1 } }] })
      .mockResolvedValueOnce({ text: '已生成。', protocol: 'tools', toolCalls: [] });
    mocks.generateImages.mockResolvedValueOnce([{ url: '/api/files/logo.png', fileName: 'logo.png' }]);
    const now = new Date().toISOString();
    const runId = startChatRun({
      threadId: 'raw-preserving-run', canvasId: 'canvas-raw-preserving', assistantMessageId: 'assistant', references: [],
      thread: { id: 'raw-preserving-run', title: '原文保留', createdAt: now, updatedAt: now, messages: [
        { id: 'user', role: 'user', content: prompt, createdAt: now },
        { id: 'assistant', role: 'assistant', content: '', status: 'running', createdAt: now },
      ] },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('done'));
    expect(mocks.generateImages).toHaveBeenCalledTimes(1);
    expect(mocks.generateImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prompt, imagesPrompt: prompt, size: '1536x1536' }));
    expect(mocks.callTextModel).not.toHaveBeenCalled();
  });

  it('新设计流程在Agent与生图之间编译，不把结构数据或旧图送进新创作', async () => {
    vi.stubEnv('HUIBAN_VISUAL_DESIGN', '1');
    const design: VisualDesign = {
      task: 'background', mode: 'create', goal: '旅行结尾背景', aspectRatio: '16:9',
      requirements: [{ source: '不要文字', instruction: '画面无字' }], exactText: [], copy: [], openDecisions: ['选择景物'],
      visual: { idea: '山路走向远方海湾', focus: '小路与地平线', composition: '下方小路向海延伸，上方天空留白', appearance: '暖色水彩', typography: '', changes: '', preserve: '' },
      references: [],
    };
    mocks.generateImages.mockResolvedValue([{ url: '/api/files/one.png', fileName: 'one.png' }]);
    mocks.callAgentModel
      .mockResolvedValueOnce({ text: '', protocol: 'tools', toolCalls: [{ id: 'design-call', name: 'generate_image', args: { design } }] })
      .mockResolvedValueOnce({ text: '已完成。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    const runId = startChatRun({
      threadId: 'design-thread', canvasId: 'design-canvas', assistantMessageId: 'design-assistant', references: [], previousVersionId: 'old-version',
      thread: { id: 'design-thread', title: '设计', createdAt: now, updatedAt: now, messages: [
        { id: 'old-user', role: 'user', content: '画一张红色海报', createdAt: now },
        { id: 'old-ai', role: 'assistant', content: '完成', media: [{ url: 'data:image/png;base64,b2xk', nodeId: 'old-node', versionId: 'old-version' }], createdAt: now },
        { id: 'design-user', role: 'user', content: '生成旅行结尾背景，16:9，不要文字', createdAt: now },
        { id: 'design-assistant', role: 'assistant', content: '', status: 'running', createdAt: now },
      ] },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('done'));
    expect(mocks.generateImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prompt: compileVisualDesign(design), size: '1536x864', referenceDataUrls: undefined }));
    expect(mocks.callAgentModel.mock.calls[0][1].tools[0].parameters.required).toEqual(['design']);
    expect(mocks.callTextModel).not.toHaveBeenCalled();
    const saved = savedMessage('design-thread', 'design-assistant');
    expect(JSON.stringify(saved)).toContain('design-brief-v1');
    expect(JSON.stringify(saved)).not.toContain('preparedReferenceUrls');
  });

  it('新设计缺少真实参考图时在任何付费生图前失败', async () => {
    vi.stubEnv('HUIBAN_VISUAL_DESIGN', '1');
    mocks.callAgentModel.mockResolvedValueOnce({ text: '', protocol: 'tools', toolCalls: [{ id: 'invalid-ref', name: 'generate_image', args: { referenceImages: [9] } }] });
    const now = new Date().toISOString();
    const runId = startChatRun({
      threadId: 'invalid-design-ref', canvasId: 'canvas', assistantMessageId: 'assistant', references: [],
      thread: { id: 'invalid-design-ref', title: '参考检查', createdAt: now, updatedAt: now, messages: [
        { id: 'user', role: 'user', content: '生成一张海报', createdAt: now },
        { id: 'assistant', role: 'assistant', content: '', status: 'running', createdAt: now },
      ] },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('error'));
    expect(mocks.generateImages).not.toHaveBeenCalled();
    expect(mocks.upsertCanvasNodes).not.toHaveBeenCalled();
  });

  it('新设计在核对与生图两个阶段都保持用户图1图2的原始顺序', async () => {
    vi.stubEnv('HUIBAN_VISUAL_DESIGN', '1');
    const first = 'data:image/png;base64,Zmlyc3Q=';
    const second = 'data:image/png;base64,c2Vjb25k';
    const design: VisualDesign = {
      task: 'illustration', mode: 'reference', goal: '参考两张图创作', aspectRatio: '1:1',
      requirements: [], exactText: [], copy: [], openDecisions: [],
      visual: { idea: '主体置于山丘前', focus: '主体', composition: '前景主体，后景山丘', appearance: '水彩', typography: '', changes: '', preserve: '' },
      references: [{ index: 1, use: '只保留主体' }, { index: 2, use: '只参考水彩风格' }],
    };
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ issues: [], design: null }) }, finish_reason: 'stop' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mocks.readCanvasDoc.mockResolvedValue({ nodes: [
      { id: 'ref-first', data: { imageUrl: first } },
      { id: 'ref-second', data: { imageUrl: second } },
    ] });
    mocks.generateImages.mockResolvedValue([{ url: '/api/files/one.png', fileName: 'one.png' }]);
    mocks.callAgentModel
      .mockResolvedValueOnce({ text: '', protocol: 'tools', toolCalls: [{ id: 'design-refs', name: 'generate_image', args: { design, referenceImages: [2, 1] } }] })
      .mockResolvedValueOnce({ text: '已完成。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    const runId = startChatRun({
      threadId: 'design-refs', canvasId: 'canvas', assistantMessageId: 'assistant', references: [{ nodeId: 'ref-first' }, { nodeId: 'ref-second' }],
      thread: { id: 'design-refs', title: '参考顺序', createdAt: now, updatedAt: now, messages: [
        { id: 'user', role: 'user', content: '根据图1的主体与图2的水彩风格生成插画', createdAt: now },
        { id: 'assistant', role: 'assistant', content: '', status: 'running', createdAt: now },
      ] },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('done'));
    expect(mocks.generateImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ referenceDataUrls: [first, second] }));
    const request = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(request.messages[1].content.filter((part: { type: string }) => part.type === 'image_url').map((part: { image_url: { url: string } }) => part.image_url.url)).toEqual([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['模型选择竖版', '请做一张开业海报', '竖版2:3开业海报，标题突出，活动信息分组。', '2:3', '1024x1536'],
    ['遗漏比例的用途兜底', '请做一张开业海报', '开业海报，主标题突出，活动信息按主次分组。', undefined, '1024x1536'],
    ['用户明确横版', '请做16:9的海报', '横版16:9海报，标题在左，活动区域在右。', undefined, '1536x864'],
  ])('%s：对话请求使用一致画幅且不注入默认方形', async (_label, original, prompt, ratio, size) => {
    mocks.generateImages.mockResolvedValue([{ url: '/api/files/one.png', fileName: 'one.png' }]);
    mocks.callAgentModel
      .mockResolvedValueOnce({ text: '', protocol: 'tools', toolCalls: [{ id: 'planned', name: 'generate_image', args: { prompt, originalPrompt: original, ratio } }] })
      .mockResolvedValueOnce({ text: '已完成。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    const threadId = `plan-${size}-${String(ratio)}`;
    const runId = startChatRun({
      threadId, canvasId: 'canvas-plan', assistantMessageId: 'assistant-plan', references: [],
      thread: { id: threadId, title: '画幅测试', createdAt: now, updatedAt: now, messages: [
        { id: 'user-plan', role: 'user', content: original, createdAt: now },
        { id: 'assistant-plan', role: 'assistant', content: '', status: 'running', createdAt: now },
      ] },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('done'));
    expect(mocks.generateImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ size, prompt, imagesPrompt: prompt }));
    expect(mocks.callAgentModel.mock.calls[0][1].systemSpec).toContain('画幅为自动');
    expect(mocks.callAgentModel.mock.calls[0][1].systemSpec).not.toContain('目标画幅 1024x1024');
  });

  it('多图确认展示的自动画幅与最终请求保持一致', async () => {
    mocks.callAgentModel
      .mockResolvedValueOnce({ text: '', protocol: 'tools', toolCalls: [{ id: 'plan-confirm', name: 'generate_image', args: { prompt: '开业海报，主标题醒目，正文分组。', count: 2 } }] })
      .mockResolvedValueOnce({ text: '已完成。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    const runId = startChatRun({
      threadId: 'plan-confirm', canvasId: 'canvas-plan-confirm', assistantMessageId: 'assistant-confirm', references: [],
      thread: { id: 'plan-confirm', title: '确认测试', createdAt: now, updatedAt: now, messages: [
        { id: 'user-confirm', role: 'user', content: '请做两张开业海报', createdAt: now },
        { id: 'assistant-confirm', role: 'assistant', content: '', status: 'running', createdAt: now },
      ] },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.pendingConfirmation?.size).toBe('1024x1536'));
    expect(mocks.generateImages).not.toHaveBeenCalled();
    await approvePendingImages(runId, 'plan-confirm');
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('done'));
    expect(mocks.generateImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ size: '1024x1536', n: 2 }));
  });

  it('对话的画幅冲突在调用生图之前被拦截', async () => {
    mocks.callAgentModel.mockResolvedValueOnce({ text: '', protocol: 'tools', toolCalls: [{ id: 'plan-conflict', name: 'generate_image', args: {
      prompt: '设计1:1方形海报，活动信息分组。', originalPrompt: '生成2:3海报', ratio: '1:1',
    } }] });
    const now = new Date().toISOString();
    const runId = startChatRun({
      threadId: 'plan-conflict', canvasId: 'canvas-plan-conflict', assistantMessageId: 'assistant-conflict', references: [],
      thread: { id: 'plan-conflict', title: '冲突测试', createdAt: now, updatedAt: now, messages: [
        { id: 'user-conflict', role: 'user', content: '生成2:3海报', createdAt: now },
        { id: 'assistant-conflict', role: 'assistant', content: '', status: 'running', createdAt: now },
      ] },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('error'));
    expect(mocks.generateImages).not.toHaveBeenCalled();
  });

  it('聊天生图工具透传 GIF 格式并把原格式记录到画布', async () => {
    mocks.generateImages.mockResolvedValue([{ url: '/api/files/animated.gif', fileName: 'animated.gif', width: 640, height: 360 }]);
    mocks.callAgentModel
      .mockResolvedValueOnce({ text: '', protocol: 'tools', toolCalls: [{ id: 'call-gif', name: 'generate_image', args: { prompt: '测试动图', count: 1, outputFormat: 'gif' } }] })
      .mockResolvedValueOnce({ text: '已完成。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    const runId = startChatRun({
      threadId: 'thread-gif', canvasId: 'canvas-gif', assistantMessageId: 'assistant-gif', references: [],
      thread: {
        id: 'thread-gif', canvasId: 'canvas-gif', title: 'GIF', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-gif', role: 'user', content: '生成 GIF', createdAt: now },
          { id: 'assistant-gif', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('done'));
    expect(mocks.generateImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outputFormat: 'gif' }));
    const finalNodes = (mocks.upsertCanvasNodes.mock.calls as unknown as Array<[string, Array<{ data: Record<string, unknown> }>]>).at(-1)![1];
    expect(finalNodes[0].data).toMatchObject({ status: 'done', fileName: 'animated.gif', outputFormat: 'gif', width: 640, height: 360 });
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
    await vi.waitFor(() => expect(mocks.upsertCanvasNodes).toHaveBeenCalledTimes(2));
    const calls = mocks.upsertCanvasNodes.mock.calls as unknown as Array<[
      string,
      Array<{ id: string; position: { x: number; y: number }; data: { status: string } }>,
      { connectFrom: string[] } | undefined,
    ]>;
    const placeholderNodes = calls[0][1];
    expect(placeholderNodes[0].data.status).toBe('running');
    expect(mocks.pushNodeState).toHaveBeenCalledWith(expect.objectContaining({ phase: 'started', source: 'chat' }));
    expect(mocks.pushLocate).toHaveBeenCalledWith(expect.objectContaining({
      canvasId: 'canvas-ref-edge',
      nodeId: placeholderNodes[0].id,
      onlyIfOffscreen: true,
    }));
    const finalCall = calls.find(([, , options]) => Boolean(options));
    expect(finalCall).toBeDefined();
    const [, nodes, options] = finalCall!;
    expect(options!.connectFrom).toEqual(['ref-node']);
    expect(nodes[0].position).toEqual({ x: 540, y: 100 });
    await vi.waitFor(() => expect(mocks.writeRunThread).toHaveBeenCalled());
    expect(mocks.callAgentModel.mock.calls[0][1].systemSpec).toContain('生成成功后默认只用一句简短告知');
    const resultMessages = mocks.callAgentModel.mock.calls[1][1].messages;
    expect(resultMessages).toContainEqual(expect.objectContaining({
      role: 'tool', toolCallId: 'call-ref',
      content: expect.stringContaining('图片已展示，默认只需一句简短告知，不要主动点评或复述提示词'),
    }));
  });

  it('聊天多图按真实位图尺寸重排落点，竖图和横图互不重叠', async () => {
    const referenceImage = 'data:image/png;base64,dGVzdC1yZWY=';
    mocks.readCanvasDoc.mockResolvedValue({
      nodes: [{
        id: 'ref-node', type: 'flow-image', position: { x: 100, y: 100 },
        data: {
          kind: 'image', size: '1536x1536', width: 1536, height: 1536,
          imageUrl: referenceImage, versions: [{ id: 'ver-ref', imageUrl: referenceImage }],
        },
      }],
    });
    mocks.generateImages.mockReset().mockResolvedValue([
      { url: '/api/files/tall.png', fileName: 'tall.png', width: 1024, height: 1536 },
      { url: '/api/files/wide.png', fileName: 'wide.png', width: 1536, height: 1024 },
    ]);
    mocks.callAgentModel.mockReset()
      .mockResolvedValueOnce({
        text: '', protocol: 'tools',
        toolCalls: [{ id: 'call-size', name: 'generate_image', args: { prompt: '一竖一横', referenceUsage: 'edit', count: 2 } }],
      })
      .mockResolvedValueOnce({ text: '已完成。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    const runId = startChatRun({
      threadId: 'thread-size', canvasId: 'canvas-size', assistantMessageId: 'assistant-size',
      references: [{ canvasId: 'canvas-size', nodeId: 'ref-node', versionId: 'ver-ref' }],
      thread: {
        id: 'thread-size', canvasId: 'canvas-size', title: '真实尺寸', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-size', role: 'user', content: '一竖一横', createdAt: now },
          { id: 'assistant-size', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    });
    await approvePendingImages(runId, 'call-size');
    await vi.waitFor(() => expect(mocks.upsertCanvasNodes).toHaveBeenCalledTimes(2));
    const calls = mocks.upsertCanvasNodes.mock.calls as unknown as Array<[
      string,
      Array<{ position: { x: number; y: number }; data: Record<string, unknown> }>,
      { connectFrom: string[] } | undefined,
    ]>;
    const finalCall = calls.find(([, , options]) => Boolean(options));
    expect(finalCall).toBeDefined();
    const [, nodes] = finalCall!;
    expect(nodes.map((node) => node.position)).toEqual([
      { x: 540, y: 100 },
      { x: 540, y: 568 },
    ]);
    expect(nodes.map((node) => node.data)).toEqual([
      expect.objectContaining({ width: 1024, height: 1536, size: '1024x1536' }),
      expect.objectContaining({ width: 1536, height: 1024, size: '1536x1024' }),
    ]);
    expect(mocks.pushImage.mock.calls.map(([payload]) => payload)).toEqual([
      expect.objectContaining({ size: '1024x1536', width: 1024, height: 1536 }),
      expect.objectContaining({ size: '1536x1024', width: 1536, height: 1024 }),
    ]);
    await vi.waitFor(() => expect(mocks.writeRunThread).toHaveBeenCalled());
  });

  it.each([
    { name: 'same', newReference: false, model: 'image-model', reuse: true },
    { name: 'new-reference', newReference: true, model: 'image-model', reuse: false },
    { name: 'new-model', newReference: false, model: 'image-v2', reuse: false },
  ])('聊天 Responses 保留独立主模型与完整素材：$name', async ({ name, newReference, model, reuse }) => {
    mocks.direct = false;
    mocks.imageProfileOverrides = {
      model, models: [model], enabledModels: [model], imageApiMode: 'responses', responsesModel: 'same-provider-reasoner',
    };
    const baseImage = 'data:image/png;base64,QUJD';
    const newImage = 'data:image/png;base64,REVG';
    mocks.readCanvasDoc.mockResolvedValue({ nodes: [
      { id: 'base-node', type: 'flow-image', position: { x: 0, y: 0 }, data: {
        kind: 'image', imageUrl: baseImage, versions: [{ id: 'ver-base', imageUrl: baseImage,
          responseId: 'resp_base', imageGenerationCallId: 'ig_base', responseProfileId: 'image',
          responseModel: 'same-provider-reasoner', model: 'image-model' }],
      } },
      { id: 'new-node', type: 'flow-image', position: { x: 0, y: 500 }, data: {
        kind: 'image', imageUrl: newImage, versions: [{ id: 'ver-new', imageUrl: newImage }],
      } },
    ] });
    mocks.generateImages.mockResolvedValue([{ url: '/api/files/next.png', fileName: 'next.png' }]);
    mocks.callAgentModel.mockResolvedValueOnce({
      text: '', protocol: 'tools', toolCalls: [{ id: `call-${name}`, name: 'generate_image', args: {
        prompt: '继续修改背景', referenceUsage: 'edit', baseVersionId: 'ver-base',
        referenceImages: newReference ? [1] : [], count: 1,
      } }],
    }).mockResolvedValueOnce({ text: '已完成。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    const threadId = `thread-model-${name}`;
    const assistantMessageId = `assistant-model-${name}`;
    const run = startChatRun({ threadId, canvasId: 'canvas-model', assistantMessageId,
      references: newReference ? [{ nodeId: 'new-node', versionId: 'ver-new' }] : [],
      previousVersionId: 'ver-base', previousCanvasId: 'canvas-model',
      thread: { id: threadId, canvasId: 'canvas-model', title: '修改', createdAt: now, updatedAt: now, messages: [
        { id: `user-${name}`, role: 'user', content: '继续修改背景', createdAt: now },
        { id: assistantMessageId, role: 'assistant', content: '', status: 'running', createdAt: now },
      ] },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(run)?.status).toBe('done'));
    const params = mocks.generateImages.mock.calls[0][1];
    expect(params.responseModel).toBe('same-provider-reasoner');
    expect(params.model).toBe(model);
    expect(params.referenceDataUrls).toEqual(newReference ? [baseImage, newImage] : [baseImage]);
    expect(params.previousResponseId).toBe(reuse ? 'resp_base' : undefined);
    expect(params.previousImageGenerationCallId).toBe(reuse ? 'ig_base' : undefined);
    expect(params.reusePreviousImage).toBe(reuse ? true : undefined);
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
    await vi.waitFor(() => expect(mocks.upsertCanvasNodes).toHaveBeenCalledTimes(2));
    const calls = mocks.upsertCanvasNodes.mock.calls as unknown as Array<[
      string,
      Array<{ id: string; position: { x: number; y: number } }>,
      { connectFrom: string[] } | undefined,
    ]>;
    const finalCall = calls.find(([, , options]) => Boolean(options));
    expect(finalCall).toBeDefined();
    const [, nodes, options] = finalCall!;
    expect(options!.connectFrom).toEqual(['base-node']);
    expect(nodes[0].position).toEqual({ x: 640, y: 150 });
    await vi.waitFor(() => expect(mocks.writeRunThread).toHaveBeenCalled());
  });

  it('第二轮没有重新选图时沿用任务原图锚点，连线和摆放都不漂移', async () => {
    const anchorImage = 'data:image/png;base64,dGVzdC1hbmNob3I=';
    const previousImage = 'data:image/png;base64,dGVzdC1wcmV2aW91cw==';
    mocks.readCanvasDoc.mockResolvedValue({
      nodes: [
        {
          id: 'anchor-node', type: 'flow-image', position: { x: 100, y: 100 },
          data: { kind: 'image', size: '1024x1024', imageUrl: anchorImage, versions: [{ id: 'ver-anchor', imageUrl: anchorImage }] },
        },
        {
          id: 'previous-node', type: 'flow-image', position: { x: 540, y: 100 },
          data: { kind: 'image', size: '1024x1024', imageUrl: previousImage, versions: [{ id: 'ver-previous', imageUrl: previousImage }] },
        },
      ],
    });
    mocks.generateImages.mockReset().mockResolvedValue([{ url: '/api/files/second.png', fileName: 'second.png' }]);
    mocks.callAgentModel.mockReset()
      .mockResolvedValueOnce({
        text: '', protocol: 'tools',
        toolCalls: [{ id: 'call-anchor', name: 'generate_image', args: { prompt: '继续把线条加粗', referenceUsage: 'edit', count: 1 } }],
      })
      .mockResolvedValueOnce({ text: '已完成。', toolCalls: [], protocol: 'tools' });
    const now = new Date().toISOString();
    startChatRun({
      threadId: 'thread-anchor', canvasId: 'canvas-anchor', assistantMessageId: 'assistant-anchor',
      references: [], previousVersionId: 'ver-previous', previousCanvasId: 'canvas-anchor',
      thread: {
        id: 'thread-anchor', canvasId: 'canvas-anchor', title: '原图锚点', createdAt: now, updatedAt: now,
        memory: {
          visualWorkingSet: {
            sourceAnchor: { canvasId: 'canvas-anchor', nodeId: 'anchor-node', versionId: 'ver-anchor' },
          },
        },
        messages: [
          {
            id: 'user-anchor-first', role: 'user', content: '按这张参考图继续调整', createdAt: now,
            attachments: [{ canvasId: 'canvas-anchor', nodeId: 'anchor-node', versionId: 'ver-anchor' }],
          },
          {
            id: 'assistant-anchor-previous', role: 'assistant', content: '已生成。', status: 'done', createdAt: now,
            media: [{ canvasId: 'canvas-anchor', nodeId: 'previous-node', versionId: 'ver-previous', url: previousImage }],
          },
          { id: 'user-anchor-current', role: 'user', content: '继续把线条加粗', createdAt: now },
          { id: 'assistant-anchor', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    });

    await vi.waitFor(() => expect(mocks.upsertCanvasNodes).toHaveBeenCalledTimes(2));
    const calls = mocks.upsertCanvasNodes.mock.calls as unknown as Array<[
      string,
      Array<{ position: { x: number; y: number } }>,
      { connectFrom: string[] } | undefined,
    ]>;
    const finalCall = calls.find(([, , options]) => Boolean(options));
    expect(finalCall).toBeDefined();
    const [, nodes, options] = finalCall!;
    expect(options!.connectFrom).toEqual(['anchor-node']);
    expect(nodes[0].position).toEqual({ x: 540, y: 468 });
    expect(mocks.generateImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      referenceDataUrls: expect.arrayContaining([anchorImage]),
    }));
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

  it.each([
    ['new-without-image', '全新需求：设计蓝色Logo，不要文字', false, false, undefined],
    ['new-with-image', '全新需求：参考这张图设计蓝色Logo', true, false, 'current'],
    ['continue-edit', '把上一张标题放大', false, false, 'result'],
    ['clarification', '参考这张图设计Logo', true, true, 'current'],
    ['new-clarification', '全新需求：设计蓝色Logo，不要文字', false, true, undefined],
  ])('%s：视觉上下文只取当前需求，不回捞旧附件', async (tag, content, hasAttachment, hasAnswers, expectedImage) => {
    mocks.callAgentModel.mockResolvedValueOnce({ text: '已收到需求。', toolCalls: [], protocol: 'tools' });
    mocks.callTextModel.mockRejectedValue(new Error('摘要暂不可用，保留原文'));
    const oldImage = 'data:image/png;base64,b2xk';
    const currentImage = 'data:image/png;base64,Y3VycmVudA==';
    const resultImage = 'data:image/png;base64,cmVzdWx0';
    const now = new Date().toISOString();
    const threadId = `visual-boundary-${tag}`;
    const runId = startChatRun({
      threadId, canvasId: 'canvas-visual-boundary', assistantMessageId: 'current-assistant', references: [],
      ...(hasAnswers ? { answers: { style: ['蓝色'] } } : {}),
      thread: {
        id: threadId, title: '视觉上下文边界', createdAt: now, updatedAt: now,
        messages: [
          { id: 'old-user', role: 'user', content: '参考这张图做红金海报', createdAt: now, attachments: [{ canvasId: 'canvas-visual-boundary', nodeId: 'old-reference', url: oldImage }] },
          { id: 'old-assistant', role: 'assistant', content: '已完成。', status: 'done', createdAt: now, media: [{ canvasId: 'canvas-visual-boundary', nodeId: 'old-result', versionId: 'old-version', url: resultImage }] },
          { id: 'current-user', role: 'user', content, createdAt: now, ...(hasAttachment ? { attachments: [{ canvasId: 'canvas-visual-boundary', nodeId: 'current-reference', url: currentImage }] } : {}) },
          { id: 'current-assistant', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('done'));
    const params = mocks.callAgentModel.mock.calls[0][1];
    expect(params.visualContext.map((item: { url: string }) => item.url)).toEqual(expectedImage ? [expectedImage === 'current' ? currentImage : resultImage] : []);
    if (hasAnswers) expect(params.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.content).toContain('已确认的补充信息');
    expect(mocks.generateImages).not.toHaveBeenCalled();
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

  it('追问 schema 限制为最多两题且过滤无效选项', () => {
    const questions = normalizeAskUserQuestions([
      { id: 'subject', title: '主体是什么？', options: ['商品', '场景'] },
      { title: '风格？', multiple: true, options: [{ label: '简约', recommended: true }, { label: '复古' }] },
      { title: '不完整问题', options: ['唯一选项'] },
      { title: '比例？', options: ['横向', '竖向'] },
      { title: '超出上限', options: ['A', 'B'] },
    ]);
    expect(questions).toHaveLength(2);
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
      expect(mocks.upsertCanvasNodes).toHaveBeenCalledTimes(2);
      expect(mocks.pushImage).toHaveBeenCalledTimes(2);
      expect(mocks.upsertCanvasNodes.mock.invocationCallOrder[0]).toBeLessThan(mocks.generateImages.mock.invocationCallOrder[0]);
      expect(mocks.upsertCanvasNodes.mock.invocationCallOrder[1]).toBeLessThan(mocks.pushImage.mock.invocationCallOrder[0]);
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

  it('生图失败时把已落盘的生成中占位改成错误态', async () => {
    mocks.generateImages.mockRejectedValueOnce(new Error('upstream boom'));
    mocks.callAgentModel.mockResolvedValueOnce({
      text: '',
      protocol: 'tools',
      toolCalls: [{
        id: 'call-fail',
        name: 'generate_image',
        args: { prompt: '这次会失败', count: 1 },
      }],
    });
    const now = new Date().toISOString();
    const request: StartRunRequest = {
      threadId: 'thread-fail', canvasId: 'canvas-fail', assistantMessageId: 'assistant-fail', references: [],
      thread: {
        id: 'thread-fail', canvasId: 'canvas-fail', title: '失败占位', createdAt: now, updatedAt: now,
        messages: [
          { id: 'user-fail', role: 'user', content: '生成一张', createdAt: now },
          { id: 'assistant-fail', role: 'assistant', content: '', status: 'running', createdAt: now },
        ],
      },
    };
    const runId = startChatRun(request);
    await vi.waitFor(() => expect(mocks.generateImages).toHaveBeenCalled());
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('error'));

    const calls = mocks.upsertCanvasNodes.mock.calls as unknown as Array<[
      string,
      Array<{ data: Record<string, unknown> }>,
      { connectFrom?: string[] } | undefined,
    ]>;
    expect(calls).toHaveLength(2);
    expect(calls[1][1][0].data).toMatchObject({
      status: 'error',
      error: expect.stringContaining('upstream boom'),
    });
    expect(mocks.pushNodeState).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'error',
      source: 'chat',
    }));
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
    expect(mocks.upsertCanvasNodes).not.toHaveBeenCalled();
    expect(mocks.pushImage).not.toHaveBeenCalled();
    expect(mocks.callAgentModel).toHaveBeenCalledTimes(1);
  });

  it('待回答时切换模型保留上下文，旧 run 继续原模型，下一轮使用新模型', async () => {
    const now = new Date().toISOString();
    const question = { id: 'style', title: '希望什么感觉？', purpose: 'creative', options: [{ label: '温暖', value: 'warm' }] };
    mocks.callAgentModel
      .mockResolvedValueOnce({ text: '', protocol: 'tools', toolCalls: [{ id: 'ask-switch', name: 'ask_user', args: { questions: [question] } }] })
      .mockResolvedValueOnce({ text: '保留文字，只调整颜色。', protocol: 'tools', toolCalls: [] })
      .mockResolvedValueOnce({ text: '继续按已确认的内容调整。', protocol: 'tools', toolCalls: [] });
    const runId = startChatRun({
      threadId: 'switch-run', canvasId: 'canvas-switch', assistantMessageId: 'a1', references: [],
      modelSelection: { textProfileId: 'text', textModel: 'text-model' },
      thread: { id: 'switch-run', canvasId: 'canvas-switch', title: '切模型', createdAt: now, updatedAt: now, messages: [
        { id: 'u1', role: 'user', content: '保留山间来信这几个字，只改颜色', createdAt: now },
        { id: 'a1', role: 'assistant', content: '', status: 'running', createdAt: now },
      ] },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.thread.messages[1].status).toBe('awaiting_input'));
    const latest = mocks.savedThreads.get('switch-run')!;
    mocks.savedThreads.set('switch-run', { ...latest, textProfileId: 'text', textModel: 'next-model', revision: latest.revision + 1 });
    const transient = Object.assign(new Error('并发更新'), { status: 409 });
    mocks.writeClientThread.mockRejectedValueOnce(transient);
    const input = { answers: { style: ['warm'] }, userMessage: { id: 'u2', content: '温暖' }, assistantMessage: { id: 'a2', content: '' } };
    expect(await answerChatRun(runId, 'ask-switch', input)).toBe(true);
    expect(await answerChatRun(runId, 'ask-switch', input)).toBe(false);
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('done'));
    expect(mocks.callAgentModel.mock.calls.slice(0, 2).map(([profile]) => profile.model)).toEqual(['text-model', 'text-model']);
    const saved = mocks.savedThreads.get('switch-run')!;
    expect(saved.textModel).toBe('next-model');
    expect(saved.messages.find((message) => message.id === 'a2')?.modelSelection).toMatchObject({ textModel: 'text-model' });
    const next = startChatRun({
      threadId: saved.id, canvasId: 'canvas-switch', assistantMessageId: 'a3', references: [],
      modelSelection: { textProfileId: 'text', textModel: 'next-model' },
      thread: { ...saved, messages: [...saved.messages, { id: 'u3', role: 'user', content: '继续', createdAt: now }, { id: 'a3', role: 'assistant', content: '', status: 'running', createdAt: now }] },
    });
    await vi.waitFor(() => expect(getChatRunSnapshot(next)?.status).toBe('done'));
    expect(mocks.callAgentModel.mock.calls[2][0].model).toBe('next-model');
    expect(JSON.stringify(mocks.callAgentModel.mock.calls[2][1].messages)).toContain('保留山间来信这几个字');
    expect(mocks.generateImages).not.toHaveBeenCalled();
  });

  it('答案保存失败后保持待答，允许重试且不重复追加', async () => {
    const now = new Date().toISOString();
    mocks.callAgentModel
      .mockResolvedValueOnce({ text: '', protocol: 'tools', toolCalls: [{ id: 'ask-retry', name: 'ask_user', args: { questions: [{ id: 'text', title: '需要哪段文字？', type: 'text' }] } }] })
      .mockResolvedValueOnce({ text: '已收到。', protocol: 'tools', toolCalls: [] });
    const runId = startChatRun({ threadId: 'answer-retry', canvasId: 'canvas-retry', assistantMessageId: 'a1', references: [], thread: {
      id: 'answer-retry', title: '重试答案', createdAt: now, updatedAt: now, messages: [
        { id: 'u1', role: 'user', content: '生成品牌标志', createdAt: now }, { id: 'a1', role: 'assistant', content: '', status: 'running', createdAt: now },
      ],
    } });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.thread.messages[1].status).toBe('awaiting_input'));
    mocks.writeClientThread.mockRejectedValueOnce(new Error('暂时无法保存'));
    const input = { answers: { text: ['山间来信'] }, userMessage: { id: 'u2', content: '山间来信' }, assistantMessage: { id: 'a2', content: '' } };
    await expect(answerChatRun(runId, 'ask-retry', input)).rejects.toThrow('暂时无法保存');
    expect(getChatRunSnapshot(runId)).toMatchObject({ status: 'running' });
    expect(getChatRunSnapshot(runId)?.thread.messages[1].status).toBe('awaiting_input');
    expect(await answerChatRun(runId, 'ask-retry', input)).toBe(true);
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('done'));
    expect(mocks.savedThreads.get('answer-retry')?.messages).toHaveLength(4);
  });

  it('拒绝把已有对话发送到另一画布，且不调用模型', async () => {
    const now = new Date().toISOString();
    const thread = { id: 'wrong-owner', canvasId: 'canvas-a', title: '归属校验', createdAt: now, updatedAt: now, messages: [], revision: 1, generation: 0 };
    mocks.savedThreads.set(thread.id, thread);
    const runId = startChatRun({ threadId: thread.id, canvasId: 'canvas-b', assistantMessageId: 'a1', references: [], thread: { ...thread, canvasId: 'canvas-b' } });
    await vi.waitFor(() => expect(getChatRunSnapshot(runId)?.status).toBe('error'));
    expect(mocks.writeClientThread).not.toHaveBeenCalled();
    expect(mocks.callAgentModel).not.toHaveBeenCalled();
    expect(mocks.savedThreads.get(thread.id)?.canvasId).toBe('canvas-a');
  });

  it('结构化追问会暂停当前 run，提交答案后继续同一轮', async () => {
    mocks.callAgentModel.mockReset();
    mocks.upsertCanvasNodes.mockClear();
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
