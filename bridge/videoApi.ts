import { normalizeCustomVideoApiConfig, normalizeVideoApiMode, type CustomVideoApiConfig, type ModelProfile, type VideoApiMode } from './settings.js';
import { looksLikeVideo, saveVideoBuffer, type SavedFile } from './files.js';
import { readVideoResponsePath, renderVideoHeadersTemplate, renderVideoRequestTemplate } from './videoRequestTemplate.js';

/**
 * 视频生成出口。通过协议适配器兼容两类上游：
 * - OpenAI Videos：提交 taskId，结果靠轮询和 /content 下载；
 * - xAI Grok Imagine：/videos/generations，完成后从任务响应读取 video.url；
 * - GrsAI generate：可能同步返回公网视频地址，也可能返回任务 id 后由 /api/result 轮询；
 * - Media v1：部分中转站使用 /media/generate + /media/status，参数嵌套在 params。
 *
 * 契约来自中转站文档（2026-10 核对）：
 *   POST   /v1/videos                创建，秒回 { id, status: 'queued', progress: 0 }
 *   GET    /v1/videos/{task_id}      查询，status: queued / in_progress / completed / failed
 *   GET    /v1/videos/{task_id}/content   下载 MP4（带鉴权）
 *
 * 文档两条红线，这里都遵守：
 *   1. 拿到 taskId 后只查询，绝不自动重发 POST（无幂等保证，重发 = 重复计费）。
 *   2. 素材必须是公网 HTTPS 地址，不收二进制附件。本机 /api/files 中转站拉不到，
 *      所以「上传图床」这件事在 http.ts 的 /api/videos 路由里做，不在这层。
 */

export const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
export type VideoRatio = typeof VIDEO_RATIOS[number];

export const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export type VideoResolution = typeof VIDEO_RESOLUTIONS[number];

/** 文档：常规 4–15 秒整数，省略默认 5 秒。 */
export const VIDEO_SECONDS_MIN = 4;
export const VIDEO_SECONDS_MAX = 15;
export const DEFAULT_VIDEO_SECONDS = 5;
export const VIDEO_INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_INLINE_IMAGES_MAX_BYTES = 30 * 1024 * 1024;

export class VideoImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoImageInputError';
  }
}

export function videoUploadSupportsInlineDataUrl(description: string): boolean {
  return /data:\s*<[^>]+>;base64/i.test(String(description || ''));
}

export function encodeVideoImagesAsDataUrls(images: Array<{ buffer: Buffer; mimeType: string }>): string[] {
  let totalBytes = 0;
  for (const [index, image] of images.entries()) {
    if (image.buffer.length === 0) throw new VideoImageInputError(`第 ${index + 1} 张参考图是空文件`);
    if (!String(image.mimeType || '').toLowerCase().startsWith('image/')) {
      throw new VideoImageInputError(`第 ${index + 1} 张参考图不是受支持的图片格式`);
    }
    if (image.buffer.length > VIDEO_INLINE_IMAGE_MAX_BYTES) {
      throw new VideoImageInputError(`第 ${index + 1} 张参考图超过 10 MB，请先压缩后再提交`);
    }
    totalBytes += image.buffer.length;
  }
  if (totalBytes > VIDEO_INLINE_IMAGES_MAX_BYTES) {
    throw new VideoImageInputError('参考图片总大小超过 30 MB，请先压缩后再提交');
  }
  return images.map(({ buffer, mimeType }) => `data:${mimeType};base64,${buffer.toString('base64')}`);
}

export function validateVideoImageDataUrls(imageUrls: string[]): void {
  let totalBytes = 0;
  for (const [index, value] of imageUrls.entries()) {
    if (!/^data:/i.test(value)) continue;
    const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i);
    if (!match || match[2].length % 4 !== 0) {
      throw new VideoImageInputError(`第 ${index + 1} 张参考图不是有效的 Base64 图片`);
    }
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) throw new VideoImageInputError(`第 ${index + 1} 张参考图是空文件`);
    if (buffer.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
      throw new VideoImageInputError(`第 ${index + 1} 张参考图不是有效的 Base64 图片`);
    }
    if (buffer.length > VIDEO_INLINE_IMAGE_MAX_BYTES) {
      throw new VideoImageInputError(`第 ${index + 1} 张参考图超过 10 MB，请先压缩后再提交`);
    }
    totalBytes += buffer.length;
  }
  if (totalBytes > VIDEO_INLINE_IMAGES_MAX_BYTES) {
    throw new VideoImageInputError('参考图片总大小超过 30 MB，请先压缩后再提交');
  }
}

export function normalizeVideoRatio(value: unknown): VideoRatio {
  const raw = String(value || '').trim();
  return (VIDEO_RATIOS as readonly string[]).includes(raw) ? (raw as VideoRatio) : '16:9';
}

export function normalizeVideoResolution(value: unknown): VideoResolution {
  const raw = String(value || '').trim();
  return (VIDEO_RESOLUTIONS as readonly string[]).includes(raw) ? raw as VideoResolution : '480p';
}

export function normalizeVideoSeconds(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_VIDEO_SECONDS;
  return Math.min(VIDEO_SECONDS_MAX, Math.max(VIDEO_SECONDS_MIN, parsed));
}

export function assertDownloadedVideoBuffer(buffer: Buffer, contentType: string, htmlMessage: string): void {
  if (buffer.length === 0) throw new Error('下载接口返回了空文件');
  const type = String(contentType || '').toLowerCase();
  const prefix = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (type.includes('text/html') || prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) {
    throw new Error(htmlMessage);
  }
  if (type.includes('json') || prefix.startsWith('{')) {
    try {
      const data = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
      const nested = data.data && typeof data.data === 'object' ? data.data as Record<string, unknown> : {};
      throw new Error(readVideoError(data, nested) || '下载接口返回了 JSON 错误，而不是视频文件');
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('下载接口返回了 JSON 错误，而不是视频文件');
      throw error;
    }
  }
  if (!type.startsWith('video/') && !looksLikeVideo(buffer)) {
    throw new Error('下载接口返回的内容无法识别为视频文件');
  }
}

/** 任务状态：文档主状态四种，另兼容各渠道的大小写与同义写法。 */
export type VideoTaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'unknown';

const QUEUED = ['queued', 'pending', 'submitted', 'created', 'waiting', 'retrying', 'queued_for_processing'];
const RUNNING = ['in_progress', 'running', 'processing', 'generating', 'started'];
const DONE = ['completed', 'complete', 'done', 'succeeded', 'succeed', 'success', 'successful', 'finished', 'ok', 'ready'];
const FAILED = ['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired', 'rejected', 'timeout', 'timed_out'];

export function normalizeVideoStatus(value: unknown): VideoTaskStatus {
  const raw = String(value || '').trim().toLowerCase();
  if (QUEUED.includes(raw)) return 'queued';
  if (RUNNING.includes(raw)) return 'in_progress';
  if (DONE.includes(raw)) return 'completed';
  if (FAILED.includes(raw)) return 'failed';
  return 'unknown';
}

/** 中转站的状态字段名不统一：主状态可能在 status / state / task_status / video_status。 */
function readStatusField(data: Record<string, unknown> | null, nested: Record<string, unknown>): unknown {
  return data?.status
    ?? data?.state
    ?? data?.task_status
    ?? data?.video_status
    ?? nested.status
    ?? nested.state
    ?? nested.task_status
    ?? nested.video_status;
}

