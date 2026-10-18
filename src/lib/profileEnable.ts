/** 一路模型配置的启停态最小视图：设置面板的草稿、bridge 的 profile 都套得上 */
export interface ProfileEnableLike {
  id: string;
  /** 'text' = 语言模型（提示词优化 / Responses 主模型）；其余按生图配置处理 */
  kind?: string;
  /** 缺省视为启用：老配置没有这个字段，不能一升级就全部停用 */
  enabled?: boolean;
}

/** 生图配置可以多路同时启用；语言模型同时只跑一路。 */
export const SINGLE_ENABLE_KIND = 'text';

/** 是否启用这路配置：缺省 true（对齐 bridge 的 `enabled !== false`） */
export function isProfileEnabled(profile: ProfileEnableLike): boolean {
  return profile.enabled !== false;
}

/**
 * 语言模型同时只能启用一路：除 keepId 之外的语言模型一律置停用，生图配置不动。
 *
 * 用在三个入口——新建语言模型、勾选启用某一路、保存前归一——
 * 保证「同时只跑一路」不依赖用户按顺序操作，也不怕老配置里躺着两路启用。
 * keepId 为空串（没有可留的语言模型）时，全部语言模型停用。
 */
export function withSingleLanguageProfile<T extends ProfileEnableLike>(profiles: T[], keepId: string): T[] {
  return profiles.map((profile) => (
    profile.kind === SINGLE_ENABLE_KIND && profile.id !== keepId ? { ...profile, enabled: false } : profile
  ));
}

/**
 * 该留用的那一路语言模型 id：优先显式指定的 textProfileId，
 * 否则第一路仍启用的，再不行第一路语言模型。返回空串表示没有该留的。
 */
export function pickSingleLanguageProfileId(profiles: ProfileEnableLike[], preferredId?: string): string {
  const languages = profiles.filter((profile) => profile.kind === SINGLE_ENABLE_KIND);
  if (languages.length === 0) return '';
  if (preferredId && languages.some((profile) => profile.id === preferredId && isProfileEnabled(profile))) {
    return preferredId;
  }
  // 全都停用是用户的明确选择（提示词优化不开）：返回空串，别把哪一路悄悄打开
  const stillEnabled = languages.find((profile) => isProfileEnabled(profile));
  return stillEnabled ? stillEnabled.id : '';
}
