import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// settings.ts 在 import 时就按 HUIBAN_DATA_ROOT 定 SETTINGS_FILE，顺序不能反
const TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'huiban-settings-'));
process.env.HUIBAN_DATA_ROOT = TEST_DATA_ROOT;
const {
  activeProfile,
  createProfile,
  imageModelReadiness,
  normalizeSettings,
  defaultChatRuntimeSettings,
  normalizeChatRuntimeSettings,
  publicView,
  readSettings,
  resolveDefaultModel,
  resolveTextModel,
  resolveTextProfile,
  resolveVideoProfile,
  videoProfilesOf,
  textProfilesOf,
  writeSettings,
} = await import('../bridge/settings');

function imageProfile(id: string, enabled?: boolean) {
  return { ...createProfile(id), id, enabled };
}

function textProfile(id: string, enabled?: boolean) {
  return { ...createProfile(id, 'text' as const), id, enabled };
}

function videoProfile(id: string, enabled?: boolean) {
  return { ...createProfile(id, 'video' as const), id, enabled };
}

describe('对话记忆与运行预算设置', () => {
  it('migrates old settings and publishes distinct memory/runtime defaults', () => {
    for (const raw of [{}, { profiles: [] }, { profiles: [imageProfile('defaults')] }]) {
      const settings = normalizeSettings(raw);
      expect(settings.chatMemory).toMatchObject({ enabled: true, shortTermMessageLimit: 12, shortTermTokenBudget: 4500 });
      expect(publicView(settings).chatRuntime).toEqual(defaultChatRuntimeSettings());
    }
    expect(normalizeChatRuntimeSettings({ maxModelRounds: 99, maxToolCalls: 0, maxImagesPerRun: 99, confirmImagesAbove: 99, maxOutputTokens: 1 })).toEqual({ maxModelRounds: 8, maxToolCalls: 1, maxImagesPerRun: 8, confirmImagesAbove: 1, maxOutputTokens: 2048 });
  });

  it('saves partial globals without replacing profiles, keys, other budgets or preferences', async () => {
    const profile = { ...imageProfile('partial-global'), apiKey: 'partial-secret' };
    const first = await writeSettings({ profiles: [profile], activeProfileId: profile.id, chatMemory: { shortTermMessageLimit: 20 }, chatRuntime: { maxModelRounds: 6 } });
    const saved = await writeSettings({ chatMemory: { enabled: false }, chatRuntime: { maxImagesPerRun: 7 } });
    expect(saved.profiles).toEqual(first.profiles);
    expect(saved.chatMemory).toMatchObject({ enabled: false, shortTermMessageLimit: 20 });
    expect(saved.chatRuntime).toMatchObject({ maxModelRounds: 6, maxImagesPerRun: 7 });
    expect(publicView(saved).chatMemory.enabled).toBe(false);
    expect(JSON.stringify(publicView(saved))).not.toContain('partial-secret');
  });

  it('updates the active profile with a partial global save', async () => {
    const first = await writeSettings({ profiles: [imageProfile('partial-a'), imageProfile('partial-b')], activeProfileId: 'partial-a' });
    const secondId = first.profiles[1].id;
    const saved = await writeSettings({ activeProfileId: secondId });
    expect(saved.activeProfileId).toBe(secondId);
    expect(saved.profiles).toHaveLength(2);
  });

  it('serializes read-merge-write for concurrent independent global patches', async () => {
    await Promise.all([
      writeSettings({ chatMemory: { summaryTargetTokens: 1100 } }),
      writeSettings({ chatRuntime: { maxModelRounds: 7 } }),
    ]);
    const saved = await readSettings();
    expect(saved.chatMemory.summaryTargetTokens).toBe(1100);
    expect(saved.chatRuntime.maxModelRounds).toBe(7);
  });
});

