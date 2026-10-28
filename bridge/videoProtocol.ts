import { normalizeVideoApiMode, type ModelProfile, type VideoApiMode } from './settings.js';
import { looksLikeVideoModel, resolveVideoApiMode, videoAuthHeaders, videoBaseUrl } from './videoApi.js';

/**
 * 视频协议探测：**只发 GET，不发 POST**。
 *
 * 用户的要求是「添加了视频模型就能用」，但各中转站的视频协议并不统一：
 *   - media-v1：/media/generate + /media/status，参数走 params（kk0606 / lk888）
 *   - openai-videos：OpenAI 风格 /v1/videos
 *   - xai-videos：xAI Grok Imagine /v1/videos/generations
 *   - grsai-generate：/api/generate + /api/result
 *
 * 运行时猜协议会让用户看到无法理解的 404。这里在「测试连接 / 获取模型 / 首次生成前」
 * 用只读接口确认协议，并把结果缓存；探测失败时给出低置信度的兜底和明确诊断。
 */

export type VideoProtocolConfidence = 'high' | 'medium' | 'low';

export interface VideoProtocolDetection {
  mode: Exclude<VideoApiMode, 'auto'>;
  confidence: VideoProtocolConfidence;
  /** 给用户看的一句话依据（测试连接 / 设置面板直接展示）。 */
  evidence: string;
  models?: string[];
}

const detectionCache = new Map<string, VideoProtocolDetection>();

function cacheKey(profile: ModelProfile): string {
  return `${profile.baseUrl || ''}|${profile.apiKey ? profile.apiKey.slice(-6) : ''}|${profile.model || ''}`;
}

/** 测试用：清空进程内缓存。 */
export function __resetVideoProtocolCacheForTest(): void {
  detectionCache.clear();
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

function collectModelNames(body: Record<string, unknown> | null): string[] {
  if (!body) return [];
  const lists = [body.models, body.data, body.items];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    return list
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') {
          const entry = item as Record<string, unknown>;
          return String(entry.name || entry.id || entry.model || '').trim();
        }
        return '';
      })
      .filter(Boolean);
  }
  return [];
}

/** Base URL 里已经粘了完整 endpoint 时，直接按路径判定协议（无需网络）。 */
function modeFromEndpointPath(baseUrl: string): Exclude<VideoApiMode, 'auto'> | null {
  const raw = String(baseUrl || '').toLowerCase();
  if (/\/media\/(?:generate|status)(?:\/|$)/.test(raw)) return 'media-v1';
  if (/\/api\/(?:generate|result)(?:\/|$)/.test(raw)) return 'grsai-generate';
  if (/\/videos\/generations(?:\/|$)/.test(raw)) return 'xai-videos';
  if (isXaiBaseUrl(baseUrl)) return 'xai-videos';
  if (/\/videos(?:\/|$)/.test(raw) || /\/video\/generations(?:\/|$)/.test(raw)) return 'openai-videos';
  return null;
}

function isXaiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.x.ai';
  } catch {
    return false;
  }
}

/**
 * 探测协议。传了 `force` 会跳过缓存（设置面板「重新检测」用）。
 */
