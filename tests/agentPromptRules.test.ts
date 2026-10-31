import { describe, expect, it } from 'vitest';
import * as textApi from '../bridge/textApi';
import { generateImageToolDef, jsonProtocolSpec } from '../bridge/agent';
import type { EnhanceLevel } from '../bridge/settings';

describe('Agent 与独立优化器共用视觉规则', () => {
  it.each(['strict', 'balanced', 'creative'] as EnhanceLevel[])('%s 规则不携带独立优化器的任务或输出协议', (level) => {
    expect(textApi).toHaveProperty('buildVisualPromptRules', expect.any(Function));
    const rules = textApi.buildVisualPromptRules('1024x1536', level);
    expect(rules).toContain(textApi.LEVEL_SPECS[level].freedom);
    expect(rules).toContain('竖向画幅');
    expect(rules).toContain('图中文字');
    expect(rules).toContain('一字不改');
    expect(rules).toContain('保留参考图的主体与构图');
    expect(rules).toContain('必须保留');
    expect(rules).toContain('否定约束');
    expect(rules).not.toMatch(/唯一任务|只输出|JSON|输出格式/);
    const standalone = textApi.buildSystemSpec('1024x1536', level);
    expect(standalone).toContain(rules);
    expect(standalone).toContain('只输出一个 JSON 对象');
    expect(standalone).toContain('你的唯一任务');
  });

  it('工具与 JSON 协议要求 Agent 直接提交最终 prompt 并可留存原始意图', () => {
    const definition = generateImageToolDef();
    const properties = definition.parameters.properties as Record<string, { description: string }>;
    expect(properties.prompt.description).toMatch(/最终.*提示词/);
    expect(properties.originalPrompt.description).toContain('原始');
    expect(definition.parameters.required).toEqual(['prompt']);
    expect(jsonProtocolSpec()).toContain('最终');
    expect(jsonProtocolSpec()).toContain('originalPrompt');
    expect(`${properties.prompt.description}\n${jsonProtocolSpec()}`).not.toMatch(/优化器的输入|会统一优化一次|不要自行扩写/);
  });
});
