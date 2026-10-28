import { describe, expect, it } from 'vitest';
import type { ModelProfileView, ProfileKind } from '../src/types';
import { imageModelOptionsOf } from '../src/lib/imageModelOptions';

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
