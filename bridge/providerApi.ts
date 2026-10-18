import { describeHttpError } from './imageApi.js';
import { saveBuffer, type SavedFile } from './files.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** 代取网络图片：粘贴/拖入的图片链接经 bridge 落盘，浏览器侧无 CORS 限制。 */
export async function fetchRemoteImage(rawUrl: string): Promise<SavedFile> {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http(s) 图片链接');
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
  const type = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) throw new Error('该链接不是图片');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('图片超过 12MB 上限');
  return saveBuffer(buffer, type.slice('image/'.length) || 'png');
}

export interface ProviderRequest {
  baseUrl: string;
  apiKey: string;
}

/** Keep standard Bearer compatibility while supporting GrsAI's native header. */
function providerAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    apikey: apiKey,
  };
}

function normalizeBase(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * 用户经常把完整接口地址粘进 Base URL：/images/generations、/responses 等。
 * 生图调用仍按原值工作，这里只为模型发现推导出对应的 API 根地址。
 */
function modelListUrls(baseUrl: string): string[] {
  const base = normalizeBase(baseUrl);
  if (!base) return [];
  const urls: string[] = [];
  const add = (url: string) => {
    const normalized = url.replace(/\/+$/, '');
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
  };
  // Full operation endpoints are a common paste from provider docs.
  const apiRoot = base.replace(/\/(?:images\/(?:generations|edits)|chat\/completions|responses|completions)$/i, '');
  if (apiRoot !== base) add(`${apiRoot}/models`);
  if (/\/models$/i.test(base)) add(base);
  else add(`${base}/models`);

  // Some gateways show Base URL as https://host but expose OpenAI routes under /v1.
  if (!/\/models$/i.test(apiRoot) && !/\/v1(?:\/|$)/i.test(apiRoot)) add(`${apiRoot}/v1/models`);
  return urls;
}

/** 常见兼容接口的列表形态；不从无关对象里猜模型名。 */
export function parseProviderModels(body: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || value == null || seen.has(value)) return;
    if (typeof value === 'string') {
      const name = value.trim();
      if (name) found.push(name);
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    const model = value as Record<string, unknown>;
    for (const key of ['id', 'slug', 'model', 'model_id', 'modelId', 'model_name', 'modelName', 'name']) {
      if (typeof model[key] === 'string' && String(model[key]).trim()) {
        found.push(String(model[key]).trim());
        break;
      }
    }
    // Only walk known list containers; this avoids turning unrelated response text into model names.
    for (const key of ['data', 'models', 'result', 'items', 'list', 'model_list', 'modelList']) {
      if (model[key] !== undefined) visit(model[key], depth + 1);
    }
  };
  visit(body, 0);
  return Array.from(new Set(found));
}

/** 拉取 OpenAI-compatible /models 列表，返回模型 id；只请求一次，不探测其它收费接口。 */
export async function fetchProviderModels(input: ProviderRequest): Promise<string[]> {
  const urls = modelListUrls(input.baseUrl);
  if (urls.length === 0) throw new Error('请先填写 API Base URL');
  let lastNotFound = false;
  let authFailure = false;
  for (const url of urls) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: providerAuthHeaders(input.apiKey),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`连接模型列表接口超时（20 秒）：${url}`);
      }
      throw err;
    }
    if (response.status === 404 || response.status === 405) {
      lastNotFound = true;
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      authFailure = true;
      continue;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(describeHttpError('模型列表接口', response.status, detail));
    }
    const body = await response.json().catch(() => null) as unknown;
    if (!body) throw new Error('模型列表接口没有返回 JSON；可在下方手动填写模型名');
    return parseProviderModels(body);
  }
  if (lastNotFound) {
    if (authFailure) throw new Error('模型列表地址可达，但 API Key 无效或没有权限');
    throw new Error('未找到模型列表接口（已尝试常见 /models 地址）；可在下方手动填写模型名，不影响已保存配置');
  }
  if (authFailure) throw new Error('API Key 无效或没有权限');
  throw new Error('模型列表接口不可用；可在下方手动填写模型名');
}

/** 连接测试只探活不生成：打 OpenAI 兼容 /models 列表，验 Key 与地址，不烧生图额度。 */
export async function testProviderConnection(input: ProviderRequest & { model: string }): Promise<string> {
  const urls = modelListUrls(input.baseUrl);
  if (urls.length === 0) throw new Error('尚未填写接口地址（Base URL）');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let notFound = false;
  let authFailure = false;
  try {
    for (const url of urls) {
      const res = await fetch(url, {
        headers: { ...providerAuthHeaders(input.apiKey), 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        authFailure = true;
        continue;
      }
      if (res.status === 404 || res.status === 405) {
        notFound = true;
        continue;
      }
      if (res.ok) {
        const body = await res.json().catch(() => null) as unknown;
        const count = parseProviderModels(body).length;
        return `连接成功：接口可达，可列出 ${count} 个模型（未发起生图）`;
      }
      throw new Error(`接口返回 ${res.status}：请检查 Base URL 与 API Key`);
    }
    if (authFailure) throw new Error('API Key 无效或没有权限');
    if (notFound) return '地址可达，但不提供 /models 列表；无法通过这次测试验证 API Key，未发起生图';
    throw new Error('模型列表接口不可用：请检查 Base URL 与 API Key');
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('连接超时：请检查 Base URL 是否可达');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
