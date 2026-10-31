import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CANVASES_FILE, CANVAS_DOCS_FILE, CHAT_DOCS_FILE, HOST, MEDIA_DIR, PORT, STATIC_DIR } from './paths.js';
import { createProfile, findProfile, imageModelReadiness, normalizeEnhanceLevel, publicView, readSettings, resolveTextProfile, resolveVideoProfile, writeSettings, type ModelProfile } from './settings.js';
import { addManualPreference, clearPreferences, distillPreferences, removePreference, setPreferencesEnabled } from './preferences.js';
import { generateImages, normalizeImageSize } from './imageApi.js';
import { detectReferenceUsage, directStyleNote, enhancePromptDetailed, fidelityForUsage, optimizeVideoPrompt, testTextProfile, usageForGenerateRequest } from './textApi.js';
import { fetchProviderModels, fetchRemoteImage, testProviderConnection } from './providerApi.js';
import { ackPendingLocate, addSseClient, countOpenTabs, peekPendingLocate, pushCanvasUpdated, pushImage, pushLocate, pushVideo } from './hub.js';
import { ChatConflictError, clearChatThread, deleteChatThread, readChatThread, readChatThreads, updateChatMemory, writeClientThread } from './chat.js';
import { answerChatRun, buildAgentSystemSpec, confirmChatRun, getChatRunSnapshot, startChatRun, stopChatRun, stopThreadRuns, subscribeChatRun, waitChatRunReady, type StartRunRequest } from './runs.js';
import { contentTypeOf, copyMediaFile, deleteMediaFile, imageExtensionOf, revealLocalFile, saveDataUrl, safeMediaPath } from './files.js';
import { createVideoTask, describeVideoModel, downloadVideoUrl, encodeVideoImagesAsDataUrls, getMediaVideoPriceQuote, listVideoModels, normalizeVideoRatio, normalizeVideoResolution, probeVideoConnection, validateVideoConfig, validateVideoImageDataUrls, VideoConfigurationError, VideoImageInputError, VideoRequestError, videoImagesUseDataUrls, videoUploadSupportsInlineDataUrl } from './videoApi.js';
import { detectVideoProtocol, ensureVideoApiMode } from './videoProtocol.js';
import { claimVideoDownload, completeVideoTask, confirmVideoSubmission, failVideoSubmission, findVideoTaskByNode, getVideoTaskRecord, markVideoSubmissionUnknown, releaseVideoDownload, removeVideoTask, removeVideoTaskByNode, removeVideoTasksByCanvas, reserveVideoTask } from './videoTasks.js';
import { describeImageHostFailure, defaultImageHost, imageHostReady, isLegacyDefaultImageHost, readImageHost, resolveImageHost, uploadToImageHost, writeImageHost, EMPTY_IMAGE_HOST, IMAGE_HOST_PRESETS, type ImageHostConfig } from './imageHost.js';
import { isAgentPresenceFresh, readAgentPresence } from './agentPresence.js';
import { collectHistoryItems } from './history.js';
import { addAsset, createAssetFolder, deleteAsset, deleteAssetFolder, listAssets, moveAsset, renameAssetFolder } from './assets.js';
import { deletePromptSkill, listPromptSkills, savePromptSkill } from './skills.js';

interface CanvasRegistry { [canvasId: string]: string }

/** MCP 追加的图片节点形状：字段与浏览器 SSE handler appendNode 的那份对齐（含 source:'mcp'）。 */
export interface CanvasNodeRecord {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

/** 画布完整文档（浏览器 PUT 上来的全量快照，供换浏览器/换机器打开链接时还原）。 */
export interface CanvasDocRecord {
  name: string;
  nodes: unknown[];
  edges: unknown[];
  viewport?: { x: number; y: number; zoom: number };
  updatedAt?: string;
  /** 已删除节点墓碑（id → 删除时间）：用于阻止旧标签页把节点复活。 */
  deletedNodeIds?: Record<string, string>;
  deletedEdgeIds?: Record<string, string>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MCP_ENTRY = path.resolve(STATIC_DIR, '..', 'bridge', 'dist', 'index.js');
const MCP_LAUNCHER = path.resolve(STATIC_DIR, '..', 'bridge', 'mcp-launch.sh');

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readRoleSkills(raw: unknown): Array<{ id: string; name: string; content: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    return [{
      id: String(item.id || ''),
      name: String(item.name || ''),
      content: String(item.content || ''),
    }];
  });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readStaticFile(pathname: string): Promise<{ data: Buffer; type: string } | null> {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(STATIC_DIR, safe);
  const data = await fs.readFile(filePath).catch(() => null);
  if (!data) return null;
  return { data, type: MIME[path.extname(filePath)] || 'application/octet-stream' };
}

async function serveSpa(res: http.ServerResponse): Promise<void> {
  const index = await fs.readFile(path.join(STATIC_DIR, 'index.html')).catch(() => null);
  if (!index) {
    json(res, 404, { code: 1, data: null, msg: '前端尚未构建：请先 npm run build' });
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME['.html'] });
  res.end(index);
}

async function serveMediaFile(req: http.IncomingMessage, res: http.ServerResponse, fileName: string): Promise<void> {
  if (!/^[\w.-]+$/.test(fileName)) {
    json(res, 400, { code: 1, data: null, msg: '非法文件名' });
    return;
  }
  const filePath = path.join(MEDIA_DIR, fileName);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    json(res, 404, { code: 1, data: null, msg: '文件不存在' });
    return;
  }
  let contentType = contentTypeOf(fileName);
  if (contentType === 'application/octet-stream') {
    // 没有扩展名的旧媒体：读前 32 字节嗅探图片格式
    const head = Buffer.alloc(Math.min(32, stat.size));
    const handle = await fs.open(filePath, 'r').catch(() => null);
    if (handle) {
      await handle.read(head, 0, head.length, 0).catch(() => undefined);
      await handle.close().catch(() => undefined);
    }
    contentType = `image/${imageExtensionOf(head, path.extname(fileName).slice(1))}`;
  }

  const total = stat.size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Content-Type', contentType);

  // 视频播放器（尤其 Safari）要求分段请求：没有 206 会直接判成无法播放。
  const rangeHeader = String(req.headers.range || '').trim();
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (match) {
      const hasStart = match[1] !== '';
      const hasEnd = match[2] !== '';
      let start = hasStart ? Number(match[1]) : 0;
      let end = hasEnd ? Number(match[2]) : total - 1;
      if (!hasStart && hasEnd) {
        // suffix range: bytes=-N 表示最后 N 字节
        start = Math.max(0, total - Number(match[2]));
        end = total - 1;
      }
      if (start >= total || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      end = Math.min(end, total - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(end - start + 1),
      });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, { 'Content-Length': String(total) });
  createReadStream(filePath).pipe(res);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error(`数据文件不是 JSON 对象：${path.basename(filePath)}`);
  return parsed;
}

/** 同目录唯一临时文件 + rename：读者只会看到完整的旧版或新版 JSON。 */
async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, filePath);
  } finally {
    await fs.unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function readRegistry(): Promise<CanvasRegistry> {
  const parsed = await readJsonObject(CANVASES_FILE);
  if (!Object.values(parsed).every((name) => typeof name === 'string')) throw new Error('画布注册表损坏');
  return parsed as CanvasRegistry;
}

async function writeRegistry(registry: CanvasRegistry): Promise<void> {
  await atomicWriteJson(CANVASES_FILE, registry);
}

async function readCanvasDocs(): Promise<Record<string, CanvasDocRecord>> {
  const parsed = await readJsonObject(CANVAS_DOCS_FILE);
  if (!Object.values(parsed).every((doc) => isRecord(doc)
    && typeof doc.name === 'string' && Array.isArray(doc.nodes) && Array.isArray(doc.edges))) {
    throw new Error('画布文档损坏：name/nodes/edges 类型不正确');
  }
  return parsed as unknown as Record<string, CanvasDocRecord>;
}

async function mediaFileIsReferenced(fileName: string): Promise<boolean> {
  const needle = `/api/files/${fileName}`;
  const read = async (filePath: string): Promise<string> => fs.readFile(filePath, 'utf8').catch(() => '');
  const [canvasText, chatText] = await Promise.all([read(CANVAS_DOCS_FILE), read(CHAT_DOCS_FILE)]);
  return canvasText.includes(needle) || chatText.includes(needle);
}

/**
 * 画布文档写入队列：多个浏览器标签页 / StrictMode 双跑会并发打进来，
 * 读-改-写整个 JSON 一旦交叉就丢数据，这里把所有写操作串成一条链。
 */
let canvasWriteChain: Promise<unknown> = Promise.resolve();
function withCanvasWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = canvasWriteChain.then(task, task);
  canvasWriteChain = run.catch(() => undefined);
  return run;
}

/** 写前留一份滚动备份：万一哪条写路径拿空快照覆盖了有内容的画布，也能手工捞回来。 */
async function backupCanvasDocs(): Promise<void> {
  try {
    const current = await fs.readFile(CANVAS_DOCS_FILE, 'utf8');
    const dir = path.join(path.dirname(CANVAS_DOCS_FILE), 'backups');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(dir, `canvas-docs-${stamp}.json`), current, 'utf8');
    const names = (await fs.readdir(dir)).filter((name) => name.startsWith('canvas-docs-')).sort();
    for (const stale of names.slice(0, Math.max(0, names.length - 5))) {
      await fs.unlink(path.join(dir, stale)).catch(() => undefined);
    }
  } catch {
    /* 备份失败不阻断主流程 */
  }
}

/* ── 以下导出具给 MCP（bridge/mcp.ts）复用。写路径一条不少地走
   withCanvasWriteLock 串行链 + backupCanvasDocs 滚动备份（AGENTS.md 三条保险）。 ── */

/** 画布注册表（id → 名称）：MCP 的 huiban_canvases / huiban_canvas_create 用。 */
export async function readCanvasRegistry(): Promise<CanvasRegistry> {
  return readRegistry();
}

/** 读单个画布文档：huiban_nodes 列节点、追加前排点位用。 */
export async function readCanvasDoc(canvasId: string): Promise<CanvasDocRecord | undefined> {
  const docs = await readCanvasDocs();
  return docs[canvasId];
}

/** MCP 视频生成前更新已有节点输入快照，串行写入并广播，让画布与任务提示词一致。 */
export async function patchCanvasVideoNode(
  canvasId: string,
  nodeId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const updatedAt = await withCanvasWriteLock(async () => {
    const docs = await readCanvasDocs();
    const doc = docs[canvasId];
    if (!doc || !Array.isArray(doc.nodes)) return '';
    const index = doc.nodes.findIndex((raw) => {
      const node = raw as { id?: unknown; data?: Record<string, unknown> };
      return String(node?.id || '') === nodeId && node.data?.kind === 'video';
    });
    if (index < 0) return '';
    const nodes = [...doc.nodes];
    const node = nodes[index] as { id: string; data: Record<string, unknown> };
    nodes[index] = { ...node, data: { ...node.data, ...patch } };
    const now = Date.now();
    const previous = Date.parse(String(doc.updatedAt || ''));
    const timestamp = new Date(Math.max(now, Number.isFinite(previous) ? previous + 1 : now)).toISOString();
    docs[canvasId] = { ...doc, nodes, updatedAt: timestamp };
    await backupCanvasDocs();
    await atomicWriteJson(CANVAS_DOCS_FILE, docs);
    return timestamp;
  });
  if (updatedAt) await pushCanvasUpdated({ type: 'canvas-updated', canvasId, updatedAt });
  return Boolean(updatedAt);
}

