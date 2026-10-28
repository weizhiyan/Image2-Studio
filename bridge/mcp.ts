import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { findProfile, normalizeEnhanceLevel, publicView, readSettings, resolveTextProfile } from './settings.js';
import { generateImages, normalizeImageSize } from './imageApi.js';
import {
  buildSystemSpec,
  detectReferenceUsage,
  directStyleNote,
  enhancePromptDetailed,
  fidelityForUsage,
  LEVEL_SPECS,
} from './textApi.js';
import { countOpenTabs, pushImage, pushLocate } from './hub.js';
import { fetchRemoteImage } from './providerApi.js';
import { mediaFileToDataUrl } from './files.js';
import { clearAgentPresence, markAgentPresence } from './agentPresence.js';
import {
  appendCanvasImageNodes,
  createCanvasInRegistry,
  patchCanvasVideoNode,
  readCanvasDoc,
  readCanvasRegistry,
} from './http.js';
import type { CanvasNodeRecord, CanvasDocRecord } from './http.js';
import { listEnabledPromptSkills, type PromptSkill } from './skills.js';
import { PORT } from './paths.js';
import { findVideoTaskByNode } from './videoTasks.js';

/* ── 工具说明(Agent 面向的导览) ── */
const TOOL_GUIDE = [
  '- `huiban_generate`:生成图片。指定 canvasId 时结果直接落该画布(节点带 source=mcp),用户在浏览器里立即可见;浏览器没开也会先写进画布文档,下次打开就在。',
  '- `huiban_canvases`:列出已注册画布(id / 名称 / 节点数 / 更新时间);生成前先调用它拿 canvasId。',
  '- `huiban_canvas_create`:新建画布({ name }),返回 canvasId。用户说”新建画布”而不想离开对话时用它。',
  '- `huiban_nodes`:列出某画布上的节点(含 imageUrl / fileName),想拿画布里已有的图当参考图时先用它。',
  '- `huiban_locate`:把用户的浏览器带到某个节点跟前(跨画布也会先切过去再居中)。huiban_generate 默认已自动定位;这个工具用于「再定位一次」「看早先那张」,或上次用了 locate:false 时补上。',
  '- `huiban_models`:列出每路生图配置的模型清单与默认模型;多 Key / 多中转站时配合 profileId 切换。',
  '- `huiban_config`:查看生图配置状态(不返回 Key)。',
  '- `huiban_prompt_guide`:读绘板的「生图提示词规范」——描述结构、忠实性红线、参考图用法、整理强度三档,与界面提示词优化链路同一套规则。agent 想自己构思提示词时先读它。',
  '- `huiban_video_prompt_guide`:读绘板的「视频生成提示词规范」——镜头运动、场景叙事、节奏控制、参考图用法。生成视频时先读它。',
  '- `huiban_video_generate`:将提示词提交给指定画布上已有的视频节点；提交会产生服务商费用，只能在用户明确要求生成时调用。',
  '- `huiban_video_task`:查询已提交视频任务的状态与本机结果地址。',
  '- `huiban_optimize`:显式调用语言模型优化提示词(优先使用「生图设置」里选中的语言模型),返回优化后的 prompt 与参考图用途判断;只花语言模型额度,不烧生图。画布的自动优化开关不控制此工具。',
  '- `huiban_prompt_guide`:同时返回绘板内启用的 Skills；外部 Agent 调用此工具即可读取并应用这些提示词技能。',
  '',
  '建议流程:huiban_canvases → 选画布 → huiban_generate{prompt, canvasId}。出图默认自动定位到新节点(节点已在视口内则不挪镜头)——用户手动在页面上生成时没有这个效果,所以只要是你生成的图,就别把定位关掉;真传了 locate:false,必须马上用 huiban_locate{canvasId, nodeId} 补上。',
  '提示词三步:huiban_prompt_guide 读规范 →(可选)huiban_optimize 让服务端优化 → huiban_generate 出图。',
  '带参考图:huiban_generate{prompt, referenceImages:[“/api/files/x.png”], inputFidelity:”high”}(图生图);inputFidelity:”low” 是风格参考。',
  'referenceImages 支持三种:画布媒体路径 /api/files/xxx.png、http(s) 图片链接(bridge 会代取落地)、data:image base64。',
].join('\n');

/** 比例档位 → 生图尺寸。与前端工具栏的 RATIO_PRESETS 对齐，数值最终仍过 normalizeImageSize 规范化。 */
const RATIO_TO_SIZE: Record<string, string> = {
  'auto': '',
  '1:1': '1024x1024',
  '16:9': '1344x768',
  '9:16': '768x1344',
  '3:4': '960x1280',
  '4:3': '1280x960',
  '3:2': '1248x832',
  '2:3': '832x1248',
  '21:9': '1536x656',
};

const QUALITY_VALUES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/* ── 依赖注入：协议壳与业务逻辑分离，业务逻辑可在 vitest 里用假依赖驱动 ── */
export interface McpDeps {
  readSettings: typeof readSettings;
  readCanvasRegistry: typeof readCanvasRegistry;
  readCanvasDoc: typeof readCanvasDoc;
  enhancePrompt: typeof enhancePromptDetailed;
  generateImages: typeof generateImages;
  pushImage: typeof pushImage;
  pushLocate: typeof pushLocate;
  appendCanvasImageNodes: typeof appendCanvasImageNodes;
  countOpenTabs: () => number;
  createCanvas: (canvasId: string, name: string) => Promise<{ id: string; name: string }>;
  resolveReferenceDataUrls: (inputs: string[]) => Promise<Array<{ dataUrl: string; url: string }>>;
  listPromptSkills?: () => Promise<PromptSkill[]>;
  patchVideoNode?: typeof patchCanvasVideoNode;
}

