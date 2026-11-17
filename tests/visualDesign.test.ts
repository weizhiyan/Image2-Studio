import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileVisualDesign, parseVisualDesign, visualDesignIssues, type VisualDesign } from '../bridge/visualDesign';
import { enhancePromptDetailed, finishVisualDesign } from '../bridge/textApi';
import { generateImageToolDef, jsonProtocolSpec } from '../bridge/agent';
import type { ModelProfile } from '../bridge/settings';

const profile = { id: 'text-test', name: '测试', kind: 'text', baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'test-model', textFormat: 'chat', models: [], enabledModels: [], defaultSize: '1024x1024' } satisfies ModelProfile;

function draft(): VisualDesign {
  return {
    task: 'background', mode: 'create', goal: '安静的旅行结尾背景', aspectRatio: '16:9',
    requirements: [{ source: '不要文字', instruction: '画面不添加文字' }], exactText: [], copy: [], openDecisions: ['决定景物与构图'],
    visual: { idea: '水彩山路消失在远处海湾', focus: '道路与海湾的交接', composition: '道路从左下向中部延伸，上部天空留白', appearance: '暖色水彩', typography: '', changes: '', preserve: '' },
    references: [],
  };
}

const context = { prompt: '旅行结尾背景，16:9，不要文字', lockedAspect: '16:9', referenceCount: 0 };

function responses(...outputs: unknown[]) {
  const queue = [...outputs];
  const fetchMock = vi.fn(async () => {
    if (!queue.length) throw new Error('Unexpected extra language request');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(queue.shift()) }, finish_reason: 'stop' }] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('设计中间结果与最终提示词', () => {
  it('只编译确定的设计与文案，不将出处、待决策标签或JSON发给生图', () => {
    const design = draft();
    const prompt = compileVisualDesign(design);
    expect(prompt).toContain(design.visual.idea);
    expect(prompt).toContain('画幅：16:9');
    expect(prompt).not.toContain('openDecisions');
    expect(prompt).not.toContain('决定景物与构图');
    expect(prompt).not.toContain('source');
  });

  it('模型不能借解释硬要求扩大用户的禁令', () => {
    const design = draft();
    design.requirements = [{ source: '不要咖啡杯图案', instruction: '禁止咖啡杯、咖啡豆和蒸汽' }];
    expect(compileVisualDesign(design)).toContain('不要咖啡杯图案');
    expect(compileVisualDesign(design)).not.toContain('咖啡豆');
  });

  it('不接受伪造的需求出处、无效编号与画幅冲突', () => {
    const design = draft();
    design.requirements.push({ source: '不要人物', instruction: '禁止人物' });
    design.references = [{ index: 2, use: '保留主体' }];
    design.aspectRatio = '1:1';
    expect(visualDesignIssues(design, context).join('\n')).toMatch(/找不到该出处/);
    expect(visualDesignIssues(design, context).join('\n')).toMatch(/未提供的图片/);
    expect(visualDesignIssues(design, context).join('\n')).toMatch(/画幅必须是 16:9/);
    expect(() => parseVisualDesign({ ...design, visual: null })).toThrow();
  });

  it('文案记录只包含实际文字，逐字文案与可整理口语分开', () => {
    const design = draft();
    design.requirements = [];
    design.exactText = ['新店开业'];
    design.copy = [{ source: '活动一个礼拜17号到23号', text: '活动时间：17日—23日' }];
    const prompt = compileVisualDesign(design);
    expect(prompt).toContain('"新店开业"');
    expect(prompt).toContain('"活动时间：17日—23日"');
    expect(prompt).not.toContain('活动一个礼拜');
    expect(visualDesignIssues(design, { ...context, prompt: '新店开业，活动一个礼拜17号到23号' })).toEqual([]);
  });

  it('参考图每张都必须有用途，编辑模式不能偷偷变成新创作', () => {
    expect(visualDesignIssues(draft(), { ...context, referenceCount: 2, usage: 'edit' }).join('\n')).toMatch(/明确的原图编辑/);
    const design = draft();
    design.mode = 'edit';
    design.references = [{ index: 1, use: '仅修改背景' }, { index: 2, use: '只参考笔触' }];
    expect(visualDesignIssues(design, { ...context, referenceCount: 2, usage: 'edit' })).toEqual([]);
  });

  it('检查实际画面文案的条件，不被需求区里保留的数字掩盖', () => {
    const design = draft();
    design.requirements = [];
    design.copy = [{ source: '单张中200元即额外赠送28元', text: '中200元送28元' }];
    expect(visualDesignIssues(design, { ...context, prompt: design.copy[0].source }).join('\n')).toContain('单张条件');
    design.copy[0].text = '单张中200元赠28元';
    expect(visualDesignIssues(design, { ...context, prompt: design.copy[0].source })).toEqual([]);
    design.copy = [{ source: '每人最多带3本书', text: '携带3本书' }];
    expect(visualDesignIssues(design, { ...context, prompt: design.copy[0].source }).join('\n')).toContain('数量上限');
  });

  it('不能用需求区的数值掩盖文案改错，重复日期也会被检查', () => {
    const design = draft();
    design.copy = [{ source: '有机会获得5注', text: '必得6注' }];
    expect(visualDesignIssues(design, { ...context, prompt: '有机会获得5注，不要文字' }).join('\n')).toContain('5注');
    expect(visualDesignIssues(design, { ...context, prompt: '有机会获得5注，不要文字' }).join('\n')).toContain('概率条件');
    design.exactText = ['11月17日'];
    design.copy = [{ source: '开业11月17日', text: '开业时间：11月17日' }];
    expect(visualDesignIssues(design, { ...context, prompt: '开业11月17日，不要文字' }).join('\n')).toContain('重复');
  });
});

