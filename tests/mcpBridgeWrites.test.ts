import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huiban-mcp-writes-'));
process.env.HUIBAN_DATA_ROOT = root;
const { appendCanvasImageNodes, createCanvasInRegistry, createHttpServer } = await import('../bridge/http');
const { defaultMcpDeps } = await import('../bridge/mcp');
const { setBroadcastForwardBase, peekPendingLocate, ackPendingLocate } = await import('../bridge/hub');
const server = createHttpServer();
let base = '';
const docsFile = path.join(root, 'canvas-docs.json');
const registryFile = path.join(root, 'canvases.json');
const node = (id: string) => ({ id, type: 'flow-image', position: { x: 0, y: 0 }, data: { kind: 'image', source: 'mcp' } });
const post = (body: unknown, headers: Record<string, string> = {}, endpoint = 'write') => fetch(`${base}/api/internal/${endpoint}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const readDocs = async () => JSON.parse(await fs.readFile(docsFile, 'utf8'));

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await fs.writeFile(registryFile, JSON.stringify({ c1: '画布' }));
  await fs.writeFile(docsFile, JSON.stringify({ c1: { name: '画布', nodes: [], edges: [] } }));
});
afterEach(() => { setBroadcastForwardBase(''); ackPendingLocate(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

describe('MCP 主 bridge 唯一写入者', () => {
  it('index 恢复丢失 run 只在持有端口分支执行，不实际启动入口', async () => {
    const source = await fs.readFile(new URL('../bridge/index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/if\s*\(ownsPort\)\s*(?:\{\s*)?await reconcileLostRuns\(\)/);
  });

  it('同 id 已删除节点不得被旧 MCP 重放追加复活', async () => {
    await fs.writeFile(docsFile, JSON.stringify({ c1: {
      name: '画布', nodes: [], edges: [], deletedNodeIds: { deleted: new Date().toISOString() },
    } }));
    await appendCanvasImageNodes('c1', [node('deleted'), node('fresh')]);
    expect((await readDocs()).c1.nodes.map((item: { id: string }) => item.id)).toEqual(['fresh']);
  });

  it('聊天生成按参考图连到每张候选，重复追加不重复连边', async () => {
    await fs.writeFile(docsFile, JSON.stringify({ c1: {
      name: '画布', nodes: [node('ref-1'), node('ref-2')], edges: [],
    } }));
    await appendCanvasImageNodes('c1', [node('out-1'), node('out-2')], { connectFrom: ['ref-1', 'ref-2'] });
    let edges = (await readDocs()).c1.edges as Array<{ source: string; target: string; sourceHandle?: string; targetHandle?: string }>;
    expect(edges).toHaveLength(4);
    expect(edges.map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([
      'ref-1->out-1', 'ref-1->out-2', 'ref-2->out-1', 'ref-2->out-2',
    ]);
    expect(edges.every((edge) => edge.sourceHandle === 'out' && edge.targetHandle === 'in')).toBe(true);

    await appendCanvasImageNodes('c1', [node('out-1'), node('out-2')], { connectFrom: ['ref-1', 'ref-2'] });
    edges = (await readDocs()).c1.edges;
    expect(edges).toHaveLength(4);
  });

  it('删除画布与 MCP 创建共用注册表写锁，不能丢失并发注册', async () => {
    const originalRead = fs.readFile.bind(fs);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let captured = false;
    vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const result = await originalRead(...args);
      if (String(args[0]) === registryFile && !captured) {
        captured = true;
        await paused;
      }
      return result;
    }) as typeof fs.readFile);
    const deleted = fetch(`${base}/api/canvases/c1`, { method: 'DELETE' });
    await vi.waitFor(() => expect(captured).toBe(true));
    const created = createCanvasInRegistry('c2', '第二张');
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    await created;
    expect((await deleted).status).toBe(200);
    expect(JSON.parse(await fs.readFile(registryFile, 'utf8'))).toEqual({ c2: '第二张' });
  });

  it('rename 失败保留原 JSON 且清除临时文件', async () => {
    const before = await fs.readFile(docsFile, 'utf8');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename denied'));
    await expect(appendCanvasImageNodes('c1', [node('added')])).rejects.toThrow(/rename denied/);
    expect(await fs.readFile(docsFile, 'utf8')).toBe(before);
    expect((await fs.readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('internal 拒绝非 loopback 客户端', async () => {
    server.prependOnceListener('request', (req) => {
      Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: '192.168.1.99' });
    });
    expect((await post({ op: 'createCanvas', canvasId: 'c2', name: '第二张' }, { Connection: 'close' })).status).toBe(403);
  });

  it('追加保留全部文档元数据与删除墓碑，旧基线不能复活删除节点', async () => {
    const previous = {
      name: '画布', nodes: [node('kept')], edges: [], viewport: { x: 1, y: 2, zoom: 0.8 },
      deletedNodeIds: { removed: '2026-10-30T10:00:00.000Z' }, deletedEdgeIds: { e1: '2026-10-30T10:00:00.000Z' },
      futureMetadata: { preserve: true }, updatedAt: '2026-10-30T10:00:00.000Z',
    };
    await fs.writeFile(docsFile, JSON.stringify({ c1: previous }));
    await appendCanvasImageNodes('c1', [node('added')]);
    expect((await readDocs()).c1).toMatchObject({ ...previous, nodes: [node('kept'), node('added')], updatedAt: expect.any(String) });
    const response = await fetch(`${base}/api/canvases/c1`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineUpdatedAt: '2026-10-30T09:00:00.000Z', graphChanges: { nodeUpserts: [node('removed')], nodeDeletes: [], edgeUpserts: [], edgeDeletes: [] } }),
    });
    expect(response.status).toBe(200);
    expect((await readDocs()).c1.nodes.map((item: { id: string }) => item.id)).not.toContain('removed');
  });

  it.each(['{broken', '[]', 'null', '{"c1":{"name":"画布","nodes":null,"edges":[]}}'])('损坏文档 %s 不得当空对象覆盖或先改注册表', async (broken) => {
    await fs.writeFile(docsFile, broken);
    const registry = await fs.readFile(registryFile, 'utf8');
    await expect(createCanvasInRegistry('new_canvas', '新画布')).rejects.toThrow();
    await expect(appendCanvasImageNodes('c1', [node('added')])).rejects.toThrow();
    expect(await fs.readFile(docsFile, 'utf8')).toBe(broken);
    expect(await fs.readFile(registryFile, 'utf8')).toBe(registry);
  });

  it('损坏注册表不得被创建覆盖', async () => {
    await fs.writeFile(registryFile, '{broken');
    await expect(createCanvasInRegistry('new_canvas', '新画布')).rejects.toThrow();
    expect(await fs.readFile(registryFile, 'utf8')).toBe('{broken');
  });

  it('画布与注册表只经同目录唯一临时文件 rename 写入', async () => {
    const writes = vi.spyOn(fs, 'writeFile');
    const renames = vi.spyOn(fs, 'rename');
    await createCanvasInRegistry('c2', '第二张');
    await appendCanvasImageNodes('c2', [node('added')]);
    for (const file of [docsFile, registryFile]) {
      expect(writes.mock.calls.some(([target]) => String(target) === file)).toBe(false);
      const commits = renames.mock.calls.filter(([, target]) => String(target) === file);
      expect(commits.length).toBeGreaterThan(0);
      for (const [temp] of commits) expect(path.dirname(String(temp))).toBe(path.dirname(file));
    }
    const temps = renames.mock.calls.map(([temp]) => String(temp));
    expect(new Set(temps).size).toBe(temps.length);
    expect((await fs.readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('internal typed 操作追加、创建、视频更新且保留广播兼容', async () => {
    expect((await post({ op: 'appendImages', canvasId: 'c1', nodes: [node('n1')] })).status).toBe(200);
    const created = await post({ op: 'createCanvas', canvasId: 'c2', name: '第二张' });
    expect(await created.json()).toMatchObject({ code: 0, data: { id: 'c2', name: '第二张' } });
    const docs = await readDocs();
    docs.c1.nodes.push({ ...node('video1'), data: { kind: 'video' } });
    await fs.writeFile(docsFile, JSON.stringify(docs));
    expect((await post({ op: 'patchVideoNode', canvasId: 'c1', nodeId: 'video1', patch: { prompt: '镜头推进', videoSeconds: 6 } })).status).toBe(200);
    expect((await readDocs()).c1.nodes.find((item: { id: string }) => item.id === 'video1').data.prompt).toBe('镜头推进');
    const at = new Date().toISOString();
    expect((await post({ kind: 'locate', payload: { type: 'locate', canvasId: 'c1', nodeId: 'n1', at } }, {}, 'broadcast')).status).toBe(200);
    expect(peekPendingLocate()?.nodeId).toBe('n1');
    expect((await post({ op: 'appendImages', canvasId: 'c1', nodes: [node('n2')] }, { Origin: base })).status).toBe(200);
  });

  it.each([
    null, [], { op: 'unknown' }, { op: 'createCanvas', canvasId: '../outside', name: 'bad' },
    { op: 'createCanvas', canvasId: '__proto__', name: 'bad' }, { op: 'createCanvas', canvasId: 'c2', name: [] },
    { op: 'appendImages', canvasId: 'c1', nodes: [null] },
    { op: 'appendImages', canvasId: 'c1', nodes: [{ ...node('n1'), position: { x: '0', y: 0 } }] },
    { op: 'appendImages', canvasId: 'c1', nodes: [{ ...node('n1'), data: [] }] },
    { op: 'patchVideoNode', canvasId: 'c1', nodeId: '../x', patch: {} },
    { op: 'patchVideoNode', canvasId: 'c1', nodeId: 'n1', patch: { videoSeconds: 'six' } },
    { op: 'patchVideoNode', canvasId: 'c1', nodeId: 'n1', patch: { arbitraryPath: '/tmp/x' } },
  ])('拒绝非法 internal 写操作 %j', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect((await readDocs()).c1.nodes).toEqual([]);
  });

  it('拒绝跨站 Origin、畸形 JSON 与广播 payload', async () => {
    const operation = { op: 'createCanvas', canvasId: 'c2', name: '第二张' };
    expect((await post(operation, { Origin: 'https://attacker.example' })).status).toBe(403);
    expect((await post({ kind: 'locate', payload: {} }, { Origin: 'https://attacker.example' }, 'broadcast')).status).toBe(403);
    expect((await post({ kind: 'locate', payload: {} }, {}, 'broadcast')).status).toBe(400);
    expect((await fetch(`${base}/api/internal/write`, { method: 'POST', body: '{broken' })).status).toBe(400);
  });

  it('两个独立 MCP 进程经主 bridge 并发追加不丢节点', async () => {
    const run = promisify(execFile);
    const modulePath = new URL('../bridge/mcp.ts', import.meta.url).href;
    const hubPath = new URL('../bridge/hub.ts', import.meta.url).href;
    const child = (prefix: string) => run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { defaultMcpDeps } from ${JSON.stringify(modulePath)};
      import { setBroadcastForwardBase } from ${JSON.stringify(hubPath)};
      setBroadcastForwardBase(${JSON.stringify(base)});
      await Promise.all(Array.from({length: 8}, (_, i) => defaultMcpDeps.appendCanvasImageNodes('c1', [{id: ${JSON.stringify(prefix)} + i, type:'flow-image', position:{x:0,y:0}, data:{kind:'image',source:'mcp'}}])));
    `], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env: { ...process.env, HUIBAN_DATA_ROOT: root }, timeout: 20_000 });
    await Promise.all([child('a'), child('b')]);
    expect((await readDocs()).c1.nodes).toHaveLength(16);
  }, 30_000);

  it('forward 模式 default deps 只 POST typed 操作，失败绝不回退本地写入', async () => {
    const before = await fs.readFile(docsFile, 'utf8');
    setBroadcastForwardBase(base);
    const mock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const operation = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ code: 0, data: operation.op === 'createCanvas' ? { id: operation.canvasId, name: operation.name } : true }), { status: 200 });
    });
    vi.stubGlobal('fetch', mock);
    await defaultMcpDeps.appendCanvasImageNodes('c1', [node('n1')]);
    await defaultMcpDeps.createCanvas('c2', '第二张');
    await defaultMcpDeps.patchVideoNode!('c1', 'video1', { prompt: '镜头推进' });
    expect(mock.mock.calls).toHaveLength(3);
    expect(mock.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).op)).toEqual(['appendImages', 'createCanvas', 'patchVideoNode']);
    expect(await fs.readFile(docsFile, 'utf8')).toBe(before);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 1, msg: 'disk full' }), { status: 503 })));
    await expect(defaultMcpDeps.appendCanvasImageNodes('c1', [node('n2')])).rejects.toThrow(/disk full|503/);
    await expect(defaultMcpDeps.createCanvas('c2', '第二张')).rejects.toThrow();
    await expect(defaultMcpDeps.patchVideoNode!('c1', 'video1', { prompt: 'x' })).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(defaultMcpDeps.appendCanvasImageNodes('c1', [node('n3')])).rejects.toThrow(/offline/);
    expect(await fs.readFile(docsFile, 'utf8')).toBe(before);
  });

  it('在线标签页查询失败不能伪装成零连接', async () => {
    setBroadcastForwardBase(base);
    for (const response of [new Response('{}', { status: 503 }), new Response(JSON.stringify({ data: { openTabs: 'bad' } }), { status: 200 })]) {
      vi.stubGlobal('fetch', vi.fn(async () => response));
      await expect(defaultMcpDeps.countOpenTabs()).rejects.toThrow();
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(defaultMcpDeps.countOpenTabs()).rejects.toThrow(/offline/);
  });
});
