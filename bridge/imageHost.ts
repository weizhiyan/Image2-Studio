import fs from 'node:fs/promises';
import { IMAGE_HOST_FILE } from './paths.js';

/**
 * 图生视频的图片上传通道。
 *
 * 为什么需要它：中转站文档明文要求「素材必须是无需登录即可访问的有效 HTTPS 媒体地址」，
 * 不收二进制附件、不收内网/本机路径。绘板的图存在 ~/.huiban/media，经 /api/files 只在本机
 * 可达——不先把图变成一个公网地址，图生视频这条路整个是堵的。
 *
 * 做成通用上传器而不是写死某一家：用户自己填一个「收 multipart、返回 URL」的端点就能用
 * （catbox / sm.ms / imgbb / 自建图床 / 对象存储预签名网关都长这样）。
 * 存在独立文件而不是 settings.json：动配置结构有风险，这个跟模型配置也不是一回事。
 */

export interface ImageHostConfig {
  /** 上传端点：收 multipart 表单，返回 JSON 或纯文本 URL。 */
  uploadUrl: string;
  /** 表单里文件字段名；不同图床叫法不一（file / image / smfile）。 */
  fileField: string;
  /** 返回值里 URL 的字段，支持点号路径（如 data.url）；返回纯文本时留空。 */
  urlField: string;
  /** 额外请求头：放图床 token，别放到 URL 查询参数里。 */
  headers: Record<string, string>;
  /** 额外表单字段：如 catbox 的 reqtype=fileupload。 */
  extraFields: Record<string, string>;
}

export const EMPTY_IMAGE_HOST: ImageHostConfig = {
  uploadUrl: '',
  fileField: 'file',
  urlField: '',
  headers: {},
  extraFields: {},
};

/**
 * 内置预设。
 * - imgdb：免注册临时图床，URL 可设置一小时 TTL；作为本机参考图转公网链接的默认通道。
 * - litterbox / catbox：保留兼容已有自定义设置；Litterbox 服务不可用时不再作为默认值。
 */
export const IMAGE_HOST_PRESETS: Record<string, Partial<ImageHostConfig>> = {
  imgdb: {
    uploadUrl: 'https://imgdb.io/api/v1/upload?ttl=3600',
    fileField: 'file',
    urlField: 'url',
  },
  litterbox: {
    uploadUrl: 'https://litterbox.catbox.moe/resources/internals/api.php',
    fileField: 'fileToUpload',
    urlField: '',
    extraFields: { reqtype: 'fileupload', time: '1h' },
  },
  catbox: {
    uploadUrl: 'https://catbox.moe/user/api.php',
    fileField: 'fileToUpload',
    urlField: '',
    extraFields: { reqtype: 'fileupload' },
  },
};

const UPLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_ATTEMPTS = 2;

export async function readImageHost(): Promise<ImageHostConfig | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(IMAGE_HOST_FILE, 'utf8')) as Partial<ImageHostConfig>;
    const uploadUrl = String(parsed.uploadUrl || '').trim();
    if (!uploadUrl) return null;
    return {
      uploadUrl,
      fileField: String(parsed.fileField || 'file').trim() || 'file',
      urlField: String(parsed.urlField || '').trim(),
      headers: normalizeHeaders(parsed.headers),
      extraFields: normalizeFields(parsed.extraFields),
    };
  } catch {
    return null;
  }
}

/** 内置默认图床：ImgDB 临时上传接口，TTL 为 1 小时。 */
export function defaultImageHost(): ImageHostConfig {
  const preset = IMAGE_HOST_PRESETS.imgdb;
  return {
    uploadUrl: String(preset.uploadUrl || ''),
    fileField: preset.fileField || 'file',
    urlField: preset.urlField || 'url',
    headers: normalizeHeaders(preset.headers),
    extraFields: normalizeFields(preset.extraFields),
  };
}

/**
 * 识别曾经内置过的 Catbox / Litterbox 配置，自动迁移到当前默认图床。
 */
export function isLegacyDefaultImageHost(config: ImageHostConfig | null): boolean {
  if (!config) return false;
  const url = String(config.uploadUrl || '').trim();
  const noHeaders = Object.keys(config.headers || {}).length === 0;
  const legacyCatbox = url === 'https://catbox.moe/user/api.php'
    && noHeaders
    && config.extraFields.reqtype === 'fileupload'
    && Object.keys(config.extraFields || {}).length === 1;
  const legacyLitterbox = url === 'https://litterbox.catbox.moe/resources/internals/api.php'
    && noHeaders
    && config.fileField === 'fileToUpload'
    && config.extraFields.reqtype === 'fileupload'
    && config.extraFields.time === '1h'
    && Object.keys(config.extraFields || {}).length === 2;
  return legacyCatbox || legacyLitterbox;
}

/** 使用用户配置的图床；未配置或仍是旧版默认值时退回内置临时图床。 */
export async function resolveImageHost(): Promise<ImageHostConfig> {
  return effectiveImageHost(await readImageHost());
}

export function effectiveImageHost(config: ImageHostConfig | null): ImageHostConfig {
  if (!imageHostReady(config) || isLegacyDefaultImageHost(config)) return defaultImageHost();
  return config;
}

