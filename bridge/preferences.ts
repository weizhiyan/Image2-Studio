import fs from 'node:fs/promises';
import { CANVAS_DOCS_FILE, SETTINGS_FILE } from './paths.js';
import { askTextProfile } from './textApi.js';
import {
  MAX_PREFERENCE_ENTRIES,
  createProfileId,
  normalizeEnhanceLevel,
  readSettings,
  resolveTextProfile,
  writeSettings,
  type PreferenceEntry,
  type PreferenceProfile,
} from './settings.js';

export interface CreationRecord {
  /** 用户原始输入（未经语言模型整理），偏好归纳只看这一份。 */
  prompt: string;
  model: string;
  size: string;
  createdAt: string;
}

/** 只看最近少量不同的提示词，限制一次归纳的文本成本。 */
const DISTILL_LIMIT = 40;

/** 从画布文档里捞最近的生成记录（含版本链的每一版），新的在前。 */
export async function readRecentCreations(limit: number = DISTILL_LIMIT): Promise<CreationRecord[]> {
  let docs: Record<string, { name?: string; nodes?: unknown[] }> = {};
  try {
    docs = JSON.parse(await fs.readFile(CANVAS_DOCS_FILE, 'utf8')) as Record<string, { name?: string; nodes?: unknown[] }>;
  } catch {
    return [];
  }
  const out: CreationRecord[] = [];
  for (const doc of Object.values(docs || {})) {
    for (const node of (Array.isArray(doc?.nodes) ? doc.nodes : [])) {
      const data = (node as { data?: Record<string, unknown> })?.data || {};
      const versions = Array.isArray(data.versions) ? data.versions as Array<Record<string, unknown>> : [];
      if (versions.length > 0) {
        for (const item of versions) {
          out.push({
            prompt: String(item.prompt || ''),
            model: String(item.model || ''),
            size: String(item.size || ''),
            createdAt: String(item.finishedAt || item.createdAt || ''),
          });
        }
        continue;
      }
      if (data.kind !== 'image' || !String(data.imageUrl || '').trim()) continue;
      out.push({
        prompt: String(data.prompt || ''),
        model: String(data.model || ''),
        size: String(data.size || ''),
        createdAt: String(data.finishedAt || data.createdAt || ''),
      });
    }
  }
  return out
    .filter((item) => item.prompt.trim())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((item, index, records) => records.findIndex((record) => record.prompt.trim() === item.prompt.trim()) === index)
    .slice(0, limit);
}

/** 归纳用的系统规范：只要稳定的、重复出现的偏好，且不许编造。 */
function distillSpec(): string {
  return [
    '你是用户偏好分析师。下面是一位用户最近的生图提示词记录（他的原始输入，未经任何改写）。',
    '请归纳出这位用户稳定、重复出现的画面偏好，供以后替他整理生图提示词时参考。',
    '输出一个 JSON 数组，每个元素形如 {"text":"偏好陈述","kind":"style|palette|light|composition|subject|format|avoid|other"}。',
    '硬性要求：',
    '- 只归纳出现 3 次及以上的稳定偏好；偶发内容一律忽略',
    `- 最多 ${MAX_PREFERENCE_ENTRIES} 条，每条 26 个字以内，写成“偏好…”的短陈述句`,
    '- 只能依据记录里真实出现的内容，不要编造用户没有的偏好，不要替用户升级审美',
    '- 语言与记录一致：中文记录就用中文',
    '- 只输出 JSON 数组本身，不要解释、不要 Markdown 代码块',
  ].join('\n');
}

/** 只接受明确的 JSON 条目；普通说明文字不能误写成长期偏好。 */
export function parseEntries(raw: string): PreferenceEntry[] {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw.trim());
  const text = (fenced ? fenced[1] : raw).trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return (parsed as unknown[])
          .map((item): PreferenceEntry | null => {
            const entry = (item || {}) as Record<string, unknown>;
            const value = typeof entry.text === 'string' ? entry.text.trim() : '';
            return value
              ? { id: createProfileId(), text: value.slice(0, 120), source: 'auto' as const, createdAt: new Date().toISOString() }
              : null;
          })
          .filter((item): item is PreferenceEntry => item !== null)
          .slice(0, MAX_PREFERENCE_ENTRIES);
      }
    } catch { return []; }
  }
  return [];
}

