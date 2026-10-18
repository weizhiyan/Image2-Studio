import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CANVASES_FILE, CANVAS_DOCS_FILE, CHAT_DOCS_FILE, HOST, MEDIA_DIR, PORT, STATIC_DIR } from './paths.js';
import { createProfile, findProfile, normalizeEnhanceLevel, publicView, readSettings, resolveTextProfile, writeSettings, type ModelProfile } from './settings.js';
import { addManualPreference, clearPreferences, distillPreferences, removePreference, setPreferencesEnabled } from './preferences.js';
import { generateImages, normalizeImageSize } from './imageApi.js';
import { detectReferenceUsage, directStyleNote, enhancePromptDetailed, fidelityForUsage, testTextProfile, usageForGenerateRequest } from './textApi.js';
import { fetchProviderModels, fetchRemoteImage, testProviderConnection } from './providerApi.js';
import { addSseClient, pushCanvasUpdated, pushImage } from './hub.js';
import { deleteChatThread, putChatThread, readChatThreads } from './chat.js';
import { answerChatRun, startChatRun, stopChatRun, subscribeChatRun, type StartRunRequest } from './runs.js';
import { contentTypeOf, copyMediaFile, deleteMediaFile, imageExtensionOf, revealLocalFile, saveDataUrl } from './files.js';

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

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
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

async function serveMediaFile(res: http.ServerResponse, fileName: string): Promise<void> {
  if (!/^[\w.-]+$/.test(fileName)) {
    json(res, 400, { code: 1, data: null, msg: '非法文件名' });
    return;
  }
  const data = await fs.readFile(path.join(MEDIA_DIR, fileName)).catch(() => null);
  if (!data) {
    json(res, 404, { code: 1, data: null, msg: '文件不存在' });
    return;
  }
  const contentType = contentTypeOf(fileName) === 'application/octet-stream'
    ? `image/${imageExtensionOf(data, path.extname(fileName).slice(1))}`
    : contentTypeOf(fileName);
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(data);
}

async function readRegistry(): Promise<CanvasRegistry> {
  try {
    return JSON.parse(await fs.readFile(CANVASES_FILE, 'utf8')) as CanvasRegistry;
  } catch {
    return {};
  }
}

async function writeRegistry(registry: CanvasRegistry): Promise<void> {
  await fs.writeFile(CANVASES_FILE, JSON.stringify(registry, null, 2), 'utf8');
}