export interface VideoCreateParams {
  prompt: string;
  /** 覆盖配置里的默认模型(用户在界面另选了模型时用)。 */
  model?: string;
  seconds?: number;
  resolution?: VideoResolution;
  ratio?: VideoRatio;
  generateAudio?: boolean;
  watermark?: boolean;
  /** 参考图用途:首帧(视频从这张图开始)、尾帧(视频到这张图结束)、风格(只迁移氛围)。缺省按模型默认处理。 */
  referenceMode?: 'first_frame' | 'last_frame' | 'style';
  /** 参考图 / 首帧:必须是公网 HTTPS 地址,长度上限见各家文档。 */
  imageUrls?: string[];
  /**
   * 模型自己的参数（来自 /v1/skills/models/{name} 的 params）。
   * media-v1 协议下原样放进请求体的 params，不再由代码猜字段名——
   * 各家模型叫法不同（images / img_url / image_url），硬编码必然错。
   */
  extraParams?: Record<string, unknown>;
  /** 承载参考图的参数名（schema 里 type=upload 的那一项）。缺省按 images 落位。 */
  imageParamName?: string;
  signal?: AbortSignal;
}

export interface VideoTaskSnapshot {
  id: string;
  status: VideoTaskStatus;
  progress: number;
  error?: string;
  /** 同步协议直接返回的成品地址；任务协议则为空并走轮询。 */
  outputUrl?: string;
}

/* ── 视频模型目录（media-v1 协议的 /skills/models 系列） ── */

export interface VideoModelOption {
  name: string;
  displayName: string;
  description: string;
  /** 中转站标记当前 Key 能否调用；false 的不要放进可选列表（硬调必 403）。 */
  available: boolean;
}

export interface VideoParamOption {
  label: string;
  value: string;
}

export interface VideoParamSpec {
  name: string;
  label: string;
  type: string;
  required: boolean;
  description: string;
  options?: VideoParamOption[];
}

export interface VideoModelSchema {
  name: string;
  displayName: string;
  description: string;
  inputHint: string;
  tags: string[];
  params: VideoParamSpec[];
}

export interface VideoPriceQuote {
  supported: boolean;
  balance?: number;
  unit?: string;
  billingMethod?: string;
  minimumUnitPrice?: number;
  minimumEstimate?: number;
  seconds: number;
  warning?: string;
}

export function summarizeVideoPriceQuote(
  balanceData: Record<string, unknown> | null,
  pricingData: Record<string, unknown> | null,
  seconds: number,
): VideoPriceQuote {
  const duration = Math.max(1, Math.floor(Number(seconds) || DEFAULT_VIDEO_SECONDS));
  const balance = Number(balanceData?.balance);
  const unit = String(balanceData?.unit || '算力');
  const available = pricingData?.available_for_this_key !== false;
  const groups = Array.isArray(pricingData?.channel_groups)
    ? pricingData!.channel_groups as Array<Record<string, unknown>>
    : [];
  const usable = groups.filter((group) => group.is_active !== false && group.excluded_for_this_key !== true);
  const prices = usable.map((group) => Number(group.min_price)).filter((value) => Number.isFinite(value) && value > 0);
  const billingMethod = String(usable.find((group) => group.billing_method)?.billing_method || '');
  const minimumUnitPrice = prices.length > 0 ? Math.min(...prices) : undefined;
  const estimate = minimumUnitPrice === undefined
    ? undefined
    : /按秒/.test(billingMethod)
      ? minimumUnitPrice * duration
      : /按次/.test(billingMethod)
        ? minimumUnitPrice
        : undefined;
  const supported = available && minimumUnitPrice !== undefined;
  const warning = !available
    ? '当前 API Key 没有该模型的可用渠道。'
    : !supported
      ? '服务商没有返回可计算的最低价格；生成费用未知，请到服务商后台核对。'
      : /按token/i.test(billingMethod)
        ? '此模型按 Token 计费，无法用简单公式估算；下方显示的不是本次费用。'
        : '最低参考估算，实际金额取决于所选版本、分辨率和最终派单渠道；不会阻止提交。';
  return {
    supported,
    ...(Number.isFinite(balance) ? { balance } : {}),
    unit,
    billingMethod: billingMethod || undefined,
    minimumUnitPrice,
    minimumEstimate: estimate,
    seconds: duration,
    warning,
  };
}

export async function getMediaVideoPriceQuote(profile: ModelProfile, model: string, seconds: number): Promise<VideoPriceQuote> {
  if (!profile.apiKey) throw new VideoConfigurationError('尚未配置 API Key');
  const base = videoBase(profile);
  const headers = { ...providerAuthHeaders(profile.apiKey), 'Accept-Language': 'zh-CN' };
  const [balanceResponse, priceResponse] = await Promise.all([
    fetch(`${base}/skills/balance`, { headers, signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) }),
    fetch(`${base}/skills/models/${encodeURIComponent(model)}/pricing`, { headers, signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) }),
  ]);
  if (!balanceResponse.ok || !priceResponse.ok) {
    return summarizeVideoPriceQuote(null, null, seconds);
  }
  const [balanceData, pricingData] = await Promise.all([
    balanceResponse.json().catch(() => null) as Promise<Record<string, unknown> | null>,
    priceResponse.json().catch(() => null) as Promise<Record<string, unknown> | null>,
  ]);
  return summarizeVideoPriceQuote(balanceData, pricingData, seconds);
}

/** 模型名里的视频家族关键词：用于从 /models 全量列表里筛出视频模型。 */
const VIDEO_MODEL_HINT = /(?:^|[-_/])(?:video|seedance|veo|sora|kling|minimax|hailuo|pika|runway|ltx|wan|grok|vidu|luma|pixverse)(?:[-_/]|$)/i;

export function looksLikeVideoModel(name: string): boolean {
  return VIDEO_MODEL_HINT.test(name);
}

/** 把中转站的 display_name / available_for_this_key 归一成前端字段名。 */
function normalizeModelOption(raw: Record<string, unknown>): VideoModelOption {
  return {
    name: String(raw.name || raw.id || '').trim(),
    displayName: String(raw.display_name || raw.displayName || raw.name || '').trim(),
    description: String(raw.description || '').trim(),
    available: raw.available_for_this_key !== false,
  };
}

function normalizeParamSpec(raw: Record<string, unknown>): VideoParamSpec | null {
  const name = String(raw.name || '').trim();
  if (!name) return null;
  const options = Array.isArray(raw.options)
    ? raw.options.map((item) => {
      const option = (item || {}) as Record<string, unknown>;
      return { label: String(option.label ?? option.value ?? ''), value: String(option.value ?? '') };
    }).filter((item) => item.value !== '')
    : undefined;
  return {
    name,
    label: String(raw.label || name).trim(),
    type: String(raw.type || 'text').trim(),
    required: raw.required === true,
    description: String(raw.description || '').trim(),
    ...(options && options.length > 0 ? { options } : {}),
  };
}

/**
 * 列出该中转站可用的视频模型。
 * media-v1 走 /skills/models?type=video；其他协议回落到 OpenAI 的 /models 再按名字过滤。
 */
