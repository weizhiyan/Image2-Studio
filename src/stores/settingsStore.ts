import { create } from 'zustand';
import type { EnhanceLevel, MediaSettings, ModelProfileView } from '@/types';
import { getSettings, saveSettings, type SettingsInput } from '@/lib/bridge';

interface SettingsState {
  settings: MediaSettings | null;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  save: (input: SettingsInput) => Promise<MediaSettings>;
  /** 只切换 Image API / Responses API 模式；不控制额外的提示词优化。 */
  setDirect: (direct: boolean) => Promise<void>;
  /** 只翻整理强度：节点工具栏的三档下拉走这条。 */
  setEnhanceLevel: (level: EnhanceLevel) => Promise<void>;
}

let settingsLoadRequestId = 0;

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loading: false,
  error: '',
  load: async () => {
    const requestId = ++settingsLoadRequestId;
    set({ loading: true, error: '' });
    try {
      const settings = await getSettings();
      if (requestId !== settingsLoadRequestId) return;
      set({ settings, loading: false });
    } catch (err) {
      if (requestId !== settingsLoadRequestId) return;
      set({ loading: false, error: err instanceof Error ? err.message : '读取配置失败' });
    }
  },
  save: async (input) => {
    // 失败必须落 error：否则界面上没有任何反馈，用户只会觉得“保存不了”
    try {
      const settings = await saveSettings(input);
      set({ settings, error: '' });
      return settings;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '保存配置失败' });
      throw err;
    }
  },
  setEnhanceLevel: async (level: EnhanceLevel) => {
    try {
      const settings = await saveSettings({ enhanceLevel: level });
      set({ settings, error: '' });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '保存整理强度失败' });
      throw err;
    }
  },
  setDirect: async (direct: boolean) => {
    try {
      const settings = await saveSettings({ direct });
      set({ settings, error: '' });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '保存配置失败' });
      throw err;
    }
  },
}));

/** 当前生效的那一路配置：没配好时返回 null，调用方据此拦到设置面板。 */
export function activeProfileOf(settings: MediaSettings | null): ModelProfileView | null {
  if (!settings || settings.profiles.length === 0) return null;
  return settings.profiles.find((profile) => profile.id === settings.activeProfileId)
    || settings.profiles[0]
    || null;
}

/** 某个 profile 是否可以直接生图（有 Key 且有模型）。 */
export function profileReady(profile: ModelProfileView | null | undefined): boolean {
  return Boolean(profile?.keyConfigured && profile?.model);
}
