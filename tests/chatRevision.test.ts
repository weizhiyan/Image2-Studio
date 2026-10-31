import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let chat: typeof import('../bridge/chat');
let root = '';
let previousRoot: string | undefined;
const user = (id = 'u1') => ({ id, role: 'user', content: '画咖啡杯', createdAt: '2026-10-20T00:00:00.000Z' });
const assistant = (id = 'a1', content = '') => ({ id, role: 'assistant', content, status: content ? 'done' : 'running', createdAt: '2026-10-20T00:00:00.000Z' });
const thread = (extra: Record<string, unknown> = {}) => ({ id: 't1', title: '咖啡杯', messages: [user(), assistant()], ...extra });
const role = { id: 'designer', name: '设计师', systemPrompt: '保留背景', temperature: 0.3, skills: [], unsafe: 'drop' };

beforeEach(async () => {
  previousRoot = process.env.HUIBAN_DATA_ROOT;
  root = await fs.mkdtemp(join(tmpdir(), 'huiban-chat-revision-'));
  process.env.HUIBAN_DATA_ROOT = root;
  vi.resetModules();
  chat = await import('../bridge/chat');
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.HUIBAN_DATA_ROOT;
  else process.env.HUIBAN_DATA_ROOT = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

describe('chat revisions and sanitized snapshots', () => {
  it('defaults legacy revision/generation to zero and retains only explicit role/model/retry fields', () => {
    const clean = chat.normalizeChatThread(thread({ messages: [{ ...assistant(), agentRole: role, modelSelection: { textModel: ' model ', imageModel: 42, unsafe: 'drop' }, runId: 'run-1', requestId: 'req-1', retryOfMessageId: 'old-a', retrySource: { content: '原始需求', attachments: [{ nodeId: 'n1', url: '/api/files/a.png' }], modelSelection: { textModel: 'model' }, agentRole: role, answers: { q: ['a'] }, unsafe: 'drop' }, unsafe: 'drop' }] }));
    expect(clean).toMatchObject({ revision: 0, generation: 0 });
    expect(clean?.messages[0]).toMatchObject({ runId: 'run-1', requestId: 'req-1', retryOfMessageId: 'old-a', agentRole: { id: 'designer', temperature: 0.3 }, modelSelection: { textModel: 'model' }, retrySource: { content: '原始需求', answers: { q: ['a'] } } });
    expect(clean?.messages[0]).not.toHaveProperty('unsafe');
    expect(clean?.messages[0].agentRole).not.toHaveProperty('unsafe');
    expect(clean?.messages[0].modelSelection).not.toHaveProperty('imageModel');
    expect(clean?.messages[0].retrySource).not.toHaveProperty('unsafe');
    expect(chat.normalizeChatThread(thread({ revision: -1, generation: 'bad' }))).toMatchObject({ revision: 0, generation: 0 });
  });

  it('roundtrips memory boundaries, stats, brief, status and strips unknown fields and giant visual data URLs', async () => {
    const memory = { version: 1, memoryRevision: 3, summary: '摘要', summaryThroughMessageId: 'u1', clearedThroughMessageId: 'u0', windowMessageCount: 12, windowEstimatedTokens: 4500, compactionStatus: 'failed', warning: '保留原文', goal: { statement: '目标', preserve: ['背景'], rejected: ['改色'], unsafe: 'drop' }, visualWorkingSet: { base: { nodeId: 'n1', url: `data:image/png;base64,${'A'.repeat(70 * 1024)}` } }, unsafe: 'drop' };
    await chat.putChatThread(thread({ memory }));
    const saved = await chat.readChatThread('t1');
    expect(saved?.memory).toMatchObject({ memoryRevision: 3, summaryThroughMessageId: 'u1', clearedThroughMessageId: 'u0', windowMessageCount: 12, windowEstimatedTokens: 4500, compactionStatus: 'failed', warning: '保留原文', goal: { preserve: ['背景'], rejected: ['改色'] } });
    expect(saved?.memory).not.toHaveProperty('unsafe');
    expect(saved?.memory?.visualWorkingSet).toMatchObject({ base: { nodeId: 'n1' } });
    expect((saved?.memory?.visualWorkingSet as any).base).not.toHaveProperty('url');
  });

  it('imports absent legacy threads, but revisioned existing threads require a matching baseline', async () => {
    const created = await chat.writeClientThread(thread({ messages: [user(), assistant('a1', '历史回复')] }));
    expect(created).toMatchObject({ revision: 1, generation: 0 });
    await expect(chat.writeClientThread(thread())).rejects.toMatchObject({ status: 409, thread: { revision: 1 } });
    const result = await chat.writeClientThread({ ...created!, title: '新标题' });
    expect(result).toMatchObject({ title: '新标题', revision: 2 });
    await expect(chat.writeClientThread({ ...created!, title: '过期标题' })).rejects.toBeInstanceOf(chat.ChatConflictError);
  });

  it('client appends user/empty assistant without overwriting authoritative messages, role or memory', async () => {
    const created = await chat.writeClientThread(thread({ memory: { summary: '服务端记忆' }, messages: [user(), { ...assistant('a1', '真实回复'), agentRole: role }] }));
    const updated = await chat.writeClientThread({ ...created!, title: '改名', textModel: 'text-new', canvasId: 'untrusted-canvas', memory: { summary: '旧记忆' }, messages: [{ ...user(), content: '篡改历史' }, { ...assistant('a1', '旧回复'), agentRole: { ...role, name: '别的角色' } }, user('u2'), { ...assistant('a2', '伪造输出'), toolCalls: [{ id: 'c', status: 'done' }], media: [{ nodeId: 'n', url: '/api/files/a.png' }], memory: { summary: '伪造' } }] }, created!.revision);
    expect(updated).toMatchObject({ title: '改名', textModel: 'text-new', revision: 2, memory: { summary: '服务端记忆' } });
    expect(updated).toHaveProperty('canvasId', 'untrusted-canvas');
    expect(updated?.messages).toHaveLength(4);
    expect(updated?.messages[0].content).toBe('画咖啡杯');
    expect(updated?.messages[1]).toMatchObject({ content: '真实回复', agentRole: { name: '设计师' } });
    expect(updated?.messages[3]).toMatchObject({ id: 'a2', role: 'assistant', content: '', status: 'running' });
    expect(updated?.messages[3]).not.toHaveProperty('toolCalls');
    expect(updated?.messages[3]).not.toHaveProperty('media');
    expect(updated?.messages[3]).not.toHaveProperty('memory');
  });

  it('serializes client CAS so two writers cannot both accept one revision', async () => {
    const created = await chat.writeClientThread(thread());
    const results = await Promise.allSettled([
      chat.writeClientThread({ ...created!, title: 'A' }, created!.revision),
      chat.writeClientThread({ ...created!, title: 'B' }, created!.revision),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await chat.readChatThread('t1')).toMatchObject({ revision: 2 });
  });

  it('run merge updates only owned assistants, appends clarification turns and preserves metadata and other messages', async () => {
    const created = await chat.writeClientThread(thread({ memory: { summary: '原记忆' }, messages: [user(), { ...assistant(), agentRole: role }, assistant('other', '另一个run')] }));
    const saved = await chat.writeRunThread({ ...created!, title: '旧标题', imageModel: 'old', memory: { summary: '不允许' }, messages: [{ ...user(), content: '不允许' }, assistant('a1', '流式内容'), assistant('other', '覆盖别的run'), { ...assistant('a2', '澄清续答'), runId: 'run-1' }] }, { generation: 0, messageIds: ['u1', 'a1', 'a2'] });
    expect(saved).toMatchObject({ title: '咖啡杯', revision: 2, memory: { summary: '原记忆' } });
    expect(saved).not.toHaveProperty('imageModel');
    expect(saved?.messages[0].content).toBe('画咖啡杯');
    expect(saved?.messages[1]).toMatchObject({ content: '流式内容', agentRole: { id: 'designer' } });
    expect(saved?.messages[2].content).toBe('另一个run');
    expect(saved?.messages[3]).toMatchObject({ id: 'a2', runId: 'run-1' });
  });

  it('accepts explicit client landing canvas metadata and a trusted run canvas update', async () => {
    const created = await chat.writeClientThread(thread({ canvasId: 'canvas-1' }));
    const selected = await chat.writeClientThread({ id: 't1', revision: created!.revision, canvasId: 'canvas-2', messages: [] });
    expect(selected).toMatchObject({ canvasId: 'canvas-2' });
    const saved = await chat.writeRunThread({ ...created!, canvasId: 'canvas-3' }, { generation: 0, messageIds: ['a1'] });
    expect(saved).toMatchObject({ canvasId: 'canvas-3' });
  });

  it('memory edits use their own CAS and old run summaries cannot overwrite them', async () => {
    const created = await chat.writeClientThread(thread({ memory: { summary: '旧摘要' } }));
    const edited = await chat.updateChatMemory('t1', { summary: '手工摘要', memoryRevision: 500, unsafe: 'drop' }, 0);
    expect(edited).toMatchObject({ revision: 2, memory: { memoryRevision: 1, summary: '手工摘要' } });
    expect(edited?.memory).not.toHaveProperty('unsafe');
    await expect(chat.updateChatMemory('t1', { summary: '冲突' }, 0)).rejects.toMatchObject({ status: 409, thread: { memory: { memoryRevision: 1 } } });
    const merged = await chat.writeRunThread({ ...created!, memory: { summary: '迟到压缩' }, messages: [assistant('a1', '最终消息')] }, { generation: 0, messageIds: ['a1'], memoryRevision: 0 });
    expect(merged).toMatchObject({ memory: { summary: '手工摘要', memoryRevision: 1 } });
    expect(merged?.messages[1].content).toBe('最终消息');
    const compacted = await chat.writeRunThread({ ...merged!, memory: { summary: '新压缩' } }, { generation: 0, messageIds: ['a1'], memoryRevision: 1 });
    expect(compacted?.memory).toMatchObject({ summary: '新压缩', memoryRevision: 2 });
  });

  it('clear advances generation and revision and rejects old client and run snapshots', async () => {
    const created = await chat.writeClientThread(thread({ memory: { summary: '要清空', memoryRevision: 4 } }));
    const cleared = await chat.clearChatThread('t1', created!.revision);
    expect(cleared).toMatchObject({ revision: 2, generation: 1, messages: [], memory: { memoryRevision: 5, clearedThroughMessageId: 'a1' } });
    expect(cleared?.memory).not.toHaveProperty('summary');
    await expect(chat.writeClientThread(created)).rejects.toMatchObject({ status: 409 });
    expect(await chat.writeRunThread(created, { generation: 0, messageIds: ['a1'], memoryRevision: 4 })).toBeNull();
    expect(await chat.readChatThread('t1')).toEqual(cleared);
    await expect(chat.clearChatThread('t1', created!.revision)).rejects.toMatchObject({ status: 409 });
  });

  it('delete persists a hidden tombstone that blocks client, legacy and run resurrection after reload', async () => {
    const created = await chat.writeClientThread(thread());
    await chat.deleteChatThread('t1');
    vi.resetModules();
    chat = await import('../bridge/chat');
    expect(await chat.readChatThreads()).toEqual([]);
    expect(await chat.readChatThread('t1')).toBeNull();
    expect(await chat.writeClientThread(created, created!.revision)).toBeNull();
    expect(await chat.putChatThread({ ...created!, updatedAt: '2099-01-01T00:00:00Z' })).toBeNull();
    expect(await chat.writeRunThread(created, { generation: 0, messageIds: ['a1'] })).toBeNull();
    await chat.writeClientThread(thread({ id: 'new-thread' }));
    expect((await chat.readChatThreads()).map((entry) => entry.id)).toEqual(['new-thread']);
  });

  it('legacy snapshot writes cannot roll back an established clear/revision barrier', async () => {
    const created = await chat.writeClientThread(thread());
    const cleared = await chat.clearChatThread('t1', created!.revision);
    const stale = await chat.putChatThread({ ...created!, updatedAt: '2099-01-01T00:00:00Z' });
    expect(stale).toEqual(cleared);
    expect(await chat.readChatThread('t1')).toEqual(cleared);
  });

  it('client rejects a wrong generation even if the caller carries a matching revision', async () => {
    const created = await chat.writeClientThread(thread());
    const cleared = await chat.clearChatThread('t1', created!.revision);
    await expect(chat.writeClientThread({ ...cleared!, generation: 0, messages: [user()] })).rejects.toMatchObject({ status: 409 });
    const { generation: _generation, ...missingGeneration } = cleared!;
    await expect(chat.writeClientThread({ ...missingGeneration, messages: [user()] })).rejects.toMatchObject({ status: 409 });
  });

  it('memory-only clear preserves history and its barrier survives stale run memory', async () => {
    const created = await chat.writeClientThread(thread({ memory: { summary: '旧摘要', goal: { statement: '旧目标' }, visualWorkingSet: { base: { nodeId: 'n' } } } }));
    const cleared = await chat.updateChatMemory('t1', { clearedThroughMessageId: 'a1' }, 0);
    expect(cleared?.messages).toEqual(created?.messages);
    expect(cleared?.memory).toEqual({ version: 1, memoryRevision: 1, clearedThroughMessageId: 'a1' });
    const stale = await chat.writeRunThread(created, { generation: 0, messageIds: ['a1'], memoryRevision: 0 });
    expect(stale?.memory).toEqual(cleared?.memory);
  });

  it('non-ENOENT read failures propagate instead of erasing the document', async () => {
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(failure);
    await expect(chat.readChatThreads()).rejects.toBe(failure);
  });

  it('missing run target never creates a thread and deleting an absent id still creates a barrier', async () => {
    expect(await chat.writeRunThread(thread(), { generation: 0, messageIds: ['a1'] })).toBeNull();
    await chat.deleteChatThread('t1');
    expect(await chat.writeClientThread(thread())).toBeNull();
  });

  it('allows legacy import into a revision-zero existing thread, then upgrades to CAS', async () => {
    await fs.writeFile(join(root, 'chat-docs.json'), JSON.stringify({ t1: thread({ messages: [user(), assistant('a1', 'legacy')] }) }));
    const upgraded = await chat.writeClientThread(thread({ title: '导入', messages: [user(), assistant('a1', '旧快照')] }));
    expect(upgraded).toMatchObject({ revision: 1, title: '导入' });
    expect(upgraded?.messages[1].content).toBe('legacy');
  });

  it.each(['{broken', '[]', 'null', '42'])('does not turn damaged JSON %s into an empty store on a write', async (damaged) => {
    await fs.writeFile(join(root, 'chat-docs.json'), damaged);
    await expect(chat.readChatThreads()).rejects.toThrow();
    await expect(chat.putChatThread(thread())).rejects.toThrow();
    expect(await fs.readFile(join(root, 'chat-docs.json'), 'utf8')).toBe(damaged);
  });

  it('atomic rename failure keeps previous document intact and cleans its temporary file', async () => {
    await chat.putChatThread(thread());
    const before = await fs.readFile(join(root, 'chat-docs.json'), 'utf8');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(chat.putChatThread(thread({ title: '不会落盘', updatedAt: '2099-01-01T00:00:00Z' }))).rejects.toThrow('rename failed');
    expect(await fs.readFile(join(root, 'chat-docs.json'), 'utf8')).toBe(before);
    expect((await fs.readdir(root)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