export async function listVideoModels(profile: ModelProfile): Promise<VideoModelOption[]> {
  if (!profile.apiKey) throw new VideoConfigurationError('尚未配置 API Key：请先填写并保存');
  const base = videoBase(profile);
  const mode = resolveVideoApiMode(profile);
  const headers = providerAuthHeaders(profile.apiKey);

  if (mode === 'media-v1') {
    const response = await fetch(`${base}/skills/models?type=video`, {
      headers: { ...headers, 'Accept-Language': 'zh-CN' },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new VideoRequestError(response.status, await response.text().catch(() => ''));
    }
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    const list = Array.isArray(data?.models) ? data.models : [];
    return list
      .map((item) => normalizeModelOption((item || {}) as Record<string, unknown>))
      .filter((item) => item.name && item.available);
  }

  const response = await fetch(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new VideoRequestError(response.status, await response.text().catch(() => ''));
  }
  const data = await response.json().catch(() => null) as { data?: Array<Record<string, unknown>> } | null;
  return (data?.data || [])
    .map((item) => normalizeModelOption(item))
    // /models 是图片 / 文本 / 视频混在一起的；视频配置只列视频家族，避免用户选到图片模型
    .filter((item) => item.name && item.available && looksLikeVideoModel(item.name));
}

/** 读单个模型的参数 schema：界面据此动态渲染表单。 */
export async function describeVideoModel(profile: ModelProfile, model: string): Promise<VideoModelSchema> {
  const name = String(model || '').trim();
  if (!name) throw new VideoConfigurationError('缺少模型名');
  if (resolveVideoApiMode(profile, name) !== 'media-v1') {
    throw new VideoConfigurationError('当前视频协议不提供模型参数描述；请把「接口协议」改为媒体协议（/v1/media/generate）');
  }
  const response = await fetch(`${videoBase(profile)}/skills/models/${encodeURIComponent(name)}`, {
    headers: { ...providerAuthHeaders(profile.apiKey), 'Accept-Language': 'zh-CN' },
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new VideoRequestError(response.status, await response.text().catch(() => ''));
  }
  const raw = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!raw) throw new Error(`读不到模型 ${name} 的参数定义`);
  const params = (Array.isArray(raw.params) ? raw.params : [])
    .map((item) => normalizeParamSpec((item || {}) as Record<string, unknown>))
    .filter((item): item is VideoParamSpec => Boolean(item))
    // 提示词由节点输入框负责，不在参数面板里重复出现
    .filter((item) => item.name !== 'prompt');
  return {
    name,
    displayName: String(raw.display_name || name).trim(),
    description: String(raw.description || '').trim(),
    inputHint: String(raw.input_hint || '').trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.map((item) => String(item)) : [],
    params,
  };
}

export class VideoRequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly definitiveFailure = status < 500 && status !== 408 && status !== 429,
  ) {
    super(`视频接口返回 ${status}：${String(detail || '').slice(0, 200)}`);
  }
}

/** 本地配置错误：请求还没有发给上游，不能被标记成“提交结果未知”。 */
export class VideoConfigurationError extends Error {
  readonly definitiveFailure = true;

  constructor(message: string) {
    super(message);
    this.name = 'VideoConfigurationError';
  }
}

const CREATE_TIMEOUT_MS = 15 * 60_000;
const QUERY_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

function providerAuthHeaders(apiKey: string): Record<string, string> {
  // 与生图同一套别名：Bearer 兼容绝大多数网关，apikey 兼容 GrsAI 那类原生头
  const token = String(apiKey || '').trim().replace(/^Bearer\s+/i, '');
  return { Authorization: `Bearer ${token}`, apikey: token };
}

/**
 * 归一化 Base URL：用户从中转站复制过来的可能是 https://x.com 也可能是 https://x.com/v1，
 * 两种都得能用。去掉尾部斜杠后，若路径里已经有 v1 段就不再补。
 * 生图侧（imageApi.ts）是直接拼 /images/generations，所以 URL 必须自带 /v1；
 * 视频侧统一在这里兜住，别让用户因为多写一个 /v1 就拿到 404。
 */
function videoBase(profile: ModelProfile): string {
  const raw = String(profile.baseUrl || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  // 接受用户粘贴创建接口的完整 URL，同时保留前面的代理前缀与版本段。
  const endpointSuffix = raw.match(/\/(?:videos\/generations|video\/generations|api\/(?:generate|result)|media\/(?:generate|status)|videos)$/i)?.[0];
  const isFullEndpoint = Boolean(endpointSuffix);
  const base = endpointSuffix ? raw.slice(0, -endpointSuffix.length) : raw;
  if (!base) throw new VideoConfigurationError('尚未配置视频模型的 Base URL');
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('协议不受支持');
    }
  } catch {
    throw new VideoConfigurationError('视频模型的 Base URL 无效，请填写 http:// 或 https:// 地址');
  }
  // 用户粘贴完整 endpoint 时保留原路径版本：/api/generate 不应被悄悄改成 /v1/api/generate。
  if (isFullEndpoint) return base;
  if (/^https?:\/\/[^/]+$/i.test(base)) return `${base}/v1`;
  // 已经形如 /v1、/v1beta、/v2alpha 的版本段不要再追加 /v1（曾拼出 /v1beta/v1）
  if (/\/v\d+[a-z]*$/i.test(base)) return base;
  return `${base}/v1`;
}

function videoModelOf(profile: ModelProfile, requested?: string): string {
  const model = String(requested || profile.model || '').trim();
  if (!model) throw new VideoConfigurationError('尚未选择视频模型：请先在模型设置中填写模型名');
  return model;
}

/** 供协议探测复用：与真实请求完全同一套 Base URL 归一化。 */
export function videoBaseUrl(profile: ModelProfile): string {
  return videoBase(profile);
}

/** 供协议探测复用：与真实请求完全同一套鉴权头。 */
export function videoAuthHeaders(apiKey: string): Record<string, string> {
  return providerAuthHeaders(apiKey);
}

export function validateVideoConfig(profile: ModelProfile, requestedModel?: string): void {
  videoBase(profile);
  videoModelOf(profile, requestedModel);
  if (resolveVideoApiMode(profile, requestedModel) === 'custom') {
    const config = normalizeCustomVideoApiConfig(profile.videoCustomConfig);
    if (!config.createPath.trim()) throw new VideoConfigurationError('自定义视频协议缺少提交路径');
    if (!config.pollPath.trim()) throw new VideoConfigurationError('自定义异步视频协议缺少查询任务路径');
    if (!config.outputUrlPath.trim()) throw new VideoConfigurationError('自定义视频协议缺少视频地址字段路径');
    renderVideoRequestTemplate(config.requestBodyTemplate, videoTemplateValues(profile, {
      prompt: 'test',
      model: requestedModel || profile.model,
    }));
    renderVideoHeadersTemplate(config.headersTemplate, { apiKey: profile.apiKey });
    parseCustomStatusMap(config.statusMap);
    if (!config.pollPath.includes('{{taskId}}')) {
      throw new VideoConfigurationError('轮询路径需要包含 {{taskId}}，例如 /videos/{{taskId}}');
    }
  }
}

export function videoImagesUseDataUrls(profile: ModelProfile): boolean {
  const mode = resolveVideoApiMode(profile);
  return mode === 'xai-videos'
    || (mode === 'custom' && customVideoConfig(profile).imageTransport === 'data-url');
}

/**
 * 选择协议适配器：显式配置优先，旧配置按 Base URL / 模型名自动识别。
 * 这里不把所有 GrsAI 模型写死，后续同一协议新增模型也能复用。
 */
