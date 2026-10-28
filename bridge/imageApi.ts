import type { ModelProfile } from './settings.js';
import { saveBuffer, type SavedFile } from './files.js';

export interface GenerateParams {
  /** Responses 模式的主模型，由当前启用的语言模型配置提供。 */
  responseModel?: string;
  signal?: AbortSignal;
  prompt: string;
  /** 本次生成的 API 出口；未传时继续兼容 profile 里的旧配置。 */
  apiMode?: 'images' | 'responses';
  /** Image API 直连或 Responses 兼容回退时使用的提示词。 */
  imagesPrompt?: string;
  size?: string;
  referenceDataUrl?: string;
  /**
   * 多张参考图（二次编辑：基准图 + 用户额外连过来的图）。
   * 只有一张时走单个 image 字段（中转站最兼容的行为），
   * 多张走 OpenAI 的 image[] 形式——两种字段不混发，
   * 混发会把第一张图重复发给模型，编辑效果反而变差。
   */
  referenceDataUrls?: string[];
  /** 覆盖配置里的默认模型（MCP 侧指定模型名时用）。 */
  model?: string;
  /** 一次生成几张（1~8，前端工具栏的数量档位）。 */
  n?: number;
  /** 图像质量；与 size 分开传，未指定时由 provider 使用 auto。 */
  quality?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * GPT-image 官方参数（edits）：high = 严格保留参考图细节（图生图）；
   * low = 放开束缚自由发挥（风格参考）。仅带参考图时生效。
   */
  inputFidelity?: 'high' | 'low';
  /** Prior Responses API turn used only when continuing the same image conversation. */
  previousResponseId?: string;
  /** Saved for lineage; previous_response_id carries the full editable context. */
  previousImageGenerationCallId?: string;
}

export interface GeneratedImage extends SavedFile {
  revisedPrompt?: string;
  responseId?: string;
  imageGenerationCallId?: string;
  responseModel?: string;
}

export function normalizeImageSize(raw: string): string {
  const normalized = String(raw || '').trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  const match = /^(\d+)x(\d+)$/i.exec(normalized);
  if (!match) return '1024x1024';
  let width = Number(match[1]);
  let height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '1024x1024';
  const step = 16;
  const maxEdge = 3840;
  const maxPixels = 8_294_400;
  const minPixels = 655_360;
  const maxAspect = 3;
  const roundUp = (value: number) => Math.max(step, Math.ceil(value / step) * step);
  const roundDown = (value: number) => Math.max(step, Math.floor(value / step) * step);
  const scaleUp = Math.sqrt(minPixels / (width * height));
  if (width * height < minPixels) {
    width = roundUp(width * scaleUp);
    height = roundUp(height * scaleUp);
  }
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (aspect > maxAspect) {
    if (width > height) height = roundUp(width / maxAspect);
    else width = roundUp(height / maxAspect);
  }
  const scaleDown = Math.min(1, Math.sqrt(maxPixels / (width * height)), maxEdge / Math.max(width, height));
  if (scaleDown < 1) {
    width = roundDown(width * scaleDown);
    height = roundDown(height * scaleDown);
  }
  return `${Math.min(width, maxEdge)}x${Math.min(height, maxEdge)}`;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isQuotaError(detail: string): boolean {
  try {
    const parsed = JSON.parse(detail) as { error?: { code?: unknown; type?: unknown } };
    const code = `${parsed.error?.code || ''} ${parsed.error?.type || ''}`.toLowerCase();
    return code.includes('quota') || code.includes('insufficient_quota');
  } catch {
    return /insufficient[_ ]quota|quota exceeded/i.test(detail);
  }
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 300 : 900));
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; extension: string } {
  const match = /^data:image\/([a-z0-9+]+);base64,(.*)$/i.exec(dataUrl);
  if (!match) throw new Error('参考图格式不支持，需要 base64 data URL');
  return { buffer: Buffer.from(match[2], 'base64'), extension: match[1] === 'jpeg' ? 'jpg' : match[1] };
}

/**
 * Most OpenAI-compatible gateways use Bearer auth. GrsAI also accepts the
 * provider-native `apikey` header, so send both aliases to the same endpoint.
 */
function providerAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    apikey: apiKey,
  };
}

/** 接口报错美化：中转站常返回 {"error":{"message":"..."}}，提炼成一句人能读的话。 */
export function describeHttpError(prefix: string, status: number, detail: string): string {
  const trimmed = String(detail || '').trim();
  if (!trimmed) return `${prefix}返回 ${status}`;
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string }; message?: string };
    const message = parsed?.error?.message || parsed?.message;
    if (message) return `${prefix}返回 ${status}：${String(message).slice(0, 200)}`;
  } catch {
    /* 非 JSON：原样截断展示 */
  }
  return `${prefix}返回 ${status}：${trimmed.slice(0, 200)}`;
}

