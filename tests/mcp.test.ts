import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpDeps } from '../bridge/mcp';
import type { StoredSettings } from '../bridge/settings';

// 参考图归一化会真的写 / 读媒体文件：先进临时数据根，再动态 import bridge——
// paths.ts 在 import 时就按 HUIBAN_DATA_ROOT 定 MEDIA_DIR，顺序不能反
const TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'huiban-mcp-'));
process.env.HUIBAN_DATA_ROOT = TEST_DATA_ROOT;
const { callMcpTool, defaultMcpDeps, listMcpTools, resolveReferenceDataUrls } = await import('../bridge/mcp');
const { keepExternalNodesOnSnapshot } = await import('../bridge/http');
const { createProfile, emptyPreferences } = await import('../bridge/settings');

function makeDeps(overrides: Partial<McpDeps> = {}): McpDeps {
  const generateImages = vi.fn(async () => [{
    fileName: 'img_test_1.png',
    url: '/api/files/img_test_1.png',
    filePath: '/tmp/media/img_test_1.png',
    revisedPrompt: 'revised-1',
    responseId: 'resp-1',
    imageGenerationCallId: 'call-1',
    responseModel: 'gpt-image-2.5',
  }]) as unknown as McpDeps['generateImages'];
  return {
    ...defaultMcpDeps,
    readSettings: vi.fn(async () => {
      const profile = { ...createProfile('默认'), id: 'p1', baseUrl: 'https://api.example.com/v1', apiKey: 'key' };
      return {
        profiles: [profile],
        activeProfileId: 'p1',
        direct: true,
        textProfileId: '',
        enhanceLevel: 'balanced',
        preferences: emptyPreferences(),
      } as unknown as StoredSettings;
    }) as unknown as McpDeps['readSettings'],
    readCanvasRegistry: vi.fn(async () => ({ c1: '默认画布' })) as unknown as McpDeps['readCanvasRegistry'],
    readCanvasDoc: vi.fn(async (id: string) => (
      id === 'c1' ? { name: '默认画布', nodes: [], edges: [] } : undefined
    )) as unknown as McpDeps['readCanvasDoc'],
    generateImages,
    pushImage: vi.fn(),
    pushLocate: vi.fn(),
    countOpenTabs: vi.fn(() => 1),
    appendCanvasImageNodes: vi.fn(async () => true) as unknown as McpDeps['appendCanvasImageNodes'],
    createCanvas: vi.fn(async (canvasId: string, name: string) => ({ id: canvasId, name })) as unknown as McpDeps['createCanvas'],
    resolveReferenceDataUrls: vi.fn(async (inputs: string[]) => inputs.map((item) => ({ dataUrl: `data:${item}`, url: item }))),
    enhancePrompt: vi.fn(async () => ({ prompt: 'stub-optimized', usage: 'style', referenceRoles: [] })) as unknown as McpDeps['enhancePrompt'],
    ...overrides,
  };
}

