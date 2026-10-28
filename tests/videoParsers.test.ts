import { describe, expect, it, vi } from 'vitest';
import { getVideoTask, readVideoOutputUrl } from '../bridge/videoApi.js';
import type { ModelProfile } from '../bridge/settings.js';

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p',
    name: '视频模型',
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-test',
    model: 'grok-video-1.0',
    defaultSize: '',
    models: [],
    enabledModels: [],
    kind: 'video',
    textFormat: 'auto',
    imageApiMode: 'images',
    responsesModel: 'gpt-5.5',
    videoApiMode: 'openai-videos',
    enabled: true,
    ...overrides,
  } as ModelProfile;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('视频结果地址解析', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['顶层 output', { output: 'https://cdn.example/a.mp4' }],
    ['顶层 result_url', { result_url: 'https://cdn.example/b.mp4' }],
    ['顶层 result.url', { result: { url: 'https://cdn.example/c.mp4' } }],
    ['data.result_url', { data: { result_url: 'https://cdn.example/d.mp4' } }],
    ['data.video.video_url', { data: { video: { video_url: 'https://cdn.example/e.mp4' } } }],
    ['videos[0].url', { videos: [{ url: 'https://cdn.example/f.mp4' }] }],
    ['outputs[0].url', { outputs: [{ url: 'https://cdn.example/g.mp4' }] }],
    ['files[0].url', { files: [{ url: 'https://cdn.example/h.mp4' }] }],
    ['results 字符串数组', { results: ['https://cdn.example/i.mp4'] }],
    ['task.result_url', { task: { result_url: 'https://cdn.example/j.mp4' } }],
    ['data.data 嵌套', { data: { data: { url: 'https://cdn.example/k.mp4' } } }],
  ];

  for (const [label, body] of cases) {
    it(label, () => {
      const nested = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
      expect(readVideoOutputUrl(body, nested)).not.toBe('');
    });
  }

  it('完全没有地址时返回空串', () => {
    expect(readVideoOutputUrl({ status: 'in_progress' }, {})).toBe('');
    expect(readVideoOutputUrl(null, {})).toBe('');
  });
});

describe('media-v1 终态判定', () => {
  it('is_final=1 且给出 result_url → completed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: { is_final: 1, state: 'success', result_url: 'https://cdn.example/m.mp4' },
    })));
    const snapshot = await getVideoTask(profile({ videoApiMode: 'media-v1' }), 't1');
    expect(snapshot.status).toBe('completed');
    expect(snapshot.outputUrl).toBe('https://cdn.example/m.mp4');
  });

  it('is_final=true 且带 error → failed（内容违规不再空转）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: { is_final: true, error: '内容违规' },
    })));
    const snapshot = await getVideoTask(profile({ videoApiMode: 'media-v1' }), 't2');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toContain('内容违规');
  });

  it('中文终态「生成失败」→ failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: { is_final: true, state: '生成失败', message: '模型拒绝' },
    })));
    const snapshot = await getVideoTask(profile({ videoApiMode: 'media-v1' }), 't3');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toContain('模型拒绝');
  });
});
