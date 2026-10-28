import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAgentModel, extractDsmlToolCalls, generateImageToolDef } from '../bridge/agent';
import type { ModelProfile } from '../bridge/settings';

const profile: ModelProfile = {
  id: 'deepseek-text',
  name: 'DeepSeek Flash',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'test-key',
  model: 'deepseek-flash',
  defaultSize: '1024x1024',
  models: [],
  enabledModels: [],
  kind: 'text',
  textFormat: 'responses',
};

const imageA = 'data:image/png;base64,aW1hZ2UtYQ==';
const imageB = 'data:image/png;base64,aW1hZ2UtYg==';

afterEach(() => vi.unstubAllGlobals());

describe('Responses JSON 对话的图像输入', () => {
  it('把最近一条含图用户消息的真实图片传给 Responses API', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ output_text: '我看到了图片中的对象。' }), { status: 200 });
    }));

    const result = await callAgentModel(profile, {
      systemSpec: '你是画布设计助手。',
      messages: [
        { role: 'user', content: '比较这两张参考图', images: [imageA, imageB] },
        { role: 'assistant', content: '我会查看图片。' },
        { role: 'user', content: '先告诉我两张图的主要区别。' },
      ],
      visualContextImages: [imageA, imageB],
      tools: [],
    });

    expect(result.text).toContain('我看到了');
    expect(requestUrl).toBe('https://api.deepseek.com/responses');
    const input = requestBody.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const userMessage = input.find((item) => item.role === 'user');
    const content = userMessage?.content || [];
    expect(content.find((part) => part.type === 'input_text')?.text).toContain('请实际查看图片内容');
    expect(content.filter((part) => part.type === 'input_image').map((part) => part.image_url)).toEqual([imageA, imageB]);
  });

  it('无图片时仍只发送文本，不伪造图像输入', async () => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ output_text: '纯文本回答。' }), { status: 200 });
    }));

    await callAgentModel(profile, {
      systemSpec: '你是画布设计助手。',
      messages: [
        { role: 'user', content: '旧问题附图', images: [imageA] },
        { role: 'assistant', content: '我们重新开始。' },
        { role: 'user', content: '新问题没有引用图片' },
      ],
      visualContextImages: [],
      tools: [],
    });

    const input = requestBody.input as Array<{ content: unknown }>;
    expect(JSON.stringify(input)).not.toContain('input_image');
  });
});

describe('Responses JSON 工具调用兼容', () => {
  it('将 DSML generate_image 调用转换为工具调用而不是展示源码', async () => {
    const dsml = [
      '我按你的描述生成一张图。',
      '<|DSML|>calls><|DSML|>invoke name="generate_image">',
      '<|DSML|>parameter name="args" string="false">',
      '{"prompt":"黑灰色、简约 3D 无人机，纯白背景","ratio":"1:1"}',
      '<|DSML|>parameter><|DSML|>invoke><|DSML|>calls>',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: dsml }), { status: 200 })));
    const onTextDelta = vi.fn();

    const result = await callAgentModel(profile, {
      systemSpec: '你是画布设计助手。',
      messages: [{ role: 'user', content: '我想生成一张黑灰色的简约无人机效果图' }],
      tools: [generateImageToolDef()],
      onTextDelta,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: 'generate_image',
      args: { prompt: '黑灰色、简约 3D 无人机，纯白背景', ratio: '1:1' },
    });
    expect(result.text).toBe('我按你的描述生成一张图。');
    expect(onTextDelta).toHaveBeenCalledWith('我按你的描述生成一张图。');
    expect(onTextDelta.mock.calls.flat().join('')).not.toContain('DSML');
  });

  it('识别页面转录中常见的全角 DSML 分隔符', () => {
    const result = extractDsmlToolCalls([
      '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="generate_image">',
      '<｜｜DSML｜｜ parameter name="args" string="false">{"prompt":"test"}</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>',
    ].join(''));

    expect(result?.toolCalls[0]).toMatchObject({ name: 'generate_image', args: { prompt: 'test' } });
    expect(result?.text).toBe('');
  });
});
