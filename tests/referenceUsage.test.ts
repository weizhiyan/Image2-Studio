import { describe, expect, it } from 'vitest';
import { detectReferenceUsage } from '../bridge/textApi';

describe('detectReferenceUsage 参考图用法预判', () => {
  it('风格 / 呼应 / 做背景 → style（不复刻参考图主体）', () => {
    expect(detectReferenceUsage('这是ppt的两个页面。图2是结尾页面，图1是首页。现在我希望你根据图1这张插画的风格，帮我生成一个呼应的图片，放在结尾。格式jpg，高清，不要文字')).toBe('style');
    expect(detectReferenceUsage('根据图1的风格生成一张新背景')).toBe('style');
    expect(detectReferenceUsage('参考这两张图的感觉做一张年终海报')).toBe('style');
    expect(detectReferenceUsage('帮我生成一个呼应的图片')).toBe('style');
  });

  it('明确要改这张图本身 → edit', () => {
    expect(detectReferenceUsage('把图1里的天空换成黄昏')).toBe('edit');
    expect(detectReferenceUsage('基于这张图给猫加一顶帽子')).toBe('edit');
    expect(detectReferenceUsage('去掉图片里的文字')).toBe('edit');
    expect(detectReferenceUsage('在这张图上加一团篝火')).toBe('edit');
    expect(detectReferenceUsage('将这张图改为 16:9，右侧扩展留白')).toBe('edit');
    expect(detectReferenceUsage('扩展画布，补全右侧的云海')).toBe('edit');
  });

  it('两种说法同时出现时以改图为准（edit 优先）', () => {
    expect(detectReferenceUsage('保持图1的风格，把这张图的云层调亮一点')).toBe('edit');
  });

  it('无参考图场景 / 空输入不误判', () => {
    expect(detectReferenceUsage('')).toBe('style');
    expect(detectReferenceUsage('一只柴犬在樱花树下')).toBe('style');
  });
});

describe('fidelity 联动（GPT-image input_fidelity）', () => {
  it('style → low，edit → high', async () => {
    const { fidelityForUsage } = await import('../bridge/textApi');
    expect(fidelityForUsage('style')).toBe('low');
    expect(fidelityForUsage('edit')).toBe('high');
  });

  it('优化后的 prompt 带「本次用法」标记时最可信', async () => {
    const { usageForGenerateRequest } = await import('../bridge/textApi');
    expect(usageForGenerateRequest('xxx 本次用法：风格参考 yyy', '把这张改成黄昏')).toBe('style');
    expect(usageForGenerateRequest('xxx 本次用法：图生图 yyy', '根据风格生成新图')).toBe('edit');
  });

  it('直连（无标记）时退回对用户原句的规则预判', async () => {
    const { usageForGenerateRequest } = await import('../bridge/textApi');
    expect(usageForGenerateRequest('a lighthouse, no text', '根据图1风格生成呼应背景')).toBe('style');
    expect(usageForGenerateRequest('same scene, dusk sky', '把这张图的天空换成黄昏')).toBe('edit');
  });
});

describe('直连兜底注入 directStyleNote', () => {
  it('style + 编号段 → 前缀场景约束', async () => {
    const { directStyleNote } = await import('../bridge/textApi');
    const out = directStyleNote('附带参考图编号（按提供顺序）：图1、图2。\n根据图1风格生成', 'style');
    expect(out.startsWith('[风格参考约束]')).toBe(true);
    expect(out).toContain('主体与构图都不同于参考图');
    expect(out).toContain('根据图1风格生成');
  });

  it('edit 或不带编号段 → 原样返回', async () => {
    const { directStyleNote } = await import('../bridge/textApi');
    const p = '把这张图的天空换成黄昏';
    expect(directStyleNote(p, 'edit')).toBe(p);
    expect(directStyleNote(p, 'style')).toBe(p);
  });
});
