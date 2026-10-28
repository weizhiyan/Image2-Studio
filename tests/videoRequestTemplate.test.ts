import { describe, expect, it } from 'vitest';
import {
  readVideoResponsePath,
  renderVideoHeadersTemplate,
  renderVideoRequestTemplate,
} from '../bridge/videoRequestTemplate';

describe('视频请求模板', () => {
  it('将整段变量替换为原始 JSON 值，保留数组、对象、数字和布尔值类型', () => {
    const result = renderVideoRequestTemplate(JSON.stringify({
      model: '{{model}}',
      duration: '{{seconds}}',
      image: '{{firstImageUrl}}',
      images: '{{imageUrls}}',
      audio: '{{generateAudio}}',
      params: '{{params}}',
    }), {
      model: 'grok-video',
      seconds: 6,
      firstImageUrl: 'https://example.test/frame.png',
      imageUrls: ['https://example.test/frame.png'],
      generateAudio: false,
      params: { quality: 'standard' },
    });

    expect(result).toEqual({
      model: 'grok-video',
      duration: 6,
      image: 'https://example.test/frame.png',
      images: ['https://example.test/frame.png'],
      audio: false,
      params: { quality: 'standard' },
    });
  });

  it('安全地把标量插入字符串并转义行为由 JSON parser 保证', () => {
    const prompt = '角色说："开始"\n{{不是模板}}';
    const result = renderVideoRequestTemplate('{"prompt":"{{prompt}} / {{model}}"}', {
      prompt,
      model: '模型 A',
    });
    expect(result).toEqual({ prompt: `${prompt} / 模型 A` });
  });

  it('拒绝未知变量、对象字符串插值、无效 JSON 和非对象顶层', () => {
    expect(() => renderVideoRequestTemplate('{"prompt":"{{missing}}"}', {})).toThrow(/未知变量/);
    expect(() => renderVideoRequestTemplate('{"prompt":"{{params}} extra"}', { params: { a: 1 } })).toThrow(/不能嵌入字符串/);
    expect(() => renderVideoRequestTemplate('{broken', {})).toThrow(/不是有效 JSON/);
    expect(() => renderVideoRequestTemplate('[]', {})).toThrow(/顶层必须是 JSON 对象/);
  });

  it('请求头模板要求字符串值，并禁止 CRLF 注入', () => {
    expect(renderVideoHeadersTemplate('{"X-API-Key":"{{apiKey}}"}', { apiKey: 'secret' }))
      .toEqual({ 'X-API-Key': 'secret' });
    expect(() => renderVideoHeadersTemplate('{"X-Count":3}', {})).toThrow(/字符串值/);
    expect(() => renderVideoHeadersTemplate('{"X-Key":"{{apiKey}}"}', { apiKey: 'a\r\nb' })).toThrow(/换行符/);
  });

  it('按点路径和数组序号提取响应字段，并阻止原型属性读取', () => {
    const response = { data: { tasks: [{ id: 7, video: { url: 'https://cdn.test/a.mp4' } }] } };
    expect(readVideoResponsePath(response, 'data.tasks[0].video.url')).toBe('https://cdn.test/a.mp4');
    expect(readVideoResponsePath(response, 'data.tasks.0.id')).toBe(7);
    expect(readVideoResponsePath(response, '__proto__.polluted')).toBeUndefined();
    expect(readVideoResponsePath(response, 'data.missing.value')).toBeUndefined();
    expect(readVideoResponsePath(response, '')).toBeUndefined();
  });
});
