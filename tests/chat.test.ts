/**
 * bridge 对话持久化：三条保险逐条验——串行写（同文件不交叉）、单调时间戳
 * （旧快照不能覆盖新数据）、滚动备份；外加入库清洗（大 dataURL 剥掉、消息数截断）、
 * 旧版「一画布一条线程」数据迁移为默认线程。
 * 数据根目录指到临时目录，不碰用户真实 ~/.huiban。
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

let chat: typeof import('../bridge/chat');
let dataRoot = '';

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'huiban-chat-test-'));
  // 必须在 import 之前设好：paths.ts 在模块加载时读 DATA_DIR
  process.env.HUIBAN_DATA_ROOT = dataRoot;
  chat = await import('../bridge/chat');
});

afterAll(async () => {
  delete process.env.HUIBAN_DATA_ROOT;
  await rm(dataRoot, { recursive: true, force: true });
});

type LooseMessage = Record<string, any>;

/** 取出规范化后的消息数组（ Record 里字段都是 unknown，测试里放宽成 any 断言）。 */
const msgs = (normalized: { messages: unknown[] } | null): LooseMessage[] => (normalized?.messages || []) as LooseMessage[];

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: 'thread-1',
  canvasId: 'canvas-1',
  title: 'logo 迭代',
  messages: [{ id: 'm1', role: 'user', content: '画一个咖啡杯 logo', createdAt: '2026-10-13T20:00:00.000Z' }],
  createdAt: '2026-10-13T20:00:00.000Z',
  updatedAt: '2026-10-13T20:00:00.000Z',
  ...overrides,
});

describe('normalizeChatThread 入库清洗', () => {
  it('小 dataURL 保留、超过 64KB 的剥掉', () => {
    const small = `data:image/png;base64,${'A'.repeat(100)}`;
    const huge = `data:image/png;base64,${'A'.repeat(70 * 1024)}`;
    const normalized = chat.normalizeChatThread(thread({
      messages: [
        { id: 'm1', role: 'user', content: '带小图', attachments: [{ canvasId: 'canvas-1', nodeId: 'n1', url: small }] },
        { id: 'm2', role: 'user', content: '带大图', attachments: [{ canvasId: 'canvas-1', nodeId: 'n1', url: huge }] },
      ],
    }));
    expect(msgs(normalized)[0].attachments?.[0].url).toBe(small);
    // 大 dataURL 只剥 url：引用以 nodeId 为事实源，ref 本身保留（缩略图重解析即可）
    expect(msgs(normalized)[1].attachments?.[0].url).toBeUndefined();
    expect(msgs(normalized)[1].attachments?.[0].nodeId).toBe('n1');
  });

  it('线程的对话模型与 Agent 生图模型随对话持久化，非法值丢弃', () => {
    const normalized = chat.normalizeChatThread(thread({
      textProfileId: ' text-a ',
      textModel: ' model-a ',
      imageProfileId: ' img-a ',
      imageModel: ' image-a ',
    }));
    expect(normalized).toMatchObject({
      textProfileId: 'text-a',
      textModel: 'model-a',
      imageProfileId: 'img-a',
      imageModel: 'image-a',
    });
    const invalid = chat.normalizeChatThread(thread({ textProfileId: 42, textModel: 42, imageProfileId: 42, imageModel: 42 }));
    expect(invalid?.textProfileId).toBeUndefined();
    expect(invalid?.textModel).toBeUndefined();
    expect(invalid?.imageProfileId).toBeUndefined();
    expect(invalid?.imageModel).toBeUndefined();
    expect(chat.normalizeChatThread(thread())?.textProfileId).toBeUndefined();
  });

  it('引用与媒体保留 nodeId / versionId（对话只存引用，不断链）', () => {
    const normalized = chat.normalizeChatThread(thread({
      messages: [{
        id: 'm2', role: 'assistant', content: '',
        media: [{ url: '/api/files/a.png', fileName: 'a.png', nodeId: 'composer-1', versionId: 'ver-1', prompt: 'p', model: 'm', size: '1K' }],
        toolCalls: [{ id: 'c1', name: 'generate_image', args: { prompt: 'p' }, status: 'done', steps: ['已理解你的方向'] }],
        status: 'done',
      }],
    }));
    expect(msgs(normalized)[0].media?.[0]).toMatchObject({ nodeId: 'composer-1', versionId: 'ver-1' });
    expect(msgs(normalized)[0].toolCalls?.[0]).toMatchObject({ id: 'c1', status: 'done' });
    expect(msgs(normalized)[0].status).toBe('done');
  });

  it('结构化追问持久化：答案与问题不会在入库时丢失', () => {
    const normalized = chat.normalizeChatThread(thread({
      messages: [{
        id: 'm-ask', role: 'assistant', content: '我先确认几个信息', status: 'awaiting_input',
        clarifications: [{
          callId: 'call-ask',
          status: 'answered',
          questions: [{ id: 'subject', title: '主体是什么？', multiple: false, options: [{ label: '产品', value: 'product' }, { label: '场景', value: 'scene' }] }],
          answers: { subject: ['product'] },
        }],
      }],
    }));
    expect(msgs(normalized)[0]).toMatchObject({ status: 'awaiting_input' });
    expect(msgs(normalized)[0].clarifications[0]).toMatchObject({ callId: 'call-ask', status: 'answered' });
  });

  it('超过 500 条只留最后 500 条', () => {
    const messages = Array.from({ length: 520 }, (_, index) => ({ id: `m${index}`, role: 'user', content: `第${index}条` }));
    const normalized = chat.normalizeChatThread(thread({ messages }));
    expect(msgs(normalized)).toHaveLength(500);
    expect(msgs(normalized)[0].id).toBe('m20');
    expect(msgs(normalized)[499].id).toBe('m519');
  });

  it('缺 canvasId 的线程仍可独立持久化；缺 id 的消息丢弃', () => {
    const independent = chat.normalizeChatThread(thread({ canvasId: '' }));
    expect(independent?.canvasId).toBeUndefined();
    const normalized = chat.normalizeChatThread(thread({
      messages: [{ role: 'user', content: '没有 id' }, { id: 'm2', role: 'assistant', content: 'ok' }],
    }));
    expect(msgs(normalized)).toHaveLength(1);
  });

  it('清理异常的 canvasId，避免历史定位读到 [object Object]', () => {
    const normalized = chat.normalizeChatThread(thread({
      canvasId: '[object Object]',
      messages: [{
        id: 'm3', role: 'assistant', content: '',
        attachments: [{ canvasId: '[object Object]', nodeId: 'n1', versionId: 'v1' }],
        media: [{ canvasId: '[object Object]', url: '/api/files/a.png', nodeId: 'n1', versionId: 'v1' }],
      }],
    }));
    expect(normalized?.canvasId).toBeUndefined();
    expect(msgs(normalized)[0].attachments?.[0].canvasId).toBe('');
    expect(msgs(normalized)[0].media?.[0].canvasId).toBeUndefined();
  });
});

