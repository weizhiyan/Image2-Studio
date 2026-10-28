import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const PRESENCE_FILE = path.join(DATA_DIR, 'agent-presence.json');

export const AGENT_PRESENCE_TTL_MS = 10 * 60 * 1000;

export interface AgentPresenceRecord {
  lastSeenAt?: string;
  canvasId?: string;
  transport?: string;
  processId?: number;
}

/** MCP 进程可能和 HTTP bridge 分开运行，用共享文件传递最近活跃状态。 */
export async function markAgentPresence(
  input: { canvasId?: string; transport?: string } = {},
): Promise<AgentPresenceRecord> {
  const record: AgentPresenceRecord = {
    lastSeenAt: new Date().toISOString(),
    canvasId: input.canvasId,
    transport: input.transport || 'stdio',
    processId: process.pid,
  };
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(PRESENCE_FILE, JSON.stringify(record), 'utf8');
  } catch {
    /* 状态文件写入失败不阻断 MCP 工具调用 */
  }
  return record;
}

export async function clearAgentPresence(processId: number): Promise<void> {
  try {
    const current = await readAgentPresence();
    if (current.processId === processId) {
      await fs.writeFile(PRESENCE_FILE, '{}', 'utf8');
    }
  } catch {
    /* 状态清理失败不影响 MCP 断开 */
  }
}

export async function readAgentPresence(): Promise<AgentPresenceRecord> {
  try {
    return JSON.parse(await fs.readFile(PRESENCE_FILE, 'utf8')) as AgentPresenceRecord;
  } catch {
    return {};
  }
}

export function isAgentPresenceFresh(record: AgentPresenceRecord, now = Date.now()): boolean {
  if (!record.lastSeenAt) return false;
  const lastSeen = Date.parse(record.lastSeenAt);
  return Number.isFinite(lastSeen) && now - lastSeen >= 0 && now - lastSeen < AGENT_PRESENCE_TTL_MS;
}