export async function writeImageHost(config: ImageHostConfig | null): Promise<ImageHostConfig | null> {
  if (!config || !String(config.uploadUrl || '').trim()) {
    await fs.rm(IMAGE_HOST_FILE, { force: true }).catch(() => undefined);
    return null;
  }
  const next: ImageHostConfig = {
    uploadUrl: String(config.uploadUrl).trim(),
    fileField: String(config.fileField || 'file').trim() || 'file',
    urlField: String(config.urlField || '').trim(),
    headers: normalizeHeaders(config.headers),
    extraFields: normalizeFields(config.extraFields),
  };
  const tmp = `${IMAGE_HOST_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmp, IMAGE_HOST_FILE);
  return next;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object') {
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const name = String(key || '').trim();
      if (name) out[name] = String(raw ?? '');
    }
  }
  return out;
}

function normalizeFields(value: unknown): Record<string, string> {
  return normalizeHeaders(value);
}

/** 从上传响应里挖 URL：先按配置的点号路径找，找不到就把整个纯文本响应当 URL。 */
function pickUrl(body: string, urlField: string): string {
  const trimmed = String(body || '').trim();
  if (!urlField) {
    return /^https?:\/\//i.test(trimmed) ? trimmed : '';
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    let cursor: unknown = parsed;
    for (const segment of urlField.split('.')) {
      if (cursor && typeof cursor === 'object') cursor = (cursor as Record<string, unknown>)[segment];
      else return '';
    }
    return String(cursor || '').trim();
  } catch {
    return '';
  }
}

export class ImageHostError extends Error {}

export function describeImageHostFailure(error: unknown, uploadUrl: string): string {
  let hostname = '当前图床';
  try {
    hostname = new URL(uploadUrl).hostname || hostname;
  } catch {
  }

  const message = error instanceof Error ? error.message : '未知网络错误';
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const causeCode = cause && typeof cause === 'object' && 'code' in cause
    ? String((cause as { code?: unknown }).code || '')
    : '';
  const isTimeout = (error instanceof Error && (error.name === 'TimeoutError' || /operation was aborted due to timeout/i.test(error.message)))
    || causeCode === 'ETIMEDOUT'
    || causeCode === 'UND_ERR_CONNECT_TIMEOUT';
  const reason = isTimeout
    ? `等待图床响应超时（${UPLOAD_TIMEOUT_MS / 1000} 秒）`
    : causeCode === 'UND_ERR_SOCKET'
    ? '对端提前关闭了连接（UND_ERR_SOCKET）'
    : causeCode === 'ENOTFOUND'
      ? '域名解析失败（ENOTFOUND）'
      : causeCode === 'ECONNRESET'
        ? '连接被重置（ECONNRESET）'
        : /fetch failed|failed to fetch/i.test(message)
          ? '网络请求失败'
          : message.slice(0, 180);

  return `首帧图片上传到图床 ${hostname} 失败：${reason}。视频服务尚未收到生成请求，修复图床后可以安全重试。`;
}

/** 把一段二进制上传成公网 HTTPS 地址。失败时抛错，由调用方决定是整条任务失败还是提示用户。 */
export async function uploadToImageHost(
  config: ImageHostConfig,
  file: { buffer: Buffer; fileName: string; contentType: string },
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    const form = new FormData();
    for (const [key, value] of Object.entries(config.extraFields)) form.append(key, value);
    form.append(config.fileField || 'file', new Blob([new Uint8Array(file.buffer)], { type: file.contentType }), file.fileName);
    try {
      const response = await fetch(config.uploadUrl, {
        method: 'POST',
        headers: { ...config.headers },
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      const body = await response.text().catch(() => '');
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        const isHtmlErrorPage = /text\/html/i.test(contentType) || /<(?:!doctype|html|head|body)\b/i.test(body);
        const details = isHtmlErrorPage ? '图床服务端返回错误页面' : body.slice(0, 160);
        throw new ImageHostError(`图床上传失败（HTTP ${response.status}）${details ? `：${details}` : ''}`);
      }
      const url = pickUrl(body, config.urlField);
      if (!/^https:\/\//i.test(url)) {
        throw new ImageHostError(`图床没有返回可用的 HTTPS 地址：${body.slice(0, 160)}`);
      }
      return url;
    } catch (error) {
      lastError = error;
      if (attempt === UPLOAD_ATTEMPTS || !isTransientImageHostError(error)) throw error;
    }
  }
  throw lastError;
}

function isTransientImageHostError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/operation was aborted due to timeout|timed? ?out|timeout/i.test(error.message)) return true;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === 'object' && 'code' in cause
    ? String((cause as { code?: unknown }).code || '')
    : '';
  return ['UND_ERR_SOCKET', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET'].includes(causeCode)
    || (error instanceof TypeError && /fetch failed|failed to fetch/i.test(error.message));
}

/** 上传配置是否可用：界面在用户填的时候就拿来给即时反馈。 */
export function imageHostReady(config: ImageHostConfig | null): config is ImageHostConfig {
  return Boolean(config && /^https:\/\//i.test(String(config.uploadUrl || '').trim()));
}
