import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR } from './paths.js';
import { networkErrorCode } from './requestErrors.js';
import type { ModelProfile } from './settings.js';

export interface ImageRequestContext {
  source: 'browser' | 'chat' | 'mcp';
  canvasId?: string;
  nodeId?: string;
  runId?: string;
}

interface PromptTrace {
  originalPrompt?: string;
  optimizedPrompt?: string;
  requestContext?: ImageRequestContext;
}

export const IMAGE_REQUEST_LOG_PATH = path.join(DATA_DIR, 'logs', 'image-requests.jsonl');
export const IMAGE_REQUEST_LOG_LIMIT = 10 * 1024 * 1024;
let pendingWrites = Promise.resolve();

async function appendRecord(record: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify(record) + '\n';
  const writing = pendingWrites.then(async () => {
    await fs.mkdir(path.dirname(IMAGE_REQUEST_LOG_PATH), { recursive: true, mode: 0o700 });
    const size = await fs.stat(IMAGE_REQUEST_LOG_PATH).then(stat => stat.size).catch(error => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
    if (size > 0 && size + Buffer.byteLength(line) > IMAGE_REQUEST_LOG_LIMIT) {
      await fs.rm(`${IMAGE_REQUEST_LOG_PATH}.1`, { force: true });
      await fs.rename(IMAGE_REQUEST_LOG_PATH, `${IMAGE_REQUEST_LOG_PATH}.1`);
    }
    await fs.appendFile(IMAGE_REQUEST_LOG_PATH, line, { mode: 0o600 });
  });
  pendingWrites = writing.catch(() => undefined);
  await writing;
}

async function safeAppend(record: Record<string, unknown>): Promise<void> {
  try {
    await appendRecord(record);
  } catch {
    console.warn('生图请求诊断日志写入失败，本次生成继续。');
  }
}

async function referenceSummary(value: Blob | string, index: number) {
  const dataUrl = typeof value === 'string' ? /^data:([^;,]+);base64,([\s\S]*)$/.exec(value) : null;
  const buffer = typeof value === 'string'
    ? dataUrl ? Buffer.from(dataUrl[2], 'base64') : Buffer.from(value)
    : Buffer.from(await value.arrayBuffer());
  return {
    index,
    source: typeof value !== 'string' || dataUrl ? 'image' : 'url',
    mimeType: typeof value === 'string' ? dataUrl?.[1] : value.type,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

export async function describeImageRequest(
  profile: ModelProfile,
  trace: PromptTrace,
  endpoint: string,
  init: RequestInit,
) {
  const url = new URL(endpoint);
  const references: Array<Blob | string> = [];
  let body: Record<string, any>;
  if (init.body instanceof FormData) {
    body = {};
    for (const [key, value] of init.body.entries()) {
      if ((key === 'image' || key === 'image[]') && value instanceof Blob) references.push(value);
      else if (typeof value === 'string') body[key] = value;
    }
  } else {
    body = JSON.parse(String(init.body));
  }
  const imageTool = Array.isArray(body.tools)
    ? body.tools.find((tool: Record<string, unknown>) => tool.type === 'image_generation')
    : undefined;
  const inputText: string[] = [];
  for (const message of Array.isArray(body.input) ? body.input : []) {
    for (const content of Array.isArray(message.content) ? message.content : []) {
      if (content.type === 'input_text' && typeof content.text === 'string') inputText.push(content.text);
      if (content.type === 'input_image' && typeof content.image_url === 'string') references.push(content.image_url);
    }
  }
  const settings = imageTool || body;
  return {
    originalPrompt: trace.originalPrompt,
    optimizedPrompt: trace.optimizedPrompt,
    actualProviderPrompt: typeof body.prompt === 'string' ? body.prompt : inputText.join('\n'),
    provider: { id: profile.id, name: profile.name, endpoint: `${url.origin}${url.pathname}` },
    modelId: settings.model,
    responseModel: imageTool ? body.model : undefined,
    parameters: {
      size: settings.size,
      quality: settings.quality ?? null,
      count: imageTool ? 1 : Number(body.n || 1),
      outputFormat: settings.output_format ?? null,
      inputFidelity: settings.input_fidelity ?? null,
      action: imageTool?.action,
      previousResponseId: body.previous_response_id,
    },
    referenceImages: await Promise.all(references.map((value, index) => referenceSummary(value, index + 1))),
    context: trace.requestContext ? {
      source: trace.requestContext.source,
      canvasId: trace.requestContext.canvasId,
      nodeId: trace.requestContext.nodeId,
      runId: trace.requestContext.runId,
    } : undefined,
  };
}

export async function fetchImageRequest(
  profile: ModelProfile,
  trace: PromptTrace,
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const details = await describeImageRequest(profile, trace, endpoint, init);
    await safeAppend({ requestId, event: 'request', at: new Date().toISOString(), ...details });
  } catch {
    console.warn('生图请求诊断信息不可用，本次生成继续。');
  }
  try {
    init.signal?.throwIfAborted();
    const response = await fetch(endpoint, init);
    await safeAppend({ requestId, event: 'response', at: new Date().toISOString(), status: response.status });
    return response;
  } catch (error) {
    await safeAppend({ requestId, event: 'error', at: new Date().toISOString(), code: networkErrorCode(error) || 'UNKNOWN' });
    throw error;
  }
}
