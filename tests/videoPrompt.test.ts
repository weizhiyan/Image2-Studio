import { describe, expect, it } from 'vitest';
import { buildVideoPrompt, extractVideoScript } from '../src/lib/videoPrompt';

describe('视频提示词组合', () => {
  it('把连线文案并入空输入的提示词并去重', () => {
    expect(buildVideoPrompt('', ['海边日落', '海边日落'])).toBe('以连接的图片作为视频起始画面，保持主体和场景连续，再自然发展动作。\n参考文案：海边日落');
  });

  it('保留用户描述，并避免重复拼入已包含的文案', () => {
    expect(buildVideoPrompt('海边日落，镜头缓慢推进', ['海边日落', '远处有灯塔']))
      .toBe('海边日落，镜头缓慢推进\n以连接的图片作为视频起始画面，保持主体和场景连续，再自然发展动作。\n参考文案：远处有灯塔');
  });

  it('根据参考图用途去重旧的模式说明，并支持尾帧语义', () => {
    expect(buildVideoPrompt('镜头向前推进\n以连接的图片作为视频起始画面，保持主体和场景连续，再自然发展动作。', [], 'last_frame', true))
      .toBe('镜头向前推进\n连接的图片作为视频结束画面，安排自然过渡并让动作在该画面收束。');
  });

  it('两张连接图明确指定首帧与尾帧', () => {
    expect(buildVideoPrompt('小船驶向海边', [], 'first_frame', true, 2))
      .toBe('小船驶向海边\n第一张连接图作为视频首帧，第二张连接图作为尾帧，让画面自然过渡并保持主体场景连贯。');
  });

  it('从 AI 回复中提取代码块或视频提示词段落', () => {
    expect(extractVideoScript('视频提示词：\n海边，镜头缓慢推进')).toBe('海边，镜头缓慢推进');
    expect(extractVideoScript('```video\nA paper boat moves slowly\n```')).toBe('A paper boat moves slowly');
  });
});
