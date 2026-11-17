import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPromptAspect, assertPromptFacts, fallbackImageAspect, imageAspectPlan, imagePlanningTokenBudget, promptAspectRatio } from '../bridge/imagePlanning';
import { buildSystemSpec, buildVisualPromptRules, enhancePromptDetailed } from '../bridge/textApi';
import type { ModelProfile } from '../bridge/settings';
import { planImageGeneration, resolvePlannedImageSize } from '../src/lib/imageGenerationPlan';

const profile: ModelProfile = {
  id: 'text-test', name: '测试模型', kind: 'text', apiKey: 'test-key',
  baseUrl: 'https://example.com/v1', model: 'text-model', textFormat: 'chat',
  defaultSize: '1024x1024', models: [], enabledModels: [],
};

function reply(content: object | string, textFormat = 'chat') {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(textFormat === 'responses'
    ? { status: 'completed', output_text: text }
    : { choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('画幅识别与兜底', () => {
  it('识别画幅，不把时间、引号内文案或人物肖像当画幅', () => {
    expect(promptAspectRatio('海报，11:17开业')).toBeUndefined();
    expect(promptAspectRatio('营业时间 16:9')).toBeUndefined();
    expect(promptAspectRatio('a portrait of a woman in a landscape')).toBeUndefined();
    expect(promptAspectRatio('设计Logo，三条竖向线条，横向排列')).toBeUndefined();
    expect(promptAspectRatio('标题“1:1服务”，竖版 2:3')).toBe('2:3');
    expect(promptAspectRatio('尺寸 1024×1536')).toBe('2:3');
  });

  it.each([
    ['包含多项活动的开业海报', '2:3'],
    ['给 PPT 结尾做一张云海背景', '16:9'],
    ['为咖啡馆设计 Logo', '1:1'],
    ['海报采用 16:9', '16:9'],
  ])('%s 的兜底比例为 %s', (prompt, expected) => {
    expect(fallbackImageAspect(prompt)).toBe(expected);
  });

  it('自动模式把临时方形留给模型决定，固定尺寸不能被模型覆盖', () => {
    expect(imageAspectPlan({ prompt: '开业海报', size: '1024x1024', aspectRatio: 'auto' })).toEqual({ aspectRatio: '2:3', locked: false });
    expect(imageAspectPlan({ prompt: '开业海报', size: '1024x1024' })).toEqual({ aspectRatio: '1:1', locked: true });
    expect(imageAspectPlan({ prompt: '海报 2:3', size: '1024x1024', aspectRatio: 'auto' })).toEqual({ aspectRatio: '2:3', locked: true });
    expect(imageAspectPlan({ prompt: '海报 2:3', size: '1024x1024' })).toEqual({ aspectRatio: '2:3', locked: true });
    expect(fallbackImageAspect('修改海报颜色', '1536x1024', 'edit')).toBe('3:2');
    expect(imageAspectPlan({ prompt: '把背景改蓝', aspectRatio: 'auto', referenceSize: '1536x1024', usage: 'edit' })).toEqual({ aspectRatio: '3:2', locked: true });
  });
});

describe('节点优化结果与实际参数', () => {
  const input = { prompt: '做一张开业海报', ratio: 'auto', defaultSize: '1024x1024', optimize: true };

  it('优化器返回竖幅后重新计算实际尺寸，失败也不退回默认方形', () => {
    const plan = planImageGeneration(input);
    expect(plan.automatic).toBe(true);
    const [fallbackWidth, fallbackHeight] = plan.size.split('x').map(Number);
    expect(fallbackHeight / fallbackWidth).toBeCloseTo(1.5, 1);
    const size = resolvePlannedImageSize(plan, { prompt: '画幅 9:16，标题和活动区域上下分布。', aspectRatio: '9:16' });
    const [width, height] = size.split('x').map(Number);
    expect(height / width).toBeCloseTo(16 / 9, 1);
  });

  it('保持手动画幅、显式比例、扩图尺寸和分辨率档位', () => {
    const manual = planImageGeneration({ ...input, ratio: '1:1' });
    expect(manual.automatic).toBe(false);
    expect(resolvePlannedImageSize(manual, { prompt: '方形海报，各区清晰分组。', aspectRatio: '2:3' })).toBe('1024x1024');
    expect(planImageGeneration({ ...input, prompt: '海报 16:9', ratio: '1:1' }).automatic).toBe(false);
    expect(planImageGeneration({ ...input, sizeOverride: '1536x1024' }).size).toBe('1536x1024');
    expect(planImageGeneration({ ...input, editingSize: '1536x1024' }).automatic).toBe(false);
    const highResolution = planImageGeneration({ ...input, resolution: '2K' });
    expect(resolvePlannedImageSize(highResolution, { prompt: '宽幅 16:9 的背景', aspectRatio: '16:9' })).toBe('2048x1152');
  });

  it('继续编辑保留基准画幅，用户重新选比例时仍以用户选择为准', () => {
    const editing = planImageGeneration({ ...input, editingSize: '1536x1024' });
    expect(Number(editing.size.split('x')[0])).toBeGreaterThan(Number(editing.size.split('x')[1]));
    expect(planImageGeneration({ ...input, ratio: '1:1', editingSize: '1536x1024' }).size).toBe('1024x1024');
  });

  it('关闭优化时不把新的用途推断施加到直连', () => {
    const direct = planImageGeneration({ ...input, optimize: false });
    expect(direct.automatic).toBe(false);
    expect(direct.size).toBe('1024x1024');
  });
});

describe('智能设计约束', () => {
  it('以原文为基础，不强制补齐视觉方案，保留画幅和事实检查', () => {
    const rules = buildVisualPromptRules('', 'balanced');
    expect(rules).toContain('原文已经清楚时可以原样返回');
    expect(rules).toContain('不主动指定用户未决定的主体、配色、字体、材质或布局');
    expect(rules).toContain('数值与条件关系');
    expect(rules).not.toMatch(/明确一套适合当前目标的视觉方向|未决定的必要设计由你补齐/);
    expect(rules).not.toContain('80–150');
    expect(rules).not.toContain('按 1:1 方形构图');
    expect(buildSystemSpec('', 'balanced')).toContain('aspectRatio');
    expect(imagePlanningTokenBudget('活动文案'.repeat(1000))).toBeGreaterThan(6000);
  });

  it('检查画幅冲突并允许同方向的文字描述', () => {
    expect(() => assertPromptAspect('设计一张1:1方形海报', '1024x1536')).toThrow('不一致');
    expect(() => assertPromptAspect('竖版海报', '1024x1536')).not.toThrow();
    expect(() => assertPromptAspect('标题“1:1服务”，竖版海报', '1024x1536')).not.toThrow();
    expect(() => assertPromptAspect('竖版 2:3 海报', '848x1264')).not.toThrow();
  });

  it('拦截遗漏或改动数值，金额子串不算保留', () => {
    expect(() => assertPromptFacts('中500元送58元，11月17日开业', '中1500元送58元，11月17日开业')).toThrow('500元');
    expect(() => assertPromptFacts('中500元送58元，11月17日开业', '中500元送58元，11月17日开业')).not.toThrow();
    expect(() => assertPromptFacts('不要原来的500元，改为200元', '金额改为200元，其余不变')).not.toThrow();
    expect(() => assertPromptFacts('从500元改为200元', '金额改为200元，其余不变')).not.toThrow();
  });

  it('允许日历日期的号与日互换，不把地址和编号当日期', () => {
    expect(() => assertPromptFacts('开业时间11月17日，活动一个礼拜17号到23号，地点汇旺路1079号', '开业11月17日，活动11月17日—11月23日，地点汇旺路1079号')).not.toThrow();
    expect(() => assertPromptFacts('活动日期11月17号到23号', '活动11月17日—11月23日')).not.toThrow();
    expect(() => assertPromptFacts('开业11月17日', '开业11月17号')).not.toThrow();
    expect(() => assertPromptFacts('活动17号到23号', '活动17日到24日')).toThrow('23号');
    expect(() => assertPromptFacts('地址：汇旺路17号', '地址：汇旺路17日')).toThrow('17号');
    expect(() => assertPromptFacts('编号23号', '编号23日')).toThrow('23号');
    expect(() => assertPromptFacts('地点：汇旺路1079号', '地点：汇旺路1079日')).toThrow('1079号');
  });

  it('给推理与最终提示词共同预留预算，仍有上限', () => {
    expect(imagePlanningTokenBudget('复杂海报')).toBeGreaterThanOrEqual(8192);
    expect(imagePlanningTokenBudget('信息'.repeat(10000))).toBeLessThanOrEqual(16000);
  });

  it('独立引号和逗号中的日期不受前文地点说明干扰', () => {
    const source = '开业时间11月17日，活动一个礼拜17号到23号，地址汇旺路1079号';
    expect(() => assertPromptFacts(source, '展示时间与地点：“开业时间：11月17日”“活动时间：17号到23号”“地址：汇旺路1079号”')).not.toThrow();
    expect(() => assertPromptFacts(source, '地点汇旺路1079号，活动时间17号到23号，开业11月17日')).not.toThrow();
    expect(() => assertPromptFacts(source, '展示时间与地点：“开业时间：11月17日”“活动时间：17号到24号”“地址：汇旺路1079号”')).toThrow('23号');
    expect(() => assertPromptFacts('地点：“汇旺路17号”', '地点：“汇旺路17日”')).toThrow('17号');
    expect(() => assertPromptFacts('活动日期11月17日，编号23号', '活动日期11月17日，编号23日')).toThrow('23号');
  });
});

describe('优化接口的真实编译过程（模拟上游）', () => {
  it.each(['chat', 'responses'] as const)('%s 接受保持原文的短需求，不强迫模型扩写', async (textFormat) => {
    for (const prompt of ['一只猫', 'A red fox']) {
      const fetchMock = reply({ prompt, aspectRatio: '1:1', usage: 'style' }, textFormat);
      await expect(enhancePromptDetailed({ ...profile, textFormat }, { prompt, aspectRatio: 'auto' }))
        .resolves.toMatchObject({ prompt, aspectRatio: '1:1', usage: 'style' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('接受完整的用户自定方案，不把精确细节当成过度设计删除', async () => {
    const prompt = '为“山间来信”设计咖啡馆Logo。绿色山形与信封融合，居中图上字下，粗线条，最多两种颜色，不要样机。画幅1:1。';
    reply({ prompt, aspectRatio: '1:1', usage: 'style' });
    await expect(enhancePromptDetailed(profile, { prompt, level: 'balanced' })).resolves.toMatchObject({ prompt });
  });

  it.each(['好的', 'I am sorry, I cannot generate images.'])('仍拒绝不是原文的无用回答：%s', async (prompt) => {
    reply({ prompt, aspectRatio: '1:1' });
    await expect(enhancePromptDetailed(profile, { prompt: '一只猫' })).rejects.toThrow(/过短|不是提示词/);
  });

  it.each(['chat', 'responses'] as const)('%s 接口把自动画幅与设计方案一起返回', async (textFormat) => {
    const fetchMock = reply({ prompt: '竖版2:3海报，标题为第一视觉重点，活动分组置于浅底卡片，18元与11月17日保持原样。', aspectRatio: '2:3', usage: 'style' }, textFormat);
    const result = await enhancePromptDetailed({ ...profile, textFormat }, { prompt: '活动送18元，11月17日开业，做张海报', size: '1024x1024', aspectRatio: 'auto' });
    expect(result.aspectRatio).toBe('2:3');
    expect(result.prompt).toContain('浅底卡片');
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const instructions = body.instructions || body.messages[0].content;
    expect(instructions).toContain('画幅为自动');
    expect(instructions).not.toContain('目标画幅 1024x1024');
    expect(body.max_tokens || body.max_output_tokens).toBeGreaterThan(1400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('固定画幅与优化内容矛盾时拒绝，交由调用方带原因回退', async () => {
    reply({ prompt: '设计一张1:1方形中文海报，标题突出，活动分组排列。', aspectRatio: '1:1' });
    await expect(enhancePromptDetailed(profile, { prompt: '海报', size: '1024x1536' })).rejects.toThrow('不一致');
  });

  it('不把改了金额的结果当成成功优化', async () => {
    reply({ prompt: '设计竖版海报，清晰展示1000元大奖，活动卡片分组排列。', aspectRatio: '2:3' });
    await expect(enhancePromptDetailed(profile, { prompt: '海报，10000元大奖', aspectRatio: 'auto' })).rejects.toThrow('10000元');
  });

  it('保留完整的多段复杂设计，不因超过400英文词而丢弃', async () => {
    const prompt = Array.from({ length: 100 }, () => 'Keep the supplied layout and exact text.').join('\n');
    reply({ prompt, aspectRatio: '2:3', usage: 'style' });
    await expect(enhancePromptDetailed(profile, { prompt: 'Design a detailed poster', aspectRatio: 'auto' })).resolves.toMatchObject({ prompt, aspectRatio: '2:3' });
  });

  it('兼容纯文本输出和缺少画幅字段的旧网关', async () => {
    reply('设计一张竖版2:3海报，活动内容分组，主标题突出，正文与背景保持清晰对比。');
    await expect(enhancePromptDetailed(profile, { prompt: '做海报', aspectRatio: 'auto' })).resolves.toMatchObject({ aspectRatio: '2:3' });
  });
});