/** 参考图归一化：本地媒体 / 网络链接 / dataURL 三种入口，输出「喂接口的 dataURL + 节点上展示的 url」。 */
export async function resolveReferenceDataUrls(inputs: string[]): Promise<Array<{ dataUrl: string; url: string }>> {
  const out: Array<{ dataUrl: string; url: string }> = [];
  for (const raw of inputs) {
    const value = String(raw || '').trim();
    if (!value) continue;
    if (value.startsWith('data:image/')) {
      out.push({ dataUrl: value, url: '' });
      continue;
    }
    if (value.startsWith('/api/files/')) {
      const dataUrl = await mediaFileToDataUrl(value.slice('/api/files/'.length));
      if (!dataUrl) throw new Error(`参考图文件不存在：${value}`);
      out.push({ dataUrl, url: value });
      continue;
    }
    if (/^https?:\/\//i.test(value)) {
      const file = await fetchRemoteImage(value);
      const dataUrl = await mediaFileToDataUrl(file.fileName);
      if (!dataUrl) throw new Error(`参考图下载后读取失败：${value}`);
      out.push({ dataUrl, url: file.url });
      continue;
    }
    throw new Error(`参考图格式不支持：${value}（支持 /api/files/xxx.png、http(s) 链接、data:image base64）`);
  }
  return out;
}

function toolText(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : (typeof value === 'string' && value.trim() ? [value.trim()] : []);
}

