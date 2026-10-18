import { describe, expect, it } from 'vitest';
import { pickTextProfile, resolveDirect, shouldEnhancePrompt } from '../src/lib/enhance';
import { preferenceBlockText } from '../src/lib/bridge';
import { normalizeEnhanceLevel, normalizeSettings } from '../bridge/settings';
import type { MediaSettings, ModelProfileView } from '../src/types';

function profile(partial: Partial<ModelProfileView>): ModelProfileView {
  return {
    id: partial.id || 'p1',
    name: partial.name || '配置',
    baseUrl: 'https://api.openai.com/v1',
    model: partial.model ?? 'gpt-4o-mini',
    defaultSize: '1024x1024',
    models: [],
    enabledModels: [],
    kind: partial.kind || 'image',
    keyConfigured: partial.keyConfigured ?? true,
    textFormat: partial.textFormat || 'auto',
  };
}

function settings(partial: Partial<MediaSettings>): MediaSettings {
  return {
    profiles: partial.profiles || [],
    activeProfileId: partial.activeProfileId || '',
    direct: partial.direct ?? true,
    promptOptimizationEnabled: partial.promptOptimizationEnabled ?? false,
    textProfileId: partial.textProfileId ?? '',
    enhanceLevel: partial.enhanceLevel || 'balanced',
    preferences: partial.preferences || { enabled: false, entries: [], updatedAt: '' },
  };
}

describe('resolveDirect', () => {
  it('节点没显式选过时跟随全局', () => {
    expect(resolveDirect(undefined, true)).toBe(true);
    expect(resolveDirect(undefined, false)).toBe(false);
  });

  it('全局缺省视为直连', () => {
    expect(resolveDirect(undefined, undefined)).toBe(true);
  });

  it('节点显式覆盖优先于全局', () => {
    expect(resolveDirect(true, false)).toBe(true);
    expect(resolveDirect(false, true)).toBe(false);
  });
});

describe('提示词优化设置', () => {
  it('与旧 API 模式开关互不影响，旧设置缺省不额外调用语言模型', () => {
    const current = settings({ direct: false });
    expect(current.direct).toBe(false);
    expect(current.promptOptimizationEnabled).toBe(false);
    expect(settings({ promptOptimizationEnabled: true }).direct).toBe(true);
  });

  it('打开智能生成时即使旧的独立开关为 false 也会整理提示词', () => {
    expect(shouldEnhancePrompt(settings({ promptOptimizationEnabled: false }), false)).toBe(true);
    expect(shouldEnhancePrompt(settings({ promptOptimizationEnabled: false }), true)).toBe(false);
    expect(shouldEnhancePrompt(settings({ promptOptimizationEnabled: true }), true)).toBe(true);
  });

  it('空的语言模型名称读取后仍为空，不误用生图模型', () => {
    const current = normalizeSettings({
      profiles: [{ id: 'text-1', name: '语言模型', kind: 'text', model: '', apiKey: 'test-key' }],
      activeProfileId: 'text-1',
    });
    expect(current.profiles[0].model).toBe('');
  });
});

describe('pickTextProfile', () => {
  it('没有语言模型时返回 null', () => {
    expect(pickTextProfile(settings({ profiles: [profile({})] }))).toBeNull();
    expect(pickTextProfile(null)).toBeNull();
  });

  it('优先设置里选中的那把', () => {
    const result = pickTextProfile(settings({
      profiles: [profile({ id: 'a', kind: 'text' }), profile({ id: 'b', kind: 'text' })],
      textProfileId: 'b',
    }));
    expect(result?.id).toBe('b');
  });

  it('没选中时回落第一把', () => {
    const result = pickTextProfile(settings({ profiles: [profile({ id: 'a', kind: 'text' }), profile({ id: 'b', kind: 'text' })] }));
    expect(result?.id).toBe('a');
  });

  it('Key 或模型没配好时不可用', () => {
    expect(pickTextProfile(settings({ profiles: [profile({ kind: 'text', keyConfigured: false })] }))).toBeNull();
    expect(pickTextProfile(settings({ profiles: [profile({ kind: 'text', model: '' })] }))).toBeNull();
  });

  it('只认语言模型，生图配置不算', () => {
    const result = pickTextProfile(settings({ profiles: [profile({ id: 'img' })] }));
    expect(result).toBeNull();
  });
});

describe('normalizeEnhanceLevel', () => {
  it('只认三档，其余回落均衡', () => {
    expect(normalizeEnhanceLevel('strict')).toBe('strict');
    expect(normalizeEnhanceLevel('balanced')).toBe('balanced');
    expect(normalizeEnhanceLevel('creative')).toBe('creative');
    expect(normalizeEnhanceLevel('wild')).toBe('balanced');
    expect(normalizeEnhanceLevel(undefined)).toBe('balanced');
  });
});

describe('preferenceBlockText', () => {
  it('空档案不注入', () => {
    expect(preferenceBlockText([])).toBe('');
  });

  it('条目按行拼进 system 段，并带上“冲突以本次为准”', () => {
    const text = preferenceBlockText([
      { id: 'a', text: '偏好国潮插画', source: 'auto', createdAt: '' },
      { id: 'b', text: '偏好暖色调', source: 'manual', createdAt: '' },
    ]);
    expect(text).toContain('冲突时以本次要求为准');
    expect(text).toContain('- 偏好国潮插画');
    expect(text).toContain('- 偏好暖色调');
  });
});