describe('配置启停（enabled）', () => {
  it('老配置没有 enabled 字段时一律按启用处理', () => {
    const settings = normalizeSettings({
      profiles: [imageProfile('img1'), textProfile('txt1')],
      activeProfileId: 'img1',
      textProfileId: 'txt1',
    });
    expect(settings.profiles.map((profile) => profile.enabled)).toEqual([true, true]);
  });

  it('activeProfile 跳过停用的生图配置，全停用时退回原池', () => {
    const imageA = imageProfile('imgA');
    const imageB = imageProfile('imgB', false);
    const settings = normalizeSettings({
      profiles: [imageA, imageB],
      activeProfileId: 'imgB',
    });
    // 显式 active 被停用 → 让位给第一路可用的
    expect(activeProfile(settings).id).toBe('imgA');
    const allOff = normalizeSettings({
      profiles: [imageProfile('imgA', false), imageProfile('imgB', false)],
      activeProfileId: 'imgB',
    });
    // 全停用不抛空：退回原池第一路，界面保存前也有护栏拦住这种配置
    expect(activeProfile(allOff).id).toBe('imgA');
  });

  it('语言配置不再有配置级停用，textProfilesOf 包含全部', () => {
    const settings = normalizeSettings({
      profiles: [textProfile('txtA', false), textProfile('txtB')],
      textProfileId: '',
    });
    expect(settings.profiles.filter((profile) => profile.kind === 'text').map((profile) => profile.enabled)).toEqual([true, true]);
    expect(textProfilesOf(settings).map((profile) => profile.id)).toEqual(['txtA', 'txtB']);
    expect(resolveTextProfile(settings, 'txtA')?.id).toBe('txtA');
    expect(resolveTextProfile(settings)?.id).toBe('txtA');
  });

  it('selectedModels 与 enabledModels 分开持久化', () => {
    const base = textProfile('txt');
    const settings = normalizeSettings({
      profiles: [{ ...base, selectedModels: ['m-a', 'm-b'], enabledModels: ['m-a'] }],
      textProfileId: 'txt',
    });
    expect(settings.profiles[0].selectedModels).toEqual(['m-a', 'm-b']);
    expect(settings.profiles[0].enabledModels).toEqual(['m-a']);
  });

  it('resolveTextModel 只认 enabledModels 里的具体模型，否则回退配置默认', () => {
    const profile = { ...textProfile('txt'), model: 'm-default', enabledModels: ['m-a', 'm-b'] };
    expect(resolveTextModel(profile, 'm-b')).toBe('m-b');
    expect(resolveTextModel(profile, 'm-x')).toBe('m-default');
    expect(resolveTextModel(profile)).toBe('m-default');
    expect(resolveTextModel(null, 'm-a')).toBe('');
  });

  it('writeSettings 透传 enabled，publicView 不回 Key 但带启停状态', async () => {
    const saved = await writeSettings({
      profiles: [
        { ...imageProfile('imgA'), apiKey: 'k-a' },
        { ...imageProfile('imgB', false), apiKey: 'k-b' },
      ],
      activeProfileId: 'imgA',
      direct: true,
    });
    expect(saved.profiles.map((profile) => profile.enabled)).toEqual([true, false]);
    const view = publicView(await readSettings());
    expect(view.profiles.map((profile) => profile.enabled)).toEqual([true, false]);
    expect(JSON.stringify(view)).not.toContain('k-a');
  });

  it('自定义视频协议持久化映射配置，并把模板中的已保存 Key 转为占位符', async () => {
    const profile = {
      ...createProfile('自定义视频', 'video'),
      id: 'video-custom',
      baseUrl: 'https://video.example/v1',
      apiKey: 'long-secret-video-key',
      model: 'custom-video',
      videoApiMode: 'custom' as const,
      videoCustomConfig: {
        createPath: '/videos/generate',
        pollPath: '/videos/{{taskId}}',
        imageTransport: 'data-url' as const,
        headersTemplate: '{"X-API-Key":"Bearer long-secret-video-key"}',
        requestBodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}"}',
        taskIdPath: 'data.task_id',
        statusPath: 'data.state',
        progressPath: 'data.progress',
        outputUrlPath: 'data.result_url',
        errorPath: 'data.error',
        statusMap: '{"success":"completed"}',
      },
    };
    const saved = await writeSettings({ profiles: [profile], activeProfileId: profile.id, direct: true });
    expect(saved.profiles[0].videoApiMode).toBe('custom');
    expect(saved.profiles[0].videoCustomConfig?.imageTransport).toBe('data-url');
    expect(saved.profiles[0].videoCustomConfig?.headersTemplate).toContain('{{apiKey}}');
    const view = publicView(saved);
    expect(JSON.stringify(view)).not.toContain('long-secret-video-key');
    expect(view.profiles[0].videoCustomConfig?.outputUrlPath).toBe('data.result_url');
  });

  it('writeSettings 草稿缺省 enabled 时视为启用（界面旧版本不发该字段）', async () => {
    const draft = imageProfile('imgC');
    delete (draft as Record<string, unknown>).enabled;
    const saved = await writeSettings({
      profiles: [draft],
      activeProfileId: 'imgC',
      direct: true,
    });
    expect(saved.profiles[0].enabled).toBe(true);
  });

  it('profile ID 变化但身份唯一时保留已保存 Key', async () => {
    const original = {
      ...imageProfile('img-stable'),
      name: 'Grsai API',
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret-key',
      model: 'image-model',
    };
    const first = await writeSettings({ profiles: [original], activeProfileId: original.id, direct: true });
    const saved = await writeSettings({
      profiles: [{
        ...original,
        id: 'stale-tab-id',
        apiKey: '',
      }],
      activeProfileId: 'stale-tab-id',
      direct: true,
    });
    expect(saved.profiles[0].id).toBe(first.profiles[0].id);
    expect(saved.profiles[0].apiKey).toBe('secret-key');
  });

  it('仅保存模型设置时保留已存偏好档案', async () => {
    const preferences = {
      enabled: true,
      entries: [{ id: 'pref-1', text: '偏好留白', source: 'manual' as const, createdAt: '2026-10-26T00:00:00.000Z' }],
      updatedAt: '2026-10-26T00:00:00.000Z',
    };
    const profile = imageProfile('pref-preserved');
    await writeSettings({ profiles: [profile], activeProfileId: profile.id, preferences });

    const saved = await writeSettings({ profiles: [profile], activeProfileId: profile.id, direct: false });

    expect(saved.preferences).toEqual(preferences);
  });
});

