/** 视频接口契约：参数归一化 + 状态映射 + 「拿到 id 后绝不重发」的红线。 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ModelProfile } from '../bridge/settings';
import {
  VIDEO_RATIOS,
  VIDEO_SECONDS_MAX,
  VIDEO_SECONDS_MIN,
  VideoRequestError,
  summarizeVideoPriceQuote,
  createVideoTask,
  downloadVideoUrl,
  getVideoTask,
  normalizeVideoRatio,
  normalizeVideoResolution,
  normalizeVideoSeconds,
  normalizeVideoStatus,
  buildGrsaiCreateBody,
  buildMediaCreateBody,
  assertDownloadedVideoBuffer,
  encodeVideoImagesAsDataUrls,
  videoBaseUrl,
  videoImagesUseDataUrls,
  validateVideoImageDataUrls,
  describeVideoModel,
  listVideoModels,
  probeVideoConnection,
  resolveVideoApiMode,
  validateVideoConfig,
} from '../bridge/videoApi';

describe('视频价格预览', () => {
  it('按秒费用按最低渠道参考估算并提示不保证实际扣费', () => {
    const quote = summarizeVideoPriceQuote(
      { balance: 1, unit: '算力' },
      { available_for_this_key: true, channel_groups: [
        { is_active: false, min_price: 0.05, billing_method: '按秒' },
        { is_active: true, min_price: 0.2, billing_method: '按秒' },
      ] },
      5,
    );
    expect(quote).toMatchObject({ supported: true, balance: 1, minimumUnitPrice: 0.2, minimumEstimate: 1, seconds: 5 });
    expect(quote.warning).toContain('实际金额');
  });

  it('Token 计费不编造金额', () => {
    const quote = summarizeVideoPriceQuote(
      { balance: 10, unit: '算力' },
      { available_for_this_key: true, channel_groups: [{ is_active: true, min_price: 0.4, billing_method: '按token' }] },
      5,
    );
    expect(quote.minimumEstimate).toBeUndefined();
    expect(quote.warning).toContain('无法用简单公式估算');
  });
});

function profile(extra: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p1',
    name: '视频',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'dreamina-seedance-2-0-mini-260615',
    defaultSize: '480p',
    models: [],
    enabledModels: [],
    kind: 'video',
    textFormat: 'auto',
    imageApiMode: 'images',
    ...extra,
  } as ModelProfile;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('视频参数归一化', () => {
  it('比例只认文档给的六个值，乱值回落 16:9', () => {
    for (const ratio of VIDEO_RATIOS) expect(normalizeVideoRatio(ratio)).toBe(ratio);
    expect(normalizeVideoRatio('32:9')).toBe('16:9');
    expect(normalizeVideoRatio('')).toBe('16:9');
  });

  it('清晰度支持 480p / 720p / 1080p，非法值回落 480p', () => {
    expect(normalizeVideoResolution('720p')).toBe('720p');
    expect(normalizeVideoResolution('1080p')).toBe('1080p');
    expect(normalizeVideoResolution('4K')).toBe('480p');
    expect(normalizeVideoResolution(undefined)).toBe('480p');
  });

  it('时长钳在 4–15 秒，非法值回落 5', () => {
    expect(normalizeVideoSeconds(4)).toBe(VIDEO_SECONDS_MIN);
    expect(normalizeVideoSeconds(99)).toBe(VIDEO_SECONDS_MAX);
    expect(normalizeVideoSeconds(2)).toBe(VIDEO_SECONDS_MIN);
    expect(normalizeVideoSeconds('abc')).toBe(5);
    expect(normalizeVideoSeconds(undefined)).toBe(5);
  });

  it('模型名和 Base URL 不完整时在提交前给出明确配置错误', () => {
    expect(() => validateVideoConfig(profile({ model: '' }))).toThrow(/模型名/);
    expect(() => validateVideoConfig(profile({ baseUrl: '' }))).toThrow(/Base URL/);
    expect(() => validateVideoConfig(profile({ baseUrl: 'ftp://provider.example' }))).toThrow(/http/);
  });

  it('识别 xAI 官方域名，并把完整创建 endpoint 归一成版本根路径', () => {
    const xai = profile({ baseUrl: 'https://api.x.ai' });
    expect(resolveVideoApiMode(xai)).toBe('xai-videos');
    expect(videoBaseUrl(profile({ baseUrl: 'https://api.x.ai/v1/videos/generations' })))
      .toBe('https://api.x.ai/v1');
    expect(videoImagesUseDataUrls(xai)).toBe(true);
    expect(videoImagesUseDataUrls(profile({ videoApiMode: 'openai-videos' }))).toBe(false);
  });
});

describe('视频 HTTP 错误重试分类', () => {
  it('限流与网关超时可重试，认证与参数错误不可重试', () => {
    expect(new VideoRequestError(429, 'rate limited').definitiveFailure).toBe(false);
    expect(new VideoRequestError(408, 'request timeout').definitiveFailure).toBe(false);
    expect(new VideoRequestError(401, 'unauthorized').definitiveFailure).toBe(true);
    expect(new VideoRequestError(404, 'task not found').definitiveFailure).toBe(true);
  });
});

describe('图生视频本地图片传输', () => {
  it('以内联 Base64 编码图片并限制单图与总大小', () => {
    expect(encodeVideoImagesAsDataUrls([{ buffer: Buffer.from('png-bytes'), mimeType: 'image/png' }]))
      .toEqual([`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`]);
    expect(() => encodeVideoImagesAsDataUrls([{ buffer: Buffer.alloc(0), mimeType: 'image/png' }]))
      .toThrow(/空文件/);
    expect(() => encodeVideoImagesAsDataUrls([{ buffer: Buffer.alloc(10 * 1024 * 1024 + 1), mimeType: 'image/png' }]))
      .toThrow(/超过 10 MB/);
    expect(() => encodeVideoImagesAsDataUrls([
      { buffer: Buffer.alloc(8 * 1024 * 1024), mimeType: 'image/png' },
      { buffer: Buffer.alloc(8 * 1024 * 1024), mimeType: 'image/jpeg' },
      { buffer: Buffer.alloc(8 * 1024 * 1024), mimeType: 'image/webp' },
      { buffer: Buffer.alloc(8 * 1024 * 1024), mimeType: 'image/png' },
    ])).toThrow(/总大小超过 30 MB/);
  });

  it('验证直接传入的 Data URL，避免绕过内联图片大小与格式限制', () => {
    expect(() => validateVideoImageDataUrls(['data:image/png;base64,Zmlyc3Q='])).not.toThrow();
    expect(() => validateVideoImageDataUrls(['data:image/png;base64,']))
      .toThrow(/空文件/);
    expect(() => validateVideoImageDataUrls(['data:image/png;base64,not_base64']))
      .toThrow(/有效的 Base64/);
    expect(() => validateVideoImageDataUrls([
      `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}`,
    ])).toThrow(/超过 10 MB/);
  });

  it('拒绝把 JSON 错误或 HTML 页面当作生成的视频', () => {
    expect(() => assertDownloadedVideoBuffer(Buffer.from('{"error":{"message":"task failed"}}'), 'application/octet-stream', 'HTML'))
      .toThrow(/task failed/);
    expect(() => assertDownloadedVideoBuffer(Buffer.from('<html>error</html>'), 'video/mp4', 'HTML'))
      .toThrow('HTML');
    expect(() => assertDownloadedVideoBuffer(Buffer.from('not a video'), 'application/octet-stream', 'HTML'))
      .toThrow(/无法识别为视频/);
  });
});

describe('任务状态映射（渠道封装各不相同，统一大小写与同义词）', () => {
  it('排队 / 处理中 / 完成 / 失败各归各类', () => {
    expect(normalizeVideoStatus('queued')).toBe('queued');
    expect(normalizeVideoStatus('PENDING')).toBe('queued');
    expect(normalizeVideoStatus('in_progress')).toBe('in_progress');
    expect(normalizeVideoStatus('PROCESSING')).toBe('in_progress');
    expect(normalizeVideoStatus('completed')).toBe('completed');
    expect(normalizeVideoStatus('SUCCEEDED')).toBe('completed');
    expect(normalizeVideoStatus('failed')).toBe('failed');
    expect(normalizeVideoStatus('Cancelled')).toBe('failed');
  });

  it('认不出的状态是 unknown，不当成完成', () => {
    expect(normalizeVideoStatus('weird')).toBe('unknown');
    expect(normalizeVideoStatus('')).toBe('unknown');
  });
});

describe('创建视频任务', () => {
  it('xAI 单图图生视频把图片作为首帧对象发送', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ request_id: 'xai-first-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createVideoTask(profile({ videoApiMode: 'xai-videos', model: 'grok-imagine-video' }), {
      prompt: '窗边的猫转头看向镜头',
      imageUrls: ['data:image/png;base64,Zmlyc3Q='],
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.image).toEqual({ url: 'data:image/png;base64,Zmlyc3Q=' });
    expect(body.last_frame).toBeUndefined();
    expect(body.reference_images).toBeUndefined();
  });

  it('xAI Grok 用 generations endpoint、duration、图片对象和 request_id 任务 ID', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return init?.method === 'POST'
        ? new Response(JSON.stringify({ request_id: 'xai-42', status: 'pending' }), { status: 200 })
        : new Response(JSON.stringify({
          request_id: 'xai-42',
          status: 'done',
          video: { url: 'https://cdn.example/xai.mp4' },
        }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const xaiProfile = profile({
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-imagine-video-1.5',
      videoApiMode: 'xai-videos',
    });

    const created = await createVideoTask(xaiProfile, {
      prompt: '海边日落',
      seconds: 6,
      resolution: '720p',
      ratio: '9:16',
      generateAudio: false,
      imageUrls: ['data:image/png;base64,Zmlyc3Q=', 'https://images.example/last.png'],
    });

    expect(calls[0].url).toBe('https://api.x.ai/v1/videos/generations');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: '海边日落',
      duration: 6,
      aspect_ratio: '9:16',
      resolution: '720p',
      generate_audio: false,
      image: { url: 'data:image/png;base64,Zmlyc3Q=' },
      last_frame: { url: 'https://images.example/last.png' },
    });
    expect(created).toMatchObject({ id: 'xai-42', status: 'queued' });

    const completed = await getVideoTask(xaiProfile, 'xai-42');
    expect(calls[1].url).toBe('https://api.x.ai/v1/videos/xai-42');
    expect(completed).toMatchObject({
      id: 'xai-42',
      status: 'completed',
      outputUrl: 'https://cdn.example/xai.mp4',
    });
  });

  it('xAI 风格参考使用 reference_images 而不是固定首帧字段', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ request_id: 'xai-style-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createVideoTask(profile({ videoApiMode: 'xai-videos', model: 'grok-imagine-video' }), {
      prompt: '复古胶片风格',
      referenceMode: 'style',
      imageUrls: ['https://images.example/a.png', 'https://images.example/b.png'],
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.reference_images).toEqual([
      { url: 'https://images.example/a.png' },
      { url: 'https://images.example/b.png' },
    ]);
    expect(body.image).toBeUndefined();
    expect(body.last_frame).toBeUndefined();
  });

  it('xAI 不支持首尾帧或画质组合时在发送请求前阻止计费', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const legacy = profile({ videoApiMode: 'xai-videos', model: 'grok-imagine-video' });
    await expect(createVideoTask(legacy, {
      prompt: '镜头推进',
      imageUrls: ['https://images.example/first.png', 'https://images.example/last.png'],
    })).rejects.toThrow(/不支持首尾帧/);
    await expect(createVideoTask(profile({
      videoApiMode: 'xai-videos',
      model: 'grok-imagine-video-1.5',
    }), {
      prompt: '氛围转场',
      resolution: '1080p',
      referenceMode: 'style',
      imageUrls: ['https://images.example/ref.png'],
    })).rejects.toThrow(/最高支持 720p/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GrsAI minimax-h3 使用 /v1/api/generate，并把参数转换成该协议', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'grsai_task_1',
      status: 'succeeded',
      results: [{ url: 'https://cdn.example/video.mp4' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const grsaiProfile = profile({
      baseUrl: 'https://grsai.dakka.com.cn',
      model: 'minimax-h3',
      videoApiMode: 'grsai-generate',
    });
    expect(resolveVideoApiMode(grsaiProfile)).toBe('grsai-generate');
    expect(buildGrsaiCreateBody(grsaiProfile, {
      prompt: '一只纸船',
      seconds: 12,
      resolution: '720p',
      ratio: '9:16',
      imageUrls: ['https://img.example/a.png'],
    })).toMatchObject({
      model: 'minimax-h3',
      aspectRatio: 'portrait',
      resolution: '768p',
      duration: 12,
      replyType: 'async',
    });
    const snapshot = await createVideoTask(grsaiProfile, { prompt: '一只纸船', seconds: 12, resolution: '720p', ratio: '9:16' });
    expect(snapshot).toMatchObject({ id: 'grsai_task_1', status: 'completed', progress: 100, outputUrl: 'https://cdn.example/video.mp4' });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('https://grsai.dakka.com.cn/v1/api/generate');
  });

  it('自动识别用户直接粘贴的 API endpoint，且保留 endpoint 的版本路径', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'task_endpoint', status: 'queued' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const endpointProfile = profile({
      baseUrl: 'https://gateway.example/api/generate',
      videoApiMode: 'auto',
    });

    expect(resolveVideoApiMode(endpointProfile)).toBe('grsai-generate');
    await createVideoTask(endpointProfile, { prompt: '纸船' });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])
      .toBe('https://gateway.example/api/generate');
  });

  it('识别媒体协议，并按 params / media 路径提交任务', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ task_id: 'media_task_1', state: 'pending' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const mediaProfile = profile({
      baseUrl: 'https://api.lk888.ai/v1',
      model: 'seedance-2.0-anci',
      videoApiMode: 'auto',
    });

    expect(resolveVideoApiMode(mediaProfile)).toBe('media-v1');
    expect(buildMediaCreateBody(mediaProfile, {
      prompt: '海边散步',
      seconds: 5,
      resolution: '480p',
      ratio: '9:16',
      imageUrls: ['https://img.example/ref.png'],
    })).toEqual({
      model: 'seedance-2.0-anci',
      prompt: '海边散步',
      params: {
        aspect_ratio: '9:16',
        duration: '5',
        resolution: '720p',
        images: ['https://img.example/ref.png'],
        mode: 'cankaosheng',
      },
    });

    await createVideoTask(mediaProfile, { prompt: '海边散步', seconds: 5, resolution: '480p', ratio: '9:16' });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])
      .toBe('https://api.lk888.ai/v1/media/generate');
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({
      params: { aspect_ratio: '9:16', duration: '5', resolution: '720p' },
    });
  });

  it('schema 参数优先：模型自己声明的字段名不被通用三件套覆盖', () => {
    const mediaProfile = profile({
      baseUrl: 'https://api.lk888.ai/v1',
      model: 'wan2.6-shouzheng',
      videoApiMode: 'media-v1',
    });
    expect(buildMediaCreateBody(mediaProfile, {
      prompt: '猫跳下沙发',
      // 画布上的旧三件套照常传，但 schema 已经给了等价字段，不能反过来覆盖它
      seconds: 5,
      resolution: '1080p',
      ratio: '16:9',
      extraParams: {
        quality: 'fast',
        resolution: '720P',
        duration: '3',
        aspect_ratio: '9:16',
      },
      imageUrls: ['https://img.example/ref.png'],
      imageParamName: 'img_url',
    })).toEqual({
      model: 'wan2.6-shouzheng',
      prompt: '猫跳下沙发',
      params: {
        quality: 'fast',
        resolution: '720P',
        duration: '3',
        aspect_ratio: '9:16',
        img_url: ['https://img.example/ref.png'],
      },
    });
  });

  it('媒体协议的 images 字段接受内联 data URL 数组', () => {
    const body = buildMediaCreateBody(profile({
      baseUrl: 'https://api.lk888.ai/v1',
      model: 'seedance-2.0-guanfang-anmiao',
      videoApiMode: 'media-v1',
    }), {
      prompt: '让主体自然动起来',
      imageUrls: ['data:image/png;base64,AAAA'],
      imageParamName: 'images',
      extraParams: { mode: 'shouweizhen', duration: '5', resolution: '720p' },
    });

    expect(body.params).toMatchObject({ images: ['data:image/png;base64,AAAA'], mode: 'shouweizhen' });
  });

  it('读模型参数 schema：归一化 options 并去掉 prompt', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      name: 'wan2.6-shouzheng',
      display_name: '万相 2.6 首帧',
      description: '图生视频',
      input_hint: '描述动作',
      tags: ['图生视频'],
      params: [
        { name: 'prompt', label: '提示词', type: 'textarea', required: true },
        { name: 'img_url', label: '参考图片', type: 'upload', required: false },
        {
          name: 'quality',
          label: '生成质量',
          type: 'radio',
          required: true,
          options: [{ label: '快速', value: 'fast' }, { label: '高质量', value: 'standard' }],
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const schema = await describeVideoModel(profile({
      baseUrl: 'https://api.lk888.ai/v1',
      model: 'wan2.6-shouzheng',
      videoApiMode: 'media-v1',
    }), 'wan2.6-shouzheng');

    expect(schema.displayName).toBe('万相 2.6 首帧');
    expect(schema.params.map((item) => item.name)).toEqual(['img_url', 'quality']);
    expect(schema.params[1].options).toEqual([
      { label: '快速', value: 'fast' },
      { label: '高质量', value: 'standard' },
    ]);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])
      .toBe('https://api.lk888.ai/v1/skills/models/wan2.6-shouzheng');
  });

  it('列视频模型时过滤掉当前 Key 不可用的', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [
      { name: 'seedance-2.0-anci', display_name: 'SD 2.0', available_for_this_key: true },
      { name: 'gk-video-3.5', display_name: 'GK 3.5', available_for_this_key: false },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await listVideoModels(profile({
      baseUrl: 'https://api.lk888.ai/v1',
      model: 'seedance-2.0-anci',
      videoApiMode: 'media-v1',
    }));

    expect(models.map((item) => item.name)).toEqual(['seedance-2.0-anci']);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])
      .toBe('https://api.lk888.ai/v1/skills/models?type=video');
  });

  it('媒体协议以 is_final 为准：没给地址不判死，失败态才报错', async () => {
    const mediaProfile = profile({ baseUrl: 'https://free.kk0606.com', videoApiMode: 'media-v1' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      task_id: 't1',
      state: 'success',
      is_final: false,
      progress: '90%',
      result_url: '',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getVideoTask(mediaProfile, 't1')).resolves.toMatchObject({ status: 'in_progress', progress: 90 });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      task_id: 't1',
      state: 'failed',
      is_final: true,
      progress: '100%',
      error: '内容违规',
      result_url: '',
    }), { status: 200 }));
    await expect(getVideoTask(mediaProfile, 't1')).resolves.toMatchObject({ status: 'failed', error: '内容违规' });
  });

  it('GrsAI 的 minimax-h3 发像素档位（真实上游不认 SD，会报 resolution not found）', () => {
    const selectedModel = buildGrsaiCreateBody(profile({
      baseUrl: 'https://grsai.dakka.com.cn/v1',
      model: 'seedance-default',
      videoApiMode: 'grsai-generate',
    }), {
      prompt: '纸船',
      model: 'minimax-h3',
      resolution: '480p',
    });

    expect(selectedModel.resolution).toBe('480p');
    expect(selectedModel).not.toHaveProperty('images');
  });

  it('同步返回视频地址但没有任务 ID 时仍可用本地任务 ID 接收成品', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      results: [{ url: 'https://cdn.example/video.mp4' }],
    }), { status: 200 })));

    const snapshot = await createVideoTask(profile({
      baseUrl: 'https://grsai.dakka.com.cn/v1',
      videoApiMode: 'grsai-generate',
    }), { prompt: '纸船' });

    expect(snapshot.id).toMatch(/^local_video_/);
    expect(snapshot.outputUrl).toBe('https://cdn.example/video.mp4');
  });

  it('用户粘贴完整 GrsAI endpoint 时不会重复拼接路径', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'grsai_task_2', status: 'succeeded', results: [{ url: 'https://cdn.example/video.mp4' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createVideoTask(profile({
      baseUrl: 'https://grsai.dakka.com.cn/v1/api/generate',
      model: 'minimax-h3',
      videoApiMode: 'grsai-generate',
    }), { prompt: 'p' });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('https://grsai.dakka.com.cn/v1/api/generate');
  });

  it('API Key 已包含 Bearer 前缀时不会重复添加', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'task_bearer', status: 'queued' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createVideoTask(profile({ apiKey: 'Bearer secret-key' }), { prompt: 'p' });
    const request = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(request.headers).get('authorization')).toBe('Bearer secret-key');
  });

  it('GrsAI 返回异步任务 id 时保留任务并等待轮询，不误报缺少视频地址', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { id: 'grsai_async_1', status: 'processing', progress: 12 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const snapshot = await createVideoTask(profile({
      baseUrl: 'https://grsai.dakka.com.cn/v1',
      model: 'minimax-h3',
      videoApiMode: 'grsai-generate',
    }), { prompt: 'p', imageUrls: ['https://img.example/a.png'] });

    expect(snapshot).toMatchObject({ id: 'grsai_async_1', status: 'in_progress', progress: 12 });
    expect(snapshot.outputUrl).toBeUndefined();
  });

  it('模型未选择时拒绝提交，不回落到内置模型', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createVideoTask(profile({ model: '' }), { prompt: '一只纸船' }))
      .rejects.toThrow('尚未选择视频模型');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Seedance 用 ratio + images 简写，不发 Grok 那套字段', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'task_1', status: 'queued', progress: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const snapshot = await createVideoTask(profile(), {
      prompt: '一只纸船',
      seconds: 6,
      resolution: '1080p',
      ratio: '9:16',
      generateAudio: true,
      imageUrls: ['https://img.example/a.png'],
    });
    expect(snapshot.id).toBe('task_1');
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]?.body));
    const request = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(body.ratio).toBe('9:16');
    expect(body.images).toEqual(['https://img.example/a.png']);
    expect(body.aspect_ratio).toBeUndefined();
    expect(body.image_urls).toBeUndefined();
    expect(body.seconds).toBe('6');
    expect(body.resolution).toBe('1080p');
    expect(body.generate_audio).toBe(true);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('通用 OpenAI Videos 中转站的 Grok 适配仍使用单图 image 字段', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'task_2', status: 'queued' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createVideoTask(profile({ model: 'grok-imagine-video-6s' }), {
      prompt: 'p',
      imageUrls: ['https://img.example/b.png'],
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]?.body));
    expect(body.aspect_ratio).toBe('16:9');
    // 通用 OpenAI Videos 协议保持既有字段；漫小白使用独立的 image_urls 适配。
    expect(body.image).toBe('https://img.example/b.png');
    expect(body.image_urls).toBeUndefined();
    expect(body.ratio).toBeUndefined();
    // 适配不附带未明确指定的参数，避免严格校验的上游拒绝请求。
    expect(body.seconds).toBe('5');
    expect(body.resolution).toBeUndefined();
    expect(body.generate_audio).toBeUndefined();
    expect(body.watermark).toBeUndefined();
  });

  it('漫小白 Grok Imagine 6s 使用 reference_images 数组字段', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'manxiaobai-task', status: 'queued' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createVideoTask(profile({
      baseUrl: 'https://api.manxiaobai.online/v1',
      model: 'grok-imagine-video-6s',
    }), {
      prompt: '小猪看向镜头微笑',
      seconds: 6,
      imageUrls: ['https://images.example/frame.png'],
    });

    const [singleUrl, singleInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const singleBody = JSON.parse(String(singleInit.body));
    expect(singleUrl).toBe('https://api.manxiaobai.online/v1/videos');
    expect(singleBody).toMatchObject({
      model: 'grok-imagine-video-6s',
      seconds: '6',
      aspect_ratio: '16:9',
      reference_images: ['https://images.example/frame.png'],
    });
    expect(singleBody).not.toHaveProperty('image_urls');
    expect(singleBody).not.toHaveProperty('image');
    expect(singleBody).not.toHaveProperty('image_url');

    fetchMock.mockClear();
    await createVideoTask(profile({
      baseUrl: 'https://api.manxiaobai.online/v1',
      model: 'grok-imagine-video-6s',
    }), {
      prompt: '多图参考视频',
      seconds: 6,
      imageUrls: ['https://images.example/first.png', 'https://images.example/second.png'],
    });
    const [, multipleInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const multipleBody = JSON.parse(String(multipleInit.body));
    expect(multipleBody.reference_images).toEqual([
      'https://images.example/first.png',
      'https://images.example/second.png',
    ]);
    expect(multipleBody).not.toHaveProperty('image_urls');
    expect(multipleBody).not.toHaveProperty('image');
  });

  it('漫小白 Grok Imagine Video 1.5 6s 同样使用 reference_images', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'manxiaobai-task', status: 'queued' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createVideoTask(profile({
      baseUrl: 'https://api.manxiaobai.online/v1',
      model: 'grok-imagine-video-1.5-6s',
    }), {
      prompt: '参考图片生成视频',
      imageUrls: ['https://images.example/frame.png'],
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.reference_images).toEqual(['https://images.example/frame.png']);
    expect(body).not.toHaveProperty('image_urls');
  });

  it('漫小白文档中的 Grok Video 1.0/1.5 使用 image_urls 数组', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'manxiaobai-task', status: 'queued' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createVideoTask(profile({
      baseUrl: 'https://api.manxiaobai.online/v1',
      model: 'grok-video-1.0',
    }), {
      prompt: '参考图片生成视频',
      imageUrls: ['https://images.example/frame.png'],
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.image_urls).toEqual(['https://images.example/frame.png']);
    expect(body).not.toHaveProperty('image');
  });

  it('图片字段被拒绝时不盲目换字段重试，避免意外重复提交', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.image).toBe('https://img.example/a.png');
      return new Response(JSON.stringify({
        error: { message: 'Unsupported request field: image (request id: x)', type: 'new_api_error' },
      }), { status: 400 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(createVideoTask(profile({ model: 'grok-imagine-video-1.5-6s' }), {
      prompt: 'p',
      imageUrls: ['https://img.example/a.png'],
    })).rejects.toThrow(/Unsupported request field: image/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('自定义协议按模板提交，并按映射字段读取异步任务', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ task: { uuid: 'custom-42', phase: 'waiting' } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { phase: 'done', progress: '100%', rendered: { url: 'https://cdn.example/custom.mp4' } },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const customProfile = profile({
      model: 'grok-imagine-video-1.5',
      videoApiMode: 'custom',
      videoCustomConfig: {
        createPath: '/videos/generations',
        pollPath: '/videos/{{taskId}}/status',
        imageTransport: 'public-url',
        headersTemplate: '{"X-API-Key":"{{apiKey}}"}',
        requestBodyTemplate: JSON.stringify({
          model: '{{model}}',
          prompt: '{{prompt}}',
          duration: '{{seconds}}',
          image: { url: '{{firstImageUrl}}' },
        }),
        taskIdPath: 'task.uuid',
        statusPath: 'task.phase',
        progressPath: 'data.progress',
        outputUrlPath: 'data.rendered.url',
        errorPath: 'error.message',
        statusMap: '{"waiting":"queued","done":"completed"}',
      },
    });

    const submitted = await createVideoTask(customProfile, {
      prompt: '小船出海',
      seconds: 6,
      imageUrls: ['https://img.example/first.png'],
    });
    expect(submitted).toMatchObject({ id: 'custom-42', status: 'queued' });
    expect(calls[0].url).toBe('https://api.example.com/v1/videos/generations');
    expect(new Headers(calls[0].init?.headers).get('x-api-key')).toBe('k');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: '小船出海',
      duration: 6,
      image: { url: 'https://img.example/first.png' },
    });

    const completed = await getVideoTask(customProfile, 'custom-42');
    expect(calls[1].url).toBe('https://api.example.com/v1/videos/custom-42/status');
    expect(completed).toMatchObject({
      id: 'custom-42',
      status: 'completed',
      progress: 100,
      outputUrl: 'https://cdn.example/custom.mp4',
    });
  });

  it('自定义异步协议缺少轮询或结果路径时在 POST 前拦截', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const baseProfile = profile({
      videoApiMode: 'custom',
      videoCustomConfig: {
        createPath: '/videos',
        pollPath: '',
        imageTransport: 'public-url',
        headersTemplate: '{}',
        requestBodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}"}',
        taskIdPath: 'id',
        statusPath: 'status',
        progressPath: 'progress',
        outputUrlPath: 'video.url',
        errorPath: 'error.message',
        statusMap: '{}',
      },
    });
    expect(() => validateVideoConfig(baseProfile)).toThrow(/缺少查询任务路径/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => validateVideoConfig({
      ...baseProfile,
      videoCustomConfig: { ...baseProfile.videoCustomConfig!, pollPath: '/videos/{{taskId}}', outputUrlPath: '' },
    })).toThrow(/缺少视频地址字段路径/);
  });

  it('自定义任务报告完成但没有视频 URL 时立即返回可操作错误', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'completed' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const customProfile = profile({
      videoApiMode: 'custom',
      videoCustomConfig: {
        createPath: '/videos',
        pollPath: '/videos/{{taskId}}',
        imageTransport: 'public-url',
        headersTemplate: '{}',
        requestBodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}"}',
        taskIdPath: 'id',
        statusPath: 'status',
        progressPath: 'progress',
        outputUrlPath: 'video.url',
        errorPath: 'error.message',
        statusMap: '{}',
      },
    });
    const snapshot = await getVideoTask(customProfile, 'task-no-url');
    expect(snapshot).toMatchObject({
      id: 'task-no-url',
      status: 'failed',
      error: expect.stringMatching(/没有视频地址/),
    });
  });

  it('/v1/videos 404 时回退 /v1/video/generations（404 = 未受理，不会重复计费）', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/videos')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ id: 'task-fallback', status: 'queued' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const snapshot = await createVideoTask(profile({ model: 'grok-video-1.0' }), { prompt: 'p' });
    expect(snapshot.id).toBe('task-fallback');
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toMatch(/\/v1\/videos$/);
    expect(urls[1]).toMatch(/\/v1\/video\/generations$/);
  });

  it('没有 Key 时直接拒，不发请求', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    await expect(createVideoTask(profile({ apiKey: '' }), { prompt: 'p' })).rejects.toThrow(/尚未配置 API Key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('空提示词直接拒', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    await expect(createVideoTask(profile(), { prompt: '   ' })).rejects.toThrow(/提示词不能为空/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('创建只发一次：失败也不自动重发（重发 = 重复计费）', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"quota"}}', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createVideoTask(profile(), { prompt: 'p' })).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('没拿到 id 时报错，不返回假任务', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ object: 'video' }), { status: 200 })));
    await expect(createVideoTask(profile(), { prompt: 'p' })).rejects.toThrow(/未返回任务 id/);
  });
});

describe('查询任务', () => {
  it('data.status 嵌套封装也认', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { status: 'Completed', progress: 62 } }), { status: 200 })));
    const snapshot = await getVideoTask(profile(), 'task_x');
    expect(snapshot.status).toBe('completed');
    expect(snapshot.progress).toBe(62);
  });

  it('失败时带上原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'failed', error: '内容审核未通过' }), { status: 200 })));
    const snapshot = await getVideoTask(profile(), 'task_y');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toContain('内容审核未通过');
  });

  it('GrsAI 用 /v1/api/result?id 查询异步任务，并读取完成视频地址', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        id: 'grsai_async_2',
        status: 'succeeded',
        results: [{ url: 'https://cdn.example/video.mp4' }],
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await getVideoTask(profile({
      baseUrl: 'https://grsai.dakka.com.cn/v1',
      model: 'minimax-h3',
      videoApiMode: 'grsai-generate',
    }), 'grsai_async_2');

    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])
      .toBe('https://grsai.dakka.com.cn/v1/api/result?id=grsai_async_2');
    expect(snapshot).toMatchObject({
      status: 'completed',
      outputUrl: 'https://cdn.example/video.mp4',
    });
  });

  it('用户把 /api/result 完整地址贴进 Base URL 时仍只拼一次查询路径', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { id: 'grsai_async_3', status: 'processing' },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getVideoTask(profile({
      baseUrl: 'https://grsai.dakka.com.cn/v1/api/result',
      model: 'minimax-h3',
      videoApiMode: 'grsai-generate',
    }), 'grsai_async_3');

    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])
      .toBe('https://grsai.dakka.com.cn/v1/api/result?id=grsai_async_3');
  });

  it('GrsAI HTTP 200 的业务错误落成 failed，而不是抛异常让轮询空转', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 400, msg: '任务不存在' }), { status: 200 })));
    const snapshot = await getVideoTask(profile({
      baseUrl: 'https://grsai.dakka.com.cn/v1',
      model: 'minimax-h3',
      videoApiMode: 'grsai-generate',
    }), 'missing-task');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toContain('任务不存在');
  });

  it('媒体协议读取 state / 百分比进度 / result_url', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      task_id: 'media_task_2',
      state: 'running',
      progress: '45%',
      result_url: '',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const mediaProfile = profile({ baseUrl: 'https://free.kk0606.com', videoApiMode: 'media-v1' });
    const pending = await getVideoTask(mediaProfile, 'media_task_2');
    expect(pending).toMatchObject({ status: 'in_progress', progress: 45 });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])
      .toBe('https://free.kk0606.com/v1/media/status?task_id=media_task_2');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      task_id: 'media_task_2',
      state: 'success',
      progress: '100%',
      result_url: 'https://cdn.example/media.mp4',
    }), { status: 200 }));
    const done = await getVideoTask(mediaProfile, 'media_task_2');
    expect(done).toMatchObject({ status: 'completed', progress: 100, outputUrl: 'https://cdn.example/media.mp4' });
  });

  it('媒体协议连接测试走 /skills/models?type=video 并过滤不可用模型', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [
      { name: 'seedance-2.0-anci', display_name: 'SD 2.0', available_for_this_key: true },
      { name: 'gk-video-3.5', display_name: 'GK 3.5', available_for_this_key: false },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeVideoConnection(profile({
      baseUrl: 'https://api.lk888.ai/v1',
      model: 'seedance-2.0-anci',
      videoApiMode: 'media-v1',
    }))).resolves.toContain('发现 1 个视频模型');
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])
      .toBe('https://api.lk888.ai/v1/skills/models?type=video');
  });

  it('不会把视频模型 API Key 转发给第三方 CDN 地址', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(downloadVideoUrl('https://cdn.example/video.mp4', 'secret-key', 'https://grsai.dakka.com.cn/v1'))
      .rejects.toThrow(/404/);
    const request = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(request.headers).toBeUndefined();
  });
});
