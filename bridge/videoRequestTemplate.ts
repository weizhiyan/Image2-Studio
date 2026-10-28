type JsonRecord = Record<string, unknown>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;
const EXACT_PLACEHOLDER = /^\{\{\s*([a-zA-Z][\w.]*)\s*\}\}$/;

function resolveValue(name: string, values: JsonRecord): unknown {
  if (!Object.prototype.hasOwnProperty.call(values, name)) {
    throw new Error(`请求模板包含未知变量：{{${name}}}`);
  }
  return values[name];
}

function renderValue(value: unknown, values: JsonRecord): unknown {
  if (typeof value === 'string') {
    const exact = value.match(EXACT_PLACEHOLDER);
    if (exact) return resolveValue(exact[1], values);
    return value.replace(PLACEHOLDER, (_match, name: string) => {
      const replacement = resolveValue(name, values);
      if (replacement !== null && typeof replacement === 'object') {
        throw new Error(`变量 {{${name}}} 是对象或数组，不能嵌入字符串`);
      }
      return String(replacement ?? '');
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as JsonRecord).map(([key, item]) => [key, renderValue(item, values)]));
  }
  return value;
}

export function renderVideoRequestTemplate(template: string, values: JsonRecord): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(template || '')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'JSON 格式错误';
    throw new Error(`视频请求模板不是有效 JSON：${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('视频请求模板顶层必须是 JSON 对象');
  }
  return renderValue(parsed, values) as JsonRecord;
}

export function renderVideoHeadersTemplate(template: string, values: JsonRecord): Record<string, string> {
  const parsed = renderVideoRequestTemplate(template || '{}', values);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!name.trim() || typeof value !== 'string') {
      throw new Error('自定义请求头必须是非空名称对应字符串值的 JSON 对象');
    }
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error('自定义请求头不能包含换行符');
    }
    headers[name] = value;
  }
  return headers;
}

export function readVideoResponsePath(source: unknown, path: string): unknown {
  const segments = String(path || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((item) => item.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;
  let current: unknown = source;
  for (const segment of segments) {
    if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as JsonRecord)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}
