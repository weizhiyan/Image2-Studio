import fs from 'node:fs/promises';
import { SETTINGS_FILE } from './paths.js';
import { defaultMemorySettings, normalizeMemorySettings, type MemorySettings } from './chatMemory.js';

export interface ChatRuntimeSettings {
  maxModelRounds: number;
  maxToolCalls: number;
  maxImagesPerRun: number;
  confirmImagesAbove: number;
  maxOutputTokens: number;
}

export function defaultChatRuntimeSettings(): ChatRuntimeSettings {
  return { maxModelRounds: 4, maxToolCalls: 2, maxImagesPerRun: 4, confirmImagesAbove: 1, maxOutputTokens: 4096 };
}

export function normalizeChatRuntimeSettings(raw: unknown): ChatRuntimeSettings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const defaults = defaultChatRuntimeSettings();
  const bound = (key: keyof ChatRuntimeSettings, min: number, max: number) => typeof value[key] === 'number' && Number.isFinite(value[key]) ? Math.max(min, Math.min(max, Math.round(value[key] as number))) : defaults[key];
  return { maxModelRounds: bound('maxModelRounds', 4, 8), maxToolCalls: bound('maxToolCalls', 1, 2), maxImagesPerRun: bound('maxImagesPerRun', 1, 8), confirmImagesAbove: 1, maxOutputTokens: bound('maxOutputTokens', 2048, 8192) };
}

/** 配置种类：image = 生图模型；text = 语言/多模态模型（发送前整理提示词用）；video = 视频生成模型。 */
export type ProfileKind = 'image' | 'text' | 'video';
export type VideoApiMode = 'auto' | 'openai-videos' | 'xai-videos' | 'grsai-generate' | 'media-v1' | 'custom';

export interface CustomVideoApiConfig {
  createPath: string;
  pollPath: string;
  imageTransport: 'public-url' | 'data-url';
  headersTemplate: string;
  requestBodyTemplate: string;
  taskIdPath: string;
  statusPath: string;
  progressPath: string;
  outputUrlPath: string;
  errorPath: string;
  statusMap: string;
}

export function defaultCustomVideoApiConfig(): CustomVideoApiConfig {
  return {
    createPath: '/videos',
    pollPath: '/videos/{{taskId}}',
    imageTransport: 'public-url',
    headersTemplate: '{}',
    requestBodyTemplate: JSON.stringify({
      model: '{{model}}',
      prompt: '{{prompt}}',
      seconds: '{{seconds}}',
      ratio: '{{ratio}}',
    }, null, 2),
    taskIdPath: 'id',
    statusPath: 'status',
    progressPath: 'progress',
    outputUrlPath: 'video_url',
    errorPath: 'error.message',
    statusMap: '{}',
  };
}

/**
 * 语言模型的上游接口格式：
 * - chat：OpenAI 兼容 /chat/completions（绝大多数中转站）
 * - responses：OpenAI /responses（Codex 系路由器，如只开放 Responses 的网关）
 * - auto：先 chat，遇到路由类错误自动回落 responses
 */
export type TextApiFormat = 'chat' | 'responses' | 'auto';

const TEXT_API_FORMATS: TextApiFormat[] = ['auto', 'chat', 'responses'];

export function normalizeTextApiFormat(value: unknown): TextApiFormat {
  return TEXT_API_FORMATS.includes(value as TextApiFormat) ? (value as TextApiFormat) : 'auto';
}

/** 生图出口：Image API 兼容面最广；Responses 适合多轮编辑与上下文复用。 */
export type ImageApiMode = 'images' | 'responses';

export function normalizeImageApiMode(value: unknown): ImageApiMode {
  return value === 'responses' ? 'responses' : 'images';
}

/**
 * 提示词优化强度（只作用于语言模型那一次整理对话，不改变生图模型参数）：
 * - strict：高遵循，用户写什么画什么；- balanced：均衡，补齐必要细节；- creative：创意，意图内主动发挥。
 */
export type EnhanceLevel = 'strict' | 'balanced' | 'creative';