describe('有界设计核对', () => {
  it('简单需求一次调用，并返回可追溯的设计结论', async () => {
    const fetchMock = responses({ design: draft() });
    const result = await enhancePromptDetailed(profile, { prompt: context.prompt, planningMode: 'design' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.prompt).toContain('水彩山路');
    expect(result.planning).toMatchObject({ reviewed: false, repaired: false });
    expect(result.design?.aspectRatio).toBe('16:9');
  });

  it('明确校验问题只进行一次定向修正', async () => {
    const bad = { ...draft(), aspectRatio: '1:1' };
    const fetchMock = responses({ design: bad }, { issues: ['固定画幅冲突'], design: draft() });
    const result = await enhancePromptDetailed(profile, { prompt: context.prompt, planningMode: 'design' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.planning).toMatchObject({ reviewed: true, repaired: true });
    expect(result.aspectRatio).toBe('16:9');
  });

  it('修正后仍不合格就停止，不继续花费或送出错误提示词', async () => {
    const bad = { ...draft(), aspectRatio: '1:1' };
    const fetchMock = responses({ design: bad }, { issues: ['画幅冲突'], design: bad });
    await expect(enhancePromptDetailed(profile, { prompt: context.prompt, planningMode: 'design' })).rejects.toThrow('核对后仍不符合');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('复杂需求即使程序检查通过，也核对事实关系，原方案通过时不重写', async () => {
    const fetchMock = responses({ issues: [], design: null });
    const result = await finishVisualDesign(profile, draft(), { ...context, prompt: context.prompt + '保持安静氛围。'.repeat(50) }, { imageUrls: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.design).toEqual(draft());
    expect(result.planning).toMatchObject({ reviewed: true, repaired: false });
    const request = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].body));
    expect(request.messages[0].content).toContain('核对输出协议替代');
  });

  it('核对发现未修复问题时不能算优化成功', async () => {
    responses({ issues: ['把概率奖励变成了必得'], design: null });
    await expect(finishVisualDesign(profile, draft(), { ...context, prompt: context.prompt + '活动说明'.repeat(100) }, { imageUrls: [] })).rejects.toThrow('概率奖励');
  });

  it('Agent工具和JSON回落提供相同设计协议，兼容旧工具', () => {
    expect(generateImageToolDef(true).parameters.required).toEqual(['design']);
    expect(generateImageToolDef(false).parameters.required).toEqual(['prompt']);
    expect(jsonProtocolSpec(true)).toContain('必须提供 design');
    expect(jsonProtocolSpec(false)).toContain('最终生图提示词');
  });
});