export function listMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'huiban_generate',
      description: '生成图片并落入绘板画布。指定 canvasId 时图片直接成为该画布上的节点（浏览器在线即时可见；没开浏览器也会先写进画布文档）。可带参考图做图生图 / 风格参考。出图后默认自动把用户的浏览器定位到新节点——这是定位效果唯一会出现的路径（用户在页面上手动生成不会动镜头）。若传 locate:false，你必须接着调 huiban_locate{canvasId, nodeId} 把结果呈现给用户，否则用户看不到这次生成了什么。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          prompt: { type: 'string', description: '生图提示词：主体、构图、风格、材质、光线写清楚' },
          size: { type: 'string', description: '尺寸，如 1024x1024 / 1024x1536 / 1536x1024；与 ratio 二选一，都不传用配置里的默认尺寸' },
          ratio: { type: 'string', enum: ['auto', '21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'], description: '按比例出图（比 size 更好记的口径）；传 auto 表示跟随配置默认' },
          n: { type: 'number', description: '一次生成几张（1~8，默认 1）。多张时每张在画布上各成一个节点' },
          referenceImages: {
            type: 'array',
            items: { type: 'string' },
            description: '参考图（图生图 / 风格参考）：/api/files/xxx.png、http(s) 图片链接、data:image base64；可用 huiban_nodes 先找画布里已有的图',
          },
          referenceUsage: { type: 'string', enum: ['edit', 'style'], description: '参考图用途：edit=图生图（严格保主体，等价 inputFidelity:high）；style=风格参考（放开束缚，等价 inputFidelity:low）' },
          inputFidelity: { type: 'string', enum: ['high', 'low'], description: 'GPT-image 参考图保真度，仅带参考图时生效：high=保留参考图细节，low=自由发挥' },
          quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], description: '图像质量档位（可选），与尺寸独立' },
          model: { type: 'string', description: '指定模型名（可选）。不传用当前生效配置里的默认模型' },
          profileId: { type: 'string', description: '指定哪一路生图配置（可选，来自 huiban_models 的 id）。多 Key / 多中转站时用它切换' },
          canvasId: { type: 'string', description: '目标画布 id（来自 huiban_canvases / huiban_canvas_create）。不传则只返回图片，不落画布' },
          label: { type: 'string', description: '画布上节点标题，默认「Codex 生成」' },
          locate: { type: 'boolean', description: '出图后是否把用户的浏览器定位到新节点（默认 true，建议保持）。节点已在视口内时不会挪镜头；传 false 则本次完全不碰用户视口——但之后必须自己调 huiban_locate 补上，别让用户找不到图' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'huiban_canvases',
      description: '列出绘板里已注册的画布（id / 名称 / 节点数 / 更新时间），供 huiban_generate 指定落点。',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'huiban_canvas_create',
      description: '新建一张画布并返回 canvasId（幂等保护：不会覆盖已存在的画布）。用户说“新建画布 / 画到一张新画布上”时用。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: '画布名称，缺省「新画布」' },
        },
      },
    },
    {
      name: 'huiban_nodes',
      description: '列出某画布上的节点（id / 类型 / 提示词 / 图片地址），用于找画布里已有的图当参考图、或确认生成结果落点。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          canvasId: { type: 'string', description: '目标画布 id（来自 huiban_canvases）' },
          kind: { type: 'string', enum: ['image', 'reference', 'composer'], description: '只列某类节点，缺省列全部' },
          limit: { type: 'number', description: '最多返回几条，默认 50，最大 200' },
        },
        required: ['canvasId'],
      },
    },
    {
      name: 'huiban_locate',
      description: '把用户的浏览器定位到指定节点（视口居中 + 轻高亮）。浏览器停在别的画布时会先切到目标画布再定位。huiban_generate 出图时默认已自动定位一次；本工具用于再次定位（用户滚动走了、想看早先那张），或上一次生成传了 locate:false 时补上——用了 locate:false 就别忘记调它。nodeId 可省略，此时定位该画布最新加入的节点。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          canvasId: { type: 'string', description: '目标画布 id（来自 huiban_canvases）' },
          nodeId: { type: 'string', description: '要定位的节点 id（huiban_generate / huiban_nodes 的返回值里带）；省略则定位该画布最新的节点' },
        },
        required: ['canvasId'],
      },
    },
    {
      name: 'huiban_models',
      description: '列出每路生图配置（id / 名称 / 默认模型 / 候选模型 / 是否默认那路）。模型清单与界面「生图设置」一致。',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'huiban_config',
      description: '查看当前生图配置状态（Base URL / 模型 / 默认尺寸 / Key 是否已配置），不返回 Key。',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'huiban_prompt_guide',
      description: '返回绘板的「生图提示词规范」——提示词优化链路用的同一套规则：描述结构（主体/场景/构图/光线/色彩/媒介/质感）、忠实性红线、参考图用法、整理强度三档（高遵循/均衡/创意）。agent 要自己构思或改写生图提示词时先读它，再调 huiban_generate。不联网、不写数据。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          size: { type: 'string', description: '目标尺寸（如 1024x1024 / 1024x1536），规范里会附带该画幅的构图建议；不传用生图配置的默认尺寸' },
          level: { type: 'string', enum: ['strict', 'balanced', 'creative'], description: '整理强度档位：strict=高遵循 / balanced=均衡 / creative=创意；不传用「生图设置」里的当前档位' },
        },
      },
    },
    {
      name: 'huiban_video_prompt_guide',
      description: '返回绘板的「视频生成提示词规范」——镜头运动、场景叙事、节奏控制、参考图用法。agent 要生成视频时先读它,再调视频生成工具。不联网、不写数据。',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'huiban_optimize',
      description: '用绘板「生图设置」里启用的那一路语言模型，按绘板同一套提示词规范优化 prompt（等价界面里的「提示词优化」）。返回优化后的 prompt、参考图用途（style/edit）与用途判定依据。只花语言模型额度，不烧生图、不写任何数据。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          prompt: { type: 'string', description: '用户原始描述，一句话也行，可中文' },
          size: { type: 'string', description: '目标尺寸，让改写适配画幅；不传用生图配置的默认尺寸' },
          referenceImages: {
            type: 'array',
            items: { type: 'string' },
            description: '参考图（图生图 / 风格参考）：/api/files/xxx.png、http(s) 图片链接、data:image base64；多张按数组顺序编号',
          },
          usage: { type: 'string', enum: ['edit', 'style'], description: '参考图用途；不传按措辞自动判断（"改这张图"→edit，其余→style）' },
          level: { type: 'string', enum: ['strict', 'balanced', 'creative'], description: '整理强度；不传用「生图设置」里的当前档位' },
          profileId: { type: 'string', description: '指定哪一路语言模型（可选，来自 huiban_models）；不传用启用的那一路或第一路语言模型' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'huiban_video_generate',
      description: '将视频提示词提交到绘板画布上已有的视频生成节点。每次调用可能产生服务商费用；仅当用户明确要求生成视频时调用。生成前先用 huiban_canvases / huiban_nodes 找到目标视频节点，并读取 huiban_video_prompt_guide。提交断线时先用 huiban_video_task 核查，禁止盲目重提。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          canvasId: { type: 'string', description: '目标画布 id，来自 huiban_canvases' },
          nodeId: { type: 'string', description: '画布上已有的视频节点 id，来自 huiban_nodes' },
          prompt: { type: 'string', description: '视频脚本 / 提示词，写清主体动作、场景和镜头运动' },
          profileId: { type: 'string', description: '视频模型配置 id，可选；缺省使用当前可用配置' },
          model: { type: 'string', description: '视频模型名，可选；缺省使用配置默认模型' },
          seconds: { type: 'number', description: '视频时长秒数，默认 5' },
          resolution: { type: 'string', enum: ['480p', '720p', '1080p'], description: '清晰度档位' },
          ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], description: '视频画幅' },
          generateAudio: { type: 'boolean', description: '是否生成声音' },
          referenceMode: { type: 'string', enum: ['first_frame', 'last_frame', 'style'], description: '参考图用途' },
          imageFileNames: { type: 'array', items: { type: 'string' }, description: '本机已保存的图片文件名，可由 huiban_nodes 返回的 fileName 提供' },
          imageUrls: { type: 'array', items: { type: 'string' }, description: '公网 HTTPS 图片 URL' },
          imageParamName: { type: 'string', description: '模型 schema 声明的图片参数名，可选' },
          params: { type: 'object', description: '媒体协议模型 schema 的额外参数，可选' },
        },
        required: ['canvasId', 'nodeId', 'prompt'],
      },
    },
    {
      name: 'huiban_video_task',
      description: '查询 huiban_video_generate 返回的视频任务状态。提交结果未知时先调用它核查，避免重复生成扣费。',
      inputSchema: {
        type: 'object' as const,
        properties: { taskId: { type: 'string', description: '视频任务 id' } },
        required: ['taskId'],
      },
    },
  ];
}