export function resolveVideoApiMode(profile: ModelProfile, requestedModel?: string): VideoApiMode {
  const configured = normalizeVideoApiMode(profile.videoApiMode);
  if (configured !== 'auto') return configured;
  const base = String(profile.baseUrl || '').toLowerCase();
  const model = String(requestedModel || profile.model || '').toLowerCase();
  if (/\/videos\/generations(?:\/|$)/.test(base)) return 'xai-videos';
  try {
    if (new URL(profile.baseUrl).hostname.toLowerCase() === 'api.x.ai') return 'xai-videos';
  } catch {
    // The URL validation below returns the user-facing configuration error.
  }
  // 用户可能直接把 /v1/api/generate 或 /v1/api/result 粘进 Base URL，
  // 这比按供应商域名猜协议可靠，也能覆盖未收录的中转站域名。
  if (/\/media\/(?:generate|status)(?:\/|$)/.test(base) || /(?:lk888|kk0606)/.test(base)) return 'media-v1';
  if (/\/api\/(?:generate|result)(?:\/|$)/.test(base)) return 'grsai-generate';
  return /grsai|dakka/.test(base) || /minimax[-_]?h3/.test(model)
    ? 'grsai-generate'
    : 'openai-videos';
}

function grsaiAspectRatio(value: unknown): 'portrait' | 'landscape' {
  const ratio = normalizeVideoRatio(value);
  return ratio === '9:16' || ratio === '3:4' ? 'portrait' : 'landscape';
}

/**
 * 分辨率归一化：不同中转站/模型的分辨率命名千差万别,这里按模型自适应。
 * - GrsAI: 720p → 768p (怪异命名,文档写死)
 * - Minimax-H3: 只认 SD / HD,不认数字档位
 * - Kling / Seedance / Grok: 直接用 480p / 720p / 1080p
 * - 其他中转站: 原样透传,让上游自己处理
 */
function resolveVideoResolution(profile: ModelProfile, requested: VideoResolution, requestedModel?: string): string {
  const mode = resolveVideoApiMode(profile, requestedModel);
  const model = String(requestedModel || profile.model || '').toLowerCase();

  // GrsAI 协议优先：它按像素档位收参数（720p 那档叫 768p）。
  // 真实调用验证过：GrsAI 的 minimax-h3 不认 SD/HD，发过去会报 "resolution not found: SD"。
  if (mode === 'grsai-generate' || /grsai|dakka/.test(String(profile.baseUrl || '').toLowerCase())) {
    return requested === '720p' ? '768p' : requested;
  }

  // Minimax 原生 API：480p→SD, 720p/1080p→HD（只有两档）。
  // 只在中转站不是 GrsAI 时才走这条，避免把原生命名发给 GrsAI。
  if (/minimax[-_]?h3/i.test(model)) {
    if (requested === '480p') return 'SD';
    return 'HD';
  }

  // 其他模型: 原样透传 480p / 720p / 1080p
  return requested;
}

function grsaiDuration(profile: ModelProfile, seconds: unknown, resolution: unknown, model?: string): number {
  const requested = normalizeVideoSeconds(seconds);
  const resolvedResolution = resolveVideoResolution(profile, normalizeVideoResolution(resolution), model);
  // GrsAI 的 1080p 最多 10 秒
  return resolvedResolution === '1080p' ? Math.min(requested, 10) : requested;
}

function isManxiaobaiVideoApi(profile: ModelProfile): boolean {
  try {
    return new URL(profile.baseUrl).hostname.toLowerCase() === 'api.manxiaobai.online';
  } catch {
    return false;
  }
}

/** 错误详情美化：中转站常返回 {"error":{"message":"..."}}，提炼成一句人能读的话。 */
function describeVideoError(status: number, detail: string): string {
  const trimmed = String(detail || '').trim();
  if (!trimmed) return `视频接口返回 ${status}`;
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string }; message?: string };
    const message = parsed?.error?.message || parsed?.message;
    if (message) return `视频接口返回 ${status}：${String(message).slice(0, 200)}`;
  } catch {
    /* 非 JSON：原样截断展示 */
  }
  return `视频接口返回 ${status}：${trimmed.slice(0, 200)}`;
}

/**
 * 常见 OpenAI Videos 兼容协议。
 *
 * 只发上游文档明确列出的字段，避免严格校验的中转站因为多余键直接 400：
 * - 兼容中转站常见的视频协议字段；Grok 仅保留既有代理兼容形状
 * - xAI 官方格式由单独的 xai-videos 适配器处理
 * - `generate_audio`、`watermark` 只在显式开启时附带（不主动发 false）
 * - `resolution` 对中转站不保证精确交付，默认不发；调用方显式指定非默认值时才带上
 */
function buildOpenAiCreateBody(
  profile: ModelProfile,
  params: VideoCreateParams,
): Record<string, unknown> {
  const model = videoModelOf(profile, params.model);
  const imageUrls = (params.imageUrls || []).map((item) => String(item || '').trim()).filter(Boolean);
  const grok = /grok/i.test(model);
  const manxiaobai = isManxiaobaiVideoApi(profile);
  const manxiaobaiDocumentedGrokModel = manxiaobai && /^grok-video-1\.[015](?:[-_]|$)/i.test(model);
  const manxiaobaiGrokImagineModel = manxiaobai && /^grok-imagine-video(?:-1\.5)?-6s$/i.test(model);
  const body: Record<string, unknown> = {
    model,
    prompt: String(params.prompt || '').trim(),
    // manxiaobai 文档建议字符串；整数虽然也接受，但字符串兼容面更广
    seconds: String(normalizeVideoSeconds(params.seconds)),
    ...(grok
      ? { aspect_ratio: normalizeVideoRatio(params.ratio) }
      : { ratio: normalizeVideoRatio(params.ratio) }),
  };
  if (imageUrls.length > 0) {
    if (grok) {
      if (manxiaobaiGrokImagineModel) {
        body.reference_images = imageUrls;
      } else if (manxiaobaiDocumentedGrokModel) body.image_urls = imageUrls;
      else if (imageUrls.length === 1) body.image = imageUrls[0];
      else body.reference_images = imageUrls;
    } else {
      body.images = imageUrls;
    }
  }
  if (params.generateAudio === true) body.generate_audio = true;
  if (params.watermark === true) body.watermark = true;
  // 只有调用方明确指定、且不是默认档位时才发分辨率（中转站多为建议值）
  if (params.resolution && normalizeVideoResolution(params.resolution) !== '480p') {
    body.resolution = resolveVideoResolution(profile, normalizeVideoResolution(params.resolution), model);
  }
  return body;
}