const ENHANCE_LEVELS: EnhanceLevel[] = ['strict', 'balanced', 'creative'];

export function normalizeEnhanceLevel(value: unknown): EnhanceLevel {
  return ENHANCE_LEVELS.includes(value as EnhanceLevel) ? (value as EnhanceLevel) : 'balanced';
}

/** 偏好档案的一条：manual = 灯箱手动录入，auto = 由生成记录归纳。 */
export interface PreferenceEntry {
  id: string;
  text: string;
  source: 'manual' | 'auto';
  createdAt: string;
}

export interface PreferenceProfile {
  /** 是否把档案注入语言模型优化对话；未调用优化时无副作用。 */
  enabled: boolean;
  entries: PreferenceEntry[];
  updatedAt: string;
}

/** 档案上限：再多就该删了，塞满 system 只会把语言模型带跑偏。 */
export const MAX_PREFERENCE_ENTRIES = 16;
const MAX_PREFERENCE_TEXT = 120;

export function emptyPreferences(): PreferenceProfile {
  return { enabled: false, entries: [], updatedAt: '' };
}

export function normalizePreferences(raw: unknown): PreferenceProfile {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const entries = Array.isArray(source.entries)
    ? source.entries.map((item) => {
      const entry = (item || {}) as Record<string, unknown>;
      return {
        id: String(entry.id || createProfileId()),
        text: String(entry.text || '').slice(0, MAX_PREFERENCE_TEXT),
        source: entry.source === 'manual' ? 'manual' : 'auto',
        createdAt: String(entry.createdAt || ''),
      } satisfies PreferenceEntry;
    }).filter((entry) => entry.text)
    : [];
  return {
    enabled: source.enabled === true,
    entries: entries.slice(0, MAX_PREFERENCE_ENTRIES),
    updatedAt: String(source.updatedAt || ''),
  };
}

/** 一路生图模型配置：独立的 Base URL / Key / 模型列表，可同时存在多路。 */
export interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultSize: string;
  /** 从服务端拉取到的候选模型（拉取后随保存落盘，刷新不丢）。 */
  models: string[];
  /** 勾选启用的模型；默认模型必须落在其中。 */
  enabledModels: string[];
  /** 在配置卡片里展示的模型（内层勾选）；缺省时回落到 enabledModels。 */
  selectedModels?: string[];
  /** 这路配置的用途：生图 / 语言模型（提示词优化）。 */
  kind: ProfileKind;
  /** 语言模型的上游接口格式；生图配置恒为 auto（用不到）。 */
  textFormat: TextApiFormat;
  /** 生图 API 出口；默认 Image API，显式选择 Responses 才启用对话式图像上下文。 */
  imageApiMode?: ImageApiMode;
  /** 是否启用这路配置：false = 停用，不参与默认竞选（界面列表置灰，仍可按 id 手动指定）；缺省视为启用 */
  enabled?: boolean;
  /** Responses API 顶层主模型（负责理解上下文并调用图像工具），与 model 分离。 */
  responsesModel?: string;
  /** 视频配置的上游协议。 */
  videoApiMode?: VideoApiMode;
  /** 仅 custom 协议使用；模板是 JSON，不执行任意代码。 */
  videoCustomConfig?: CustomVideoApiConfig;
}

export interface StoredSettings {
  profiles: ModelProfile[];
  activeProfileId: string;
  /** 兼容旧字段：true = Image API；false = Responses 智能生成。 */
  direct: boolean;
  /** 浏览器生图前是否额外调用一次语言模型整理；默认关闭，避免意外消耗额度。 */
  promptOptimizationEnabled: boolean;
  /** 优化提示词用的语言模型 id；为空时取第一把可用的 language 配置。 */
  textProfileId: string;
  /** 提示词整理强度：高遵循 / 均衡 / 创意，只影响语言模型那一次对话。 */
  enhanceLevel: EnhanceLevel;
  /** 用户偏好档案：生成记录归纳 + 灯箱手动录入，注入优化对话。 */
  preferences: PreferenceProfile;
  chatMemory: MemorySettings;
  chatRuntime: ChatRuntimeSettings;
}