export async function detectVideoProtocol(
  profile: ModelProfile,
  options: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<VideoProtocolDetection> {
  const fetchImpl = options.fetchImpl || fetch;
  const key = cacheKey(profile);
  if (!options.force) {
    const cached = detectionCache.get(key);
    if (cached) return cached;
  }

  const configured = normalizeVideoApiMode(profile.videoApiMode);
  if (configured !== 'auto') {
    const result: VideoProtocolDetection = {
      mode: configured,
      confidence: 'high',
      evidence: '配置里已明确指定接口协议',
    };
    detectionCache.set(key, result);
    return result;
  }

  const pathHint = modeFromEndpointPath(profile.baseUrl);
  if (pathHint) {
    const result: VideoProtocolDetection = {
      mode: pathHint,
      confidence: 'high',
      evidence: 'Base URL 里已经包含完整接口路径，按路径识别',
    };
    detectionCache.set(key, result);
    return result;
  }

  let base = '';
  try {
    base = videoBaseUrl(profile);
  } catch (err) {
    return {
      mode: 'openai-videos',
      confidence: 'low',
      evidence: err instanceof Error ? err.message : 'Base URL 无效',
    };
  }

  const headers = { ...videoAuthHeaders(profile.apiKey), 'Accept-Language': 'zh-CN' };

  // 1) media-v1 的模型目录：命中即高置信度
  try {
    const response = await fetchImpl(`${base}/skills/models?type=video`, {
      headers,
      signal: timeoutSignal(8_000),
    });
    if (response.ok) {
      const names = collectModelNames(await readJson(response));
      if (names.length > 0) {
        const result: VideoProtocolDetection = {
          mode: 'media-v1',
          confidence: 'high',
          evidence: `GET /skills/models?type=video 返回 ${names.length} 个视频模型`,
          models: names,
        };
        detectionCache.set(key, result);
        return result;
      }
    }
  } catch {
    /* 不支持的站会超时 / 404，继续下一条路径 */
  }

  // 2) OpenAI 兼容的 /models：能列出视频家族模型就按 openai-videos
  try {
    const response = await fetchImpl(`${base}/models`, {
      headers,
      signal: timeoutSignal(8_000),
    });
    if (response.ok) {
      const names = collectModelNames(await readJson(response));
      const videoNames = names.filter((name) => looksLikeVideoModel(name));
      if (videoNames.length > 0) {
        const result: VideoProtocolDetection = {
          mode: 'openai-videos',
          confidence: 'high',
          evidence: `GET /models 发现 ${videoNames.length} 个视频模型：${videoNames.slice(0, 3).join('、')}`,
          models: videoNames,
        };
        detectionCache.set(key, result);
        return result;
      }
      // 返回 200 但一个模型都读不到（常见于 SPA 兜底页 / 无权限）：这不算证据，继续往下判断
      if (names.length > 0) {
        const result: VideoProtocolDetection = {
          mode: 'openai-videos',
          confidence: 'medium',
          evidence: `GET /models 可用，但没有识别到视频模型（共 ${names.length} 个）；已按 OpenAI Videos 尝试`,
          models: names,
        };
        detectionCache.set(key, result);
        return result;
      }
    }
  } catch {
    /* 部分站禁用了 /models */
  }

  // 3) 什么都探测不到：先看已知中转站规则（域名 / 模型家族），再按 OpenAI Videos 兜底
  const guessedRaw = resolveVideoApiMode(profile, profile.model);
  const guessed = guessedRaw === 'auto' ? 'openai-videos' : guessedRaw;
  if (guessed !== 'openai-videos') {
    const known: VideoProtocolDetection = {
      mode: guessed,
      confidence: 'medium',
      evidence: `未能从 ${base} 读到模型目录；按已知中转站规则识别为 ${guessed}`,
    };
    detectionCache.set(key, known);
    return known;
  }
  const fallback: VideoProtocolDetection = {
    mode: 'openai-videos',
    confidence: 'low',
    evidence: `未能从 ${base} 探测到协议；已按 OpenAI Videos (/v1/videos) 尝试。若失败，请把文档里的视频 endpoint 直接粘进 Base URL`,
  };
  detectionCache.set(key, fallback);
  return fallback;
}

/**
 * 请求前确保有一个确定协议：已配置就不探测，auto 才探测（带缓存）。
 * 返回的 profile 是浅拷贝，`videoApiMode` 已落成确定值，供适配器使用。
 */
export async function ensureVideoApiMode(
  profile: ModelProfile,
  options: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<ModelProfile> {
  const configured = normalizeVideoApiMode(profile.videoApiMode);
  if (configured !== 'auto') return profile;
  const detection = await detectVideoProtocol(profile, options);
  return { ...profile, videoApiMode: detection.mode };
}
