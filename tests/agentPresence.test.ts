import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'huiban-agent-presence-'));
process.env.HUIBAN_DATA_ROOT = TEST_DATA_ROOT;

const {
  AGENT_PRESENCE_TTL_MS,
  clearAgentPresence,
  isAgentPresenceFresh,
  markAgentPresence,
  readAgentPresence,
} = await import('../bridge/agentPresence');

afterAll(() => {
  fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});

describe('Agent 连接状态', () => {
  it('只把 TTL 内的最近活动认定为已连接', () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z');

    expect(isAgentPresenceFresh({}, now)).toBe(false);
    expect(isAgentPresenceFresh({ lastSeenAt: 'not-a-date' }, now)).toBe(false);
    expect(isAgentPresenceFresh({ lastSeenAt: new Date(now - AGENT_PRESENCE_TTL_MS + 1).toISOString() }, now)).toBe(true);
    expect(isAgentPresenceFresh({ lastSeenAt: new Date(now - AGENT_PRESENCE_TTL_MS).toISOString() }, now)).toBe(false);
    expect(isAgentPresenceFresh({ lastSeenAt: new Date(now + 1).toISOString() }, now)).toBe(false);
  });

  it('写入并读取 MCP 最近活动', async () => {
    const written = await markAgentPresence({ canvasId: 'canvas_test', transport: 'stdio' });
    const stored = await readAgentPresence();

    expect(written.lastSeenAt).toBeTruthy();
    expect(stored).toMatchObject({ canvasId: 'canvas_test', transport: 'stdio' });
    expect(stored.lastSeenAt).toBe(written.lastSeenAt);
    expect(isAgentPresenceFresh(stored)).toBe(true);
  });

  it('只清理由当前 MCP 进程写入的状态', async () => {
    await markAgentPresence({ canvasId: 'canvas_owned' });
    await clearAgentPresence(process.pid + 1);
    expect(await readAgentPresence()).toMatchObject({ canvasId: 'canvas_owned' });

    await clearAgentPresence(process.pid);
    expect(await readAgentPresence()).toEqual({});
  });
});