let seq = 0;

/** 写入串行链：两个标签页同时保存时，读-改-写必须排队，不能交叉写同一个文件。 */
let settingsWriteChain: Promise<unknown> = Promise.resolve();

function withSettingsWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = settingsWriteChain.then(task, task);
  settingsWriteChain = run.catch(() => undefined);
  return run;
}

/** 原子写入：先写同目录临时文件再 rename，进程被杀也不会留下半截 JSON。 */
async function writeSettingsFile(value: StoredSettings): Promise<void> {
  const tmp = `${SETTINGS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, SETTINGS_FILE);
}

/** 截出第一个完整 JSON 对象：并发写留下的尾部残片走这条自愈，返回 null 表示文件不可救。 */
function firstJsonObject(raw: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(0, i + 1);
    }
  }
  return null;
}

export function createProfileId(): string {
  seq += 1;
  return `profile_${Date.now().toString(36)}_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function normalizeProfileKind(value: unknown): ProfileKind {
  return value === 'text' || value === 'video' ? value : 'image';
}

export function normalizeVideoApiMode(value: unknown): VideoApiMode {
  return value === 'openai-videos' || value === 'xai-videos' || value === 'grsai-generate' || value === 'media-v1' || value === 'custom' ? value : 'auto';
}

export function normalizeCustomVideoApiConfig(value: unknown, knownApiKey = ''): CustomVideoApiConfig {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const defaults = defaultCustomVideoApiConfig();
  const text = (key: keyof CustomVideoApiConfig, maxLength = 16_000) => (
    typeof source[key] === 'string' ? String(source[key]).slice(0, maxLength) : defaults[key]
  );
  const config: CustomVideoApiConfig = {
    createPath: text('createPath', 2_000),
    pollPath: text('pollPath', 2_000),
    imageTransport: source.imageTransport === 'data-url' ? 'data-url' : 'public-url',
    headersTemplate: text('headersTemplate', 8_000),
    requestBodyTemplate: text('requestBodyTemplate'),
    taskIdPath: text('taskIdPath', 300),
    statusPath: text('statusPath', 300),
    progressPath: text('progressPath', 300),
    outputUrlPath: text('outputUrlPath', 300),
    errorPath: text('errorPath', 300),
    statusMap: text('statusMap', 4_000),
  };
  const secret = String(knownApiKey || '');
  if (secret.length >= 8) {
    config.headersTemplate = config.headersTemplate.split(secret).join('{{apiKey}}');
    config.requestBodyTemplate = config.requestBodyTemplate.split(secret).join('{{apiKey}}');
  }
  return config;
}

/** 默认模型按类型分开：视频不沿用生图的 gpt-image-1，那家伙在视频接口上必然报错。 */
function defaultModelForKind(kind: ProfileKind): string {
  if (kind === 'text' || kind === 'video') return '';
  return 'gpt-image-1';
}

function defaultNameForKind(kind: ProfileKind): string {
  if (kind === 'text') return '语言模型';
  if (kind === 'video') return '视频模型';
  return '生图模型';
}

export function createProfile(name: string, kind: ProfileKind = 'image'): ModelProfile {
  return {
    id: createProfileId(),
    name: name.trim() || defaultNameForKind(kind),
    baseUrl: kind === 'video' ? '' : 'https://api.openai.com/v1',
    apiKey: '',
    model: defaultModelForKind(kind),
    defaultSize: kind === 'video' ? '' : '1024x1024',
    models: [],
    enabledModels: [],
    kind,
    textFormat: 'auto',
    imageApiMode: 'images',
    responsesModel: 'gpt-5.5',
    videoApiMode: kind === 'video' ? 'auto' : undefined,
    videoCustomConfig: kind === 'video' ? defaultCustomVideoApiConfig() : undefined,
    enabled: true,
  };
}

/**
 * 默认模型必须落在「已勾选的模型」里，否则画布一生成就挂。
 *
 * 实测踩坑：某一路的默认模型是 gpt-image-1，勾选列表里却只有 gpt-image-2.5。
 * 画布上不带显式模型名生成时发的是 profile.model，上游直接回
 * "model not register: gpt-image-1"，而设置面板里这路看着完全是好的。
 * 所以读（normalizeSettings）和写（updateSettings）两端做同一件事：
 * 默认模型不在勾选列表里就收敛到列表第一项，历史错数据无需用户手动改。
 * enabledModels 为空（还没拉过列表、纯手填模型名）时保持原值不动。
 */
export function resolveDefaultModel(model: string, enabledModels: string[]): string {
  const requested = String(model || '').trim();
  if (requested && (enabledModels.length === 0 || enabledModels.includes(requested))) return requested;
  return enabledModels[0] || requested;
}

/** 旧版单配置（v0.1 的扁平字段）整体迁移成一路 profile，Key 不丢。 */
function migrateLegacy(raw: Record<string, unknown>): StoredSettings {
  const profile = createProfile(String(raw.name || '默认模型') || '默认模型');
  profile.baseUrl = String(raw.baseUrl || '').trim() || profile.baseUrl;
  profile.apiKey = String(raw.apiKey || '');
  profile.model = String(raw.model || '').trim() || profile.model;
  profile.defaultSize = String(raw.defaultSize || '').trim() || profile.defaultSize;
  profile.models = Array.isArray(raw.models) ? raw.models.map((item) => String(item)) : [];
  profile.enabledModels = Array.isArray(raw.enabledModels) ? raw.enabledModels.map((item) => String(item)) : [];
  return { profiles: [profile], activeProfileId: profile.id, direct: true, promptOptimizationEnabled: false, textProfileId: '', enhanceLevel: 'balanced', preferences: emptyPreferences(), chatMemory: defaultMemorySettings(), chatRuntime: defaultChatRuntimeSettings() };
}

export function normalizeSettings(raw: Record<string, unknown>): StoredSettings {
  if (!Array.isArray(raw.profiles)) return migrateLegacy(raw);
  const profiles = raw.profiles
    .map((item) => {
      const entry = (item || {}) as Record<string, unknown>;
      const kind = normalizeProfileKind(entry.kind);
      const base = createProfile(String(entry.name || defaultNameForKind(kind)), kind);
      const models = Array.isArray(entry.models) ? entry.models.map((item) => String(item)) : [];
      const enabledModels = Array.isArray(entry.enabledModels) ? entry.enabledModels.map((item) => String(item)) : [];
      const requestedModel = String(entry.model || '').trim();
      // 旧配置没有 selectedModels：已启用的模型视为卡片可见；纯手填模型名时也让它可见且启用。
      const explicitSelected = Array.isArray(entry.selectedModels);
      const selectedModels = explicitSelected
        ? Array.from(new Set((entry.selectedModels as unknown[]).map((item) => String(item)).filter(Boolean)))
        : (enabledModels.length > 0 ? enabledModels : (requestedModel ? [requestedModel] : []));
      const effectiveEnabled = explicitSelected || enabledModels.length > 0 ? enabledModels : selectedModels;
      const apiKey = String(entry.apiKey || '');
      return {
        ...base,
        id: String(entry.id || base.id),
        name: String(entry.name || base.name),
        baseUrl: String(kind === 'video' ? entry.baseUrl ?? '' : entry.baseUrl || base.baseUrl),
        apiKey,
        defaultSize: String(kind === 'video' ? entry.defaultSize ?? '' : entry.defaultSize || base.defaultSize),
        models,
        enabledModels: effectiveEnabled,
        selectedModels,
        model: kind === 'video'
          // 视频配置：没填默认模型时自动取第一个已勾选模型。
          // 用户只要「加了模型」，节点端就不会因为默认模型为空而判定「还没配好」。
          ? (requestedModel || effectiveEnabled[0] || '')
          : resolveDefaultModel(String(entry.model || base.model), effectiveEnabled),
        kind,
        textFormat: normalizeTextApiFormat(entry.textFormat),
        imageApiMode: normalizeImageApiMode(entry.imageApiMode),
        responsesModel: String(entry.responsesModel || base.responsesModel),
        videoApiMode: kind === 'video' ? normalizeVideoApiMode(entry.videoApiMode) : undefined,
        videoCustomConfig: kind === 'video' ? normalizeCustomVideoApiConfig(entry.videoCustomConfig, apiKey) : undefined,
        // 语言配置不再有配置级启停：语言模型都由对话/默认选择器按模型选择。
        enabled: kind === 'text' ? true : entry.enabled !== false,
      } satisfies ModelProfile;
    })
    .filter((profile) => profile.id);
  if (profiles.length === 0) return { profiles: [createProfile('默认模型')], activeProfileId: '', direct: true, promptOptimizationEnabled: raw.promptOptimizationEnabled === true, textProfileId: '', enhanceLevel: normalizeEnhanceLevel(raw.enhanceLevel), preferences: normalizePreferences(raw.preferences), chatMemory: normalizeMemorySettings(raw.chatMemory), chatRuntime: normalizeChatRuntimeSettings(raw.chatRuntime) };
  const imageProfiles = profiles.filter((profile) => profile.kind === 'image');
  const pool = imageProfiles.length > 0 ? imageProfiles : profiles;
  const active = pool.find((profile) => profile.id === raw.activeProfileId) || pool[0];
  return {
    profiles,
    activeProfileId: active.id,
    direct: raw.direct !== false,
    promptOptimizationEnabled: raw.promptOptimizationEnabled === true,
    textProfileId: String(raw.textProfileId || ''),
    enhanceLevel: normalizeEnhanceLevel(raw.enhanceLevel),
    preferences: normalizePreferences(raw.preferences),
    chatMemory: normalizeMemorySettings(raw.chatMemory),
    chatRuntime: normalizeChatRuntimeSettings(raw.chatRuntime),
  };
}

export async function readSettings(): Promise<StoredSettings> {
  return withSettingsWriteLock(readSettingsUnlocked);
}

async function readSettingsUnlocked(): Promise<StoredSettings> {
  let rawText = '';
  try {
    rawText = await fs.readFile(SETTINGS_FILE, 'utf8');
    const raw = JSON.parse(rawText) as Record<string, unknown>;
    if (!Array.isArray(raw.profiles)) {
      // 旧版单配置迁移成一路 profile：立刻落盘，id 才不会在下次启动时又变一遍
      const migrated = normalizeSettings(raw);
      await writeSettingsFile(migrated);
      return migrated;
    }
    return normalizeSettings(raw);
  } catch {
    // 自愈：文件尾部残片通常只是并发写留下的脏字符，截出第一个完整对象后备份原件并重写干净文件
    const candidate = firstJsonObject(rawText);
    if (candidate) {
      try {
        const recovered = normalizeSettings(JSON.parse(candidate) as Record<string, unknown>);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fs.copyFile(SETTINGS_FILE, `${SETTINGS_FILE}.corrupt-${stamp}`).catch(() => undefined);
        await writeSettingsFile(recovered);
        console.warn('[huiban] settings.json 尾部残片已修复，原文件已留备份');
        return recovered;
      } catch {
        /* 连第一个对象都解析不了才走默认兜底 */
      }
    }
    return { profiles: [createProfile('默认模型')], activeProfileId: '', direct: true, promptOptimizationEnabled: false, textProfileId: '', enhanceLevel: 'balanced', preferences: emptyPreferences(), chatMemory: defaultMemorySettings(), chatRuntime: defaultChatRuntimeSettings() };
  }
}

/** 当前生效的那一路生图配置：语言模型不参与「默认生图」竞选。 */
export function activeProfile(settings: StoredSettings): ModelProfile {
  const imageProfiles = settings.profiles.filter((profile) => profile.kind === 'image');
  const pool = imageProfiles.length > 0 ? imageProfiles : settings.profiles;
  // 停用的不参与竞选；全停用时退回原池，别让生图直接没有配置可用
  const active = pool.find((profile) => profile.id === settings.activeProfileId);
  if (active && active.enabled !== false) return active;
  const usable = pool.filter((profile) => profile.enabled !== false);
  return usable[0] || pool[0] || createProfile('默认模型');
}

export function imageModelReadiness(settings: StoredSettings) {
  const imageProfiles = settings.profiles.filter((profile) => profile.kind === 'image');
  const active = imageProfiles.find((profile) => (
    profile.id === settings.activeProfileId && profile.enabled !== false
  ));
  const profile = active || imageProfiles.find((item) => item.enabled !== false) || imageProfiles[0];
  const configured = Boolean(
    profile
    && profile.enabled !== false
    && profile.baseUrl.trim()
    && profile.apiKey.trim()
    && profile.model.trim(),
  );

  return {
    configured,
    modelsLoaded: Boolean(profile?.models.length),
    profileName: profile?.name || '',
    modelName: profile?.model || '',
  };
}

/** 全部语言模型配置（发送前整理提示词用）。 */
export function textProfilesOf(settings: StoredSettings): ModelProfile[] {
  // 停用的不参与自动竞选；按 id 显式指定的仍认（resolveTextProfile 里单独查）
  return settings.profiles.filter((profile) => profile.kind === 'text' && profile.enabled !== false);
}

/** 优化提示词用的那一路：优先设置里选中的，否则第一把 language 配置。 */
export function resolveTextProfile(settings: StoredSettings, profileId?: string): ModelProfile | null {
  const wanted = String(profileId || settings.textProfileId || '').trim();
  const hit = wanted ? settings.profiles.find((profile) => profile.id === wanted && profile.kind === 'text') : undefined;
  return hit || textProfilesOf(settings)[0] || null;
}

/** 语言模型跑哪一档：显式选中且在 enabledModels 里就用它，否则用配置的默认模型。 */
export function resolveTextModel(profile: ModelProfile | null | undefined, requestedModel?: string): string {
  if (!profile) return '';
  const wanted = String(requestedModel || '').trim();
  const enabled = Array.isArray(profile.enabledModels) ? profile.enabledModels : [];
  return wanted && enabled.includes(wanted) ? wanted : profile.model;
}

/** 全部视频模型配置。视频是独立分组与计费，不跟生图混竞。 */
export function videoProfilesOf(settings: StoredSettings): ModelProfile[] {
  return settings.profiles.filter((profile) => (
    profile.kind === 'video'
    && profile.enabled !== false
    && Boolean(profile.baseUrl.trim() && profile.apiKey && profile.model)
  ));
}

/** 视频生成用的那一路：优先指定的，否则第一把可用的视频配置；没有配过返回 null。 */
export function resolveVideoProfile(settings: StoredSettings, profileId?: string): ModelProfile | null {
  const wanted = String(profileId || '').trim();
  const hit = wanted ? settings.profiles.find((profile) => (
    profile.id === wanted && profile.kind === 'video' && profile.enabled !== false
  )) : undefined;
  return hit || videoProfilesOf(settings)[0] || null;
}

export function findProfile(settings: StoredSettings, profileId: string | undefined): ModelProfile {
  const wanted = String(profileId || '').trim();
  if (wanted) {
    const hit = settings.profiles.find((profile) => profile.id === wanted);
    if (hit) return hit;
  }
  return activeProfile(settings);
}

export async function writeSettings(input: {
  profiles?: Array<Partial<ModelProfile>>;
  activeProfileId?: string;
  /** 不传表示保持原值。 */
  direct?: boolean;
  promptOptimizationEnabled?: boolean;
  textProfileId?: string;
  /** 不传表示保持原值。 */
  enhanceLevel?: EnhanceLevel;
  /** 整份替换；不传表示保持原值。 */
  preferences?: PreferenceProfile;
  chatMemory?: Partial<MemorySettings>;
  chatRuntime?: Partial<ChatRuntimeSettings>;
}): Promise<StoredSettings> {
  return withSettingsWriteLock(async () => {
    const current = await readSettingsUnlocked();
    const byId = new Map(current.profiles.map((profile) => [profile.id, profile]));
    const profiles: ModelProfile[] = [];
    /** 前端新增配置会带 new_ 临时 ID；保存时统一换成稳定 ID，并回写引用。 */
    const draftIdToActualId = new Map<string, string>();
    // 空数组从来不是合法用户操作（界面禁止删掉最后一组配置）：只可能是界面还没加载完就点了保存。
    // 这种情况必须原样保留已存配置，否则整个 settings.json 会被一组空配置覆盖，Key 全部丢失。
    if (!input.profiles?.length && current.profiles.length > 0) {
      const kept: StoredSettings = {
        ...current,
        activeProfileId: current.profiles.some((profile) => profile.id === input.activeProfileId) ? input.activeProfileId! : current.activeProfileId,
        direct: typeof input.direct === 'boolean' ? input.direct : current.direct !== false,
        promptOptimizationEnabled: typeof input.promptOptimizationEnabled === 'boolean' ? input.promptOptimizationEnabled : current.promptOptimizationEnabled,
        textProfileId: typeof input.textProfileId === 'string' ? input.textProfileId : current.textProfileId,
        enhanceLevel: input.enhanceLevel ? normalizeEnhanceLevel(input.enhanceLevel) : current.enhanceLevel,
        preferences: input.preferences ? normalizePreferences(input.preferences) : current.preferences,
        chatMemory: normalizeMemorySettings({ ...current.chatMemory, ...input.chatMemory }),
        chatRuntime: normalizeChatRuntimeSettings({ ...current.chatRuntime, ...input.chatRuntime }),
      };
      await writeSettingsFile(kept);
      return kept;
    }
    for (const draft of input.profiles || []) {
      const requestedId = String(draft.id || '').trim();
      const id = requestedId && !requestedId.startsWith('new_') && byId.has(requestedId) ? requestedId : '';
      const draftKind = normalizeProfileKind(draft.kind);
      const draftName = String(draft.name || '').trim();
      const draftBaseUrl = String(draft.baseUrl || '').trim();
      const identityMatches = !id && requestedId && !requestedId.startsWith('new_')
        ? current.profiles.filter((profile) => (
          profile.kind === draftKind
          && profile.name === draftName
          && profile.baseUrl === draftBaseUrl
        ))
        : [];
      // A stale client may submit an old profile ID after another tab migrated it.
      // Reuse a Key only when the non-temporary ID and full config identity match uniquely.
      const previous = (id ? byId.get(id) : undefined)
        || (identityMatches.length === 1 ? identityMatches[0] : undefined);
      const actualId = previous?.id || createProfileId();
      if (requestedId) draftIdToActualId.set(requestedId, actualId);
      // apiKey 传空串表示"不修改"，避免界面每次保存都把 key 擦掉
      const apiKey = String(draft.apiKey || '').trim() ? String(draft.apiKey).trim() : (previous?.apiKey || '');
      const enabledModels = Array.isArray(draft.enabledModels)
        ? Array.from(new Set(draft.enabledModels.map((item) => String(item).trim()).filter(Boolean)))
        : (previous?.enabledModels || []);
      const selectedModels = Array.isArray(draft.selectedModels)
        ? Array.from(new Set(draft.selectedModels.map((item) => String(item).trim()).filter(Boolean)))
        : (previous?.selectedModels || enabledModels);
      const requestedModel = String(draft.model ?? previous?.model ?? '').trim();
      const model = draftKind === 'video'
        // 视频配置：未显式选择默认模型时，自动落到第一个已勾选模型。
        // 这是「添加模型即可用」的关键一环——默认模型不再是一个隐藏的必填项。
        ? (enabledModels.length > 0
          ? (requestedModel && enabledModels.includes(requestedModel) ? requestedModel : enabledModels[0])
          : requestedModel)
        : resolveDefaultModel(requestedModel, enabledModels) || previous?.model || '';
      const baseUrl = draftKind === 'video'
        ? String(draft.baseUrl ?? previous?.baseUrl ?? '').trim()
        : draftBaseUrl || previous?.baseUrl || 'https://api.openai.com/v1';
      const defaultSize = draftKind === 'video'
        ? String(draft.defaultSize ?? previous?.defaultSize ?? '').trim()
        : String(draft.defaultSize || '').trim() || previous?.defaultSize || '1024x1024';
      profiles.push({
        id: actualId,
        name: draftName || previous?.name || defaultNameForKind(draftKind),
        baseUrl,
        apiKey,
        model,
        defaultSize,
        models: Array.isArray(draft.models) ? draft.models.map((item) => String(item)) : (previous?.models || []),
        enabledModels,
        selectedModels,
        kind: draftKind,
        textFormat: normalizeTextApiFormat(draft.textFormat ?? previous?.textFormat),
        imageApiMode: normalizeImageApiMode(draft.imageApiMode ?? previous?.imageApiMode),
        responsesModel: String(draft.responsesModel || previous?.responsesModel || 'gpt-5.5').trim() || 'gpt-5.5',
        videoApiMode: draftKind === 'video'
          ? normalizeVideoApiMode(draft.videoApiMode ?? previous?.videoApiMode)
          : undefined,
        videoCustomConfig: draftKind === 'video'
          ? normalizeCustomVideoApiConfig(draft.videoCustomConfig ?? previous?.videoCustomConfig, apiKey)
          : undefined,
        // 语言配置不再有配置级启停；生图 / 视频缺省沿用旧值，全新配置默认启用。
        enabled: draftKind === 'text'
          ? true
          : (typeof draft.enabled === 'boolean' ? draft.enabled : (previous?.enabled !== false)),
      });
    }
    if (profiles.length === 0) profiles.push(createProfile('默认模型'));
    const requestedActiveId = String(input.activeProfileId || '').trim();
    const activeIdCandidate = draftIdToActualId.get(requestedActiveId) || requestedActiveId;
    const activeId = profiles.some((profile) => profile.id === activeIdCandidate)
      ? activeIdCandidate
      : profiles[0].id;
    const requestedTextProfileId = typeof input.textProfileId === 'string' ? input.textProfileId : current.textProfileId;
    const textProfileId = draftIdToActualId.get(requestedTextProfileId) || requestedTextProfileId;
    const next: StoredSettings = {
      profiles,
      activeProfileId: activeId,
      direct: typeof input.direct === 'boolean' ? input.direct : current.direct !== false,
      promptOptimizationEnabled: typeof input.promptOptimizationEnabled === 'boolean' ? input.promptOptimizationEnabled : current.promptOptimizationEnabled,
      textProfileId,
      enhanceLevel: input.enhanceLevel ? normalizeEnhanceLevel(input.enhanceLevel) : current.enhanceLevel,
      preferences: input.preferences ? normalizePreferences(input.preferences) : current.preferences,
      chatMemory: normalizeMemorySettings({ ...current.chatMemory, ...input.chatMemory }),
      chatRuntime: normalizeChatRuntimeSettings({ ...current.chatRuntime, ...input.chatRuntime }),
    };
    await writeSettingsFile(next);
    return next;
  });
}

export function publicView(settings: StoredSettings) {
  return {
    profiles: settings.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      defaultSize: profile.defaultSize,
      models: profile.models,
      enabledModels: profile.enabledModels,
      selectedModels: profile.selectedModels,
      kind: profile.kind,
      textFormat: profile.textFormat,
      imageApiMode: profile.imageApiMode,
      responsesModel: profile.responsesModel,
      videoApiMode: profile.videoApiMode,
      videoCustomConfig: profile.videoCustomConfig
        ? normalizeCustomVideoApiConfig(profile.videoCustomConfig, profile.apiKey)
        : undefined,
      enabled: profile.enabled !== false,
      keyConfigured: Boolean(profile.apiKey),
    })),
    activeProfileId: activeProfile(settings).id,
    direct: settings.direct !== false,
    promptOptimizationEnabled: settings.promptOptimizationEnabled,
    textProfileId: settings.textProfileId,
    enhanceLevel: settings.enhanceLevel,
    chatMemory: normalizeMemorySettings(settings.chatMemory),
    chatRuntime: normalizeChatRuntimeSettings(settings.chatRuntime),
    preferences: {
      enabled: settings.preferences.enabled,
      entries: settings.preferences.entries,
      updatedAt: settings.preferences.updatedAt,
    },
  };
}