export interface AppendCanvasImageOptions {
  /** 聊天生图时把已有的参考图节点连到每张新结果上（同画布）。 */
  connectFrom?: string[];
}

/** MCP 追加图片节点（外部写入）。注册表和文档都没有这个 id 时拒绝——
   防把提示词里拼错的 canvasId 写成一张幽灵画布。
   幂等：已存在的节点 id 跳过——对话 agent 的节点 id 由 runId+callId 确定性生成，
   重复事件（SSE 重连补发 / 客户端重试）不会追加出重复节点。
   传入 connectFrom 时，按 source -> 每张结果建立边；重复调用不会重复加边。 */
export async function appendCanvasImageNodes(canvasId: string, nodes: CanvasNodeRecord[], options: AppendCanvasImageOptions = {}): Promise<boolean> {
  if (nodes.length === 0) return false;
  return withCanvasWriteLock(async () => {
    const registry = await readRegistry();
    const docs = await readCanvasDocs();
    const previous = docs[canvasId];
    if (!previous && !registry[canvasId]) return false;
    const previousNodes = previous?.nodes || [];
    const existingIds = new Set(previousNodes.map((node) => String((node as { id?: string })?.id || '')));
    const fresh = nodes.filter((node) => !existingIds.has(String(node.id || ''))
      && !Object.hasOwn(previous?.deletedNodeIds || {}, node.id));
    const targetIds = nodes
      .map((node) => String(node.id || ''))
      .filter((id) => id && !Object.hasOwn(previous?.deletedNodeIds || {}, id));
    const sourceIds = [...new Set((options.connectFrom || []).map((id) => String(id || '').trim()))]
      .filter((id) => id && existingIds.has(id) && !targetIds.includes(id));
    const previousEdges = previous?.edges || [];
    const edgeKeys = new Set(previousEdges.map((edge) => {
      const item = edge as { source?: unknown; target?: unknown };
      return `${String(item.source || '')}->${String(item.target || '')}`;
    }));
    const edgeIds = new Set(previousEdges.map((edge) => String((edge as { id?: unknown })?.id || '')));
    const newEdges: Array<Record<string, unknown>> = [];
    for (const source of sourceIds) {
      for (const target of targetIds) {
        const key = `${source}->${target}`;
        if (edgeKeys.has(key)) continue;
        let edgeId = `edge_chat_${source}_${target}`;
        for (let suffix = 2; edgeIds.has(edgeId); suffix += 1) edgeId = `edge_chat_${source}_${target}_${suffix}`;
        edgeKeys.add(key);
        edgeIds.add(edgeId);
        newEdges.push({ id: edgeId, source, sourceHandle: 'out', target, targetHandle: 'in' });
      }
    }
    if (fresh.length === 0 && newEdges.length === 0) return true;
    const previousAt = Date.parse(String(previous?.updatedAt || ''));
    docs[canvasId] = {
      ...previous,
      name: registry[canvasId] || previous?.name || '未命名画布',
      nodes: [...previousNodes, ...fresh],
      edges: [...previousEdges, ...newEdges],
      updatedAt: new Date(Math.max(Date.now(), Number.isFinite(previousAt) ? previousAt + 1 : 0)).toISOString(),
    };
    await backupCanvasDocs();
    await atomicWriteJson(CANVAS_DOCS_FILE, docs);
    return true;
  });
}

/** MCP 建画布：注册表与空文档一次到位；已存在时幂等返回原有名字，不覆盖内容。 */
export async function createCanvasInRegistry(canvasId: string, name: string): Promise<{ id: string; name: string }> {
  const finalName = String(name || '').trim() || '新画布';
  return withCanvasWriteLock(async () => {
    const registry = await readRegistry();
    const docs = await readCanvasDocs();
    const existed = registry[canvasId];
    if (existed) return { id: canvasId, name: existed };
    // 先完整读取两份文件，损坏时不允许先改注册表。
    registry[canvasId] = docs[canvasId]?.name || finalName;
    if (!docs[canvasId]) {
      docs[canvasId] = { name: finalName, nodes: [], edges: [], updatedAt: new Date().toISOString() };
      await backupCanvasDocs();
      await atomicWriteJson(CANVAS_DOCS_FILE, docs);
    }
    await writeRegistry(registry);
    return { id: canvasId, name: registry[canvasId] };
  });
}

/**
 * 第三条保险的延伸：浏览器整文档 PUT 时，把「外部刚追加、本地快照还没同步到」的节点捞回来。
 * 只认 source==='mcp' / 'chat' 且 createdAt 晚于请求快照 updatedAt 的——用户在界面上真删了
 * 这些节点后，之后的 PUT 带着更晚的 updatedAt，保护自动失效，不会把删掉的节点复活。
 */
export function keepExternalNodesOnSnapshot(
  previousNodes: unknown[] | undefined,
  incomingNodes: unknown[],
  updatedAt: string | undefined,
): unknown[] {
  const cutoff = Date.parse(String(updatedAt || ''));
  if (!Number.isFinite(cutoff) || !Array.isArray(previousNodes)) return incomingNodes;
  const present = new Set(incomingNodes.map((node) => String((node as { id?: string })?.id || '')));
  const revived = previousNodes.filter((node) => {
    const item = node as { id?: string; data?: { source?: string; createdAt?: string } };
    if (item?.data?.source !== 'mcp' && item?.data?.source !== 'chat') return false;
    const createdAt = Date.parse(String(item.data?.createdAt || ''));
    return !present.has(String(item.id || '')) && Number.isFinite(createdAt) && createdAt > cutoff;
  });
  return revived.length > 0 ? [...incomingNodes, ...revived] : incomingNodes;
}

type VideoNodeRecord = {
  id?: string;
  data?: Record<string, unknown>;
};

function isVideoTerminalNode(node: VideoNodeRecord | undefined): boolean {
  return node?.data?.kind === 'video'
    && node.data.videoStatus === 'done'
    && Boolean(String(node.data.videoUrl || '').trim());
}

/** 视频终态字段：成品地址、任务号、完成时间等。 */
function pickVideoTerminalFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'videoStatus', 'videoProgress', 'videoUrl', 'videoFileName', 'videoTaskId',
    'videoError', 'videoSubmissionUnknown', 'finishedAt', 'createdAt',
  ]) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

/**
 * 视频终态保护：旧快照缺 videoUrl 时，不能把已经出好的视频冲掉。
 *
 * 判据：上一版已经 done+url，而这一版没有，并且这一版的 createdAt **不晚于**
 * 上一版完成时间——说明这是旧快照，不是用户主动重新生成。
 * 用户点「重新生成」会把 createdAt 刷新到现在，此时允许清空旧视频。
 */
export function protectVideoTerminalNodes(
  previousNodes: unknown[] | undefined,
  incomingNodes: unknown[],
): unknown[] {
  if (!Array.isArray(previousNodes) || previousNodes.length === 0) return incomingNodes;
  const previousById = new Map<string, VideoNodeRecord>();
  for (const node of previousNodes) {
    const item = node as VideoNodeRecord;
    if (item?.id) previousById.set(String(item.id), item);
  }
  let changed = false;
  const nodes = incomingNodes.map((node) => {
    const item = node as VideoNodeRecord;
    const previous = item?.id ? previousById.get(String(item.id)) : undefined;
    if (!previous || !isVideoTerminalNode(previous) || isVideoTerminalNode(item)) return node;
    const previousDoneAt = Date.parse(String(previous.data?.finishedAt || previous.data?.createdAt || ''));
    const incomingStartedAt = Date.parse(String(item.data?.createdAt || ''));
    if (Number.isFinite(previousDoneAt) && Number.isFinite(incomingStartedAt) && incomingStartedAt > previousDoneAt) {
      return node; // 用户已经开了新一轮，允许清空
    }
    changed = true;
    return {
      ...item,
      data: { ...(item.data || {}), ...pickVideoTerminalFields(previous.data || {}) },
    };
  });
  return changed ? nodes : incomingNodes;
}

export function mergeCanvasSnapshot(
  previousNodes: unknown[] | undefined,
  incomingNodes: unknown[],
  incomingEdges: unknown[],
  snapshotUpdatedAt: string | undefined,
): { nodes: unknown[]; edges: unknown[] } {
  return {
    // Incoming arrays are the user's full current snapshot. Unioning old entries here made
    // intentional node/edge deletions impossible and caused them to reappear after saving.
    nodes: protectVideoTerminalNodes(
      previousNodes,
      keepExternalNodesOnSnapshot(previousNodes, incomingNodes, snapshotUpdatedAt),
    ),
    edges: incomingEdges,
  };
}

/** 浏览器整文档上桥改为「相对基线的变更集」，这里只描述变了什么，不覆盖整份文档。 */
export interface CanvasGraphChanges {
  nodeUpserts: Array<{ id: string; [key: string]: unknown }>;
  nodeDeletes: string[];
  edgeUpserts: Array<{ id: string; source: string; target: string; [key: string]: unknown }>;
  edgeDeletes: string[];
  name?: string;
  viewport?: { x: number; y: number; zoom: number } | null;
}

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES = 1000;

function pruneTombstones(tombstones: Record<string, string>, now: number): Record<string, string> {
  const entries = Object.entries(tombstones).filter(([, at]) => {
    const time = Date.parse(at);
    return Number.isFinite(time) && now - time <= TOMBSTONE_TTL_MS;
  });
  if (entries.length <= MAX_TOMBSTONES) return Object.fromEntries(entries);
  entries.sort((left, right) => Date.parse(left[1]) - Date.parse(right[1]));
  return Object.fromEntries(entries.slice(entries.length - MAX_TOMBSTONES));
}

function idOf(item: unknown): string {
  return String((item as { id?: unknown })?.id || '');
}

/**
 * 把某次保存相对其基线的变更合并进服务端最新文档。
 *
 * - 不同标签页改不同节点时各自生效，不互相覆盖；
 * - 节点/连线被别的标签页删掉后，旧标签页的更新不会把它带回来（墓碑时间晚于它的基线）；
 * - 客户端已经看到删除后的主动恢复（撤销）仍然允许，靠墓碑时间 ≤ 基线时间判断。
 */