function textOf(result: { content: Array<{ type: string; text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

describe('MCP 工具面', () => {
  it('十二个工具齐备，generate 带参考图与比例参数', () => {
    const tools = listMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'huiban_generate', 'huiban_canvases', 'huiban_canvas_create', 'huiban_nodes', 'huiban_locate', 'huiban_models',
      'huiban_config', 'huiban_prompt_guide', 'huiban_video_prompt_guide', 'huiban_optimize',
      'huiban_video_generate', 'huiban_video_task',
    ]);
    const optimize = tools.find((tool) => tool.name === 'huiban_optimize') as any;
    expect(optimize.inputSchema.required).toEqual(['prompt']);
    const guide = tools.find((tool) => tool.name === 'huiban_prompt_guide') as any;
    expect(guide.inputSchema.properties.level.enum).toEqual(['strict', 'balanced', 'creative']);
    const generate = tools.find((tool) => tool.name === 'huiban_generate') as any;
    expect(generate.inputSchema.required).toEqual(['prompt']);
    expect(generate.inputSchema.properties.referenceImages).toBeTruthy();
    expect(generate.inputSchema.properties.ratio.enum).toContain('16:9');
    expect(generate.inputSchema.properties.n).toBeTruthy();
  });

  it('huiban_config 不返回 Key', async () => {
    const deps = makeDeps();
    const payload = textOf(await callMcpTool('huiban_config', {}, deps));
    expect(payload.profiles[0].keyConfigured).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('"apiKey"');
    expect(payload.guide).toContain('huiban_generate');
  });

  it('huiban_prompt_guide 返回与优化链路同一份规范（size 走默认、level 可覆盖）', async () => {
    const deps = makeDeps();
    const payload = textOf(await callMcpTool('huiban_prompt_guide', { size: '1536x1024', level: 'creative' }, deps));
    expect(payload.level).toBe('creative');
    expect(payload.levels.map((item: any) => item.level)).toEqual(['strict', 'balanced', 'creative']);
    // 规范就是 buildSystemSpec 的产物：结构与红线标记必须在
    expect(payload.spec).toContain('你是图像生成模型的提示词工程师');
    expect(payload.spec).toContain('忠实性红线');
    expect(payload.spec).toContain('横向宽画幅'); // size=1536x1024 的画幅提示
    // 当前配置里的语言模型/档案如实呈现；测试桩里没有语言模型那一路
    expect(payload.activeConfig.textProfile).toBeNull();
    expect(payload.activeConfig.direct).toBe(true);
    expect(payload.referenceRules.fidelityByUsage).toEqual({ style: 'low', edit: 'high' });
  });

  it('huiban_prompt_guide 缺省 size 用生图配置默认尺寸', async () => {
    const deps = makeDeps();
    const payload = textOf(await callMcpTool('huiban_prompt_guide', {}, deps));
    // makeDeps 的桩 defaultSize=1024x1024 → 方形画幅提示
    expect(payload.spec).toContain('1:1 方形');
  });

  it('huiban_prompt_guide 把已启用 Skills 提供给外部 Agent', async () => {
    const deps = makeDeps({
      listPromptSkills: vi.fn(async () => [{
        id: 's1', name: '电商主图', description: '产品表现', category: '', avatarUrl: '', content: '# 规则\n突出产品', skills: [], enabled: true,
        createdAt: 'now', updatedAt: 'now',
      }]),
    });
    const payload = textOf(await callMcpTool('huiban_prompt_guide', {}, deps));
    expect(payload.enabledSkills).toEqual([{ name: '电商主图', description: '产品表现', content: '# 规则\n突出产品' }]);
  });

  it('huiban_video_generate 只允许目标画布中的视频节点', async () => {
    const deps = makeDeps({
      readCanvasDoc: vi.fn(async () => ({
        name: '测试', nodes: [{ id: 'image-1', type: 'flow-image', position: { x: 0, y: 0 }, data: { kind: 'image' } }], edges: [],
      })) as unknown as McpDeps['readCanvasDoc'],
    });
    await expect(callMcpTool('huiban_video_generate', {
      canvasId: 'c1', nodeId: 'image-1', prompt: '镜头推进',
    }, deps)).rejects.toThrow(/不是该画布上的视频节点/);
  });

  it('huiban_video_generate 同步提示词并把已连首帧传给现有视频路由', async () => {
    const patchVideoNode = vi.fn(async () => true);
    const originalFetch = globalThis.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({
        data: { ok: true, taskId: 'task-1' },
        msg: '视频任务已受理',
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const deps = makeDeps({
        readCanvasDoc: vi.fn(async () => ({
          name: '测试',
          nodes: [{
            id: 'video-1', type: 'flow-image', position: { x: 0, y: 0 },
            data: { kind: 'video', videoSeconds: 6, videoRatio: '9:16', references: [{ kind: 'image', url: '/api/files/frame.png' }] },
          }],
          edges: [],
        })) as unknown as McpDeps['readCanvasDoc'],
        patchVideoNode: patchVideoNode as unknown as McpDeps['patchVideoNode'],
      });
      const result = textOf(await callMcpTool('huiban_video_generate', {
        canvasId: 'c1', nodeId: 'video-1', prompt: '角色转身，镜头缓慢推进',
      }, deps));
      expect(result).toMatchObject({ ok: true, taskId: 'task-1', statusTool: 'huiban_video_task' });
      expect(patchVideoNode).toHaveBeenCalledWith('c1', 'video-1', expect.objectContaining({
        prompt: '角色转身，镜头缓慢推进', videoSeconds: 6, videoRatio: '9:16',
      }));
      expect(requestBodies[0]).toMatchObject({
        canvasId: 'c1', nodeId: 'video-1', prompt: '角色转身，镜头缓慢推进',
        seconds: 6, ratio: '9:16', imageFileNames: ['frame.png'],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('huiban_optimize 走语言模型并带回下一步指引', async () => {
    const textProfile = { ...createProfile('语言'), id: 't1', kind: 'text' as const, model: 'gpt-5.5', apiKey: 'tk' };
    const enhancePrompt = vi.fn(async (_profile: unknown, _params: Record<string, unknown>) => ({ prompt: '一只戴斗笠的柴犬，雨夜巷口，霓虹反光', usage: 'style', referenceRoles: [] }));
    const deps = makeDeps({
      readSettings: vi.fn(async () => ({
        profiles: [textProfile],
        activeProfileId: 't1',
        direct: false,
        textProfileId: 't1',
        enhanceLevel: 'balanced',
        preferences: { ...emptyPreferences(), enabled: true, entries: [{ id: 'e1', text: '偏好留白', source: 'manual', createdAt: 't' }] },
      } as unknown as StoredSettings)) as unknown as McpDeps['readSettings'],
      enhancePrompt: enhancePrompt as unknown as McpDeps['enhancePrompt'],
    });
    const payload = textOf(await callMcpTool('huiban_optimize', { prompt: '画一只斗笠柴犬' }, deps));
    expect(payload.prompt).toBe('一只戴斗笠的柴犬，雨夜巷口，霓虹反光');
    expect(payload.usage).toBe('style');
    expect(payload.profile).toEqual({ id: 't1', name: '语言' });
    expect(payload.nextStep).toContain('referenceUsage:"style"');
    // 档案开启时注入；level 取设置里的 balanced；usage 按措辞自动判为 style
    const passed = enhancePrompt.mock.calls[0][1] as any;
    expect(passed.level).toBe('balanced');
    expect(passed.usage).toBe('style');
    expect(passed.preferences).toHaveLength(1);
  });

  it('huiban_optimize 按措辞判图生图，显式 usage 优先', async () => {
    const textProfile = { ...createProfile('语言'), id: 't1', kind: 'text' as const, model: 'gpt-5.5', apiKey: 'tk' };
    const enhancePrompt = vi.fn(async (_profile: unknown, _params: Record<string, unknown>) => ({ prompt: '把参考图背景换成雪山', usage: 'edit', referenceRoles: [] }));
    const deps = makeDeps({
      readSettings: vi.fn(async () => ({
        profiles: [textProfile],
        activeProfileId: 't1',
        direct: false,
        textProfileId: 't1',
        enhanceLevel: 'balanced',
        preferences: emptyPreferences(),
      } as unknown as StoredSettings)) as unknown as McpDeps['readSettings'],
      enhancePrompt: enhancePrompt as unknown as McpDeps['enhancePrompt'],
    });
    const payload = textOf(await callMcpTool('huiban_optimize', { prompt: '把这张图改成雪山' }, deps));
    expect(payload.usage).toBe('edit');
    expect((enhancePrompt.mock.calls[0][1] as any).usage).toBe('edit');
    expect(payload.nextStep).toContain('inputFidelity:high');
  });

  it('huiban_optimize 没有语言模型 / 空 prompt 时报错并指路', async () => {
    await expect(callMcpTool('huiban_optimize', { prompt: '' }, makeDeps())).rejects.toThrow(/prompt 不能为空/);
    await expect(callMcpTool('huiban_optimize', { prompt: '画猫' }, makeDeps())).rejects.toThrow(/尚未配置语言模型/);
  });

  it('huiban_canvases 带节点数与更新时间', async () => {
    const deps = makeDeps({
      readCanvasDoc: vi.fn(async () => ({ name: '默认画布', nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [], updatedAt: '2026-09-27T00:00:00Z' })) as unknown as McpDeps['readCanvasDoc'],
    });
    const payload = textOf(await callMcpTool('huiban_canvases', {}, deps));
    expect(payload).toEqual([{ id: 'c1', name: '默认画布', nodeCount: 2, updatedAt: '2026-09-27T00:00:00Z' }]);
  });

  it('huiban_nodes 列图片节点并支持 kind 过滤与 limit', async () => {
    const deps = makeDeps({
      readCanvasDoc: vi.fn(async () => ({
        name: '默认画布',
        edges: [],
        nodes: [
          { id: 'n1', data: { kind: 'image', label: '图', prompt: 'p1', imageUrl: '/api/files/a.png', fileName: 'a.png', size: '1024x1024', model: 'm', createdAt: 't1' } },
          { id: 'n2', data: { kind: 'composer', prompt: 'p2' } },
        ],
      })) as unknown as McpDeps['readCanvasDoc'],
    });
    const all = textOf(await callMcpTool('huiban_nodes', { canvasId: 'c1' }, deps));
    expect(all.total).toBe(2);
    expect(all.nodes[0].imageUrl).toBe('/api/files/a.png');
    const onlyImages = textOf(await callMcpTool('huiban_nodes', { canvasId: 'c1', kind: 'image' }, deps));
    expect(onlyImages.total).toBe(1);
    expect(onlyImages.nodes[0].fileName).toBe('a.png');
  });

  it('huiban_nodes 对不存在的画布报错并指路', async () => {
    const deps = makeDeps({ readCanvasDoc: vi.fn(async () => undefined) as unknown as McpDeps['readCanvasDoc'] });
    await expect(callMcpTool('huiban_nodes', { canvasId: 'nope' }, deps)).rejects.toThrow(/huiban_canvases/);
  });

  it('huiban_locate 推送定位请求并回报节点信息', async () => {
    const deps = makeDeps({
      readCanvasDoc: vi.fn(async () => ({
        name: '默认画布',
        edges: [],
        nodes: [
          { id: 'n1', position: { x: 96, y: 240 }, data: { kind: 'image', label: '猫', prompt: '一只猫', imageUrl: '/api/files/a.png', createdAt: 't1' } },
        ],
      })) as unknown as McpDeps['readCanvasDoc'],
    });
    const payload = textOf(await callMcpTool('huiban_locate', { canvasId: 'c1', nodeId: 'n1' }, deps));
    expect(payload.located).toBe(true);
    expect(payload.nodeId).toBe('n1');
    expect(payload.position).toEqual({ x: 96, y: 240 });
    expect(payload.delivered).toBe(true);
    const push = deps.pushLocate as unknown as ReturnType<typeof vi.fn>;
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({ type: 'locate', canvasId: 'c1', nodeId: 'n1' });
  });

  it('huiban_locate 等待转发确认；失败时不虚报 delivered', async () => {
    let confirm!: () => void;
    const deps = makeDeps({
      readCanvasDoc: vi.fn(async () => ({ name: '画布', edges: [], nodes: [{ id: 'n1' }] })) as unknown as McpDeps['readCanvasDoc'],
      pushLocate: vi.fn(() => new Promise<void>((resolve) => { confirm = resolve; })) as unknown as McpDeps['pushLocate'],
    });
    let settled = false;
    const pending = callMcpTool('huiban_locate', { canvasId: 'c1', nodeId: 'n1' }, deps).then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(deps.pushLocate).toHaveBeenCalled());
    const beforeConfirmation = settled;
    confirm();
    await pending;
    expect(beforeConfirmation).toBe(false);
    deps.pushLocate = vi.fn(async () => { throw new Error('relay failed'); }) as unknown as McpDeps['pushLocate'];
    await expect(callMcpTool('huiban_locate', { canvasId: 'c1', nodeId: 'n1' }, deps)).rejects.toThrow(/relay failed/);
  });

  it('huiban_locate 省略 nodeId 时定位画布上最新的节点', async () => {
    const deps = makeDeps({
      readCanvasDoc: vi.fn(async () => ({
        name: '默认画布',
        edges: [],
        nodes: [
          { id: 'old', data: { kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' } },
          { id: 'new', data: { kind: 'image', createdAt: '2026-02-01T00:00:00.000Z' } },
        ],
      })) as unknown as McpDeps['readCanvasDoc'],
    });
    const payload = textOf(await callMcpTool('huiban_locate', { canvasId: 'c1' }, deps));
    expect(payload.nodeId).toBe('new');
  });

  it('huiban_locate 对不存在的画布 / 节点报错，没开浏览器时如实说', async () => {
    const missing = makeDeps({ readCanvasDoc: vi.fn(async () => undefined) as unknown as McpDeps['readCanvasDoc'] });
    await expect(callMcpTool('huiban_locate', { canvasId: 'nope', nodeId: 'n1' }, missing)).rejects.toThrow(/huiban_canvases/);

    const noNode = makeDeps({ readCanvasDoc: vi.fn(async () => ({ name: '默认画布', edges: [], nodes: [] })) as unknown as McpDeps['readCanvasDoc'] });
    await expect(callMcpTool('huiban_locate', { canvasId: 'c1', nodeId: 'x' }, noNode)).rejects.toThrow(/没有节点/);

    const noTabs = makeDeps({
      countOpenTabs: vi.fn(() => 0) as unknown as McpDeps['countOpenTabs'],
      readCanvasDoc: vi.fn(async () => ({ name: '默认画布', edges: [], nodes: [{ id: 'n1', data: { kind: 'image', createdAt: 't1' } }] })) as unknown as McpDeps['readCanvasDoc'],
    });
    const payload = textOf(await callMcpTool('huiban_locate', { canvasId: 'c1', nodeId: 'n1' }, noTabs));
    expect(payload.delivered).toBe(false);
    expect(payload.hints.join('')).toContain('没有打开的浏览器');
  });

  it('huiban_canvas_create 委托建画布并回 id（返回的就是真正建档的 id）', async () => {
    const deps = makeDeps();
    const payload = textOf(await callMcpTool('huiban_canvas_create', { name: '测试画布' }, deps));
    const [usedId, usedName] = (deps.createCanvas as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(usedName).toBe('测试画布');
    expect(usedId).toMatch(/^canvas_mcp_/);
    expect(payload.canvas).toEqual({ id: usedId, name: '测试画布' });
    expect(payload.canvasId).toBe(usedId);
  });
});

describe('huiban_generate', () => {
  it('不传 canvasId 时只出图不落画布', async () => {
    const deps = makeDeps();
    const payload = textOf(await callMcpTool('huiban_generate', { prompt: '一只猫' }, deps));
    expect(payload.ok).toBe(true);
    expect(payload.deliveredToCanvas).toBe(false);
    expect(payload.persistedToDoc).toBe(false);
    expect(payload.images[0].localPath).toBe('/tmp/media/img_test_1.png');
    expect(deps.appendCanvasImageNodes).not.toHaveBeenCalled();
    expect(deps.pushImage).not.toHaveBeenCalled();
  });

  it('传 canvasId 时写文档 + SSE 双通道，节点带 mcp 来源', async () => {
    const deps = makeDeps();
    const payload = textOf(await callMcpTool('huiban_generate', { prompt: '一只猫', canvasId: 'c1' }, deps));
    expect(payload.persistedToDoc).toBe(true);
    expect(payload.deliveredToCanvas).toBe(true);
    const append = deps.appendCanvasImageNodes as unknown as ReturnType<typeof vi.fn>;
    expect(append).toHaveBeenCalledTimes(1);
    const [canvasId, nodes] = append.mock.calls[0];
    expect(canvasId).toBe('c1');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe(payload.images[0].nodeId);
    expect(nodes[0].type).toBe('flow-image');
    expect(nodes[0].data.source).toBe('mcp');
    expect(nodes[0].data.status).toBe('done');
    expect(nodes[0].data.imageUrl).toBe('/api/files/img_test_1.png');
    expect(nodes[0].data.createdAt).toBeTruthy();
    const push = deps.pushImage as unknown as ReturnType<typeof vi.fn>;
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({ type: 'image', canvasId: 'c1', nodeId: nodes[0].id });
  });

  it('出图后默认自动定位（onlyIfOffscreen，前端自己判断要不要挪镜头）', async () => {
    const deps = makeDeps();
    const payload = textOf(await callMcpTool('huiban_generate', { prompt: '一只猫', canvasId: 'c1' }, deps));
    expect(payload.autoLocate).toBe(true);
    const locate = deps.pushLocate as unknown as ReturnType<typeof vi.fn>;
    expect(locate).toHaveBeenCalledTimes(1);
    expect(locate.mock.calls[0][0]).toMatchObject({ type: 'locate', canvasId: 'c1', onlyIfOffscreen: true });
    expect(locate.mock.calls[0][0].nodeId).toBe(payload.images[0].nodeId);
    // 定位不替代推图：图照样实时落画布
    expect((deps.pushImage as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('locate:false 时不发定位，只提示可以调 huiban_locate 补', async () => {
    const deps = makeDeps();
    const payload = textOf(await callMcpTool('huiban_generate', { prompt: '一只猫', canvasId: 'c1', locate: false }, deps));
    expect(payload.autoLocate).toBe(false);
    expect(deps.pushLocate).not.toHaveBeenCalled();
    expect(payload.hints.join('')).toContain('huiban_locate');
  });

  it('没落画布时不定位（没有节点可定位）', async () => {
    const deps = makeDeps();
    await callMcpTool('huiban_generate', { prompt: '一只猫' }, deps);
    expect(deps.pushLocate).not.toHaveBeenCalled();
  });

  it('n=3 时每张各成一个节点，label 带序号', async () => {
    const deps = makeDeps({
      generateImages: vi.fn(async () => [1, 2, 3].map((index) => ({
        fileName: `img_${index}.png`, url: `/api/files/img_${index}.png`, filePath: `/tmp/media/img_${index}.png`,
      }))) as unknown as McpDeps['generateImages'],
    });
    const payload = textOf(await callMcpTool('huiban_generate', { prompt: '猫', canvasId: 'c1', n: 3 }, deps));
    const append = deps.appendCanvasImageNodes as unknown as ReturnType<typeof vi.fn>;
    const nodes = append.mock.calls[0][1];
    expect(nodes).toHaveLength(3);
    expect(new Set(nodes.map((node: any) => node.id)).size).toBe(3);
    expect(nodes[1].data.label).toContain('2/3');
    expect(payload.images).toHaveLength(3);
    expect(deps.pushImage).toHaveBeenCalledTimes(3);
  });

  it('推图或自动定位失败如实返回 deliveryError，不虚报实时送达', async () => {
    for (const failedPush of ['pushImage', 'pushLocate'] as const) {
      const deps = makeDeps({
        [failedPush]: vi.fn(async () => { throw new Error(`${failedPush} relay failed`); }),
      });
      const payload = textOf(await callMcpTool('huiban_generate', { prompt: '猫', canvasId: 'c1' }, deps));
      expect(payload.persistedToDoc).toBe(true);
      expect(payload.deliveredToCanvas).toBe(false);
      expect(payload.autoLocate).toBe(false);
      expect(payload.deliveryError).toContain('relay failed');
      expect(payload.persistError).toBeUndefined();
      expect(payload.hints.join('')).toContain('实时通知失败');
    }
  });

  it('生成结果等待推图确认后才发定位和返回', async () => {
    let confirm!: () => void;
    const deps = makeDeps({
      pushImage: vi.fn(() => new Promise<void>((resolve) => { confirm = resolve; })) as unknown as McpDeps['pushImage'],
    });
    let settled = false;
    const pending = callMcpTool('huiban_generate', { prompt: '猫', canvasId: 'c1' }, deps).then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(deps.pushImage).toHaveBeenCalled());
    const beforeConfirmation = settled;
    const locateBeforeConfirmation = (deps.pushLocate as ReturnType<typeof vi.fn>).mock.calls.length;
    confirm();
    await pending;
    expect(beforeConfirmation).toBe(false);
    expect(locateBeforeConfirmation).toBe(0);
  });

  it('ratio 映射成尺寸，非法比例报错', async () => {
    const deps = makeDeps();
    const payload = textOf(await callMcpTool('huiban_generate', { prompt: '猫', ratio: '16:9' }, deps));
    expect(payload.size).toBe('1344x768');
    await expect(callMcpTool('huiban_generate', { prompt: '猫', ratio: '5:4' }, deps)).rejects.toThrow(/比例/);
  });

  it('参考图与 inputFidelity 传入生图出口', async () => {
    const deps = makeDeps({
      resolveReferenceDataUrls: vi.fn(async () => [{ dataUrl: 'data:image/png;base64,AA', url: '/api/files/a.png' }]),
    });
    await callMcpTool('huiban_generate', {
      prompt: '图生图', canvasId: 'c1', referenceImages: ['/api/files/a.png'], referenceUsage: 'edit',
    }, deps);
    const generate = deps.generateImages as unknown as ReturnType<typeof vi.fn>;
    const params = generate.mock.calls[0][1];
    expect(params.referenceDataUrls).toEqual(['data:image/png;base64,AA']);
    expect(params.inputFidelity).toBe('high');
  });

  it('空 prompt 与未知画布都被拦住', async () => {
    const deps = makeDeps();
    await expect(callMcpTool('huiban_generate', { prompt: '  ' }, deps)).rejects.toThrow(/prompt/);
    await expect(callMcpTool('huiban_generate', { prompt: '猫', canvasId: 'ghost' }, deps)).rejects.toThrow(/huiban_canvases/);
    expect(deps.appendCanvasImageNodes).not.toHaveBeenCalled();
  });

  it('文档写入失败不炸整轮：图照返，persistError 进 hints', async () => {
    const deps = makeDeps({
      appendCanvasImageNodes: (vi.fn(async () => { throw new Error('磁盘满了'); }) as unknown as McpDeps['appendCanvasImageNodes']),
    });
    const payload = textOf(await callMcpTool('huiban_generate', { prompt: '猫', canvasId: 'c1' }, deps));
    expect(payload.ok).toBe(true);
    expect(payload.persistedToDoc).toBe(false);
    expect(payload.persistError).toContain('磁盘满了');
  });
});

describe('参考图入口归一化', () => {
  it('dataURL 直通；本地路径从媒体目录读回；远程链接经 bridge 落地', async () => {
    // 本地媒体：写一个假 png 进临时数据根的 media 目录
    const bytes = Buffer.from('fake-png-bytes');
    fs.mkdirSync(path.join(TEST_DATA_ROOT, 'media'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DATA_ROOT, 'media', 'a.png'), bytes);
    // 远程图片：桩掉 fetch，走 fetchRemoteImage → saveBuffer 的真实落盘路径
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => bytes,
    })) as unknown as typeof fetch);

    const out = await resolveReferenceDataUrls([
      'data:image/png;base64,QQ',
      '/api/files/a.png',
      'https://example.com/x.png',
    ]);
    expect(out[0]).toEqual({ dataUrl: 'data:image/png;base64,QQ', url: '' });
    expect(out[1]).toEqual({ dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, url: '/api/files/a.png' });
    expect(out[2].url).toMatch(/^\/api\/files\/img_/);
    expect(out[2].dataUrl).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
    vi.unstubAllGlobals();
  });

  it('不认识的格式报错并给出支持清单', async () => {
    await expect(resolveReferenceDataUrls(['ftp://x/y.png'])).rejects.toThrow(/格式不支持/);
  });

  it('声明存在的本地媒体文件缺失时报错', async () => {
    await expect(resolveReferenceDataUrls(['/api/files/not-exist.png'])).rejects.toThrow(/文件不存在/);
  });
});

describe('PUT 快照合并保护', () => {
  const mcpNode = (id: string, createdAt: string) => ({ id, type: 'flow-image', position: { x: 0, y: 0 }, data: { kind: 'image', source: 'mcp', createdAt, imageUrl: '/api/files/a.png' } });
  const localNode = { id: 'l1', type: 'flow-image', position: { x: 0, y: 0 }, data: { kind: 'image', source: undefined } };

  it('比快照新的 mcp 节点被捞回，防本地旧快照整文档覆盖', () => {
    const merged = keepExternalNodesOnSnapshot(
      [localNode, mcpNode('m1', '2026-09-27T10:00:00Z')],
      [localNode],
      '2026-09-27T09:00:00Z',
    );
    expect(merged.map((node: any) => node.id)).toEqual(['l1', 'm1']);
  });

  it('用户真删了 mcp 节点（快照更新）后不复活', () => {
    const merged = keepExternalNodesOnSnapshot(
      [mcpNode('m1', '2026-09-27T10:00:00Z')],
      [localNode],
      '2026-09-27T11:00:00Z',
    );
    expect(merged).toEqual([localNode]);
  });

  it('没有 updatedAt 或旧节点非 mcp 时原样返回', () => {
    expect(keepExternalNodesOnSnapshot([localNode], [localNode], undefined)).toEqual([localNode]);
    expect(keepExternalNodesOnSnapshot([localNode], [], '')).toEqual([]);
  });
});
