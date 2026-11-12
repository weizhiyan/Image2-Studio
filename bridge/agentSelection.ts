import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const SELECTION_FILE = path.join(DATA_DIR, 'agent-selection.json');
const SELECTION_TTL_MS = 30 * 60 * 1000;

export interface AgentSelectionRecord {
  canvasId?: string;
  nodeIds?: string[];
  primaryNodeId?: string;
  updatedAt?: string;
}

function cleanId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanId).filter(Boolean))].slice(0, 100);
}

/** 浏览器把当前画布/选中节点写到共享目录，MCP stdio 进程直接读同一份状态。 */
export async function writeAgentSelection(input: {
  canvasId?: unknown;
  nodeIds?: unknown;
  primaryNodeId?: unknown;
}): Promise<AgentSelectionRecord> {
  const canvasId = cleanId(input.canvasId);
  const nodeIds = cleanIds(input.nodeIds);
  const primaryNodeId = cleanId(input.primaryNodeId);
  const record: AgentSelectionRecord = {
    ...(canvasId ? { canvasId } : {}),
    nodeIds,
    ...(primaryNodeId && nodeIds.includes(primaryNodeId) ? { primaryNodeId } : {}),
    updatedAt: new Date().toISOString(),
  };
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(SELECTION_FILE, JSON.stringify(record), 'utf8');
  } catch {
    /* 选中态是辅助信息，写失败不阻断画布操作 */
  }
  return record;
}

export function isAgentSelectionFresh(record: AgentSelectionRecord, now = Date.now()): boolean {
  if (!record.updatedAt) return false;
  const updatedAt = Date.parse(record.updatedAt);
  return Number.isFinite(updatedAt) && now - updatedAt >= 0 && now - updatedAt < SELECTION_TTL_MS;
}

export async function readAgentSelection(): Promise<AgentSelectionRecord> {
  try {
    const record = JSON.parse(await fs.readFile(SELECTION_FILE, 'utf8')) as AgentSelectionRecord;
    if (!isAgentSelectionFresh(record)) return {};
    return {
      ...(cleanId(record.canvasId) ? { canvasId: cleanId(record.canvasId) } : {}),
      nodeIds: cleanIds(record.nodeIds),
      ...(cleanId(record.primaryNodeId) ? { primaryNodeId: cleanId(record.primaryNodeId) } : {}),
      updatedAt: record.updatedAt,
    };
  } catch {
    return {};
  }
}
