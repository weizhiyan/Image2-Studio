/** 一路模型配置的启停态最小视图：设置面板的草稿、bridge 的 profile 都套得上 */
export interface ProfileEnableLike {
  id: string;
  /** 'text' = 语言模型（对话 / 提示词优化）；其余按生图配置处理 */
  kind?: string;
  /** 缺省视为启用：老配置没有这个字段，不能一升级就全部停用 */
  enabled?: boolean;
}

/** 是否启用这路配置：缺省 true（对齐 bridge 的 `enabled !== false`） */
export function isProfileEnabled(profile: ProfileEnableLike): boolean {
  return profile.enabled !== false;
}

/**
 * 默认语言模型：优先设置里选中的那一路（且仍启用），否则第一路启用的语言模型。
 * 全部停用时返回空串——这是用户的明确选择，不悄悄打开任何一路。
 * 语言模型本身允许多路同时启用，对话里可按线程选择具体模型。
 */
export function pickDefaultLanguageProfileId(profiles: ProfileEnableLike[], preferredId?: string): string {
  const languages = profiles.filter((profile) => profile.kind === 'text');
  if (languages.length === 0) return '';
  if (preferredId && languages.some((profile) => profile.id === preferredId && isProfileEnabled(profile))) {
    return preferredId;
  }
  const stillEnabled = languages.find((profile) => isProfileEnabled(profile));
  return stillEnabled ? stillEnabled.id : '';
}
