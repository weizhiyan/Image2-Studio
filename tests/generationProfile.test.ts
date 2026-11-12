import { describe, expect, it } from 'vitest';
import { activeProfileOf } from '../src/stores/settingsStore';
import type { MediaSettings } from '../src/types';

const settings = {
  activeProfileId: 'default',
  profiles: [
    { id: 'default', name: 'Default', baseUrl: 'https://default.example.test/v1',
      model: 'default-image', keyConfigured: false,
      defaultSize: '1024x1024', imageApiMode: 'images' },
    { id: 'selected', name: 'Selected', baseUrl: 'https://selected.example.test/v1',
      model: 'selected-image', keyConfigured: true,
      defaultSize: '1024x1536', imageApiMode: 'responses', responsesModel: 'selected-reasoner' },
  ],
} as MediaSettings;

describe('生成节点配置选择', () => {
  it('先采用节点显式配置，Key、模型、接口与默认尺寸来自同一路', () => {
    expect(activeProfileOf(settings, 'selected')).toMatchObject({
      id: 'selected', keyConfigured: true, model: 'selected-image',
      defaultSize: '1024x1536', imageApiMode: 'responses', responsesModel: 'selected-reasoner',
    });
  });

  it('未指定时优先完整可用的配置，已删除的 id 也回落到可用配置', () => {
    expect(activeProfileOf(settings)?.id).toBe('selected');
    expect(activeProfileOf(settings, 'removed')?.id).toBe('selected');
    expect(activeProfileOf(null, 'selected')).toBeNull();
    expect(activeProfileOf({ ...settings, profiles: [] }, 'selected')).toBeNull();
  });

  it('生效配置本身可用时保持用户选择，不被其他可用配置顶替', () => {
    expect(activeProfileOf({ ...settings, activeProfileId: 'selected' })?.id).toBe('selected');
    const activeReady = {
      ...settings,
      profiles: settings.profiles.map((profile) => (
        profile.id === 'default' ? { ...profile, keyConfigured: true } : profile
      )),
    } as MediaSettings;
    expect(activeProfileOf(activeReady)?.id).toBe('default');
  });
});