export function mergeCanvasGraphChanges(
  previous: CanvasDocRecord | undefined,
  changes: CanvasGraphChanges,
  fallbackName: string,
  baselineUpdatedAt: string | undefined,
  updatedAt: string,
): CanvasDocRecord {
  const now = Date.parse(updatedAt);
  const baselineTime = Date.parse(String(baselineUpdatedAt || ''));
  const nodeTombstones = { ...(previous?.deletedNodeIds || {}) };
  const edgeTombstones = { ...(previous?.deletedEdgeIds || {}) };
  const seenDeletion = (tombstones: Record<string, string>, id: string): boolean => {
    const deletedAt = Date.parse(String(tombstones[id] || ''));
    if (!Number.isFinite(deletedAt)) return true;
    return Number.isFinite(baselineTime) && deletedAt <= baselineTime;
  };

  const nodeDeletes = new Set(changes.nodeDeletes.map(String));
  let nodes = (previous?.nodes || []).filter((item) => !nodeDeletes.has(idOf(item)));
  for (const id of nodeDeletes) nodeTombstones[id] = updatedAt;
  const presentNodeIds = new Set(nodes.map(idOf));
  for (const node of changes.nodeUpserts) {
    const id = idOf(node);
    if (!id) continue;
    if (presentNodeIds.has(id)) {
      nodes = nodes.map((item) => (idOf(item) === id ? node : item));
      continue;
    }
    if (!seenDeletion(nodeTombstones, id)) continue;
    delete nodeTombstones[id];
    nodes = [...nodes, node];
    presentNodeIds.add(id);
  }

  const liveNodeIds = new Set(nodes.map(idOf));
  const edgeDeletes = new Set(changes.edgeDeletes.map(String));
  let edges = (previous?.edges || []).filter((item) => (
    !edgeDeletes.has(idOf(item))
    && liveNodeIds.has(String((item as { source?: unknown }).source || ''))
    && liveNodeIds.has(String((item as { target?: unknown }).target || ''))
  ));
  for (const id of edgeDeletes) edgeTombstones[id] = updatedAt;
  const presentEdgeIds = new Set(edges.map(idOf));
  for (const edge of changes.edgeUpserts) {
    const id = idOf(edge);
    if (!id) continue;
    if (!liveNodeIds.has(String(edge.source || '')) || !liveNodeIds.has(String(edge.target || ''))) continue;
    if (presentEdgeIds.has(id)) {
      edges = edges.map((item) => (idOf(item) === id ? edge : item));
      continue;
    }
    if (!seenDeletion(edgeTombstones, id)) continue;
    delete edgeTombstones[id];
    edges = [...edges, edge];
    presentEdgeIds.add(id);
  }

  const name = String(changes.name ?? previous?.name ?? fallbackName).trim() || fallbackName;
  const viewport = changes.viewport !== undefined ? changes.viewport : previous?.viewport;
  const merged: CanvasDocRecord = {
    name,
    nodes: protectVideoTerminalNodes(previous?.nodes, nodes),
    edges,
    ...(viewport ? { viewport } : {}),
    updatedAt,
  };
  const deletedNodeIds = pruneTombstones(nodeTombstones, now);
  const deletedEdgeIds = pruneTombstones(edgeTombstones, now);
  if (Object.keys(deletedNodeIds).length > 0) merged.deletedNodeIds = deletedNodeIds;
  if (Object.keys(deletedEdgeIds).length > 0) merged.deletedEdgeIds = deletedEdgeIds;
  return merged;
}

export type InternalCanvasWriteOperation =
  | { op: 'appendImages'; canvasId: string; nodes: CanvasNodeRecord[] }
  | { op: 'createCanvas'; canvasId: string; name: string }
  | { op: 'patchVideoNode'; canvasId: string; nodeId: string; patch: Record<string, unknown> };

export interface InternalCanvasWriteResults {
  appendImages: boolean;
  createCanvas: { id: string; name: string };
  patchVideoNode: boolean;
}

function validInternalId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,200}$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function validCanvasNode(value: unknown): value is CanvasNodeRecord {
  return isRecord(value) && validInternalId(value.id) && value.type === 'flow-image'
    && isRecord(value.position) && typeof value.position.x === 'number' && Number.isFinite(value.position.x)
    && typeof value.position.y === 'number' && Number.isFinite(value.position.y)
    && isRecord(value.data) && value.data.kind === 'image';
}

const VIDEO_PATCH_STRINGS = new Set([
  'prompt', 'videoStatus', 'videoError', 'videoTaskId', 'videoUrl', 'videoFileName',
  'videoResolution', 'videoRatio', 'videoReferenceMode', 'videoModel', 'videoProfileId', 'createdAt',
]);
const VIDEO_PATCH_BOOLEANS = new Set([
  'videoAudio', 'videoSubmissionUnknown', 'videoDownloadRecoverable', 'videoDownloadRecovering',
]);
function validVideoPatch(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.entries(value).every(([key, entry]) => {
    if (VIDEO_PATCH_STRINGS.has(key)) return typeof entry === 'string';
    if (VIDEO_PATCH_BOOLEANS.has(key)) return typeof entry === 'boolean';
    if (key === 'videoSeconds' || key === 'videoProgress') return typeof entry === 'number' && Number.isFinite(entry);
    if (key === 'videoParams') return isRecord(entry);
    if (key === 'videoImageUrls') return Array.isArray(entry) && entry.every((url) => typeof url === 'string');
    return false;
  });
}

function validInternalWrite(value: unknown): value is InternalCanvasWriteOperation {
  if (!isRecord(value) || !validInternalId(value.canvasId)) return false;
  switch (value.op) {
    case 'appendImages': return Array.isArray(value.nodes) && value.nodes.length <= 100 && value.nodes.every(validCanvasNode);
    case 'createCanvas': return typeof value.name === 'string' && value.name.length <= 500;
    case 'patchVideoNode': return validInternalId(value.nodeId) && validVideoPatch(value.patch);
    default: return false;
  }
}

/** 内部通道仅允许 loopback；有 Origin 时必须是本机同源，禁止浏览器跨站 POST。 */
function isInternalRequest(req: http.IncomingMessage): boolean {
  if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(String(req.socket.remoteAddress || ''))) return false;
  if (req.headers.origin === undefined) return true;
  try {
    const origin = new URL(req.headers.origin);
    const host = new URL(`http://${req.headers.host}`);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)
      && Number(host.port || 80) === req.socket.localPort
      && origin.origin === host.origin && req.headers.origin === origin.origin;
  } catch {
    return false;
  }
}

function validBroadcast(value: unknown): value is { kind: string; payload: Record<string, unknown> } {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  const p = value.payload;
  if (p.type !== value.kind) return false;
  const validOptionalCanvas = p.canvasId === undefined || p.canvasId === '' || validInternalId(p.canvasId);
  switch (value.kind) {
    case 'image': return validOptionalCanvas && validInternalId(p.nodeId)
      && ['prompt', 'fileName', 'url', 'jobId'].every((key) => typeof p[key] === 'string');
    case 'locate': return validInternalId(p.canvasId) && validInternalId(p.nodeId)
      && typeof p.at === 'string' && Number.isFinite(Date.parse(p.at))
      && (p.onlyIfOffscreen === undefined || typeof p.onlyIfOffscreen === 'boolean');
    case 'video': return validOptionalCanvas && validInternalId(p.nodeId) && typeof p.taskId === 'string'
      && ['submitted', 'progress', 'download-failed', 'done', 'failed'].includes(String(p.phase));
    case 'canvas-updated': return validInternalId(p.canvasId)
      && typeof p.updatedAt === 'string' && Number.isFinite(Date.parse(p.updatedAt))
      && (p.originId === undefined || typeof p.originId === 'string');
    default: return false;
  }
}