async function persist(profile: PreferenceProfile): Promise<PreferenceProfile> {
  const current = await readSettings();
  // 只动偏好字段：profiles 原样回写，避免这条链路把 Key 冲掉
  await writeSettings({
    profiles: current.profiles.map((profile) => ({ ...profile })),
    activeProfileId: current.activeProfileId,
    direct: current.direct,
    promptOptimizationEnabled: current.promptOptimizationEnabled,
    textProfileId: current.textProfileId,
    enhanceLevel: normalizeEnhanceLevel(current.enhanceLevel),
    preferences: profile,
  });
  return profile;
}

/** 灯箱「偏好录入」：把当前这张图的原始提示词收进档案（手动条目永不参与归纳淘汰）。 */
export async function addManualPreference(input: { prompt: string; model?: string; size?: string }): Promise<PreferenceProfile> {
  const text = String(input.prompt || '').trim().slice(0, 120);
  if (!text) throw new Error('这条记录没有提示词，无法录入');
  const current = await readSettings();
  // 同一条提示词重复录入只更新时间：否则连点几次就把 16 个坑位占满
  if (current.preferences.entries.some((entry) => entry.text === text && entry.source === 'manual')) {
    return persist({ ...current.preferences, updatedAt: new Date().toISOString() });
  }
  const entry: PreferenceEntry = {
    id: createProfileId(),
    text,
    source: 'manual',
    createdAt: new Date().toISOString(),
  };
  const entries = [entry, ...current.preferences.entries].slice(0, MAX_PREFERENCE_ENTRIES);
  return persist({
    enabled: current.preferences.enabled,
    entries,
    updatedAt: entry.createdAt,
  });
}

/** 归纳只读不同的生成记录；手动条目保留，但不拿来充当重复证据。 */
export async function distillPreferences(): Promise<PreferenceProfile> {
  const settings = await readSettings();
  const textProfile = resolveTextProfile(settings);
  if (!textProfile) {
    throw new Error('偏好归纳需要一路语言模型：请在「生图设置」里添加并选中');
  }
  const records = await readRecentCreations();
  const manual = settings.preferences.entries.filter((entry) => entry.source === 'manual');
  const evidence = Array.from(new Set(records.map((item) => item.prompt.trim()).filter(Boolean))).slice(0, DISTILL_LIMIT);
  if (evidence.length < 3) {
    throw new Error(`不同的生成提示词还太少（当前 ${evidence.length} 条，至少 3 条）：多生成几次再归纳`);
  }
  const reply = await askTextProfile(textProfile, {
    systemSpec: distillSpec(),
    userText: `最近的提示词记录：\n${evidence.slice(0, DISTILL_LIMIT).map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
    maxTokens: 900,
  });
  const distilled = parseEntries(reply);
  if (distilled.length === 0) throw new Error('归纳结果为空：语言模型没有给出可用条目，可换个模型再试');
  // 手动条目置顶，归纳条目跟上，总量超限时先淘汰旧的归纳条目
  const entries = [...manual, ...distilled].slice(0, MAX_PREFERENCE_ENTRIES);
  return persist({
    enabled: settings.preferences.enabled,
    entries,
    updatedAt: new Date().toISOString(),
  });
}

export async function removePreference(id: string): Promise<PreferenceProfile> {
  const current = await readSettings();
  return persist({
    ...current.preferences,
    entries: current.preferences.entries.filter((entry) => entry.id !== id),
    updatedAt: new Date().toISOString(),
  });
}

export async function clearPreferences(): Promise<PreferenceProfile> {
  const current = await readSettings();
  return persist({ enabled: current.preferences.enabled, entries: [], updatedAt: new Date().toISOString() });
}

export async function setPreferencesEnabled(enabled: boolean): Promise<PreferenceProfile> {
  const current = await readSettings();
  return persist({ ...current.preferences, enabled, updatedAt: current.preferences.updatedAt });
}

/** 供其它模块（MCP 等）直接读当前档案，不落盘。 */
export async function currentPreferences(): Promise<PreferenceProfile> {
  const settings = await readSettings();
  return settings.preferences;
}

export const PREFERENCES_FILE = SETTINGS_FILE;