async function readCanvasDocs(): Promise<Record<string, CanvasDocRecord>> {
  try {
    const parsed = JSON.parse(await fs.readFile(CANVAS_DOCS_FILE, 'utf8')) as Record<string, CanvasDocRecord>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
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

/** MCP 追加图片节点（外部写入）。注册表和文档都没有这个 id 时拒绝——
   防把提示词里拼错的 canvasId 写成一张幽灵画布。
   幂等：已存在的节点 id 跳过——对话 agent 的节点 id 由 runId+callId 确定性生成，
   重复事件（SSE 重连补发 / 客户端重试）不会追加出重复节点。 */
export async function appendCanvasImageNodes(canvasId: string, nodes: CanvasNodeRecord[]): Promise<boolean> {
  if (nodes.length === 0) return false;
  return withCanvasWriteLock(async () => {
    const registry = await readRegistry();
    const docs = await readCanvasDocs();
    const previous = docs[canvasId];
    if (!previous && !registry[canvasId]) return false;
    const existingIds = new Set((previous?.nodes || []).map((node) => String((node as { id?: string })?.id || '')));
    const fresh = nodes.filter((node) => !existingIds.has(String(node.id || '')));
    if (fresh.length === 0) return true;
    docs[canvasId] = {
      name: registry[canvasId] || previous?.name || '未命名画布',
      nodes: [...(previous?.nodes || []), ...fresh],
      edges: previous?.edges || [],
      ...(previous?.viewport ? { viewport: previous.viewport } : {}),
      updatedAt: new Date().toISOString(),
    };
    await backupCanvasDocs();
    await fs.writeFile(CANVAS_DOCS_FILE, JSON.stringify(docs, null, 2), 'utf8');
    return true;
  });
}

/** MCP 建画布：注册表与空文档一次到位；已存在时幂等返回原有名字，不覆盖内容。 */
export async function createCanvasInRegistry(canvasId: string, name: string): Promise<{ id: string; name: string }> {
  const finalName = String(name || '').trim() || '新画布';
  return withCanvasWriteLock(async () => {
    const registry = await readRegistry();
    const existed = registry[canvasId];
    if (existed) return { id: canvasId, name: existed };
    registry[canvasId] = finalName;
    await writeRegistry(registry);
    const docs = await readCanvasDocs();
    if (!docs[canvasId]) {
      docs[canvasId] = { name: finalName, nodes: [], edges: [], updatedAt: new Date().toISOString() };
      await backupCanvasDocs();
      await fs.writeFile(CANVAS_DOCS_FILE, JSON.stringify(docs, null, 2), 'utf8');
    }
    return { id: canvasId, name: finalName };
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

function mergeCanvasSnapshot(
  previousNodes: unknown[] | undefined,
  incomingNodes: unknown[],
  previousEdges: unknown[] | undefined,
  incomingEdges: unknown[],
): { nodes: unknown[]; edges: unknown[] } {
  const nodes = new Map<string, unknown>();
  for (const node of previousNodes || []) nodes.set(String((node as { id?: unknown })?.id || ''), node);
  for (const node of incomingNodes) nodes.set(String((node as { id?: unknown })?.id || ''), node);
  const edges = new Map<string, unknown>();
  const edgeKey = (edge: unknown) => {
    const item = edge as { id?: unknown; source?: unknown; target?: unknown };
    return String(item.id || `${item.source || ''}->${item.target || ''}`);
  };
  for (const edge of previousEdges || []) edges.set(edgeKey(edge), edge);
  for (const edge of incomingEdges) edges.set(edgeKey(edge), edge);
  return {
    nodes: [...nodes.values()].filter((node) => String((node as { id?: unknown })?.id || '')),
    edges: [...edges.values()],
  };
}

export function createHttpServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
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
            kind: draft.kind === 'text' ? 'text' : 'image',
            textFormat: (draft.textFormat === 'chat' || draft.textFormat === 'responses') ? draft.textFormat : 'auto',
            imageApiMode: draft.imageApiMode === 'responses' ? 'responses' : 'images',
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
          profiles: drafts,
          activeProfileId: Array.isArray(body.profiles) ? String(body.activeProfileId || '') : current.activeProfileId,
          direct: typeof body.direct === 'boolean' ? body.direct : undefined,
          promptOptimizationEnabled: typeof body.promptOptimizationEnabled === 'boolean' ? body.promptOptimizationEnabled : undefined,
          textProfileId: typeof body.textProfileId === 'string' ? body.textProfileId : undefined,
          enhanceLevel: typeof body.enhanceLevel === 'string' ? normalizeEnhanceLevel(body.enhanceLevel) : undefined,
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
        const kind = String(body.kind || '') === 'text' || saved?.kind === 'text' ? 'text' : 'image';
        try {
          const message = kind === 'text'
            ? await testTextProfile({ ...(saved || createProfile('测试配置', 'text')), baseUrl, apiKey, model })
            : await testProviderConnection({ baseUrl, apiKey, model });
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
            // 参考图用法自动预判：规则判「改这张图」才走 edit，其余一律 style（零用户操作）；
            // 前端将来若传显式选择，以 body.usage 为准
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
        const body = await readBody(req) as { name?: string; nodes?: unknown[]; edges?: unknown[]; viewport?: { x: number; y: number; zoom: number }; updatedAt?: string; originId?: string };
        const registry = await readRegistry();
        const name = String(body.name || '未命名画布');
        registry[canvasId] = name;
        await writeRegistry(registry);
        let storedUpdatedAt = '';
        let wroteSnapshot = false;
        await withCanvasWriteLock(async () => {
          const docs = await readCanvasDocs();
          const previous = docs[canvasId];
          // 只带 name 的注册请求（registerCanvas）：没有历史文档时直接返回，
          // 绝不用一张空快照把已经在桥上的画布冲掉
          if (!Array.isArray(body.nodes) && !Array.isArray(body.edges) && !previous) return;
          const merged = mergeCanvasSnapshot(
            previous?.nodes,
            Array.isArray(body.nodes) ? body.nodes : (previous?.nodes || []),
            previous?.edges,
            Array.isArray(body.edges) ? body.edges : (previous?.edges || []),
          );
          // 时间戳由 Bridge 生成，避免不同电脑的时钟和旧标签页时间把新写入挡掉。
          const updatedAt = new Date().toISOString();
          docs[canvasId] = {
            name,
            nodes: keepExternalNodesOnSnapshot(previous?.nodes, merged.nodes, updatedAt),
            edges: merged.edges,
            ...(body.viewport ? { viewport: body.viewport } : {}),
            updatedAt,
          };
          storedUpdatedAt = docs[canvasId].updatedAt || '';
          wroteSnapshot = true;
          await backupCanvasDocs();
          await fs.writeFile(CANVAS_DOCS_FILE, JSON.stringify(docs, null, 2), 'utf8');
        });
        if (wroteSnapshot && storedUpdatedAt) {
          pushCanvasUpdated({ type: 'canvas-updated', canvasId, updatedAt: storedUpdatedAt, originId: String(body.originId || '') || undefined });
        }
        json(res, 200, { code: 0, data: { id: canvasId, name }, msg: 'ok' });
        return;
      }
      if (pathname.startsWith('/api/canvases') && req.method === 'DELETE') {
        const canvasId = pathname.slice('/api/canvases/'.length);
        const registry = await readRegistry();
        delete registry[canvasId];
        await writeRegistry(registry);
        await withCanvasWriteLock(async () => {
          const docs = await readCanvasDocs();
          delete docs[canvasId];
          await backupCanvasDocs();
          await fs.writeFile(CANVAS_DOCS_FILE, JSON.stringify(docs, null, 2), 'utf8');
        });
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
        // 生成历史：把全部画布的图片节点汇成一张时间线（新的在前），
        // Codex 推来的图与浏览器生成的图都算，点击可在灯箱里回看。
        const registry = await readRegistry();
        const docs = await readCanvasDocs();
        const ids = new Set([...Object.keys(registry), ...Object.keys(docs)]);
        const items: Array<Record<string, unknown>> = [];
        for (const id of ids) {
          const doc = docs[id];
          if (!doc || !Array.isArray(doc.nodes)) continue;
          for (const node of doc.nodes) {
            const data = (node as { data?: Record<string, unknown> })?.data || {};
            const nodeId = String((node as { id?: unknown })?.id || '');
            const storedVersions = Array.isArray(data.versions) ? data.versions as Array<Record<string, unknown>> : [];
            const base = {
              canvasId: id,
              canvasName: doc.name || registry[id] || '未命名画布',
              source: String(data.source || 'browser'),
              nodeId,
            };
            if (storedVersions.length > 0) {
              // 版本链节点：每一版都上榜，序号 + 基数 + 基准版本一起丢出去，
              // 历史面板才能写清“这张是第几版、由哪一版二次编辑来”
              storedVersions.forEach((item, index) => {
                const url = String(item.imageUrl || '').trim();
                if (!url) return;
                items.push({
                  ...base,
                  url,
                  prompt: String(item.prompt || ''),
                  enhancedPrompt: String(item.enhancedPrompt || ''),
                  revisedPrompt: String(item.revisedPrompt || ''),
                  model: String(item.model || ''),
                  size: String(item.size || ''),
                  fileName: String(item.fileName || ''),
                  createdAt: String(item.finishedAt || item.createdAt || ''),
                  versionId: String(item.id || ''),
                  versionIndex: index + 1,
                  versionCount: storedVersions.length,
                  baseVersionId: String(item.baseVersionId || ''),
                });
              });
              continue;
            }
            const url = String(data.imageUrl || '').trim();
            if (!url || data.kind !== 'image') continue;
            items.push({
              ...base,
              url,
              prompt: String(data.prompt || ''),
              enhancedPrompt: String(data.enhancedPrompt || ''),
              revisedPrompt: String(data.revisedPrompt || ''),
              model: String(data.model || ''),
              size: String(data.size || ''),
              fileName: String(data.fileName || ''),
              createdAt: String(data.finishedAt || data.createdAt || ''),
            });
          }
        }
        items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        json(res, 200, { code: 0, data: items.slice(0, 300), msg: 'ok' });
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
      if (pathname === '/api/chat/threads' && req.method === 'POST') {
        const body = await readBody(req) as Record<string, unknown>;
        const stored = await putChatThread(body);
        if (!stored) {
          json(res, 400, { code: 1, data: null, msg: '对话内容不合法' });
          return;
        }
        json(res, 200, { code: 0, data: stored, msg: 'ok' });
        return;
      }
      if (pathname.startsWith('/api/chat/threads/') && req.method === 'DELETE') {
        const threadId = decodeURIComponent(pathname.slice('/api/chat/threads/'.length));
        if (!threadId) {
          json(res, 400, { code: 1, data: null, msg: '缺少线程 id' });
          return;
        }
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
        const runId = startChatRun(body);
        json(res, 200, { code: 0, data: { runId }, msg: 'ok' });
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
        const stopped = stopChatRun(runId);
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
        const answered = answerChatRun(runId, String(body.callId || ''), body);
        json(res, answered ? 200 : 409, { code: answered ? 0 : 1, data: { answered }, msg: answered ? 'ok' : '问题已过期或答案不完整' });
        return;
      }
      if (pathname.startsWith('/api/files/') && req.method === 'GET') {
        await serveMediaFile(res, pathname.slice('/api/files/'.length));
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

export function listenHttpServer(): Promise<void> {
  const server = createHttpServer();
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // 已有实例在跑（浏览器页或另一个 MCP 进程）：复用现状，MCP 侧仍可工作
        console.error(`[huiban] 端口 ${PORT} 已被占用，HTTP/SSE 复用已有实例`);
      } else {
        console.error(`[huiban] HTTP 服务启动失败：${err.message}`);
      }
      resolve();
    });
    server.listen(PORT, HOST, () => {
      console.error(`[huiban] HTTP 服务 listening on http://${HOST}:${PORT}`);
      resolve();
    });
  });
}