export function createHttpServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
      if (pathname === '/api/health' && req.method === 'GET') {
        const readiness = imageModelReadiness(await readSettings());
        res.setHeader('Cache-Control', 'no-store');
        json(res, 200, { code: 0, data: { bridgeOnline: true, imageModel: readiness }, msg: 'ok' });
        return;
      }
      if (pathname === '/api/agent/status' && req.method === 'GET') {
        const presence = await readAgentPresence();
        json(res, 200, {
          code: 0,
          data: {
            connected: isAgentPresenceFresh(presence),
            lastSeenAt: presence.lastSeenAt || '',
            canvasId: presence.canvasId || '',
            transport: presence.transport || 'stdio',
            mcpEntry: MCP_ENTRY,
            nodeCommand: MCP_LAUNCHER,
            nodePath: process.execPath,
            platform: process.platform,
            openTabs: countOpenTabs(),
          },
          msg: 'ok',
        });
        return;
      }
      if ((pathname === '/api/internal/write' || pathname === '/api/internal/broadcast') && req.method === 'POST') {
        if (!isInternalRequest(req)) {
          json(res, 403, { code: 1, data: null, msg: 'forbidden' });
          return;
        }
        let body: unknown;
        try {
          body = await readBody(req);
        } catch {
          json(res, 400, { code: 1, data: null, msg: '非法 JSON' });
          return;
        }
        if (pathname === '/api/internal/write') {
          if (!validInternalWrite(body)) {
            json(res, 400, { code: 1, data: null, msg: '非法画布写入操作或参数' });
            return;
          }
          let result: InternalCanvasWriteResults[keyof InternalCanvasWriteResults];
          switch (body.op) {
            case 'appendImages': result = await appendCanvasImageNodes(body.canvasId, body.nodes); break;
            case 'createCanvas': result = await createCanvasInRegistry(body.canvasId, body.name); break;
            case 'patchVideoNode': result = await patchCanvasVideoNode(body.canvasId, body.nodeId, body.patch); break;
          }
          json(res, 200, { code: 0, data: result, msg: 'ok' });
          return;
        }
        if (!validBroadcast(body)) {
          json(res, 400, { code: 1, data: null, msg: '非法广播类型或参数' });
          return;
        }
        switch (body.kind) {
          case 'image': await pushImage(body.payload as never); break;
          case 'locate': await pushLocate(body.payload as never); break;
          case 'video': await pushVideo(body.payload as never); break;
          case 'canvas-updated': await pushCanvasUpdated(body.payload as never); break;
        }
        json(res, 200, { code: 0, data: { broadcast: body.kind }, msg: 'ok' });
        return;
      }
      if (pathname === '/api/agent/locate' && req.method === 'GET') {
        json(res, 200, { code: 0, data: { pending: peekPendingLocate() }, msg: 'ok' });
        return;
      }
      if (pathname === '/api/agent/locate/ack' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({})) as Record<string, unknown>;
        ackPendingLocate(typeof body.at === 'string' ? body.at : undefined);
        json(res, 200, { code: 0, data: { acked: true }, msg: 'ok' });
        return;
      }
      if (pathname === '/api/settings' && req.method === 'GET') {
        json(res, 200, { code: 0, data: publicView(await readSettings()), msg: 'ok' });
        return;
      }
      if (pathname === '/api/settings/reveal-key' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, unknown>;
        const profileId = String(body.profileId || '').trim();
        const profile = (await readSettings()).profiles.find((item) => item.id === profileId);
        res.setHeader('Cache-Control', 'no-store');
        if (!profile) {
          json(res, 404, { code: 1, data: null, msg: '找不到这路模型配置' });
          return;
        }
        if (!profile.apiKey) {
          json(res, 404, { code: 1, data: null, msg: '当前配置没有已保存的 API Key，请重新填写并保存' });
          return;
        }
        json(res, 200, { code: 0, data: { apiKey: profile.apiKey }, msg: 'ok' });
        return;
      }
      if (pathname === '/api/settings' && req.method === 'PUT') {
        const body = await readBody(req) as Record<string, unknown>;
        const current = await readSettings();
        // 不带 profiles 的保存（节点工具栏只翻「直连」）：原样带回已存配置；
        // apiKey 传空串 = 不修改，不会把已保存的 Key 擦掉
        const drafts: Array<Partial<ModelProfile>> = Array.isArray(body.profiles)
          ? (body.profiles as Array<Record<string, unknown>>).map((draft) => ({
            id: String(draft.id || ''),
            name: String(draft.name || ''),
            baseUrl: String(draft.baseUrl || ''),
            apiKey: String(draft.apiKey || ''),
            model: String(draft.model || ''),
            defaultSize: String(draft.defaultSize || ''),
            models: Array.isArray(draft.models) ? draft.models.map((item) => String(item)) : undefined,
            enabledModels: Array.isArray(draft.enabledModels) ? draft.enabledModels.map((item) => String(item)) : undefined,
            kind: draft.kind === 'text' || draft.kind === 'video' ? draft.kind : 'image',
            textFormat: (draft.textFormat === 'chat' || draft.textFormat === 'responses') ? draft.textFormat : 'auto',
            imageApiMode: draft.imageApiMode === 'responses' ? 'responses' : 'images',
            videoApiMode: draft.videoApiMode === 'openai-videos' || draft.videoApiMode === 'xai-videos' || draft.videoApiMode === 'grsai-generate' || draft.videoApiMode === 'media-v1' || draft.videoApiMode === 'custom' || draft.videoApiMode === 'auto'
              ? draft.videoApiMode
              : undefined,
            videoCustomConfig: draft.videoCustomConfig && typeof draft.videoCustomConfig === 'object'
              ? draft.videoCustomConfig as ModelProfile['videoCustomConfig']
              : undefined,
            responsesModel: String(draft.responsesModel || ''),
            enabled: typeof draft.enabled === 'boolean' ? draft.enabled : undefined,
          }))
          : current.profiles.map((profile) => ({
            id: profile.id,
            name: profile.name,
            baseUrl: profile.baseUrl,
            apiKey: '',
            model: profile.model,
            defaultSize: profile.defaultSize,
            models: profile.models,
            enabledModels: profile.enabledModels,
            kind: profile.kind,
            imageApiMode: profile.imageApiMode,
            responsesModel: profile.responsesModel,
            enabled: profile.enabled,
          }));
        const settings = await writeSettings({
          profiles: Array.isArray(body.profiles) ? drafts : undefined,
          activeProfileId: Array.isArray(body.profiles) ? String(body.activeProfileId || '') : undefined,
          direct: typeof body.direct === 'boolean' ? body.direct : undefined,
          promptOptimizationEnabled: typeof body.promptOptimizationEnabled === 'boolean' ? body.promptOptimizationEnabled : undefined,
          textProfileId: typeof body.textProfileId === 'string' ? body.textProfileId : undefined,
          enhanceLevel: typeof body.enhanceLevel === 'string' ? normalizeEnhanceLevel(body.enhanceLevel) : undefined,
          chatMemory: body.chatMemory && typeof body.chatMemory === 'object' ? body.chatMemory as Parameters<typeof writeSettings>[0]['chatMemory'] : undefined,
          chatRuntime: body.chatRuntime && typeof body.chatRuntime === 'object' ? body.chatRuntime as Parameters<typeof writeSettings>[0]['chatRuntime'] : undefined,
        });
        json(res, 200, { code: 0, data: publicView(settings), msg: 'ok' });
        return;
      }
      if (pathname === '/api/preferences' && req.method === 'POST') {
        // 偏好档案：整理强度只走 /api/settings，这里只管档案的增删清与归纳
        const body = await readBody(req) as Record<string, unknown>;
        const action = String(body.action || '');
        try {
          if (action === 'add') {
            const profile = await addManualPreference({
              prompt: String(body.prompt || ''),
              model: String(body.model || ''),
              size: String(body.size || ''),
            });
            json(res, 200, { code: 0, data: profile, msg: '已录入偏好档案' });
            return;
          }
          if (action === 'distill') {
            const profile = await distillPreferences();
            json(res, 200, { code: 0, data: profile, msg: `已归纳出 ${profile.entries.length} 条偏好` });
            return;
          }
          if (action === 'remove') {
            json(res, 200, { code: 0, data: await removePreference(String(body.id || '')), msg: '已删除这条偏好' });
            return;
          }
          if (action === 'clear') {
            json(res, 200, { code: 0, data: await clearPreferences(), msg: '已清空偏好档案' });
            return;
          }
          if (action === 'toggle') {
            json(res, 200, { code: 0, data: await setPreferencesEnabled(body.enabled === true), msg: body.enabled === true ? '偏好档案已启用' : '偏好档案已关闭' });
            return;
          }
          json(res, 400, { code: 1, data: null, msg: `未知的偏好操作：${action || '(空)'}` });
        } catch (err) {
          json(res, 502, { code: 1, data: null, msg: err instanceof Error ? err.message : '偏好档案操作失败' });
        }
        return;
      }
      if (pathname === '/api/models' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, string>;
        const current = await readSettings();
        // 草稿态留空的字段回落到已保存配置，测试/拉取不需要先保存
        const saved = body.profileId
          ? current.profiles.find((profile) => profile.id === body.profileId)
          : findProfile(current, undefined);
        const baseUrl = String(body.baseUrl || '').trim() || saved?.baseUrl || '';
        const sameBase = saved && baseUrl.replace(/\/+$/, '') === saved.baseUrl.trim().replace(/\/+$/, '');
        const apiKey = String(body.apiKey || '').trim() || (sameBase ? saved.apiKey : '');
        if (!apiKey) {
          json(res, 400, { code: 1, data: null, msg: '尚未配置 API Key：请先填写并保存' });
          return;
        }
        try {
          const models = await fetchProviderModels({ baseUrl, apiKey });
          json(res, 200, { code: 0, data: models, msg: 'ok' });
        } catch (err) {
          json(res, 502, { code: 1, data: null, msg: err instanceof Error ? err.message : '获取模型列表失败' });
        }
        return;
      }
      if (pathname === '/api/reveal-file' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, string>;
        try {
          const filePath = await revealLocalFile(String(body.fileName || ''));
          json(res, 200, { code: 0, data: { filePath }, msg: 'ok' });
        } catch (err) {
          json(res, 400, { code: 1, data: null, msg: err instanceof Error ? err.message : '打开本地文件失败' });
        }
        return;
      }
      if (pathname === '/api/fetch-image' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, string>;
        try {
          const file = await fetchRemoteImage(String(body.url || ''));
          json(res, 200, { code: 0, data: { url: file.url, fileName: file.fileName }, msg: 'ok' });
        } catch (err) {
          json(res, 502, { code: 1, data: null, msg: err instanceof Error ? err.message : '图片获取失败' });
        }
        return;
      }
      if (pathname === '/api/test' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, string>;
        const current = await readSettings();
        const saved = body.profileId
          ? current.profiles.find((profile) => profile.id === body.profileId)
          : findProfile(current, undefined);
        const baseUrl = String(body.baseUrl || '').trim() || saved?.baseUrl || '';
        const sameBase = saved && baseUrl.replace(/\/+$/, '') === saved.baseUrl.trim().replace(/\/+$/, '');
        const apiKey = String(body.apiKey || '').trim() || (sameBase ? saved.apiKey : '');
        const model = String(body.model || '').trim() || saved?.model || '';
        if (!apiKey) {
          json(res, 400, { code: 1, data: null, msg: '尚未配置 API Key：请先填写并保存' });
          return;
        }
        const kind = body.kind === 'text' || body.kind === 'video' || saved?.kind === 'text' || saved?.kind === 'video'
          ? (body.kind || saved?.kind)
          : 'image';
        try {
          let message: string;
          if (kind === 'text') {
            message = await testTextProfile({ ...(saved || createProfile('测试配置', 'text')), baseUrl, apiKey, model });
          } else if (kind === 'video') {
            const draft = {
              ...(saved || createProfile('测试配置', 'video')),
              baseUrl,
              apiKey,
              model,
              ...(body.videoApiMode ? { videoApiMode: body.videoApiMode as ModelProfile['videoApiMode'] } : {}),
              ...(body.videoCustomConfig && typeof body.videoCustomConfig === 'object'
                ? { videoCustomConfig: body.videoCustomConfig as ModelProfile['videoCustomConfig'] }
                : {}),
            };
            // 视频先做只读协议探测，把识别依据一并返回；用户不用先猜该选哪个协议
            const detection = await detectVideoProtocol(draft, { force: true });
            const probe = await probeVideoConnection({ ...draft, videoApiMode: detection.mode });
            const confidence = detection.confidence === 'high' ? '高' : detection.confidence === 'medium' ? '中' : '低';
            message = `${probe}\n协议识别：${detection.mode}（${confidence}置信度）—— ${detection.evidence}`;
          } else {
            message = await testProviderConnection({ baseUrl, apiKey, model });
          }
          json(res, 200, { code: 0, data: { message }, msg: 'ok' });
        } catch (err) {
          json(res, 502, { code: 1, data: null, msg: err instanceof Error ? err.message : '连接测试失败' });
        }
        return;
      }
