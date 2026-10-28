import type { ServerResponse } from 'node:http';
import type { VideoTaskStatus } from './videoApi.js';

interface SseClient {
  res: ServerResponse;
  canvasId: string | null;
}

const clients = new Set<SseClient>();

export function addSseClient(res: ServerResponse, canvasId: string | null): () => void {
  const client: SseClient = { res, canvasId };
  clients.add(client);
  return () => clients.delete(client);
}

export interface PushedImage {
  type: 'image';
  canvasId: string;
  nodeId: string;
  /** 用户原始提示词（经语言模型优化时是优化前的那份）。 */
  prompt: string;
  /** 实际发给生图模型的提示词（优化后才与 prompt 不同）。 */
  usedPrompt?: string;
  /** 生图模型服务端返回的润色后提示词（revised_prompt）。 */
  revisedPrompt?: string;
  model?: string;
  size?: string;
  responseId?: string;
  imageGenerationCallId?: string;
  responseModel?: string;
  responseProfileId?: string;
  fileName: string;
  url: string;
  jobId: string;
  /** 来源：mcp = Codex 推来的图；chat = 对话 agent 调生图工具产的图。 */
  source?: 'mcp' | 'chat';
}

/** 推给订阅了该画布的浏览器标签页；canvasId 为空表示广播。 */
export function pushImage(payload: PushedImage | Omit<PushedImage, 'canvasId'>): void {
  const event = 'image';
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if ('canvasId' in payload && payload.canvasId && client.canvasId !== payload.canvasId) continue;
    try {
      client.res.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

export interface LocateRequest {
  type: 'locate';
  /** 目标节点所在画布：浏览器停在别的画布时，前端会先切过去再聚焦。 */
  canvasId: string;
  nodeId: string;
  /** 触发时间（ISO）：前端据此忽略过期请求。 */
  at: string;
  /**
   * 生成后的自动定位用：节点明明已经在用户视口里就别挪镜头（用户正盯着那儿看，
   * 无谓的平移反而打断他）。agent 显式调 huiban_locate 时不带这个字段，一律归位。
   */
  onlyIfOffscreen?: boolean;
}

/**
 * 定位请求：agent 调 huiban_locate 时触发，把用户的浏览器带到指定节点前。
 * 不做画布过滤——定位本身就是跨画布操作，停在别的画布上的标签页也该收到，
 * 由前端决定切不切换（切之前会先把目标画布的最新文档拉回来合并）。
 */
export function pushLocate(payload: LocateRequest): void {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    try {
      client.res.write(`event: locate\ndata: ${data}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

export interface PushedCanvasUpdated {
  type: 'canvas-updated';
  canvasId: string;
  updatedAt: string;
  originId?: string;
}

/** 画布文档写入后广播给订阅同一画布的其他页面：局域网多人打开时能看到彼此的上传与编辑。 */
export function pushCanvasUpdated(payload: PushedCanvasUpdated): void {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.canvasId !== payload.canvasId) continue;
    try {
      client.res.write(`event: canvas-updated\ndata: ${data}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

/** 在线标签页数：huiban_locate 用它告诉 agent「用户那边没开浏览器」，别把定位说成成功了。 */
export function countOpenTabs(): number {
  return clients.size;
}

/* ── 视频任务事件 ──
   与 image 事件并列，但语义不同：一条视频要经历「排队 → 生成中(带进度) → 完成」多次推送，
   前端靠 taskId 认出是同一条任务，按 phase 分别更新节点上的进度条 / 成品 / 错误。 */

export type VideoEventPhase = 'submitted' | 'progress' | 'download-failed' | 'done' | 'failed';

export interface PushedVideo {
  type: 'video';
  /** submitted = 任务已受理；progress = 轮询到的中间态；done = 已落盘；failed = 明确失败。 */
  phase: VideoEventPhase;
  canvasId: string;
  nodeId: string;
  taskId: string;
  status?: VideoTaskStatus;
  /** 0–100：中转站直接给进度，比图片那种干等好看得多。 */
  progress?: number;
  fileName?: string;
  url?: string;
  error?: string;
  submissionUnknown?: boolean;
  recoverable?: boolean;
  finishedAt?: string;
}

/** 推给订阅了该画布的标签页；canvasId 为空表示广播（视频任务不跨画布，留口子备用）。 */
export function pushVideo(payload: PushedVideo | Omit<PushedVideo, 'canvasId'>): void {
  const event = 'video';
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if ('canvasId' in payload && payload.canvasId && client.canvasId !== payload.canvasId) continue;
    try {
      client.res.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}