function buildXaiCreateBody(profile: ModelProfile, params: VideoCreateParams): Record<string, unknown> {
  const model = videoModelOf(profile, params.model);
  const normalizedModel = model.toLowerCase();
  const imageUrls = (params.imageUrls || []).map((item) => String(item || '').trim()).filter(Boolean);
  validateVideoImageDataUrls(imageUrls);
  const isGrokImagine = /grok[-_]imagine[-_]video/.test(normalizedModel);
  const isGrokImagine15 = /grok[-_]imagine[-_]video[-_]1[._]5(?:[-_]|$)/.test(normalizedModel)
    && !/lite/.test(normalizedModel);
  const isGrokImagineLite = /grok[-_]imagine[-_]video.*lite/.test(normalizedModel);
  const hasPinnedLastFrame = imageUrls.length > 0
    && (params.referenceMode === 'last_frame' || (imageUrls.length > 1 && params.referenceMode !== 'style'));
  const usesReferenceToVideo = imageUrls.length > 0 && (params.referenceMode === 'style' || hasPinnedLastFrame);
  const requestedSeconds = normalizeVideoSeconds(params.seconds);
  const requestedResolution = normalizeVideoResolution(params.resolution);

  if (isGrokImagine && hasPinnedLastFrame && !isGrokImagine15) {
    throw new VideoConfigurationError('当前 Grok 模型不支持首尾帧；请选用 grok-imagine-video-1.5');
  }
  if (isGrokImagineLite && params.referenceMode === 'style' && imageUrls.length > 0) {
    throw new VideoConfigurationError('Grok Imagine Video 1.5 Lite 不支持风格参考图，请改为首帧模式或更换模型');
  }
  if (isGrokImagine && params.referenceMode === 'style' && imageUrls.length > (isGrokImagine15 ? 14 : 7)) {
    throw new VideoConfigurationError(`当前 Grok 模型风格参考最多支持 ${isGrokImagine15 ? 14 : 7} 张图片`);
  }
  if (isGrokImagine && usesReferenceToVideo && !isGrokImagine15 && requestedSeconds > 10) {
    throw new VideoConfigurationError('当前 Grok 模型的参考生视频最长 10 秒');
  }
  if (isGrokImagine && requestedResolution === '1080p' && (usesReferenceToVideo || !isGrokImagine15 && !isGrokImagineLite)) {
    throw new VideoConfigurationError('当前 Grok 模型的参考生视频最高支持 720p');
  }

  const body: Record<string, unknown> = {
    model,
    prompt: String(params.prompt || '').trim(),
    duration: requestedSeconds,
    aspect_ratio: normalizeVideoRatio(params.ratio),
    resolution: resolveVideoResolution(profile, requestedResolution, model),
    generate_audio: params.generateAudio === true,
  };

  if (!isGrokImagine && params.referenceMode === 'style' && imageUrls.length > 14) {
    throw new VideoConfigurationError('xAI 风格参考最多支持 14 张图片');
  }
  if (params.referenceMode !== 'style' && imageUrls.length > 2) {
    throw new VideoConfigurationError('xAI 首尾帧模式最多支持两张图片；更多参考图请切换到风格参考');
  }
  if (params.referenceMode === 'style' && imageUrls.length > 0) {
    body.reference_images = imageUrls.map((url) => ({ url }));
  } else if (imageUrls.length > 0) {
    if (params.referenceMode === 'last_frame' && imageUrls.length === 1) {
      body.last_frame = { url: imageUrls[0] };
    } else {
      body.image = { url: imageUrls[0] };
      if (imageUrls.length > 1) body.last_frame = { url: imageUrls[1] };
    }
  }

  return body;
}

function videoTemplateValues(profile: ModelProfile, params: VideoCreateParams): Record<string, unknown> {
  const images = (params.imageUrls || []).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    model: videoModelOf(profile, params.model),
    prompt: String(params.prompt || '').trim(),
    seconds: normalizeVideoSeconds(params.seconds),
    secondsString: String(normalizeVideoSeconds(params.seconds)),
    resolution: resolveVideoResolution(profile, normalizeVideoResolution(params.resolution), params.model),
    ratio: normalizeVideoRatio(params.ratio),
    generateAudio: params.generateAudio === true,
    watermark: params.watermark === true,
    referenceMode: params.referenceMode || 'first_frame',
    imageUrls: images,
    firstImageUrl: images[0] || '',
    lastImageUrl: images.length > 1 ? images[images.length - 1] : '',
    params: params.extraParams || {},
    apiKey: profile.apiKey,
  };
}

function customVideoConfig(profile: ModelProfile): CustomVideoApiConfig {
  return normalizeCustomVideoApiConfig(profile.videoCustomConfig);
}

function customVideoEndpoint(profile: ModelProfile, route: string, taskId?: string): string {
  const configRoute = String(route || '').trim();
  if (!configRoute) throw new VideoConfigurationError('自定义视频协议缺少请求路径');
  const resolvedRoute = taskId
    ? configRoute.replace(/\{\{\s*taskId\s*\}\}/g, encodeURIComponent(taskId))
    : configRoute;
  if (/\{\{[^}]+\}\}/.test(resolvedRoute)) {
    throw new VideoConfigurationError('请求路径包含未支持的变量；轮询路径仅支持 {{taskId}}');
  }
  if (/^https?:\/\//i.test(resolvedRoute)) return resolvedRoute;
  return `${videoBase(profile)}/${resolvedRoute.replace(/^\/+/, '')}`;
}

function customVideoHeaders(profile: ModelProfile, config: CustomVideoApiConfig): Record<string, string> {
  const custom = renderVideoHeadersTemplate(config.headersTemplate, { apiKey: profile.apiKey });
  const hasCustomAuth = Object.keys(custom).some((name) => /^(authorization|x-api-key|api-key)$/i.test(name));
  return {
    ...(!hasCustomAuth ? providerAuthHeaders(profile.apiKey) : {}),
    ...custom,
  };
}

