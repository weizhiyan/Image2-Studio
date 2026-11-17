import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const previousRoot = process.env.HUIBAN_DATA_ROOT;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huiban-canvas-chat-'));
process.env.HUIBAN_DATA_ROOT = root;
const { createHttpServer } = await import('../bridge/http');
const { writeClientThread, readChatThread } = await import('../bridge/chat');
const server = createHttpServer();
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.HUIBAN_DATA_ROOT;
  else process.env.HUIBAN_DATA_ROOT = previousRoot;
});

async function createCanvas(id: string) {
  const response = await fetch(`${base}/api/canvases/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: id, nodes: [], edges: [] }),
  });
  expect(response.ok).toBe(true);
}

describe('只有对话的画布生命周期', () => {
  it('保留列表中的聊天画布，拒绝自动清理，显式删除才级联删除对话', async () => {
    await createCanvas('chat-only');
    await writeClientThread({ id: 'owned', canvasId: 'chat-only', messages: [{ id: 'user', role: 'user', content: '先聊聊方向' }] });
    const listed = await (await fetch(`${base}/api/canvases`)).json();
    expect(listed.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'chat-only', hasChat: true })]));
    const cleanup = await fetch(`${base}/api/canvases/chat-only?onlyIfEmpty=1`, { method: 'DELETE' });
    expect(cleanup.status).toBe(409);
    expect(await readChatThread('owned')).not.toBeNull();
    expect((await fetch(`${base}/api/canvases/chat-only`, { method: 'DELETE' })).ok).toBe(true);
    expect(await readChatThread('owned')).toBeNull();
  });

  it('真正空草稿可以清理，有节点的画布拒绝过期标签页自动清理', async () => {
    await createCanvas('empty');
    expect((await fetch(`${base}/api/canvases/empty?onlyIfEmpty=1`, { method: 'DELETE' })).ok).toBe(true);
    await createCanvas('with-node');
    await fetch(`${base}/api/canvases/with-node`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'with-node', nodes: [{ id: 'node', type: 'flow-image', position: { x: 0, y: 0 }, data: { kind: 'image' } }], edges: [] }) });
    expect((await fetch(`${base}/api/canvases/with-node?onlyIfEmpty=1`, { method: 'DELETE' })).status).toBe(409);
  });
});