/** OpenAI-compatible Image API：文生图走 /images/generations，带参考图走 /images/edits。 */
async function generateWithImagesApi(profile: ModelProfile, params: GenerateParams): Promise<GeneratedImage[]> {
  if (!profile.apiKey) throw new Error(`尚未配置 API Key：请在绘板「生图设置」的「${profile.name}」里填写`);
  const base = profile.baseUrl.replace(/\/+$/, '');
  const size = normalizeImageSize(params.size?.trim() || profile.defaultSize);
  const model = params.model?.trim() || profile.model;
  const prompt = params.imagesPrompt?.trim() || params.prompt;
  const headers = providerAuthHeaders(profile.apiKey);

  const n = Math.min(Math.max(Math.floor(Number(params.n)) || 1, 1), 8);
  const referenceUrls = (params.referenceDataUrls || []).filter((item) => String(item || '').trim());
  if (referenceUrls.length === 0 && params.referenceDataUrl) referenceUrls.push(params.referenceDataUrl);

  const request = async (): Promise<Response> => {
    if (referenceUrls.length > 0) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('size', size);
      form.append('n', String(n));
      if (params.quality) form.append('quality', params.quality);
      // input_fidelity：风格参考(low)从机制上避免把参考图描出来；图生图(high)保住主体细节
      if (params.inputFidelity) form.append('input_fidelity', params.inputFidelity);
      const multi = referenceUrls.length > 1;
      referenceUrls.forEach((dataUrl, index) => {
        const { buffer, extension } = dataUrlToBuffer(dataUrl);
        const blob = new Blob([new Uint8Array(buffer)], { type: `image/${extension}` });
        // 单图走 image（兼容性最好），多图走 image[]（OpenAI 多图编辑）
        if (multi) form.append('image[]', blob, `reference-${index + 1}.${extension}`);
        else form.append('image', blob, `reference.${extension}`);
      });
      return fetch(`${base}/images/edits`, { method: 'POST', headers, body: form, signal: params.signal });
    }
    return fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, size, n, ...(params.quality ? { quality: params.quality } : {}) }),
      signal: params.signal,
    });
  };
  let response: Response | null = null;
  let networkError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await request();
      if (response.ok || !isTransientStatus(response.status) || attempt === 1) break;
      const detail = await response.clone().text().catch(() => '');
      if (response.status === 429 && isQuotaError(detail)) break;
      if (response.body) await response.body.cancel().catch(() => undefined);
    } catch (error) {
      networkError = error;
      if (params.signal?.aborted || attempt === 1) throw error;
    }
    await retryDelay(attempt);
  }
  if (!response) throw networkError instanceof Error ? networkError : new Error('生图接口没有响应');
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(describeHttpError('生图接口', response.status, detail));
  }

  const body = await response.json() as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
  const items = body.data || [];
  if (items.length === 0) throw new Error('生图接口未返回图片');

  const saved: GeneratedImage[] = [];
  for (const item of items) {
    if (item.b64_json) {
      const buffer = Buffer.from(item.b64_json, 'base64');
      saved.push({ ...(await saveBuffer(buffer, 'png')), revisedPrompt: item.revised_prompt });
    } else if (item.url) {
      const fetched = await fetch(item.url);
      if (!fetched.ok) throw new Error(`下载生成图失败：${fetched.status}`);
      const buffer = Buffer.from(await fetched.arrayBuffer());
      const extension = item.url.split('?')[0].split('.').pop() || 'png';
      saved.push({ ...(await saveBuffer(buffer, extension)), revisedPrompt: item.revised_prompt });
    }
  }
  if (saved.length === 0) throw new Error('生图接口返回的条目里没有图片数据');
  return saved;
}

interface ResponsesOutputItem {
  type?: string;
  id?: string;
  status?: string;
  result?: string;
  revised_prompt?: string;
}

interface ResponsesBody {
  id?: string;
  status?: string;
  output?: ResponsesOutputItem[];
  error?: { code?: string; message?: string; type?: string };
}

class ResponsesRequestError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(describeHttpError('Responses 生图接口', status, detail));
  }
}

function responseCompatFallback(error: unknown, hasPreviousResponse: boolean): boolean {
  if (!(error instanceof ResponsesRequestError)) return false;
  if (error.status === 404 || error.status === 405 || error.status === 501) return true;
  if (error.status !== 400) return false;
  try {
    const parsed = JSON.parse(error.detail) as { error?: { code?: unknown; message?: unknown; type?: unknown } };
    const code = String(parsed.error?.code || parsed.error?.type || '').toLowerCase();
    const message = String(parsed.error?.message || '').toLowerCase();
    if (hasPreviousResponse && (/previous_response/.test(message) || /previous_response/.test(code))) return true;
    return /unsupported.*(tool|endpoint|parameter)|unknown.*(tool|parameter)|tool_not_supported|unsupported_tool|route_not_found|model not found|model_not_found/.test(`${code} ${message}`);
  } catch {
    return hasPreviousResponse && /previous_response_id/i.test(error.detail);
  }
}

