import { describe, expect, it } from 'vitest';
import type { ModelProfileView, ProfileKind } from '../src/types';
import { groupModelOptions, imageModelOptionsOf } from '../src/lib/imageModelOptions';

function profile(id: string, kind: ProfileKind, enabled = true): ModelProfileView {
  return {
    id,
    name: id,
    baseUrl: 'https://example.test/v1',
    model: `${id}-model`,
    defaultSize: '1024x1024',
    models: [`${id}-model`],
    enabledModels: [`${id}-model`],
    kind,
    keyConfigured: true,
    enabled,
    textFormat: 'auto',
  };
}

describe('图像生成模型选项', () => {
  it('按配置分组，保留配置和模型顺序，同名配置不合并', () => {
    const options = [
      { key: 'a:one', profileId: 'a', profileName: '公司', model: 'one' },
      { key: 'b:one', profileId: 'b', profileName: '漫小白', model: 'one' },
      { key: 'a:two', profileId: 'a', profileName: '公司', model: 'two' },
      { key: 'c:one', profileId: 'c', profileName: '公司', model: 'one' },
    ];
    expect(groupModelOptions(options)).toEqual([
      { profileId: 'a', profileName: '公司', options: [options[0], options[2]] },
      { profileId: 'b', profileName: '漫小白', options: [options[1]] },
      { profileId: 'c', profileName: '公司', options: [options[3]] },
    ]);
    expect(groupModelOptions([])).toEqual([]);
  });

  it('只返回启用的图像模型，不混入视频或语言模型', () => {
    const options = imageModelOptionsOf([
      profile('image', 'image'),
      profile('video', 'video'),
      profile('text', 'text'),
      profile('disabled-image', 'image', false),
    ]);

    expect(options.map(({ profileId, model }) => ({ profileId, model }))).toEqual([
      { profileId: 'image', model: 'image-model' },
    ]);
  });
});