function parseCustomStatusMap(value: string): Record<string, VideoTaskStatus> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value || '{}')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'JSON 格式错误';
    throw new VideoConfigurationError(`视频状态映射不是有效 JSON：${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VideoConfigurationError('视频状态映射必须是 JSON 对象');
  }
  const allowed = new Set<VideoTaskStatus>(['queued', 'in_progress', 'completed', 'failed']);
  const result: Record<string, VideoTaskStatus> = {};
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof raw !== 'string' || !allowed.has(raw as VideoTaskStatus)) {
      throw new VideoConfigurationError(`状态映射「${key}」只能映射到 queued / in_progress / completed / failed`);
    }
    result[key.trim().toLowerCase()] = raw as VideoTaskStatus;
  }
  return result;
}

function customStatus(value: unknown, config: CustomVideoApiConfig): VideoTaskStatus {
  const raw = String(value || '').trim().toLowerCase();
  const mapped = parseCustomStatusMap(config.statusMap)[raw];
  return mapped || normalizeVideoStatus(value);
}

function customText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.message || record.error || '').trim();
  }
  return '';
}

function customProgress(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? '').replace('%', ''));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

function customVideoSnapshot(
  data: Record<string, unknown> | null,
  config: CustomVideoApiConfig,
  fallbackId = '',
  creating = false,
): VideoTaskSnapshot {
  const taskId = customText(readVideoResponsePath(data, config.taskIdPath)) || fallbackId;
  const statusValue = readVideoResponsePath(data, config.statusPath);
  const outputUrl = customText(readVideoResponsePath(data, config.outputUrlPath));
  const error = customText(readVideoResponsePath(data, config.errorPath));
  const mappedStatus = customStatus(statusValue, config);
  if (mappedStatus === 'failed' || (error && mappedStatus !== 'completed')) {
    return {
      id: taskId,
      status: 'failed',
      progress: customProgress(readVideoResponsePath(data, config.progressPath)),
      error: error || '视频生成失败',
      outputUrl: outputUrl || undefined,
    };
  }
  const status = outputUrl
    ? 'completed'
    : mappedStatus === 'completed'
      ? (creating ? 'queued' : 'completed')
      : mappedStatus;
  return {
    id: taskId,
    status: creating && status === 'unknown' ? 'queued' : status,
    progress: outputUrl ? 100 : customProgress(readVideoResponsePath(data, config.progressPath)),
    error: undefined,
    outputUrl: outputUrl || undefined,
  };
}

export function buildGrsaiCreateBody(profile: ModelProfile, params: VideoCreateParams): Record<string, unknown> {
  const model = videoModelOf(profile, params.model);
  const imageUrls = (params.imageUrls || []).map((item) => String(item || '').trim()).filter(Boolean);
  const body: Record<string, unknown> = {
    model,
    prompt: String(params.prompt || '').trim(),
    aspectRatio: grsaiAspectRatio(params.ratio),
    resolution: resolveVideoResolution(profile, normalizeVideoResolution(params.resolution), model),
    duration: grsaiDuration(profile, params.seconds, params.resolution, model),
    promptSkill: true,
    replyType: 'async',
  };
  // 没有参考图时不要发空数组；部分中转站会把 images: [] 当成非法图生视频参数。
  if (imageUrls.length > 0) body.images = imageUrls;
  return body;
}

/** KK 等中转站的媒体协议：固定 /media/generate，业务参数整体放在 params。 */
export function buildMediaCreateBody(profile: ModelProfile, params: VideoCreateParams): Record<string, unknown> {
  const model = videoModelOf(profile, params.model);
  const imageUrls = (params.imageUrls || []).map((item) => String(item || '').trim()).filter(Boolean);
  // schema 给出的参数优先：字段名与可选值都按模型自己的定义走。
  const mediaParams: Record<string, unknown> = { ...(params.extraParams || {}) };

  // 只有 schema 没覆盖时才补画布上的通用三件套——否则 images / img_url 这类
  // 各家不同的字段名会被写错，上游直接报参数不合法。
  const hasRatio = 'aspect_ratio' in mediaParams || 'ratio' in mediaParams;
  const hasDuration = 'duration' in mediaParams || 'seconds' in mediaParams;
  const hasResolution = 'resolution' in mediaParams;
  if (!hasRatio) mediaParams.aspect_ratio = normalizeVideoRatio(params.ratio);
  if (!hasDuration) mediaParams.duration = String(normalizeVideoSeconds(params.seconds));
  if (!hasResolution) {
    // 该站的 Seedance 2.0 参考生模型只接受 720p；不把画布上的其他档位原样透传。
    mediaParams.resolution = /seedance[-_]?2\.0[-_]?anci/i.test(model)
      ? '720p'
      : resolveVideoResolution(profile, normalizeVideoResolution(params.resolution), model);
  }

  if (imageUrls.length > 0) {
    // 参考图落在模型自己声明的 upload 参数上（images / img_url …），缺省退回 images。
    const imageKey = String(params.imageParamName || '').trim() || 'images';
    mediaParams[imageKey] = imageUrls;
    // seedance 的参考生模型需要 mode=cankaosheng；schema 已经给了就不要覆盖。
    if (!('mode' in mediaParams) && /seedance[-_]?2\.0[-_]?anci/i.test(model)) {
      mediaParams.mode = 'cankaosheng';
    }
  }

  return { model, prompt: String(params.prompt || '').trim(), params: mediaParams };
}

/** 提交创建任务。只提交、不重试：断线或超时时由调用方落「提交结果未知」，事后人工核查。 */
export async function createVideoTask(profile: ModelProfile, params: VideoCreateParams): Promise<VideoTaskSnapshot> {
  if (!profile.apiKey) {
    throw new VideoConfigurationError(`尚未配置 API Key：请在绘板「生图设置」的「${profile.name}」里填写`);
  }
  const prompt = String(params.prompt || '').trim();
  if (!prompt) throw new Error('提示词不能为空');
  const mode = resolveVideoApiMode(profile, params.model);
  const base = videoBase(profile);
  const config = mode === 'custom' ? customVideoConfig(profile) : undefined;
  const primaryEndpoint = mode === 'grsai-generate'
    ? `${base}/api/generate`
    : mode === 'media-v1'
      ? `${base}/media/generate`
      : mode === 'custom'
        ? customVideoEndpoint(profile, config!.createPath)
        : mode === 'xai-videos'
          ? `${base}/videos/generations`
          : `${base}/videos`;
  const requestBody = mode === 'grsai-generate'
    ? buildGrsaiCreateBody(profile, params)
    : mode === 'media-v1'
      ? buildMediaCreateBody(profile, params)
      : mode === 'custom'
        ? renderVideoRequestTemplate(config!.requestBodyTemplate, videoTemplateValues(profile, params))
        : mode === 'xai-videos'
          ? buildXaiCreateBody(profile, params)
          : buildOpenAiCreateBody(profile, params);
  const send = (endpoint: string, body: Record<string, unknown>) => fetch(endpoint, {
    method: 'POST',
    headers: {
      ...(mode === 'custom' ? customVideoHeaders(profile, config!) : providerAuthHeaders(profile.apiKey)),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: params.signal || AbortSignal.timeout(CREATE_TIMEOUT_MS),
  });
  let response = await send(primaryEndpoint, requestBody);
  // 旧 OpenAI 代理常用此兼容入口；xAI 请求只发送一次，避免重复下单。
  if (mode === 'openai-videos' && response.status === 404) {
    response = await send(`${base}/video/generations`, requestBody);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new VideoRequestError(response.status, detail);
  }
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  const nested = (data?.data && typeof data.data === 'object' ? data.data : {}) as Record<string, unknown>;
  if (mode === 'custom') {
    const snapshot = customVideoSnapshot(data, config!, '', true);
    const code = Number(data?.code ?? nested.code ?? data?.error_code ?? nested.error_code);
    const errorMessage = customText(readVideoResponsePath(data, config!.errorPath));
    if (snapshot.status === 'failed' || data?.success === false || nested.success === false
      || (Number.isFinite(code) && code !== 0 && code !== 200)) {
      throw new VideoRequestError(200, errorMessage || '自定义视频接口报告任务失败', true);
    }
    if (!snapshot.id && !snapshot.outputUrl) {
      throw new VideoRequestError(200, errorMessage || `自定义视频接口未返回任务 ID 或成品地址：${JSON.stringify(data ?? {}).slice(0, 200)}`, true);
    }
    if (!snapshot.outputUrl && !config!.pollPath.trim()) {
      throw new VideoRequestError(200, '自定义视频接口返回了任务 ID，但没有配置查询任务路径', true);
    }
    return {
      ...snapshot,
      id: snapshot.id || `local_video_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    };
  }
  // 所有协议都先看错误信封：有些站 HTTP 200 但 body 是 {error:{...}} / {code:400}
  assertBusinessSuccess(data, nested);
  const outputUrl = readVideoOutputUrl(data, nested);
  const upstreamId = String(data?.id || data?.request_id || data?.task_id || data?.taskId || nested.id || nested.request_id || nested.task_id || nested.taskId || '').trim();
  // 少数同步协议只返回视频地址、不返回任务 id；成功下载时用本地 id 绑定记录，
  // 这样节点仍能收到结果。若后续下载失败，调用方不会把这个本地 id 当成上游任务继续查询。
  const id = upstreamId || (outputUrl ? `local_video_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}` : '');
  const responseStatus = normalizeVideoStatus(readStatusField(data, nested));
  if (responseStatus === 'failed') {
    throw new VideoRequestError(200, readVideoError(data, nested) || '视频生成失败', true);
  }
  if (!id) {
    // HTTP 成功但既没有任务 id 也没有成品地址：这是**明确**的协议/参数错误，
    // 不是「结果未知」——不能把节点锁死在「可能已扣费」。
    const snippet = JSON.stringify(data ?? {}).slice(0, 200);
    throw new VideoRequestError(200, `视频接口未返回任务 id 或视频地址：${snippet}`, true);
  }
  const status = outputUrl
    ? 'completed'
    : responseStatus === 'unknown' || responseStatus === 'completed'
      ? 'queued'
      : responseStatus;
  return {
    id,
    status,
    progress: outputUrl ? 100 : readVideoProgress(data, nested),
    // 失败态在上面已经抛出；这里成功响应里的 msg 是「Task created successfully」之类，不能当错误
    error: undefined,
    outputUrl: outputUrl || undefined,
  };
}