describe('启动模型就绪状态', () => {
  it('检查当前启用的生图模型配置和已拉取列表，不泄露 Key', () => {
    const profile = {
      ...imageProfile('image-ready'),
      baseUrl: 'https://images.example.test/v1',
      apiKey: 'private-key',
      model: 'image-model',
      models: ['image-model'],
    };
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id });
    const status = imageModelReadiness(settings);

    expect(status).toEqual({
      configured: true,
      modelsLoaded: true,
      profileName: 'image-ready',
      modelName: 'image-model',
    });
    expect(JSON.stringify(status)).not.toContain('private-key');
  });

  it('缺少必要配置或模型列表时明确标记为未就绪', () => {
    const profile = { ...imageProfile('image-empty'), model: '', models: [] };
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id });

    expect(imageModelReadiness(settings)).toMatchObject({ configured: false, modelsLoaded: false });
  });

  it('不会把停用的配置报告为可用模型', () => {
    const profile = {
      ...imageProfile('image-disabled', false),
      baseUrl: 'https://images.example.test/v1',
      apiKey: 'private-key',
      model: 'image-model',
      models: ['image-model'],
    };
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id });

    expect(imageModelReadiness(settings).configured).toBe(false);
  });
});

describe('默认模型必须落在已勾选列表里（resolveDefaultModel）', () => {
  it('默认模型在列表里 → 原样保留', () => {
    expect(resolveDefaultModel('gpt-image-2.5', ['gpt-image-2.5', 'gpt-image-1'])).toBe('gpt-image-2.5');
  });

  it('默认模型不在列表里 → 收敛到列表第一项（画布否则一生成就挂）', () => {
    // 实测：Grsai 那路默认 gpt-image-1，勾选列表只有 gpt-image-2.5，
    // 不带显式模型名生成时上游回 "model not register: gpt-image-1"
    expect(resolveDefaultModel('gpt-image-1', ['gpt-image-2.5'])).toBe('gpt-image-2.5');
  });

  it('没拉过列表（enabledModels 为空）→ 保持手填的模型名', () => {
    expect(resolveDefaultModel('my-custom-model', [])).toBe('my-custom-model');
    expect(resolveDefaultModel('', [])).toBe('');
  });

  it('normalizeSettings 读路径就修好历史错数据', () => {
    const settings = normalizeSettings({
      profiles: [{ ...imageProfile('imgA'), model: 'gpt-image-1', enabledModels: ['gpt-image-2.5'] }],
      activeProfileId: 'imgA',
    });
    expect(settings.profiles[0].model).toBe('gpt-image-2.5');
  });

  it('新视频配置保持空白，不预填服务地址、模型或尺寸', () => {
    expect(createProfile('视频', 'video')).toMatchObject({
      baseUrl: '',
      model: '',
      defaultSize: '',
    });
  });

  it('保存空白视频配置时不补入 OpenAI URL 或生图尺寸，也不作为可用模型', async () => {
    const draft = {
      ...videoProfile('video-empty-save'),
      baseUrl: '',
      defaultSize: '',
      model: '',
      models: [],
      enabledModels: [],
      apiKey: '',
    };
    const settings = await writeSettings({ profiles: [draft], activeProfileId: draft.id, direct: true });

    expect(settings.profiles[0]).toMatchObject({ baseUrl: '', defaultSize: '', model: '' });
    expect(videoProfilesOf(settings)).toEqual([]);
    expect(resolveVideoProfile(settings)).toBeNull();
  });

  it('清空现有视频配置字段时不会从旧值或勾选列表自动补回', async () => {
    const existing = {
      ...videoProfile('video-clear-existing'),
      baseUrl: 'https://old-provider.example/v1',
      model: 'old-video-model',
      defaultSize: '1080p',
      models: ['old-video-model'],
      enabledModels: ['old-video-model'],
      apiKey: 'saved-video-key',
    };
    await writeSettings({ profiles: [existing], activeProfileId: existing.id, direct: true });
    const cleared = await writeSettings({
      profiles: [{ ...existing, baseUrl: '', model: '', defaultSize: '', enabledModels: [] }],
      activeProfileId: existing.id,
      direct: true,
    });

    expect(cleared.profiles[0]).toMatchObject({ baseUrl: '', model: '', defaultSize: '', apiKey: 'saved-video-key' });
  });

  it('视频模型没填默认值时，读取配置从已勾选列表回填第一个（添加模型即可用）', () => {
    const profile = {
      ...videoProfile('video-empty'),
      baseUrl: '',
      defaultSize: '',
      model: '',
      models: ['veo-3.1'],
      enabledModels: ['veo-3.1'],
    };
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: 'video-empty' });
    expect(settings.profiles[0]).toMatchObject({ baseUrl: '', defaultSize: '', model: 'veo-3.1' });
  });
});
