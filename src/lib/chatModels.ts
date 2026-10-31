import type { ChatThread, MediaSettings } from '@/types';

export interface ChatModelOption {
  key: string;
  profileId: string;
  profileName: string;
  model: string;
}

function optionsOf(settings: MediaSettings | null | undefined, kind: 'text' | 'image'): ChatModelOption[] {
  return (settings?.profiles || [])
    // 语言配置没有配置级启停，生图 / 视频仍按 enabled 过滤。
    .filter((profile) => profile.kind === kind && (kind === 'text' || profile.enabled !== false))
    .flatMap((profile) => {
      const enabled = profile.enabledModels || [];
      // 旧配置没有 selectedModels 且 enabledModels 为空时，手填的默认模型仍可用。
      const models = enabled.length > 0
        ? enabled
        : (profile.selectedModels === undefined && profile.model ? [profile.model] : []);
      return models.map((model) => ({
        key: `${profile.id}:${model}`,
        profileId: profile.id,
        profileName: profile.name,
        model,
      }));
    });
}

/** 对话可选的每个语言模型（配置 × 已勾选模型）。 */
export function chatTextModelOptions(settings: MediaSettings | null | undefined): ChatModelOption[] {
  return optionsOf(settings, 'text');
}

/** Agent 出图可选的每个生图模型（配置 × 已勾选模型）。 */
export function chatImageModelOptions(settings: MediaSettings | null | undefined): ChatModelOption[] {
  return optionsOf(settings, 'image');
}

/** 线程发出第一条消息后锁定语言模型，换模型只能新建对话。 */
export function isChatTextModelLocked(thread: ChatThread | undefined): boolean {
  return Boolean(thread && thread.messages.length > 0);
}

function savedOption(
  settings: MediaSettings | null | undefined,
  kind: 'text' | 'image',
  profileId: string | undefined,
  model: string | undefined,
): ChatModelOption | null {
  const profile = (settings?.profiles || []).find((item) => item.kind === kind && item.id === profileId);
  if (!profile) return null;
  const wanted = String(model || '').trim();
  const chosen = wanted && (profile.enabledModels?.length ? profile.enabledModels.includes(wanted) : wanted === profile.model)
    ? wanted
    : profile.model;
  return { key: `${profile.id}:${chosen}`, profileId: profile.id, profileName: profile.name, model: chosen };
}

/**
 * 线程保存的语言模型（锁定线程即使配置后来被停用也继续沿用）；
 * 没有保存时回落到设置里的默认语言模型，再不行取第一路可用。
 */
export function resolveChatTextSelection(
  settings: MediaSettings | null | undefined,
  thread: ChatThread | undefined,
): ChatModelOption | null {
  const saved = savedOption(settings, 'text', thread?.textProfileId, thread?.textModel);
  if (saved) return saved;
  const options = chatTextModelOptions(settings);
  const preferred = String(settings?.textProfileId || '');
  return options.find((option) => option.profileId === preferred) || options[0] || null;
}

/** 线程保存的 Agent 生图模型；没有时回落到设置里的默认生图配置。 */
export function resolveChatImageSelection(
  settings: MediaSettings | null | undefined,
  thread: ChatThread | undefined,
): ChatModelOption | null {
  const saved = savedOption(settings, 'image', thread?.imageProfileId, thread?.imageModel);
  if (saved) return saved;
  const options = chatImageModelOptions(settings);
  const preferred = String(settings?.activeProfileId || '');
  return options.find((option) => option.profileId === preferred) || options[0] || null;
}

export function chatModelLabel(option: ChatModelOption | null, fallback: string): string {
  return option?.model || fallback;
}