/** 查询任务：状态兼容顶层与 data.status 两种封装，大小写归一。 */
export async function getVideoTask(profile: ModelProfile, taskId: string, model?: string): Promise<VideoTaskSnapshot> {
  const id = String(taskId || '').trim();
  if (!id) throw new Error('缺少任务 id');
  const mode = resolveVideoApiMode(profile, model);
  const config = mode === 'custom' ? customVideoConfig(profile) : undefined;
  const url = mode === 'grsai-generate'
    ? `${videoBase(profile)}/api/result?id=${encodeURIComponent(id)}`
    : mode === 'media-v1'
      ? `${videoBase(profile)}/media/status?task_id=${encodeURIComponent(id)}`
      : mode === 'custom'
        ? customVideoEndpoint(profile, config!.pollPath, id)
        : `${videoBase(profile)}/videos/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    headers: mode === 'custom' ? customVideoHeaders(profile, config!) : providerAuthHeaders(profile.apiKey),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new VideoRequestError(response.status, await response.text().catch(() => ''));
  }
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  const nested = (data?.data && typeof data.data === 'object' ? data.data : {}) as Record<string, unknown>;
  if (mode === 'custom') {
    const snapshot = customVideoSnapshot(data, config!, id);
    const code = Number(data?.code ?? nested.code ?? data?.error_code ?? nested.error_code);
    if (snapshot.status === 'failed' || data?.success === false || nested.success === false
      || (Number.isFinite(code) && code !== 0 && code !== 200)) {
      return {
        ...snapshot,
        id,
        status: 'failed',
        error: snapshot.error || '自定义视频接口报告任务失败',
      };
    }
    if (snapshot.status === 'completed' && !snapshot.outputUrl) {
      return {
        ...snapshot,
        id,
        status: 'failed',
        error: '任务已完成，但响应里没有视频地址；请检查「视频地址路径」配置',
      };
    }
    return { ...snapshot, id };
  }
  const outputUrl = readVideoOutputUrl(data, nested);
  if (mode === 'media-v1') {
    return { id, ...readMediaStatus(data, nested, outputUrl) };
  }
  // 查询接口的「错误信封」不抛异常——轮询器需要把它落成 failed，
  // 抛出去会被 catch 当成网络抖动，白等 50 分钟。
  const code = Number(data?.code ?? nested.code);
  const businessFailed = (Number.isFinite(code) && code !== 0 && code !== 200)
    || data?.success === false
    || nested.success === false;
  if (businessFailed) {
    return {
      id,
      status: 'failed',
      progress: readVideoProgress(data, nested),
      error: readVideoError(data, nested) || `视频接口业务错误 code ${code}`,
      outputUrl: outputUrl || undefined,
    };
  }
  const responseStatus = normalizeVideoStatus(readStatusField(data, nested));
  if (responseStatus === 'failed') {
    return {
      id,
      status: 'failed',
      progress: readVideoProgress(data, nested),
      error: readVideoError(data, nested) || '视频生成失败',
      outputUrl: outputUrl || undefined,
    };
  }
  // 已完成但暂时没给地址：
  // - openai-videos 有 /content 兜底，直接算完成（下载阶段拿文件）
  // - media-v1 / grsai 只能等结果地址，继续轮询
  const status: VideoTaskStatus = outputUrl
    ? 'completed'
      : responseStatus === 'completed'
        ? (mode === 'openai-videos' ? 'completed' : 'in_progress')
      : responseStatus;
  return {
    id,
    status,
    progress: outputUrl ? 100 : readVideoProgress(data, nested),
    outputUrl: outputUrl || undefined,
  };
}

/**
 * media-v1 的状态字段是「人话」而不是枚举：state=success / status=生成完成 / status_group=已完成。
 * 官方给的判据是 is_final —— 完成与否只看它，别用 state 猜。
 */
function readMediaStatus(
  data: Record<string, unknown> | null,
  nested: Record<string, unknown>,
  outputUrl: string,
): { status: VideoTaskStatus; progress: number; error?: string; outputUrl?: string } {
  const progress = readVideoProgress(data, nested);
  const rawError = readVideoError(data, nested) || '';
  const state = String(data?.state ?? nested.state ?? data?.status ?? nested.status ?? '').trim().toLowerCase();
  const group = String(data?.status_group ?? nested.status_group ?? '').trim();
  // is_final 各站写法不一：true / 1 / "true" / "True"
  const rawFinal = data?.is_final ?? nested.is_final ?? data?.isFinal ?? nested.isFinal;
  const isFinal = rawFinal === true || rawFinal === 1 || /^(true|1)$/i.test(String(rawFinal ?? '').trim());
  const failed = FAILED.includes(state)
    || /失败|拒绝|超时|取消/.test(state)
    || /失败|拒绝|超时|取消/.test(group)
    // 终态 + 错误信息 = 失败（文档判据），即使 state 没写 failed
    || (isFinal && Boolean(rawError));
  if (failed) {
    return {
      status: 'failed',
      progress,
      error: rawError || String(data?.status ?? nested.status ?? '视频生成失败'),
    };
  }
  if (outputUrl) {
    return { status: 'completed', progress: 100, outputUrl };
  }
  if (isFinal) {
    // is_final 为真却没给地址：部分站点会延后一两个 tick 才回填 URL，继续轮询别判死。
    return { status: 'in_progress', progress };
  }
  const normalized = normalizeVideoStatus(state);
  return { status: normalized === 'queued' ? 'queued' : 'in_progress', progress };
}

function asUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从任意「结果对象」里取视频地址：各家字段名不一（url / video_url / output_url / result_url …）。 */
function urlFromObject(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  for (const key of [
    'url', 'video_url', 'videoUrl', 'output_url', 'outputUrl', 'result_url', 'resultUrl',
    'play_url', 'playUrl', 'download_url', 'downloadUrl', 'src', 'output',
  ]) {
    const url = asUrl(obj[key]);
    if (url) return url;
  }
  for (const key of ['video', 'result', 'data', 'task', 'file']) {
    const nestedValue = obj[key];
    if (nestedValue && typeof nestedValue === 'object') {
      const url = urlFromObject(nestedValue);
      if (url) return url;
    }
  }
  return '';
}

function urlFromList(value: unknown): string {
  if (!Array.isArray(value)) return '';
  for (const item of value) {
    const url = urlFromObject(item);
    if (url) return url;
  }
  return '';
}

/**
 * 结果地址解析。中转站的真实形状远比「results[0].url」丰富：
 *   { output }、{ result:{url} }、{ result_url }、{ videos:[{url}] }、
 *   { outputs:[...] }、{ files:[...] }、{ results:["https://…"] }、{ data:{…} }
 * 这里统一按「列表 → 对象 → 标量」三层扫，漏掉任何一种都会让已完成的任务永远拿不到视频。
 */
export function readVideoOutputUrl(data: Record<string, unknown> | null, nested: Record<string, unknown>): string {
  for (const source of [data, nested]) {
    if (!source) continue;
    for (const key of ['results', 'videos', 'outputs', 'files', 'items', 'data_list']) {
      const url = urlFromList(source[key]);
      if (url) return url;
    }
    for (const key of ['output', 'result', 'video', 'task', 'file', 'data']) {
      const url = urlFromObject(source[key]);
      if (url) return url;
    }
    for (const key of [
      'url', 'video_url', 'videoUrl', 'output_url', 'outputUrl',
      'result_url', 'resultUrl', 'play_url', 'download_url',
    ]) {
      const url = asUrl(source[key]);
      if (url) return url;
    }
  }
  return '';
}

function readVideoProgress(data: Record<string, unknown> | null, nested: Record<string, unknown>): number {
  const raw = data?.progress ?? nested.progress ?? 0;
  if (typeof raw === 'string' && raw.trim().endsWith('%')) {
    const parsed = Number.parseFloat(raw);
    return Math.max(0, Math.min(100, Number.isFinite(parsed) ? parsed : 0));
  }
  return Math.max(0, Math.min(100, Number(raw) || 0));
}

function readVideoError(data: Record<string, unknown> | null, nested: Record<string, unknown>): string | undefined {
  for (const source of [data, nested]) {
    if (!source) continue;
    for (const key of [
      'error', 'fail_reason', 'failReason', 'failure_reason', 'failureReason',
      'reason', 'error_message', 'errorMessage', 'error_msg', '详情', 'detail', 'message',
    ]) {
      const value = source[key];
      if (value == null) continue;
      const message = value && typeof value === 'object'
        ? ((value as Record<string, unknown>).message
          || (value as Record<string, unknown>).msg
          || (value as Record<string, unknown>).detail)
        : value;
      const text = String(message ?? '').trim();
      if (text) return text.slice(0, 300);
    }
  }
  // msg 在成功响应里常是「Task created successfully」这类文案，只在没有其它错误字段时兜底
  const fallback = data?.msg ?? nested.msg;
  return fallback ? String(fallback).slice(0, 300) : undefined;
}

function assertBusinessSuccess(data: Record<string, unknown> | null, nested: Record<string, unknown>): void {
  const code = Number(data?.code ?? nested.code ?? (data?.error as Record<string, unknown> | undefined)?.code);
  const errorCode = Number(data?.error_code ?? nested.error_code);
  const message = readVideoError(data, nested);
  if (Number.isFinite(code) && code !== 0 && code !== 200) {
    throw new VideoRequestError(200, message || `视频接口业务错误 code ${code}`, true);
  }
  if (Number.isFinite(errorCode) && errorCode !== 0) {
    throw new VideoRequestError(200, message || `视频接口业务错误 error_code ${errorCode}`, true);
  }
  if (data?.success === false || nested.success === false) {
    throw new VideoRequestError(200, message || '视频接口请求失败', true);
  }
  // 有些站 HTTP 200 + {error:{...}}；没有任务 id / 成品地址时按确定失败处理
  const hasPayload = Boolean(readVideoOutputUrl(data, nested))
    || Boolean(data?.id || data?.task_id || nested.id || nested.task_id);
  const explicitError = data?.error ?? nested.error;
  if (!hasPayload && explicitError != null && explicitError !== '') {
    throw new VideoRequestError(200, message || '视频接口请求失败', true);
  }
  const status = String(readStatusField(data, nested) ?? '').trim().toLowerCase();
  if (!hasPayload && (status === 'error' || status === 'failed')) {
    throw new VideoRequestError(200, message || '视频生成失败', true);
  }
}

/**
 * 下载成品。走带鉴权的 /content 端点，不解析结果里的外部 URL——
 * 那些是临时地址，过期就没了，而且不带 Key 也未必能再访问。
 */
export async function downloadVideoContent(profile: ModelProfile, taskId: string, model?: string): Promise<SavedFile> {
  if (resolveVideoApiMode(profile, model) !== 'openai-videos') {
    throw new Error('当前视频协议应使用返回结果中的视频地址下载');
  }
  const id = String(taskId || '').trim();
  if (!id) throw new Error('缺少任务 id');
  const response = await fetch(`${videoBase(profile)}/videos/${encodeURIComponent(id)}/content`, {
    headers: providerAuthHeaders(profile.apiKey),
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new VideoRequestError(response.status, await response.text().catch(() => ''));
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  assertDownloadedVideoBuffer(buffer, contentType, '下载接口返回的是网页而不是视频文件（该中转站可能不支持 /content，只提供结果地址）');
  return saveVideoBuffer(buffer);
}

/** 同步协议返回的公网视频地址：下载后统一落本地媒体目录，避免临时 URL 过期。 */
export async function downloadVideoUrl(url: string, apiKey = '', providerBaseUrl = ''): Promise<SavedFile> {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error(`视频接口返回了非法的视频地址：${target.slice(0, 120)}`);
  let headers: Record<string, string> | undefined;
  if (apiKey && providerBaseUrl) {
    try {
      if (new URL(target).origin === new URL(providerBaseUrl).origin) headers = providerAuthHeaders(apiKey);
    } catch {
      headers = undefined;
    }
  }
  const response = await fetch(target, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new VideoRequestError(response.status, await response.text().catch(() => ''));
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  assertDownloadedVideoBuffer(buffer, contentType, '视频地址返回的是网页而不是视频文件（可能需要登录或链接已过期）');
  // 不再因为容器头不标准就判失败：部分 CDN 会返回 fMP4 / 分片，交给 <video> 播放器判断。
  const hint = (() => {
    try {
      return new URL(target).pathname.split('.').pop() || '';
    } catch {
      return '';
    }
  })();
  return saveVideoBuffer(buffer, hint);
}

/** 连接测试：视频没有「发一次试试」的廉价探针，用模型列表验证 Key 与视频分组权限。 */
export async function probeVideoConnection(profile: ModelProfile): Promise<string> {
  if (!profile.apiKey) throw new Error('尚未配置 API Key：请先填写并保存');
  const mode = resolveVideoApiMode(profile);
  if (mode === 'custom') {
    validateVideoConfig(profile);
    return '自定义视频请求模板已通过本地校验；未访问服务商，也未创建生成任务。实际生成可能产生费用。';
  }
  if (mode === 'grsai-generate') {
    return '已识别 GrsAI 视频协议；未发起生成请求。请手动填写服务商提供的视频模型名';
  }
  if (mode === 'media-v1') {
    const models = await listVideoModels(profile);
    if (models.length === 0) {
      return '连接成功，但这个 Key 没有可用的视频模型——请检查渠道分组权限，或改用默认策略';
    }
    return `连接成功，发现 ${models.length} 个视频模型：${models.slice(0, 5).map((item) => item.name).join('、')}`;
  }
  const response = await fetch(`${videoBase(profile)}/models`, {
    headers: providerAuthHeaders(profile.apiKey),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(describeVideoError(response.status, await response.text().catch(() => '')));
  }
  const data = await response.json().catch(() => null) as { data?: Array<{ id?: string }> } | null;
  const models = (data?.data || []).map((item) => String(item?.id || '')).filter(Boolean);
  const videoModels = models.filter((id) => looksLikeVideoModel(id));
  if (videoModels.length === 0) {
    return `连接成功，但模型列表里没看到视频模型（共 ${models.length} 个）——请确认令牌有「视频分组」权限`;
  }
  return `连接成功，发现 ${videoModels.length} 个视频模型：${videoModels.slice(0, 5).join('、')}`;
}

export { CREATE_TIMEOUT_MS };
