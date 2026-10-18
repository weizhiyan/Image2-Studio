import { describe, expect, it, vi } from 'vitest';
import { compileChatPrompt } from '../bridge/runs';
import type { ModelProfile } from '../bridge/settings';
import type { PromptEnhancementResult } from '../bridge/textApi';

const profile: ModelProfile = {
  id: 'text-1',
  name: '语言模型',
  baseUrl: 'https://example.com/v1',
  apiKey: 'test-key',
  model: 'text-model',
  defaultSize: '1024x1024',
  models: [],
  enabledModels: [],
  kind: 'text',
  textFormat: 'chat',
};

const input = {
  prompt: '保留刚才的圆形图标，只把字重调细',
  size: '1024x1024',
  referenceDataUrls: ['data:image/png;base64,AAAA'],
  usage: 'edit' as const,
  level: 'balanced' as const,
  preferences: [],
};

describe('compileChatPrompt', () => {
  it('只调用一次优化器，并返回优化后的提示词', async () => {
    const enhance = vi.fn(async (): Promise<PromptEnhancementResult> => ({
      prompt: '保留圆形图标与构图，仅将品牌文字改为更细的字重。',
      usage: 'edit',
    }));
    const result = await compileChatPrompt(profile, input, enhance);
    expect(enhance).toHaveBeenCalledTimes(1);
    expect(result.prompt).toContain('更细的字重');
    expect(result.enhancedPrompt).toBe(result.prompt);
    expect(result.warning).toBeUndefined();
  });

  it('优化失败时回退原文并返回可展示的 warning', async () => {
    const enhance = vi.fn(async () => {
      throw new Error('语言模型超时');
    });
    const result = await compileChatPrompt(profile, input, enhance);
    expect(result.prompt).toBe(input.prompt);
    expect(result.enhancedPrompt).toBe('');
    expect(result.warning).toContain('提示词优化失败');
    expect(result.warning).toContain('语言模型超时');
  });
});