export async function callMcpTool(
  name: string,
  rawArgs: Record<string, unknown>,
  deps: McpDeps,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const args = rawArgs || {};

  if (name === 'huiban_video_generate') {
    const canvasId = pickString(args.canvasId);
    const nodeId = pickString(args.nodeId);
    const prompt = pickString(args.prompt);
    if (!canvasId || !nodeId || !prompt) throw new Error('必须提供 canvasId、nodeId 和 prompt');
    const doc = await deps.readCanvasDoc(canvasId);
    const node = doc?.nodes?.find((item) => (item as CanvasNodeRecord).id === nodeId) as CanvasNodeRecord | undefined;
    if (!node || node.data.kind !== 'video') throw new Error('指定节点不是该画布上的视频节点；请先用 huiban_nodes 确认节点 id');
    const activeTask = await findVideoTaskByNode(nodeId);
    if (activeTask?.submissionUnknown) {
      return toolText({
        ok: false,
        submissionUnknown: true,
        error: activeTask.error || '这个节点的上一次提交结果未知。先到服务商后台核查任务，再决定是否重新提交。',
      });
    }
    if (activeTask && (activeTask.status === 'queued' || activeTask.status === 'in_progress') && !activeTask.url) {
      return toolText({ ok: true, duplicate: true, taskId: activeTask.taskId, status: activeTask.status, message: '该视频节点已有在途任务，不重复提交。' });
    }
    const numberOrStored = (key: string, storedKey: string) => (
      Number.isFinite(Number(args[key])) ? Number(args[key]) : Number(node.data[storedKey] || 0)
    );
    const selectedProfileId = pickString(args.profileId) || pickString(node.data.videoProfileId);
    const selectedModel = pickString(args.model) || pickString(node.data.videoModel);
    const seconds = numberOrStored('seconds', 'videoSeconds') || 5;
    const resolution = pickString(args.resolution) || pickString(node.data.videoResolution) || '480p';
    const ratio = pickString(args.ratio) || pickString(node.data.videoRatio) || '16:9';
    const generateAudio = typeof args.generateAudio === 'boolean' ? args.generateAudio : node.data.videoAudio === true;
    const referenceMode = pickString(args.referenceMode) || pickString(node.data.videoReferenceMode) || 'first_frame';
    const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params)
      ? args.params as Record<string, unknown>
      : node.data.videoParams && typeof node.data.videoParams === 'object'
        ? node.data.videoParams as Record<string, unknown>
        : {};
    const connectedReferences = Array.isArray(node.data.references) ? node.data.references as Array<Record<string, unknown>> : [];
    const suppliedFileNames = Array.isArray(args.imageFileNames) ? args.imageFileNames.map(String) : [];
    const suppliedUrls = Array.isArray(args.imageUrls) ? args.imageUrls.map(String) : [];
    const connectedFileNames: string[] = [];
    const connectedUrls: string[] = [];
    for (const reference of connectedReferences) {
      if (reference.kind === 'text') continue;
      const value = String(reference.url || '').trim();
      const localFile = value.match(/^\/api\/files\/([^/?#]+)/i);
      if (localFile) connectedFileNames.push(decodeURIComponent(localFile[1]));
      else if (/^https:\/\//i.test(value)) connectedUrls.push(value);
    }
    const imageFileNames = suppliedFileNames.length > 0 ? suppliedFileNames : connectedFileNames;
    const imageUrls = suppliedUrls.length > 0 ? suppliedUrls : connectedUrls;
    if (deps.patchVideoNode) {
      const patched = await deps.patchVideoNode(canvasId, nodeId, {
        prompt,
        videoStatus: 'idle',
        videoError: '',
        videoTaskId: '',
        videoUrl: '',
        videoFileName: '',
        videoProgress: 0,
        videoSubmissionUnknown: false,
        videoDownloadRecoverable: false,
        videoDownloadRecovering: false,
        videoSeconds: seconds,
        videoResolution: resolution,
        videoRatio: ratio,
        videoAudio: generateAudio,
        videoReferenceMode: referenceMode,
        videoModel: selectedModel || node.data.videoModel,
        videoProfileId: selectedProfileId || node.data.videoProfileId,
        videoParams: params,
        videoImageUrls: [
          ...imageUrls,
          ...imageFileNames.map((fileName) => `/api/files/${encodeURIComponent(fileName)}`),
        ],
        createdAt: new Date().toISOString(),
      });
      if (!patched) throw new Error('视频节点已不存在，或画布尚未同步到本机 Bridge');
    }
    const response = await fetch(`http://127.0.0.1:${PORT}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        canvasId,
        nodeId,
        prompt,
        ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        seconds,
        resolution,
        ratio,
        generateAudio,
        referenceMode,
        ...(imageFileNames.length > 0 ? { imageFileNames } : {}),
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
        ...(pickString(args.imageParamName) ? { imageParamName: pickString(args.imageParamName) } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
      }),
    });
    const result = await response.json().catch(() => null) as { data?: Record<string, unknown>; msg?: string } | null;
    if (!response.ok || result?.data?.ok !== true) throw new Error(result?.msg || '视频任务提交失败');
    return toolText({
      ok: true,
      taskId: result.data.taskId,
      duplicate: result.data.duplicate === true,
      message: result.msg || '视频任务已受理；可用 huiban_video_task 查询状态。',
      statusTool: 'huiban_video_task',
    });
  }

  if (name === 'huiban_video_task') {
    const taskId = pickString(args.taskId);
    if (!taskId) throw new Error('必须提供 taskId');
    const response = await fetch(`http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(taskId)}`);
    const result = await response.json().catch(() => null) as { data?: Record<string, unknown>; msg?: string } | null;
    if (!response.ok || !result?.data) throw new Error(result?.msg || '读取视频任务失败');
    return toolText(result.data);
  }

  if (name === 'huiban_config') {
    const settings = await deps.readSettings();
    const view = publicView(settings);
    return toolText({
      ...view,
      profiles: view.profiles.map((profile) => ({
        ...profile,
        active: profile.id === view.activeProfileId,
      })),
      guide: TOOL_GUIDE,
    });
  }

  if (name === 'huiban_prompt_guide') {
    // 规范 = 提示词优化链路同一份 buildSystemSpec（源头在 bridge/textApi.ts，零拷贝）；
    // 附带当前生效的语言模型 / 整理强度 / 档案，让 agent 知道按哪套配置思考
    const settings = await deps.readSettings();
    const level = normalizeEnhanceLevel(args.level || settings.enhanceLevel);
    const defaultSize = findProfile(settings, undefined).defaultSize;
    const size = pickString(args.size) || defaultSize || '';
    const textProfile = resolveTextProfile(settings);
    const preferences = settings.preferences;
    const enabledSkills = await (deps.listPromptSkills?.() || Promise.resolve([]));
    return toolText({
      level,
      levels: Object.entries(LEVEL_SPECS).map(([key, value]) => ({
        level: key,
        brief: value.brief,
        words: value.words,
        freedom: value.freedom,
      })),
      activeConfig: {
        textProfile: textProfile
          ? { id: textProfile.id, name: textProfile.name, model: textProfile.model, keyConfigured: Boolean(textProfile.apiKey) }
          : null,
        enhanceLevel: settings.enhanceLevel,
        preferencesEnabled: preferences.enabled,
        preferences: preferences.enabled ? preferences.entries.map((entry) => entry.text) : [],
        direct: settings.direct,
        promptOptimizationEnabled: settings.promptOptimizationEnabled,
      },
      spec: buildSystemSpec(size, level),
      enabledSkills: enabledSkills.map(({ name, description, content }) => ({ name, description, content })),
      referenceRules: {
        style: '只迁移参考图的色系 / 光线 / 氛围 / 质感；主体与构图必须全新，inputFidelity=low',
        edit: '保留参考图的主体与构图，只应用用户要求的改动，inputFidelity=high',
        autoDetect: '按措辞判断：「根据…风格 / 呼应 / 同样的感觉」→style；「基于这张图 / 把这张图改成 / 加上」→edit',
        directNote: directStyleNote('附带参考图编号', 'style'),
        fidelityByUsage: { style: fidelityForUsage('style'), edit: fidelityForUsage('edit') },
      },
      flow: 'huiban_prompt_guide 读规范 → 自己写提示词（或 huiban_optimize 让服务端优化）→ huiban_generate{prompt, canvasId}；带参考图时提示词里的用途要与 huiban_generate 的 referenceUsage 一致',
    });
  }

  if (name === 'huiban_video_prompt_guide') {
    // 视频提示词规范:镜头运动、场景叙事、节奏控制、参考图用法
    const enabledSkills = await (deps.listPromptSkills?.() || Promise.resolve([]));
    return toolText({
      structure: {
        subject: '主体动作:人物在做什么、物体如何变化、表情与情绪',
        motion: '镜头运动:推镜头(zoom in)、拉镜头(zoom out)、平移(pan)、跟随(follow)、环绕(orbit)、固定机位(static)、第一人称(POV)',
        scene: '场景环境:室内外、光线(日出/正午/黄昏/夜晚)、天气(晴/阴/雨/雾)、氛围(温馨/紧张/神秘)',
        duration: '时长与节奏:4-15秒,慢镜头(slow motion)、延时摄影(time-lapse)、正常速度(real-time)',
        style: '画面风格:写实(realistic)、动画(animated)、复古胶片(vintage film)、赛博朋克(cyberpunk)、水墨(ink wash)',
      },
      examples: [
        '一只橘猫从沙发跳到窗台,镜头跟随,阳光洒进客厅,5秒,温馨生活风格',
        '城市街道车流从白天过渡到夜晚,延时摄影,俯视角度,10秒,霓虹灯逐渐点亮',
        '少女转身回眸,头发随风飘动,慢镜头,背景虚化,柔和光线,6秒',
        'Logo 从屏幕中央旋转放大,粒子特效环绕,赛博朋克风格,蓝紫色调,8秒',
        '产品从左侧滑入画面中央,360度环绕展示,白色背景,专业摄影棚光线,12秒',
      ],
      referenceRules: {
        firstFrame: '视频从这张图开始:保留图片的主体、构图和色调,适合品牌 IP 动效、产品展示',
        lastFrame: '视频到这张图结束:定向过渡,从当前画面渐变到目标图(部分模型支持)',
        styleReference: '参考图的氛围与风格:只迁移光线、色系、质感,主体与动作全新生成',
      },
      typicalScenes: {
        ipAnimation: 'IP 动效:角色眨眼、挥手、跳跃等微动作,镜头固定或轻微推进,保持品牌识别度。提示词模板:"[角色名]在[背景]中[动作],表情[情绪],[镜头运动],[风格],[时长]秒"',
        backgroundEffect: '背景动效:云层流动、水波涟漪、粒子飘散、光线变化。提示词模板:"[场景描述],背景中[动效元素],[镜头运动],氛围[形容词],[时长]秒"',
        productDisplay: '产品展示:360度旋转、从侧面推进到正面、细节特写。提示词模板:"[产品]在[背景]上,[展示动作],专业摄影棚光线,[镜头运动],[时长]秒"',
        interaction: '交互动效:按钮按下、界面滑动、弹窗展开。提示词模板:"[UI元素][交互动作],从[起始状态]到[结束状态],流畅过渡,[时长]秒"',
      },
      tips: [
        '时长控制:4-6秒适合循环动效,8-12秒适合叙事片段,15秒是当前上限',
        '镜头稳定性:固定机位(static)最稳定,适合 Logo / 产品展示;跟随(follow)适合动作场景',
        '避免过度描述:一句话说清「谁在哪里做什么、镜头怎么动、什么风格」即可,过长的提示词反而降低质量',
        '首帧参考图:IP 动效、产品展示必须用首帧参考图锁定主体,否则 AI 会重新生成不同的主体',
        '画幅选择:16:9 适合横屏展示(官网 Banner、视频号),9:16 适合竖屏(抖音、快手),1:1 适合社交媒体方图',
      ],
      enabledSkills: enabledSkills.map(({ name, description, content }) => ({ name, description, content })),
      flow: 'huiban_video_prompt_guide 读规范与已启用 Skills → 构思提示词(主体动作+镜头运动+场景+时长+风格) → 在绘板视频节点或工作台提交任务',
    });
  }

  if (name === 'huiban_optimize') {
    const prompt = pickString(args.prompt);
    if (!prompt) throw new Error('prompt 不能为空');
    const settings = await deps.readSettings();
    const textProfile = resolveTextProfile(settings, pickString(args.profileId) || undefined);
    if (!textProfile) {
      throw new Error('尚未配置语言模型：请在「生图设置」里添加一路语言模型（提示词优化与 huiban_optimize 都走它）');
    }
    const level = normalizeEnhanceLevel(args.level || settings.enhanceLevel);
    const size = pickString(args.size);
    const requestedUsage = pickString(args.usage);
    // 与 /api/enhance 同一套默认：图生图要用户明说「改这张图」才 edit，其余一律 style
    const usage = requestedUsage === 'edit' || requestedUsage === 'style' ? requestedUsage : detectReferenceUsage(prompt);
    const references = await deps.resolveReferenceDataUrls(stringList(args.referenceImages));
    let result: Awaited<ReturnType<McpDeps['enhancePrompt']>>;
    try {
      result = await deps.enhancePrompt(textProfile, {
        prompt,
        size: size || undefined,
        referenceDataUrls: references.map((item) => item.dataUrl),
        level,
        usage,
        // 档案只在开启时注入；本工具是显式优化调用，不受画布自动开关控制
        preferences: settings.preferences.enabled ? settings.preferences.entries : [],
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`语言模型调用失败：${reason}（检查这路语言模型的 baseUrl / Key / 网络，或在「生图设置」换一路语言模型）`);
    }
    return toolText({
      ok: true,
      prompt: result.prompt,
      usage: result.usage,
      referenceRoles: result.referenceRoles || [],
      level,
      size: size || null,
      profile: { id: textProfile.id, name: textProfile.name },
      referenceCount: references.length,
      nextStep: `把返回的 prompt 原样交给 huiban_generate；参考图配 referenceUsage:"${result.usage}"（inputFidelity:${fidelityForUsage(result.usage)}）`,
    });
  }

  if (name === 'huiban_models') {
    const settings = await deps.readSettings();
    const view = publicView(settings);
    return toolText({
      activeProfileId: view.activeProfileId,
      direct: view.direct,
      promptOptimizationEnabled: view.promptOptimizationEnabled,
      profiles: view.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        kind: profile.kind,
        model: profile.model,
        defaultSize: profile.defaultSize,
        models: profile.enabledModels?.length ? profile.enabledModels : profile.models,
        keyConfigured: profile.keyConfigured,
        active: profile.id === view.activeProfileId,
      })),
    });
  }

  if (name === 'huiban_canvases') {
    const registry = await deps.readCanvasRegistry();
    const ids = Object.keys(registry);
    const canvases = await Promise.all(ids.map(async (id) => {
      const doc = await deps.readCanvasDoc(id);
      return {
        id,
        name: registry[id] || doc?.name || '未命名画布',
        nodeCount: Array.isArray(doc?.nodes) ? doc?.nodes.length : 0,
        updatedAt: doc?.updatedAt || '',
      };
    }));
    return toolText(canvases);
  }

  if (name === 'huiban_canvas_create') {
    const label = pickString(args.name) || '新画布';
    // id 在这里生成、原样传进去：返回给 Agent 的必须是真正建档的那个 id
    const canvasId = `canvas_mcp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const created = await deps.createCanvas(canvasId, label);
    return toolText({
      ok: true,
      canvasId: created.id,
      canvas: created,
      hint: '拿 canvasId 当 huiban_generate 的 canvasId；浏览器里切换 / 刷新即可看到这张画布',
    });
  }

  if (name === 'huiban_nodes') {
    const canvasId = pickString(args.canvasId);
    if (!canvasId) throw new Error('canvasId 不能为空（先用 huiban_canvases 拿）');
    const doc = await deps.readCanvasDoc(canvasId);
    if (!doc) throw new Error(`画布不存在：${canvasId}（先用 huiban_canvases 查看，或用 huiban_canvas_create 新建）`);
    const kind = pickString(args.kind);
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 50, 1), 200);
    const nodes = (Array.isArray(doc.nodes) ? doc.nodes : []) as Array<Record<string, any>>;
    const matched = nodes
      .filter((node) => !kind || String(node?.data?.kind || '') === kind)
      .map((node) => ({
        id: String(node?.id || ''),
        kind: String(node?.data?.kind || ''),
        label: String(node?.data?.label || ''),
        prompt: String(node?.data?.prompt || ''),
        fileName: String(node?.data?.fileName || ''),
        imageUrl: String(node?.data?.imageUrl || ''),
        size: String(node?.data?.size || ''),
        model: String(node?.data?.model || ''),
        createdAt: String(node?.data?.createdAt || ''),
        versionCount: Array.isArray(node?.data?.versions) ? node.data.versions.length : 0,
      }));
    return toolText({
      canvasId,
      total: matched.length,
      nodes: matched.slice(0, limit),
    });
  }

  if (name === 'huiban_locate') {
    const canvasId = pickString(args.canvasId);
    if (!canvasId) throw new Error('canvasId 不能为空（先用 huiban_canvases 拿）');
    const doc = await deps.readCanvasDoc(canvasId);
    if (!doc) throw new Error(`画布不存在：${canvasId}（先用 huiban_canvases 查看，或用 huiban_canvas_create 新建）`);
    const nodes = (Array.isArray(doc.nodes) ? doc.nodes : []) as Array<Record<string, any>>;
    const nodeId = pickString(args.nodeId);
    const target = nodeId
      ? nodes.find((node) => String(node?.id || '') === nodeId)
      : [...nodes].sort((left, right) => (
        Date.parse(String(right?.data?.createdAt || '')) - Date.parse(String(left?.data?.createdAt || ''))
      ))[0];
    if (!target) throw new Error(nodeId
      ? `画布 ${canvasId} 上没有节点 ${nodeId}（用 huiban_nodes 核对 id）`
      : `画布 ${canvasId} 上还没有节点，没有可定位的对象`);
    const targetId = String(target.id || '');
    deps.pushLocate({ type: 'locate', canvasId, nodeId: targetId, at: new Date().toISOString() });
    const openTabs = deps.countOpenTabs();
    return toolText({
      ok: true,
      located: true,
      canvasId,
      nodeId: targetId,
      position: { x: Number(target.position?.x) || 0, y: Number(target.position?.y) || 0 },
      prompt: String(target?.data?.prompt || ''),
      label: String(target?.data?.label || ''),
      imageUrl: String(target?.data?.imageUrl || ''),
      openTabs,
      delivered: openTabs > 0,
      hints: [
        openTabs > 0
          ? '已通知浏览器定位（停在别的画布会先切过去再居中）'
          : '当前没有打开的浏览器标签页：节点已写进画布文档，用户下次打开就在，但这次看不到实时定位',
      ],
    });
  }

  if (name === 'huiban_generate') {
    const prompt = pickString(args.prompt);
    if (!prompt) throw new Error('prompt 不能为空');
    const settings = await deps.readSettings();
    const profile = findProfile(settings, typeof args.profileId === 'string' ? args.profileId : undefined);
    if (!profile.apiKey) throw new Error('尚未配置 API Key：请在绘板「生图设置」里填一路生图配置');
    const canvasId = pickString(args.canvasId);
    let canvasDoc: CanvasDocRecord | undefined;
    if (canvasId) {
      // 先校验画布再花钱生成：坏 canvasId 不该先烧一次接口调用
      canvasDoc = await deps.readCanvasDoc(canvasId);
      const registry = await deps.readCanvasRegistry();
      if (!canvasDoc && !registry[canvasId]) {
        throw new Error(`画布不存在：${canvasId}（先用 huiban_canvases 查看，或用 huiban_canvas_create 新建）`);
      }
    }
    const modelOverride = pickString(args.model);
    const apiMode = settings.direct === false && profile.imageApiMode === 'responses' ? 'responses' : 'images';

    // 尺寸：ratio 优先（更好记），其次 size，最后配置默认；最终都过 normalizeImageSize 规范化
    const ratio = pickString(args.ratio);
    let sizeInput = pickString(args.size);
    if (ratio && ratio !== 'auto') {
      const mapped = RATIO_TO_SIZE[ratio];
      if (!mapped) throw new Error(`不支持的比例：${ratio}`);
      sizeInput = mapped;
    }
    const size = normalizeImageSize(sizeInput || profile.defaultSize);

    // 参考图：外部入口（路径 / 链接 / dataURL）→ dataURL 喂接口，url 留档到节点上
    const references = await deps.resolveReferenceDataUrls(stringList(args.referenceImages));
    const referenceDataUrls = references.map((item) => item.dataUrl);

    const requestedUsage = pickString(args.referenceUsage);
    const usage = requestedUsage === 'edit' || requestedUsage === 'style' ? requestedUsage : undefined;
    const fidelityRaw = pickString(args.inputFidelity);
    const inputFidelity = fidelityRaw === 'high' || fidelityRaw === 'low'
      ? fidelityRaw
      : (usage === 'edit' ? 'high' : usage === 'style' ? 'low' : undefined);

    const qualityRaw = pickString(args.quality);
    const quality = QUALITY_VALUES.includes(qualityRaw as typeof QUALITY_VALUES[number])
      ? qualityRaw as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      : undefined;

    const n = Math.min(Math.max(Math.floor(Number(args.n)) || 1, 1), 8);

    let images: Awaited<ReturnType<typeof deps.generateImages>>;
    try {
      images = await deps.generateImages(profile, {
        prompt,
        apiMode,
        size,
        model: modelOverride || undefined,
        quality,
        inputFidelity: referenceDataUrls.length > 0 ? inputFidelity : undefined,
        n,
        referenceDataUrls: referenceDataUrls.length > 0 ? referenceDataUrls : undefined,
          responseModel: apiMode === 'responses' ? profile.model : undefined,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`生图接口调用失败：${reason}（请检查生图设置里的 baseUrl / API Key / 网络，或换一个 profileId）`);
    }
    if (images.length === 0) throw new Error('生图接口没有返回图片');

    const label = pickString(args.label) || 'Codex 生成';
    const usedModel = modelOverride || profile.model;

    let persisted = false;
    let delivered = false;
    let persistError = '';
    const nodes: CanvasNodeRecord[] = [];

    if (canvasId) {
      // 排点位：接着画布上已有节点往后铺，别每次糊在同一处
      const existingNodes = (Array.isArray(canvasDoc?.nodes) ? canvasDoc!.nodes : []) as Array<Record<string, any>>;
      const existingCount = existingNodes.filter((node) => node?.data?.imageUrl).length;
      const createdAt = new Date().toISOString();
      images.forEach((image, index) => {
        const slot = existingCount + index;
        const nodeId = `mcp_image_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`;
        nodes.push({
          id: nodeId,
          type: 'flow-image',
          position: { x: 48 + (slot % 4) * 384, y: 48 + Math.floor(slot / 4) * 432 },
          data: {
            kind: 'image',
            label: images.length > 1 ? `${label} ${index + 1}/${images.length}` : label,
            cardWidth: 320,
            prompt,
            enhancedPrompt: '',
            revisedPrompt: String(image.revisedPrompt || ''),
            responseId: image.responseId,
            imageGenerationCallId: image.imageGenerationCallId,
            responseModel: image.responseModel,
            responseProfileId: image.responseId ? profile.id : undefined,
            status: 'done',
            imageUrl: image.url,
            fileName: image.fileName,
            size,
            model: usedModel,
            source: 'mcp',
            createdAt,
            ...(references.length > 0
              ? { references: references.map((item) => ({ ...item, label: 'MCP 参考图' })) }
              : {}),
          },
        });
      });
      try {
        persisted = await deps.appendCanvasImageNodes(canvasId, nodes);
        if (persisted) {
          nodes.forEach((node, index) => {
            deps.pushImage({
              type: 'image',
              canvasId,
              nodeId: node.id,
              prompt,
              usedPrompt: prompt,
              revisedPrompt: images[index].revisedPrompt,
              responseId: images[index].responseId,
              imageGenerationCallId: images[index].imageGenerationCallId,
              responseModel: images[index].responseModel,
              responseProfileId: images[index].responseId ? profile.id : undefined,
              model: usedModel,
              size,
              fileName: images[index].fileName,
              url: images[index].url,
              jobId: `job_${Date.now().toString(36)}_${index}`,
            });
          });
          // 图先落画布，再发定位（默认开：不依赖 agent 记得调 huiban_locate，用户不会看不到成果）。
          // onlyIfOffscreen 让前端自己判断——新节点本就在用户视口里就不挪镜头，别打断他。
          // 传 locate:false 才彻底不碰视口，之后 agent 还能用 huiban_locate 补。
          if (args.locate !== false && nodes.length > 0) {
            deps.pushLocate({
              type: 'locate',
              canvasId,
              nodeId: nodes[0].id,
              at: new Date().toISOString(),
              onlyIfOffscreen: true,
            });
          }
          delivered = true;
        }
      } catch (error) {
        persistError = error instanceof Error ? error.message : '画布写入失败';
      }
    }

    return toolText({
      ok: true,
      canvasId: canvasId || null,
      deliveredToCanvas: delivered,
      persistedToDoc: persisted,
      autoLocate: Boolean(persisted && args.locate !== false),
      ...(persistError ? { persistError } : {}),
      usedPrompt: prompt,
      apiMode,
      size,
      model: usedModel,
      referenceCount: referenceDataUrls.length,
      images: images.map((image, index) => ({
        nodeId: nodes[index]?.id || null,
        fileName: image.fileName,
        url: image.url,
        localPath: image.filePath,
        revisedPrompt: image.revisedPrompt,
        responseId: image.responseId,
        imageGenerationCallId: image.imageGenerationCallId,
        responseModel: image.responseModel,
      })),
      hints: [
        canvasId
          ? (persisted ? '已写入画布文档：浏览器里该画布在线即时可见，不在线时下次打开/刷新也能看到' : `未能写入画布文档${persistError ? `：${persistError}` : ''}`)
          : '未指定 canvasId：只返回了图片（文件已在 ~/.huiban/media），不会出现在画布上',
        referenceDataUrls.length > 0 ? `已带 ${referenceDataUrls.length} 张参考图（inputFidelity=${String(inputFidelity || '默认')}）` : '',
        persisted && args.locate === false
          ? '已按 locate:false 跳过定位：请立刻调 huiban_locate{canvasId, nodeId}（nodeId 见下面 images 列表）把结果呈现给用户，否则用户看不到这次生成了什么'
          : '',
      ].filter(Boolean),
    });
  }

  throw new Error(`未知工具: ${name}`);
}

export const defaultMcpDeps: McpDeps = {
  readSettings,
  readCanvasRegistry,
  readCanvasDoc,
  enhancePrompt: enhancePromptDetailed,
  generateImages,
  pushImage,
  pushLocate,
  countOpenTabs,
  appendCanvasImageNodes,
  createCanvas: (canvasId: string, name: string) => createCanvasInRegistry(canvasId, name),
  resolveReferenceDataUrls,
  listPromptSkills: listEnabledPromptSkills,
  patchVideoNode: patchCanvasVideoNode,
};

let presenceHeartbeat: ReturnType<typeof setInterval> | null = null;
let presenceCanvasId = '';
let presenceWrite = Promise.resolve();

function noteAgentPresence(canvasId?: string): void {
  if (canvasId) presenceCanvasId = canvasId;
  const touch = () => {
    presenceWrite = presenceWrite.then(async () => {
      await markAgentPresence({
        canvasId: presenceCanvasId || undefined,
        transport: 'stdio',
      });
    });
    return presenceWrite;
  };
  void touch();
  if (!presenceHeartbeat) {
    presenceHeartbeat = setInterval(() => void touch(), 60_000);
    presenceHeartbeat.unref?.();
  }
}

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'huiban', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.onclose = () => {
    if (presenceHeartbeat) clearInterval(presenceHeartbeat);
    presenceHeartbeat = null;
    presenceCanvasId = '';
    void presenceWrite.then(() => clearAgentPresence(process.pid));
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: listMcpTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments || {}) as Record<string, unknown>;
    noteAgentPresence(typeof args.canvasId === 'string' ? args.canvasId : undefined);
    try {
      return await callMcpTool(request.params.name, args, defaultMcpDeps);
    } catch (error) {
      // 工具级失败按 MCP 规范走 isError:true 结果（不是 JSON-RPC 协议错误）：
      // Agent 拿到的是可读的错误文本，能自己改参数重试，而不是看到一条协议级炸裂
      return {
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  return server;
}