/** /api/enhance 收参考图：优先多图数组（带顺序），回退旧的单数字段。 */
function readReferenceUrls(body: { referenceDataUrl?: unknown; referenceDataUrls?: unknown }): string[] {
  const raw = body.referenceDataUrls;
  if (Array.isArray(raw)) return raw.map((item) => String(item || '').trim()).filter(Boolean);
  const single = body.referenceDataUrl ? String(body.referenceDataUrl).trim() : '';
  return single ? [single] : [];
}

      if (pathname === '/api/enhance' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, string>;
        const current = await readSettings();
        const textProfile = resolveTextProfile(current, body.profileId);
        if (!textProfile) {
          json(res, 400, { code: 1, data: null, msg: '尚未配置语言模型：请在「生图设置」里添加一路语言模型' });
          return;
        }
        const prompt = String(body.prompt || '').trim();
        if (!prompt) {
          json(res, 400, { code: 1, data: null, msg: '提示词不能为空' });
          return;
        }
        try {
          const enhanced = await enhancePromptDetailed(textProfile, {
            prompt,
            size: body.size ? String(body.size) : undefined,
            // 多图按前端传的数组顺序走：数组第 1 张就是画布 chips 上的「图 1」
            referenceDataUrls: readReferenceUrls(body),
            level: current.enhanceLevel,
            // 二次编辑由前端显式锁定 edit；普通参考图才按措辞自动预判。
            usage: (body.usage === 'edit' || body.usage === 'style') ? body.usage : detectReferenceUsage(prompt),
            // 档案只在开启时注入；直连时整条优化层被跳过，这里传了也不起作用
            preferences: current.preferences.enabled ? current.preferences.entries : [],
          });
          json(res, 200, { code: 0, data: enhanced, msg: 'ok' });
        } catch (err) {
          json(res, 502, { code: 1, data: null, msg: err instanceof Error ? err.message : '提示词优化失败' });
        }
        return;
      }
      if (pathname === '/api/enhance-video' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, unknown>;
        const current = await readSettings();
        const textProfile = resolveTextProfile(current, body.profileId ? String(body.profileId) : undefined);
        if (!textProfile) {
          json(res, 400, { code: 1, data: null, msg: '尚未配置语言模型：请在「生图设置」里添加一路语言模型' });
          return;
        }
        const prompt = String(body.prompt || '').trim();
        if (!prompt) {
          json(res, 400, { code: 1, data: null, msg: '视频描述不能为空' });
          return;
        }
        try {
          const optimized = await optimizeVideoPrompt(textProfile, {
            prompt,
            ratio: String(body.ratio || '16:9'),
            seconds: Number(body.seconds || 5),
            resolution: String(body.resolution || '480p'),
            referenceMode: String(body.referenceMode || 'first_frame'),
          });
          json(res, 200, { code: 0, data: { prompt: optimized }, msg: 'ok' });
        } catch (err) {
          json(res, 502, { code: 1, data: null, msg: err instanceof Error ? err.message : '视频脚本优化失败' });
        }
        return;
      }
      if (pathname === '/api/generate' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, string>;
        const prompt = String(body.prompt || '').trim();
        if (!prompt) {
          json(res, 400, { code: 1, data: null, msg: '提示词不能为空' });
          return;
        }
        const settings = await readSettings();
        const profile = findProfile(settings, body.profileId);
        // 参考图：单图（referenceDataUrl）与多图（referenceDataUrls，二次编辑时基准图 + 额外连线）都收
        const rawReferences = (body as { referenceDataUrls?: unknown }).referenceDataUrls;
        const referenceDataUrls = Array.isArray(rawReferences)
          ? rawReferences.map((item) => String(item || '').trim()).filter(Boolean)
          : [];
        const referenceDataUrl = body.referenceDataUrl ? String(body.referenceDataUrl) : '';
        // 参考图用法 → GPT-image input_fidelity：风格参考 low（不描参考图），图生图 high（保主体）
        const requestedUsage = body.referenceUsage === 'edit' || body.referenceUsage === 'style'
          ? body.referenceUsage
          : undefined;
        const usage = requestedUsage || usageForGenerateRequest(prompt, String(body.originalPrompt || ''));
        const hasReferences = referenceDataUrls.length > 0 || Boolean(referenceDataUrl);
        const apiMode = body.apiMode === 'responses' && profile.imageApiMode === 'responses'
          ? 'responses'
          : body.apiMode === 'images'
            ? 'images'
            : settings.direct === false ? 'responses' : 'images';
        // Responses 主模型接收原始上下文；Image API 直连（含兼容回退）继续使用参考图约束。
        const imagesPrompt = directStyleNote(prompt, usage);
        const finalPrompt = apiMode === 'images' ? imagesPrompt : prompt;
        const images = await generateImages(profile, {
          prompt: finalPrompt,
          apiMode,
          imagesPrompt,
          size: body.size ? String(body.size) : undefined,
          model: body.model ? String(body.model).trim() : undefined,
          quality: body.quality === 'auto' || body.quality === 'low' || body.quality === 'medium' || body.quality === 'high' || body.quality === 'xhigh' || body.quality === 'max'
            ? body.quality
            : undefined,
          inputFidelity: hasReferences ? fidelityForUsage(usage) : undefined,
          n: body.n ? Number(body.n) : undefined,
          referenceDataUrl: referenceDataUrl || undefined,
          referenceDataUrls: referenceDataUrls.length > 0
            ? referenceDataUrls
            : (referenceDataUrl ? [referenceDataUrl] : undefined),
          previousResponseId: body.previousResponseId ? String(body.previousResponseId) : undefined,
          previousImageGenerationCallId: body.previousImageGenerationCallId ? String(body.previousImageGenerationCallId) : undefined,
          responseModel: apiMode === 'responses' ? profile.model : undefined,
        });
        const jobId = `job_${Date.now().toString(36)}`;
        const canvasId = String(body.canvasId || '');
        const originalPrompt = String(body.originalPrompt || '').trim() || prompt;
        // 广播给所有订阅该画布的标签页（含发起页自身按 nodeId 去重）
        if (canvasId) {
          pushImage({
            type: 'image',
            canvasId,
            nodeId: String(body.nodeId || ''),
            prompt: originalPrompt,
            usedPrompt: finalPrompt,
            revisedPrompt: images[0].revisedPrompt,
            responseId: images[0].responseId,
            imageGenerationCallId: images[0].imageGenerationCallId,
            responseModel: images[0].responseModel,
            responseProfileId: profile.id,
            model: body.model ? String(body.model).trim() : profile.model,
            size: normalizeImageSize(body.size ? String(body.size) : profile.defaultSize),
            fileName: images[0].fileName,
            url: images[0].url,
            jobId,
          });
        }
        json(res, 200, { code: 0, data: { ok: true, jobId, images }, msg: 'ok' });
        return;
      }
      /* ── 视频生成 ──
         OpenAI Videos 与 GrsAI 异步任务走「受理 → 轮询 → SSE」；GrsAI 同步结果走「生成 → 下载 → SSE」。
         两条路都先落任务占位，保证 bridge 重启或浏览器刷新时不会丢状态。 */
      /* ── 视频模型目录 ──
         media-v1 协议把每个模型的参数 schema 暴露成接口，界面据此动态渲染表单。
         这样「加一个模型就能跑」是自然结果，不用为每个模型写一套代码。 */
      if (pathname === '/api/video-models' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, string>;
        const current = await readSettings();
        // 草稿态留空的字段回落到已保存配置，拉列表不需要先保存
        const profileId = String(body.profileId || '').trim();
        const saved = profileId
          ? current.profiles.find((profile) => profile.id === profileId)
          : resolveVideoProfile(current);
        const baseUrl = String(body.baseUrl || '').trim() || saved?.baseUrl || '';
        const sameBase = saved && baseUrl.replace(/\/+$/, '') === saved.baseUrl.trim().replace(/\/+$/, '');
        const apiKey = String(body.apiKey || '').trim() || (sameBase ? saved?.apiKey || '' : '');
        if (!baseUrl) {
          json(res, 400, { code: 1, data: null, msg: '尚未配置 Base URL：请先填写' });
          return;
        }
        if (!apiKey) {
          json(res, 400, { code: 1, data: null, msg: '尚未配置 API Key：请先填写并保存' });
          return;
        }
        const draft = {
          ...(saved || createProfile('视频模型', 'video')),
          baseUrl,
          apiKey,
          videoApiMode: (String(body.videoApiMode || saved?.videoApiMode || 'auto') as ModelProfile['videoApiMode']),
        } as ModelProfile;
        try {
          // 先探测协议（只发 GET），再按探测结果取模型列表：
          // 未知中转站不再静默按 openai-videos 发请求，设置面板能直接看到识别依据。
          const detection = await detectVideoProtocol(draft, { force: true });
          const models = await listVideoModels({ ...draft, videoApiMode: detection.mode });
          json(res, 200, {
            code: 0,
            data: {
              models,
              profileId: saved?.id || '',
              protocol: detection.mode,
              confidence: detection.confidence,
              evidence: detection.evidence,
            },
            msg: 'ok',
          });
        } catch (err) {
          json(res, 502, { code: 1, data: null, msg: err instanceof Error ? err.message : '拉取视频模型失败' });
        }
        return;
      }

      if (pathname === '/api/video-model' && req.method === 'GET') {
        const profileId = url.searchParams.get('profileId') || undefined;
        const model = String(url.searchParams.get('model') || '').trim();
        if (!model) {
          json(res, 400, { code: 1, data: null, msg: '缺少 model 参数' });
          return;
        }
        const settings = await readSettings();
        const profile = resolveVideoProfile(settings, profileId);
        if (!profile) {
          json(res, 400, { code: 1, data: null, msg: '尚未配置视频模型' });
          return;
        }
        try {
          // auto 模式下先探测：media-v1 的 schema 端点只在协议识别正确时才存在
          const runtimeProfile = await ensureVideoApiMode(profile);
          const schema = await describeVideoModel(runtimeProfile, model);
          json(res, 200, { code: 0, data: { schema, profileId: profile.id, protocol: runtimeProfile.videoApiMode }, msg: 'ok' });
        } catch (err) {
          json(res, 502, { code: 1, data: null, msg: err instanceof Error ? err.message : '读取模型参数失败' });
        }
        return;
      }
      if (pathname === '/api/video-quote' && req.method === 'GET') {
        const settings = await readSettings();
        const profileId = String(url.searchParams.get('profileId') || '').trim();
        const model = String(url.searchParams.get('model') || '').trim();
        const seconds = Number(url.searchParams.get('seconds') || 5);
        const profile = resolveVideoProfile(settings, profileId || undefined);
        if (!profile || !model) {
          json(res, 400, { code: 1, data: null, msg: '缺少视频模型配置或模型名' });
          return;
        }
        try {
          const runtimeProfile = await ensureVideoApiMode(profile);
          if (runtimeProfile.videoApiMode !== 'media-v1') {
            json(res, 200, {
              code: 0,
              data: { supported: false, seconds, warning: '当前接口没有提供可读取的余额 / 报价接口，费用需在服务商后台确认。' },
              msg: '此协议不提供报价预览',
            });
            return;
          }
          const quote = await getMediaVideoPriceQuote(runtimeProfile, model, seconds);
          json(res, 200, { code: 0, data: quote, msg: 'ok' });
        } catch (error) {
          json(res, 502, { code: 1, data: null, msg: error instanceof Error ? error.message : '读取报价失败' });
        }
        return;
      }

      if (pathname === '/api/videos' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, unknown>;
        const prompt = String(body.prompt || '').trim();
        const nodeId = String(body.nodeId || '').trim();
        const canvasId = String(body.canvasId || '').trim();
        if (!prompt) {
          json(res, 400, { code: 1, data: null, msg: '提示词不能为空' });
          return;
        }
        if (!nodeId || !canvasId) {
          json(res, 400, { code: 1, data: null, msg: '缺少 nodeId / canvasId' });
          return;
        }
        const settings = await readSettings();
        const profile = resolveVideoProfile(settings, body.profileId ? String(body.profileId) : undefined);
        if (!profile) {
          json(res, 400, { code: 1, data: null, msg: '尚未配置视频模型：请在「生图设置」里添加一路视频模型' });
          return;
        }
        if (!profile.apiKey) {
          json(res, 400, { code: 1, data: null, msg: `「${profile.name}」尚未配置 API Key` });
          return;
        }
        const model = body.model ? String(body.model).trim() : String(profile.model || '').trim();
        // auto 协议先探测（只发 GET），后续请求一律使用确定的协议，避免静默打错 endpoint
        const runtimeProfile = await ensureVideoApiMode(profile);
        try {
          validateVideoConfig(runtimeProfile, model);
        } catch (err) {
          json(res, 400, { code: 1, data: null, msg: err instanceof Error ? err.message : '视频模型配置不完整' });
          return;
        }
        // 优先遵循模型 schema 的文件输入约定；明确支持 data URL 的媒体模型无需第三方图床。
        const imageUrls: string[] = [];
        const taskImageUrls: string[] = [];
        const rawImageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.map((item) => String(item || '').trim()).filter(Boolean) : [];
        const rawFileNames = Array.isArray(body.imageFileNames) ? body.imageFileNames.map((item) => String(item || '').trim()).filter(Boolean) : [];
        const extraParams = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
          ? body.params as Record<string, unknown>
          : {};
        const imageParamName = String(body.imageParamName || '').trim();

        const inlineCustomImages = videoImagesUseDataUrls(runtimeProfile);

        // 公网 HTTPS 地址直接用；自定义协议可显式声明接受内联 Data URL。
        for (const url of rawImageUrls) {
          if (/^https:\/\//i.test(url)) {
            imageUrls.push(url);
            taskImageUrls.push(url);
          } else if (inlineCustomImages && /^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) {
            imageUrls.push(url);
          } else {
            json(res, 400, { code: 1, data: null, msg: `图生视频的引用图片必须是公网 HTTPS 地址,收到: ${url}` });
            return;
          }
        }

        let inlineDataUrlSupported = inlineCustomImages;
        if (rawFileNames.length > 0 && runtimeProfile.videoApiMode === 'media-v1') {
          try {
            const schema = await describeVideoModel(runtimeProfile, model);
            const imageParam = schema.params.find((spec) => spec.type === 'upload' && spec.name === imageParamName)
              || schema.params.find((spec) => spec.type === 'upload');
            inlineDataUrlSupported = Boolean(imageParam && videoUploadSupportsInlineDataUrl(imageParam.description));
          } catch {
            // Schema 临时不可读时保留图床兜底，不把素材直接发给不明确支持的上游。
          }
        }

        if (rawFileNames.length > 0) {
          if (inlineDataUrlSupported) {
            const localImages: Array<{ buffer: Buffer; mimeType: string }> = [];
            for (const fileName of rawFileNames) {
              const filePath = safeMediaPath(fileName);
              if (!filePath) {
                json(res, 400, { code: 1, data: null, msg: `非法的图片文件名:${fileName}` });
                return;
              }
              try {
                const buffer = await fs.readFile(filePath);
                const declaredType = contentTypeOf(fileName);
                const extension = imageExtensionOf(buffer, path.extname(fileName).slice(1));
                const mimeType = declaredType.startsWith('image/')
                  ? declaredType
                  : `image/${extension === 'jpg' ? 'jpeg' : extension}`;
                localImages.push({ buffer, mimeType });
              } catch {
                json(res, 400, { code: 1, data: null, msg: `读取参考图片失败:${fileName}` });
                return;
              }
            }
            try {
              imageUrls.push(...encodeVideoImagesAsDataUrls(localImages));
            } catch (err) {
              const status = err instanceof VideoImageInputError ? 413 : 400;
              json(res, status, { code: 1, data: null, msg: err instanceof Error ? err.message : '参考图片无法处理' });
              return;
            }
          } else {
            const host = await resolveImageHost();
            for (const fileName of rawFileNames) {
              const filePath = safeMediaPath(fileName);
              if (!filePath) {
                json(res, 400, { code: 1, data: null, msg: `非法的图片文件名:${fileName}` });
                return;
              }
              try {
                const buffer = await fs.readFile(filePath);
                const uploadedUrl = await uploadToImageHost(host, {
                  buffer,
                  fileName,
                  contentType: contentTypeOf(fileName),
                });
                imageUrls.push(uploadedUrl);
                taskImageUrls.push(uploadedUrl);
              } catch (err) {
                json(res, 502, { code: 1, data: null, msg: describeImageHostFailure(err, host.uploadUrl) });
                return;
              }
            }
          }
        }
        if (inlineCustomImages) {
          try {
            validateVideoImageDataUrls(imageUrls);
          } catch (err) {
            const message = err instanceof Error ? err.message : '参考图片无法处理';
            json(res, /超过/.test(message) ? 413 : 400, { code: 1, data: null, msg: message });
            return;
          }
        }
        const ratio = String(body.ratio || '16:9');
        const resolution = normalizeVideoResolution(body.resolution);
        const seconds = Number(body.seconds || 5);
        const referenceMode = body.referenceMode === 'last_frame' || body.referenceMode === 'style'
          ? body.referenceMode
          : 'first_frame';
        // 查重与占位在同一把写锁里完成：并发请求只有一个能拿到提交权，避免重复计费
        const reservation = await reserveVideoTask({
          profileId: profile.id,
          nodeId,
          canvasId,
          prompt,
          model: model || profile.model,
          seconds,
          resolution,
          ratio,
          referenceMode,
          params: extraParams,
          apiMode: runtimeProfile.videoApiMode,
          videoCustomConfig: runtimeProfile.videoApiMode === 'custom' ? runtimeProfile.videoCustomConfig : undefined,
          imageParamName,
          imageUrls: taskImageUrls,
          imageFileNames: rawFileNames,
        });
        if (!reservation.reserved) {
          json(res, 200, { code: 0, data: { ok: true, taskId: reservation.record.taskId, duplicate: true }, msg: '该节点已有在途视频任务' });
          return;
        }
        pushVideo({ type: 'video', phase: 'submitted', canvasId, nodeId, taskId: '', status: 'queued', progress: 0 });
        try {
          const snapshot = await createVideoTask(runtimeProfile, {
            prompt,
            model,
            seconds,
            resolution,
            ratio: normalizeVideoRatio(ratio),
            generateAudio: body.generateAudio === true,
            watermark: body.watermark === true,
            referenceMode,
            imageUrls,
            extraParams,
            imageParamName,
          });
          // 先记住上游任务 ID / 直返地址，再做耗时下载。下载过程中崩溃也能在重启后续上。
          // snapshot.status 已是适配器归一后的终态语义，不再把 failed 改写成 in_progress。
          await confirmVideoSubmission(nodeId, snapshot.id, {
            status: snapshot.status === 'completed' && !snapshot.outputUrl ? 'in_progress' : snapshot.status,
            progress: snapshot.progress,
            outputUrl: snapshot.outputUrl,
          });
          if (snapshot.outputUrl) {
            const claimed = await claimVideoDownload(snapshot.id);
            if (!claimed) {
              json(res, 200, { code: 0, data: { ok: true, taskId: snapshot.id }, msg: '视频已生成，正在接收文件' });
              return;
            }
            try {
              const saved = await downloadVideoUrl(snapshot.outputUrl, runtimeProfile.apiKey, runtimeProfile.baseUrl);
              await completeVideoTask(snapshot.id, saved);
              json(res, 200, { code: 0, data: { ok: true, taskId: snapshot.id }, msg: '视频已生成' });
            } catch (err) {
              const detail = err instanceof Error ? err.message : '视频文件下载失败';
              await releaseVideoDownload(snapshot.id);
              // 记录里已经保存了 outputUrl，轮询器会接着重试下载
              pushVideo({
                type: 'video',
                phase: 'download-failed',
                canvasId,
                nodeId,
                taskId: snapshot.id,
                status: 'in_progress',
                progress: snapshot.progress,
                error: detail,
                recoverable: true,
              });
              json(res, 200, {
                code: 0,
                data: { ok: true, taskId: snapshot.id },
                msg: `视频已生成，正在重试接收文件：${detail}`,
              });
            }
            return;
          }
          pushVideo({
            type: 'video',
            phase: 'progress',
            canvasId,
            nodeId,
            taskId: snapshot.id,
            status: snapshot.status,
            progress: snapshot.progress,
          });
          json(res, 200, { code: 0, data: { ok: true, taskId: snapshot.id }, msg: '视频任务已受理' });
        } catch (err) {
          const detail = err instanceof Error ? err.message : '视频任务提交失败';
          const submissionUnknown = !(
            (err instanceof VideoRequestError && err.definitiveFailure)
            || err instanceof VideoConfigurationError
          );
          const message = submissionUnknown
            ? `提交结果未知，上游可能已收到请求。请先核查服务商任务记录，避免重复提交。${detail ? `（${detail}）` : ''}`
            : detail;
          if (submissionUnknown) await markVideoSubmissionUnknown(nodeId, message);
          else await failVideoSubmission(nodeId, message);
          pushVideo({ type: 'video', phase: 'failed', canvasId, nodeId, taskId: '', status: 'failed', error: message, submissionUnknown });
          json(res, 200, { code: 0, data: { ok: false, error: message, submissionUnknown }, msg: message });
        }
        return;
      }
      if (pathname.startsWith('/api/videos/') && req.method === 'GET') {
        const rest = decodeURIComponent(pathname.slice('/api/videos/'.length));
        if (rest.startsWith('node/')) {
          const record = await findVideoTaskByNode(rest.slice('node/'.length));
          if (!record) {
            json(res, 404, { code: 1, data: null, msg: '这个节点没有在跑的视频任务' });
            return;
          }
          json(res, 200, { code: 0, data: record, msg: 'ok' });
          return;
        }
        const record = await getVideoTaskRecord(rest);
        if (!record) {
          json(res, 404, { code: 1, data: null, msg: '找不到这个视频任务（bridge 可能重启过且任务已过期）' });
          return;
        }
        json(res, 200, { code: 0, data: record, msg: 'ok' });
        return;
      }
      if (pathname.startsWith('/api/videos/node/') && req.method === 'POST') {
        const nodeId = decodeURIComponent(pathname.slice('/api/videos/node/'.length));
        const record = await findVideoTaskByNode(nodeId);
        if (!record) {
          json(res, 404, { code: 1, data: null, msg: '找不到这个视频任务' });
          return;
        }
        if (record.url) {
          json(res, 200, { code: 0, data: { taskId: record.taskId, url: record.url }, msg: '视频已在本机' });
          return;
        }
        if (!record.outputUrl || !record.taskId) {
          json(res, 409, { code: 1, data: null, msg: '没有可恢复的视频文件地址；不会重新提交生成任务' });
          return;
        }
        const claimed = await claimVideoDownload(record.taskId);
        if (!claimed) {
          json(res, 409, { code: 1, data: null, msg: '视频文件正在接收，请稍后查看节点' });
          return;
        }
        try {
          const settings = await readSettings();
          const profile = settings.profiles.find((item) => item.id === record.profileId);
          if (!profile?.apiKey) {
            throw new Error('原视频模型配置或 API Key 已不可用；请恢复配置后再试');
          }
          const saved = await downloadVideoUrl(record.outputUrl, profile.apiKey, profile.baseUrl);
          await completeVideoTask(record.taskId, saved);
          json(res, 200, { code: 0, data: { taskId: record.taskId, url: saved.url }, msg: '视频已重新接收' });
        } catch (error) {
          await releaseVideoDownload(record.taskId);
          const message = error instanceof Error ? error.message : '视频文件接收失败';
          json(res, 502, { code: 1, data: null, msg: message });
        }
        return;
      }
      if (pathname.startsWith('/api/videos/') && req.method === 'DELETE') {
        const rest = decodeURIComponent(pathname.slice('/api/videos/'.length));
        // ?nodeId= 专门删「提交结果未知」的占位（taskId 为空，按 id 删不掉）
        const nodeId = String(url.searchParams.get('nodeId') || '').trim();
        if (rest === 'node' || nodeId) {
          const targetNode = nodeId || rest.slice('node/'.length);
          const removedByNode = await removeVideoTaskByNode(targetNode);
          json(res, 200, {
            code: 0,
            data: { nodeId: targetNode, removed: removedByNode },
            msg: removedByNode ? '已移除该节点的任务记录（上游任务未必取消）' : '该节点没有任务记录',
          });
          return;
        }
        const removed = await removeVideoTask(rest);
        if (!removed) {
          json(res, 404, { code: 1, data: null, msg: '找不到这个视频任务' });
          return;
        }
        json(res, 200, { code: 0, data: { id: rest }, msg: '已移除本地任务记录（上游任务未必取消）' });
        return;
      }
      if (pathname === '/api/image-host' && req.method === 'GET') {
        const host = await readImageHost();
        // 旧版内置 Catbox 配置等同于「没自定义」：经代理会被 Catbox 判成 invalid uploader
        const usingDefault = !imageHostReady(host) || isLegacyDefaultImageHost(host);
        json(res, 200, {
          code: 0,
          data: {
            // configured 表示「用户自定义」；未自定义时图生视频自动使用内置 ImgDB 临时图床
            configured: !usingDefault,
            usingDefault,
            effective: usingDefault ? defaultImageHost() : host,
            defaultPreset: 'imgdb',
            config: usingDefault ? EMPTY_IMAGE_HOST : host,
            presets: IMAGE_HOST_PRESETS,
          },
          msg: 'ok',
        });
        return;
      }
      if (pathname === '/api/image-host' && req.method === 'PUT') {
        const body = await readBody(req) as Partial<ImageHostConfig>;
        const saved = await writeImageHost({
          uploadUrl: String(body.uploadUrl || '').trim(),
          fileField: String(body.fileField || 'file').trim() || 'file',
          urlField: String(body.urlField || '').trim(),
          headers: (body.headers && typeof body.headers === 'object' ? body.headers : {}) as Record<string, string>,
          extraFields: (body.extraFields && typeof body.extraFields === 'object' ? body.extraFields : {}) as Record<string, string>,
        });
        json(res, 200, { code: 0, data: { configured: imageHostReady(saved), config: saved || EMPTY_IMAGE_HOST }, msg: saved ? 'ok' : '已清空图床配置' });
        return;
      }
      if (pathname === '/api/image-host/upload' && req.method === 'POST') {
        const body = await readBody(req) as { fileName?: string };
        const host = await resolveImageHost();
        const filePath = safeMediaPath(String(body.fileName || ''));
        if (!filePath) {
          json(res, 400, { code: 1, data: null, msg: '非法的文件名' });
          return;
        }
        try {
          const buffer = await fs.readFile(filePath);
          const url = await uploadToImageHost(host, {
            buffer,
            fileName: String(body.fileName),
            contentType: contentTypeOf(String(body.fileName)),
          });
          json(res, 200, { code: 0, data: { url }, msg: 'ok' });
        } catch (err) {
          json(res, 502, { code: 1, data: null, msg: err instanceof Error ? err.message : '上传失败' });
        }
        return;
      }
      if (pathname === '/api/events' && req.method === 'GET') {
        const canvasId = url.searchParams.get('canvasId');
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
        const dispose = addSseClient(res, canvasId);
        req.on('close', () => {
          clearInterval(heartbeat);
          dispose();
        });
        return;
      }
      if (pathname.startsWith('/api/canvases') && req.method === 'PUT') {
        const canvasId = pathname.slice('/api/canvases/'.length);
        if (!canvasId) {
          json(res, 400, { code: 1, data: null, msg: '缺少画布 id' });
          return;
        }
        const body = await readBody(req) as {
          name?: string;
          graphChanges?: CanvasGraphChanges;
          baselineUpdatedAt?: string;
          originId?: string;
          nodes?: unknown[];
          edges?: unknown[];
          viewport?: { x: number; y: number; zoom: number };
          updatedAt?: string;
        };
        const name = String(body.name || '未命名画布');
        let storedUpdatedAt = '';
        let storedDoc: CanvasDocRecord | undefined;
        let wroteSnapshot = false;
        await withCanvasWriteLock(async () => {
          const registry = await readRegistry();
          const docs = await readCanvasDocs();
          const previous = docs[canvasId];
          if (body.graphChanges) {
            const previousAt = Date.parse(String(previous?.updatedAt || ''));
            const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousAt) ? previousAt + 1 : 0)).toISOString();
            const merged = mergeCanvasGraphChanges(
              previous,
              body.graphChanges,
              name,
              body.baselineUpdatedAt,
              updatedAt,
            );
            const unchanged = previous && JSON.stringify({
              name: previous.name,
              nodes: previous.nodes,
              edges: previous.edges,
              viewport: previous.viewport,
              deletedNodeIds: previous.deletedNodeIds,
              deletedEdgeIds: previous.deletedEdgeIds,
            }) === JSON.stringify({
              name: merged.name,
              nodes: merged.nodes,
              edges: merged.edges,
              viewport: merged.viewport,
              deletedNodeIds: merged.deletedNodeIds,
              deletedEdgeIds: merged.deletedEdgeIds,
            });
            if (unchanged) {
              storedDoc = previous;
              storedUpdatedAt = previous.updatedAt || '';
              return;
            }
            docs[canvasId] = merged;
            registry[canvasId] = merged.name;
            await writeRegistry(registry);
            await backupCanvasDocs();
            await atomicWriteJson(CANVAS_DOCS_FILE, docs);
            storedDoc = merged;
            storedUpdatedAt = updatedAt;
            wroteSnapshot = true;
            return;
          }
          registry[canvasId] = name;
          await writeRegistry(registry);
          // 只带 name 的注册请求（registerCanvas）：没有历史文档时直接返回，
          // 绝不用一张空快照把已经在桥上的画布冲掉
          if (!Array.isArray(body.nodes) && !Array.isArray(body.edges) && !previous) return;
          const merged = mergeCanvasSnapshot(
            previous?.nodes,
            Array.isArray(body.nodes) ? body.nodes : (previous?.nodes || []),
            Array.isArray(body.edges) ? body.edges : (previous?.edges || []),
            body.updatedAt,
          );
          // 时间戳由 Bridge 生成，避免不同电脑的时钟和旧标签页时间把新写入挡掉。
          const updatedAt = new Date().toISOString();
          docs[canvasId] = {
            name,
            nodes: merged.nodes,
            edges: merged.edges,
            ...(body.viewport ? { viewport: body.viewport } : {}),
            updatedAt,
          };
          storedDoc = docs[canvasId];
          storedUpdatedAt = docs[canvasId].updatedAt || '';
          wroteSnapshot = true;
          await backupCanvasDocs();
          await atomicWriteJson(CANVAS_DOCS_FILE, docs);
        });
        if (wroteSnapshot && storedUpdatedAt) {
          pushCanvasUpdated({ type: 'canvas-updated', canvasId, updatedAt: storedUpdatedAt, originId: String(body.originId || '') || undefined });
        }
        json(res, 200, {
          code: 0,
          data: storedDoc
            ? { id: canvasId, name: storedDoc.name, updatedAt: storedUpdatedAt }
            : { id: canvasId, name },
          msg: 'ok',
        });
        return;
      }
      if (pathname.startsWith('/api/canvases') && req.method === 'DELETE') {
        const canvasId = pathname.slice('/api/canvases/'.length);
        await withCanvasWriteLock(async () => {
          const registry = await readRegistry();
          const docs = await readCanvasDocs();
          delete registry[canvasId];
          delete docs[canvasId];
          await backupCanvasDocs();
          await atomicWriteJson(CANVAS_DOCS_FILE, docs);
          await writeRegistry(registry);
        });
        // 级联清掉该画布的视频任务：否则轮询器会一直在后台查一个已删除画布的任务
        await removeVideoTasksByCanvas(canvasId);
        json(res, 200, { code: 0, data: { id: canvasId }, msg: 'ok' });
        return;
      }
      if (pathname === '/api/canvases' && req.method === 'GET') {
        const registry = await readRegistry();
        const docs = await readCanvasDocs();
        const ids = new Set([...Object.keys(registry), ...Object.keys(docs)]);
        json(res, 200, {
          code: 0,
          data: [...ids].map((id) => {
            const doc = docs[id];
            return {
              id,
              name: doc?.name || registry[id] || '未命名画布',
              nodes: doc?.nodes || [],
              edges: doc?.edges || [],
              ...(doc?.viewport ? { viewport: doc.viewport } : {}),
              updatedAt: doc?.updatedAt || '',
            };
          }),
          msg: 'ok',
        });
        return;
      }
      if (pathname === '/api/history' && req.method === 'GET') {
        const registry = await readRegistry();
        const docs = await readCanvasDocs();
        json(res, 200, { code: 0, data: collectHistoryItems(docs, registry), msg: 'ok' });
        return;
      }
      if (pathname === '/api/assets' && req.method === 'GET') {
        json(res, 200, { code: 0, data: await listAssets(), msg: 'ok' });
        return;
      }
      if (pathname === '/api/assets/folders' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, unknown>;
        try {
          const folder = await createAssetFolder(String(body.name || ''));
          json(res, 200, { code: 0, data: folder, msg: '已创建文件夹' });
        } catch (error) {
          json(res, 400, { code: 1, data: null, msg: error instanceof Error ? error.message : '创建文件夹失败' });
        }
        return;
      }
      if (pathname.startsWith('/api/assets/folders/') && req.method === 'PATCH') {
        const folderId = decodeURIComponent(pathname.slice('/api/assets/folders/'.length));
        const body = await readBody(req) as Record<string, unknown>;
        try {
          const folder = await renameAssetFolder(folderId, String(body.name || ''));
          json(res, 200, { code: 0, data: folder, msg: '已重命名文件夹' });
        } catch (error) {
          json(res, 400, { code: 1, data: null, msg: error instanceof Error ? error.message : '重命名文件夹失败' });
        }
        return;
      }
      if (pathname.startsWith('/api/assets/folders/') && req.method === 'DELETE') {
        const folderId = decodeURIComponent(pathname.slice('/api/assets/folders/'.length));
        try {
          await deleteAssetFolder(folderId);
          json(res, 200, { code: 0, data: { id: folderId }, msg: '已删除文件夹' });
        } catch (error) {
          json(res, 409, { code: 1, data: null, msg: error instanceof Error ? error.message : '删除文件夹失败' });
        }
        return;
      }
      if (pathname === '/api/assets/items' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, unknown>;
        try {
          const asset = await addAsset({
            folderId: String(body.folderId || ''),
            fileName: String(body.fileName || ''),
            prompt: String(body.prompt || ''),
            model: String(body.model || ''),
            size: String(body.size || ''),
            sourceKey: String(body.sourceKey || ''),
          });
          json(res, 200, { code: 0, data: asset, msg: '已收藏到资产库' });
        } catch (error) {
          json(res, 400, { code: 1, data: null, msg: error instanceof Error ? error.message : '收藏失败' });
        }
        return;
      }
      if (pathname.startsWith('/api/assets/items/') && req.method === 'PATCH') {
        const itemId = decodeURIComponent(pathname.slice('/api/assets/items/'.length));
        const body = await readBody(req) as Record<string, unknown>;
        try {
          const asset = await moveAsset(itemId, String(body.folderId || ''));
          json(res, 200, { code: 0, data: asset, msg: '已移动资产' });
        } catch (error) {
          json(res, 400, { code: 1, data: null, msg: error instanceof Error ? error.message : '移动资产失败' });
        }
        return;
      }
      if (pathname.startsWith('/api/assets/items/') && req.method === 'DELETE') {
        const itemId = decodeURIComponent(pathname.slice('/api/assets/items/'.length));
        try {
          await deleteAsset(itemId);
          json(res, 200, { code: 0, data: { id: itemId }, msg: '已移除资产' });
        } catch (error) {
          json(res, 404, { code: 1, data: null, msg: error instanceof Error ? error.message : '移除资产失败' });
        }
        return;
      }
      if (pathname === '/api/skills' && req.method === 'GET') {
        json(res, 200, { code: 0, data: await listPromptSkills(), msg: 'ok' });
        return;
      }
      if (pathname === '/api/skills' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, unknown>;
        try {
          const skill = await savePromptSkill({
            name: String(body.name || ''),
            description: String(body.description || ''),
            category: String(body.category || ''),
            avatarUrl: String(body.avatarUrl || ''),
            content: String(body.content || ''),
            skills: readRoleSkills(body.skills),
            temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
            enabled: body.enabled !== false,
          });
          json(res, 200, { code: 0, data: skill, msg: '已安装 Skill' });
        } catch (error) {
          json(res, 400, { code: 1, data: null, msg: error instanceof Error ? error.message : '安装 Skill 失败' });
        }
        return;
      }
      if (pathname.startsWith('/api/skills/') && req.method === 'PATCH') {
        const id = decodeURIComponent(pathname.slice('/api/skills/'.length));
        const body = await readBody(req) as Record<string, unknown>;
        try {
          const skill = await savePromptSkill({
            id,
            name: String(body.name || ''),
            description: String(body.description || ''),
            category: String(body.category || ''),
            avatarUrl: String(body.avatarUrl || ''),
            content: String(body.content || ''),
            skills: readRoleSkills(body.skills),
            temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
            enabled: body.enabled !== false,
          });
          json(res, 200, { code: 0, data: skill, msg: '已更新 Skill' });
        } catch (error) {
          json(res, 400, { code: 1, data: null, msg: error instanceof Error ? error.message : '更新 Skill 失败' });
        }
        return;
      }
      if (pathname.startsWith('/api/skills/') && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.slice('/api/skills/'.length));
        const removed = await deletePromptSkill(id);
        json(res, removed ? 200 : 404, { code: removed ? 0 : 1, data: { id }, msg: removed ? '已删除 Skill' : '找不到这个 Skill' });
        return;
      }
      /* ── 对话线程（实体，一张画布多条）──
         浏览器 localStorage 是工作副本，这里是整文档第二拷贝：换浏览器 / 新 profile
         打开链接时对话历史要能续上。写走 chat.ts 的串行链 + 滚动备份 + 单调时间戳，
         与 canvas-docs 同款三条保险。 */
      if (pathname === '/api/chat/threads' && req.method === 'GET') {
        json(res, 200, { code: 0, data: await readChatThreads(), msg: 'ok' });
        return;
      }
      if (pathname === '/api/chat/general-prompt' && req.method === 'GET') {
        json(res, 200, {
          code: 0,
          data: {
            name: '通用模式',
            description: '当前 AI 对话使用的基础系统提示词。',
            content: buildAgentSystemSpec(),
          },
          msg: 'ok',
        });
        return;
      }
      if (pathname === '/api/chat/threads' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, unknown>;
        try {
          const stored = await writeClientThread(body, typeof body.revision === 'number' ? body.revision : undefined);
          if (!stored) { json(res, 409, { code: 1, data: null, msg: '对话已删除或内容不合法' }); return; }
          json(res, 200, { code: 0, data: stored, msg: 'ok' });
        } catch (error) {
          if (!(error instanceof ChatConflictError)) throw error;
          json(res, 409, { code: 1, data: error.thread, msg: error.message });
        }
        return;
      }
      if (pathname.startsWith('/api/chat/threads/') && pathname.endsWith('/memory')) {
        const threadId = pathname.slice('/api/chat/threads/'.length, -'/memory'.length);
        const thread = await readChatThread(threadId);
        if (!thread) { json(res, 404, { code: 1, data: null, msg: '对话不存在' }); return; }
        if (req.method === 'GET') { json(res, 200, { code: 0, data: thread, msg: 'ok' }); return; }
        if (req.method === 'PATCH' || req.method === 'DELETE') {
          const body = req.method === 'PATCH' ? await readBody(req) as Record<string, unknown> : {};
          const expected = Number(body.expectedRevision ?? url.searchParams.get('revision') ?? 0);
          const now = new Date().toISOString();
          const input = req.method === 'DELETE'
            ? { memoryRevision: expected, clearedThroughMessageId: String(thread.messages.at(-1)?.id || ''), summary: '', goal: { updatedAt: now }, visualWorkingSet: { references: [], recentOutputs: [], inheritMode: 'new', explicitNewRequest: true } }
            : { ...((body.memory || {}) as Record<string, unknown>), goal: { ...(((body.memory as Record<string, unknown> | undefined)?.goal || {}) as object), updatedAt: now }, summaryUpdatedAt: now };
          try {
            const updated = await updateChatMemory(threadId, input, expected);
            json(res, updated ? 200 : 404, { code: updated ? 0 : 1, data: updated, msg: updated ? 'ok' : '对话不存在' });
          } catch (error) {
            if (!(error instanceof ChatConflictError)) throw error;
            json(res, 409, { code: 1, data: error.thread, msg: '记忆已更新，请刷新后再修改' });
          }
          return;
        }
      }
      if (pathname.startsWith('/api/chat/threads/') && pathname.endsWith('/clear') && req.method === 'POST') {
        const threadId = pathname.slice('/api/chat/threads/'.length, -'/clear'.length);
        await stopThreadRuns(threadId);
        const body = await readBody(req) as Record<string, unknown>;
        const current = await readChatThread(threadId);
        if (!current) { json(res, 404, { code: 1, data: null, msg: '对话不存在' }); return; }
        try {
          const stored = await clearChatThread(threadId, typeof body.revision === 'number' ? body.revision : Number(current.revision || 0));
          json(res, 200, { code: 0, data: stored, msg: 'ok' });
        } catch (error) {
          if (!(error instanceof ChatConflictError)) throw error;
          json(res, 409, { code: 1, data: error.thread, msg: error.message });
        }
        return;
      }
      if (pathname.startsWith('/api/chat/threads/') && req.method === 'DELETE') {
        const threadId = decodeURIComponent(pathname.slice('/api/chat/threads/'.length));
        if (!threadId) {
          json(res, 400, { code: 1, data: null, msg: '缺少线程 id' });
          return;
        }
        await stopThreadRuns(threadId);
        await deleteChatThread(threadId);
        json(res, 200, { code: 0, data: { id: threadId }, msg: 'ok' });
        return;
      }
      /* ── Agent 运行（方案 §12/§13）──
         起 run → bridge 内部跑「语言模型 ⇄ generate_image」循环，SSE 推事件；
         刷新后凭 runId 重连补发缓冲事件；stop 中断在途请求。 */
      if (pathname === '/api/chat/runs' && req.method === 'POST') {
        const body = await readBody(req) as StartRunRequest;
        if (!body?.threadId || !body?.canvasId || !body?.assistantMessageId || !body?.thread) {
          json(res, 400, { code: 1, data: null, msg: '缺少 threadId / canvasId / thread / assistantMessageId' });
          return;
        }
        try {
          const runId = startChatRun(body);
          await waitChatRunReady(runId);
          json(res, 200, { code: 0, data: { runId }, msg: 'ok' });
        } catch (err) {
          json(res, 409, { code: 1, data: err instanceof ChatConflictError ? err.thread : null, msg: err instanceof Error ? err.message : '该对话已有在途任务' });
        }
        return;
      }
      if (/^\/api\/chat\/runs\/[^/]+$/.test(pathname) && req.method === 'GET') {
        const runId = pathname.slice('/api/chat/runs/'.length);
        const snapshot = getChatRunSnapshot(runId);
        json(res, snapshot ? 200 : 404, { code: snapshot ? 0 : 1, data: snapshot, msg: snapshot ? 'ok' : 'run 不存在' });
        return;
      }
      if (pathname.startsWith('/api/chat/runs/') && pathname.endsWith('/confirm') && req.method === 'POST') {
        const runId = pathname.slice('/api/chat/runs/'.length, -'/confirm'.length);
        const body = await readBody(req) as Record<string, unknown>;
        const accepted = confirmChatRun(runId, String(body.callId || ''), body.approved === true);
        json(res, accepted ? 200 : 409, { code: accepted ? 0 : 1, data: { accepted }, msg: accepted ? 'ok' : '确认已过期' });
        return;
      }
      if (pathname.startsWith('/api/chat/runs/') && pathname.endsWith('/events') && req.method === 'GET') {
        const runId = decodeURIComponent(pathname.slice('/api/chat/runs/'.length, pathname.length - '/events'.length));
        if (!subscribeChatRun(runId, res)) {
          json(res, 404, { code: 1, data: null, msg: 'run 不存在或已结束（bridge 可能已重启）' });
        }
        return;
      }
      if (pathname.startsWith('/api/chat/runs/') && pathname.endsWith('/stop') && req.method === 'POST') {
        const runId = decodeURIComponent(pathname.slice('/api/chat/runs/'.length, pathname.length - '/stop'.length));
        const stopped = await stopChatRun(runId);
        json(res, stopped ? 200 : 404, { code: stopped ? 0 : 1, data: { stopped }, msg: stopped ? 'ok' : 'run 不存在或已结束' });
        return;
      }
      if (pathname.startsWith('/api/chat/runs/') && pathname.endsWith('/answer') && req.method === 'POST') {
        const runId = decodeURIComponent(pathname.slice('/api/chat/runs/'.length, pathname.length - '/answer'.length));
        const body = await readBody(req) as {
          callId?: string;
          answers?: Record<string, unknown>;
          cancel?: boolean;
          userMessage?: Record<string, unknown>;
          assistantMessage?: Record<string, unknown>;
        };
        const answered = await answerChatRun(runId, String(body.callId || ''), body);
        json(res, answered ? 200 : 409, { code: answered ? 0 : 1, data: { answered }, msg: answered ? 'ok' : '问题已过期或答案不完整' });
        return;
      }
      if (pathname.startsWith('/api/files/') && req.method === 'GET') {
        await serveMediaFile(req, res, pathname.slice('/api/files/'.length));
        return;
      }
      if (pathname === '/api/files/delete-if-unused' && req.method === 'POST') {
        const body = await readBody(req) as { fileName?: string };
        const fileName = String(body.fileName || '').trim();
        if (!fileName) {
          json(res, 400, { code: 1, data: null, msg: '缺少文件名' });
          return;
        }
        if (await mediaFileIsReferenced(fileName)) {
          json(res, 200, { code: 0, data: { deleted: false }, msg: '文件仍被引用，保留' });
          return;
        }
        const deleted = await deleteMediaFile(fileName);
        json(res, 200, { code: 0, data: { deleted }, msg: deleted ? 'ok' : '文件不存在' });
        return;
      }
      if (pathname.startsWith('/api/files/') && req.method === 'DELETE') {
        await deleteMediaFile(pathname.slice('/api/files/'.length));
        json(res, 200, { code: 0, data: null, msg: 'ok' });
        return;
      }
      if (pathname === '/api/files' && req.method === 'POST') {
        // 标注合成图等本地位图落盘：进来一个 dataURL，出去一个 /api/files 引用
        const body = await readBody(req) as { dataUrl?: string };
        const dataUrl = String(body.dataUrl || '').trim();
        if (!dataUrl) {
          json(res, 400, { code: 1, data: null, msg: '缺少 dataUrl' });
          return;
        }
        try {
          const saved = await saveDataUrl(dataUrl);
          json(res, 200, { code: 0, data: { url: saved.url, fileName: saved.fileName }, msg: 'ok' });
        } catch (err) {
          json(res, 400, { code: 1, data: null, msg: err instanceof Error ? err.message : '图片保存失败' });
        }
        return;
      }
      if (pathname === '/api/files/copy' && req.method === 'POST') {
        // 复制一份媒体文件（粘贴节点给副本用）：同文件被两个节点引用时，删谁都会把图弄没
        const body = await readBody(req) as { fileName?: string };
        try {
          const saved = await copyMediaFile(String(body.fileName || ''));
          if (!saved) {
            json(res, 400, { code: 1, data: null, msg: '非法的文件名' });
            return;
          }
          json(res, 200, { code: 0, data: { url: saved.url, fileName: saved.fileName }, msg: 'ok' });
        } catch (err) {
          json(res, 400, { code: 1, data: null, msg: err instanceof Error ? err.message : '图片复制失败' });
        }
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/')) {
        const file = await readStaticFile(pathname === '/' ? '/index.html' : pathname);
        if (file) {
          res.writeHead(200, { 'Content-Type': file.type });
          res.end(req.method === 'HEAD' ? undefined : file.data);
          return;
        }
        await serveSpa(res);
        return;
      }
      json(res, 404, { code: 1, data: null, msg: 'not found' });
    } catch (err) {
      json(res, 500, { code: 1, data: null, msg: err instanceof Error ? err.message : '服务器错误' });
    }
  });
}

export function listenHttpServer(): Promise<boolean> {
  const server = createHttpServer();
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // 已有实例在跑（浏览器页或另一个 MCP 进程）：复用现状，MCP 侧仍可工作。
        // 返回 false = 本进程不拥有端口，视频轮询不该在这里跑（否则同一个任务被查两遍）。
        console.error(`[huiban] 端口 ${PORT} 已被占用，HTTP/SSE 复用已有实例`);
        resolve(false);
      } else {
        console.error(`[huiban] HTTP 服务启动失败：${err.message}`);
        resolve(false);
      }
    });
    server.listen(PORT, HOST, () => {
      console.error(`[huiban] HTTP 服务 listening on http://${HOST}:${PORT}`);
      resolve(true);
    });
  });
}