describe('putChatThread 写路径', () => {
  it('roundtrip：写进去读出来一致', async () => {
    await chat.putChatThread(thread());
    const threads = await chat.readChatThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].messages[0].content).toBe('画一个咖啡杯 logo');
  });

  it('单调时间戳：旧快照不能覆盖新数据', async () => {
    await chat.putChatThread(thread({ id: 'thread-mono', title: '新', updatedAt: '2026-10-13T23:00:00.000Z' }));
    const stale = await chat.putChatThread(thread({ id: 'thread-mono', title: '旧', updatedAt: '2026-10-13T22:00:00.000Z' }));
    expect(stale?.title).toBe('新');
    const threads = await chat.readChatThreads();
    expect(threads.find((item) => item.id === 'thread-mono')?.title).toBe('新');
  });

  it('并发写不交叉：两条线程都在', async () => {
    await Promise.all([
      chat.putChatThread(thread({ id: 'thread-a' })),
      chat.putChatThread(thread({ id: 'thread-b' })),
    ]);
    const threads = await chat.readChatThreads();
    const ids = threads.map((item) => item.id).sort();
    expect(ids).toEqual(expect.arrayContaining(['thread-a', 'thread-b']));
  });

  it('deleteChatThread 幂等', async () => {
    await chat.putChatThread(thread({ id: 'thread-c' }));
    await chat.deleteChatThread('thread-c');
    await chat.deleteChatThread('thread-c');
    const threads = await chat.readChatThreads();
    expect(threads.some((item) => item.id === 'thread-c')).toBe(false);
  });

  it('画布落点元数据缺失时也能独立保存线程', async () => {
    await chat.putChatThread(thread({ id: 'tx-1', canvasId: '', updatedAt: '2026-10-13T23:10:00.000Z' }));
    const threads = await chat.readChatThreads();
    expect(threads.find((item) => item.id === 'tx-1')?.canvasId).toBeUndefined();
  });

  it('滚动备份：第二次写会把上一版内容留进 backups', async () => {
    await chat.putChatThread(thread({ id: 'thread-d', title: 'D', updatedAt: '2026-10-13T23:20:00.000Z' }));
    await chat.putChatThread(thread({ id: 'thread-d', title: 'D2', updatedAt: '2026-10-13T23:30:00.000Z' }));
    // 备份文件名是写入时的真实时间，只断言「有一份含 thread-d 的备份」
    const names = await readdir(join(dataRoot, 'backups'));
    const backups = names.filter((name) => name.startsWith('chat-docs-'));
    expect(backups.length).toBeGreaterThan(0);
    const found = await Promise.all(backups.map(async (name) => {
      const text = await readFile(join(dataRoot, 'backups', name), 'utf8').catch(() => '');
      return text.includes('thread-d');
    }));
    expect(found.some(Boolean)).toBe(true);
  });
});

describe('旧版数据迁移', () => {
  it('「一画布一条线程」（无 id、按 canvasId 为键）读成默认线程', async () => {
    const legacy = {
      'canvas-legacy': {
        canvasId: 'canvas-legacy',
        title: '旧对话',
        messages: [{ id: 'm1', role: 'user', content: '历史消息不丢', createdAt: '2026-10-01T10:00:00.000Z' }],
        updatedAt: '2026-10-01T10:00:00.000Z',
      },
    };
    await writeFile(join(dataRoot, 'chat-docs.json'), JSON.stringify(legacy), 'utf8');
    const threads = await chat.readChatThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe('thread_canvas-legacy');
    expect(threads[0].canvasId).toBe('canvas-legacy');
    expect(threads[0].messages[0].content).toBe('历史消息不丢');
    // 迁移后写入即落成新形态
    await chat.putChatThread(thread({ id: 'thread-new', canvasId: 'canvas-1' }));
    const after = await chat.readChatThreads();
    expect(after.some((item) => item.id === 'thread-new')).toBe(true);
  });
});