function responseModelForProfile(profile: ModelProfile, requested?: string): string {
  const candidate = String(requested || profile.responsesModel || '').trim();
  // 旧版把语言模型默认名（如 GPT）写进生图配置；它不属于当前生图中转站的模型列表。
  if (candidate && candidate !== 'GPT' && (profile.models.length === 0 || profile.models.includes(candidate))) return candidate;
  return profile.model.trim() || candidate || 'gpt-5.5';
}

function responsesInput(prompt: string, references: string[], usePreviousResponse: boolean) {
  const content: Array<Record<string, string>> = [{ type: 'input_text', text: prompt }];
  if (!usePreviousResponse) {
    for (const imageUrl of references) content.push({ type: 'input_image', image_url: imageUrl });
  }
  return [{ role: 'user', content }];
}

async function callResponses(profile: ModelProfile, params: GenerateParams, previousResponseId?: string): Promise<GeneratedImage[]> {
  const base = profile.baseUrl.replace(/\/+$/, '');
  const imageModel = params.model?.trim() || profile.model;
  const responseModel = responseModelForProfile(profile, params.responseModel);
  const size = normalizeImageSize(params.size?.trim() || profile.defaultSize);
  const n = Math.min(Math.max(Math.floor(Number(params.n)) || 1, 1), 8);
  const references = (params.referenceDataUrls || []).filter((item) => String(item || '').trim());
  if (references.length === 0 && params.referenceDataUrl) references.push(params.referenceDataUrl);
  const callOnce = async (): Promise<GeneratedImage[]> => {
    const body = {
      model: responseModel,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      input: responsesInput(params.prompt, references, Boolean(previousResponseId)),
      tools: [{
        type: 'image_generation',
        model: imageModel,
        // Let the mainline model choose for style references; force edit only for a
        // high-fidelity edit or a prior Responses image conversation.
        action: previousResponseId
          ? 'edit'
          : references.length > 0
            ? (params.inputFidelity === 'high' ? 'edit' : 'auto')
            : 'generate',
        size,
        ...(params.quality ? { quality: params.quality } : {}),
      }],
    };
    let response: Response | null = null;
    let error: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(`${base}/responses`, {
          method: 'POST',
          headers: { ...providerAuthHeaders(profile.apiKey), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: params.signal,
        });
        if (response.ok || !isTransientStatus(response.status) || attempt === 1) break;
        const detail = await response.clone().text().catch(() => '');
        if (response.status === 429 && isQuotaError(detail)) break;
        if (response.body) await response.body.cancel().catch(() => undefined);
      } catch (caught) {
        error = caught;
        if (params.signal?.aborted || attempt === 1) throw caught;
      }
      await retryDelay(attempt);
    }
    if (!response) throw error instanceof Error ? error : new Error('Responses 生图接口没有响应');
    if (!response.ok) throw new ResponsesRequestError(response.status, await response.text().catch(() => ''));
    const data = await response.json() as ResponsesBody;
    const calls = (data.output || []).filter((item) => item.type === 'image_generation_call' && item.result);
    if (calls.length === 0) {
      const detail = data.error?.message || `Responses API 未返回图像结果（状态：${data.status || 'unknown'}）`;
      throw new Error(detail);
    }
    return Promise.all(calls.map(async (call) => ({
      ...(await saveBuffer(Buffer.from(String(call.result), 'base64'), 'png')),
      revisedPrompt: call.revised_prompt,
      responseId: data.id,
      imageGenerationCallId: call.id,
      responseModel,
    } satisfies GeneratedImage)));
  };

  // The Responses image tool emits one image-generation call per response. Create alternatives
  // as independent calls so providers that do not implement Image API's `n` still work.
  const results = await Promise.all(Array.from({ length: n }, () => callOnce()));
  return results.flat().slice(0, n);
}

/** Responses 由本次生成请求决定；旧调用未传时仍兼容 profile 配置。 */
export const IMAGE_GENERATION_TIMEOUT_MS = 300_000;
export const IMAGE_GENERATION_TIMEOUT_MESSAGE = '生图接口超过 5 分钟没有返回结果，已自动停止；请检查该模型的图生图接口或稍后重试';

export async function generateImages(profile: ModelProfile, params: GenerateParams): Promise<GeneratedImage[]> {
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), IMAGE_GENERATION_TIMEOUT_MS);
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutController.signal])
    : timeoutController.signal;
  const boundedParams: GenerateParams = { ...params, signal };
  const apiMode = boundedParams.apiMode || profile.imageApiMode || 'images';
  try {
    if (apiMode !== 'responses') return await generateWithImagesApi(profile, boundedParams);
    if (!profile.apiKey) throw new Error(`尚未配置 API Key：请在绘板「生图设置」的「${profile.name}」里填写`);
    try {
      return await callResponses(profile, boundedParams, boundedParams.previousResponseId);
    } catch (error) {
      if (!responseCompatFallback(error, Boolean(boundedParams.previousResponseId))) throw error;
      return await generateWithImagesApi(profile, boundedParams);
    }
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new Error(IMAGE_GENERATION_TIMEOUT_MESSAGE);
    }
    throw error;
  } finally {
    clearTimeout(timeoutTimer);
  }
}
