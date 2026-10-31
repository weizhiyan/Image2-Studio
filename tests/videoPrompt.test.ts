import { describe, expect, it } from 'vitest';
import { buildVideoPrompt, extractVideoScript } from '../src/lib/videoPrompt';

describe('视频提示词组合', () => {
  it('把连线文案并入空输入的提示词并去重', () => {
    expect(buildVideoPrompt('', ['海边日落', '海边日落'])).toBe('参考文案：海边日落');
  });

  it('只有引用文案时不虚构存在参考图片', () => {
    expect(buildVideoPrompt('', ['海边日落'], 'first_frame', false, 0)).toBe('参考文案：海边日落');
  });

  it('保留用户描述，并避免重复拼入已包含的文案', () => {
    expect(buildVideoPrompt('海边日落，镜头缓慢推进', ['海边日落', '远处有灯塔']))
      .toBe('海边日落，镜头缓慢推进\n参考文案：远处有灯塔');
  });

  it('实际附带图片时才加入首帧说明', () => {
    expect(buildVideoPrompt('小猪向镜头眨眼', [], 'first_frame', true))
      .toBe('小猪向镜头眨眼\n将提供的参考图作为视频首帧，保持主体与场景特征一致，并从该画面自然延续动作。');
  });

  it('根据参考图用途去重旧的模式说明，并支持尾帧语义', () => {
    expect(buildVideoPrompt('镜头向前推进\n以连接的图片作为视频起始画面，保持主体和场景连续，再自然发展动作。', [], 'last_frame', true))
      .toBe('镜头向前推进\n将提供的参考图作为视频尾帧，安排自然过渡，并让动作在该画面收束。');
  });

  it('两张连接图明确指定首帧与尾帧', () => {
    expect(buildVideoPrompt('小船驶向海边', [], 'first_frame', true, 2))
      .toBe('小船驶向海边\n将第一张参考图作为视频首帧，第二张参考图作为尾帧，生成两帧之间自然连贯的过渡。');
  });

  it('风格参考措辞面向模型，不暴露画布连线的内部概念', () => {
    const prompt = buildVideoPrompt('沿用类似的暖色光线', [], 'style', true);
    expect(prompt).toBe('沿用类似的暖色光线\n将提供的参考图仅用于风格参考，提取其光线、色彩和质感，不要求复刻原图主体。');
    expect(prompt).not.toContain('连接');
  });

  it('从 AI 回复中提取代码块或视频提示词段落', () => {
    expect(extractVideoScript('视频提示词：\n海边，镜头缓慢推进')).toBe('海边，镜头缓慢推进');
    expect(extractVideoScript('```video\nA paper boat moves slowly\n```')).toBe('A paper boat moves slowly');
  });
});
