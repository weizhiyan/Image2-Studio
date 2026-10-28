import { describe, expect, it } from 'vitest';
import { fillVideoSchemaDefaults, videoUploadParamForMode } from '@/lib/videoSchemaDefaults';
import type { VideoModelSchema } from '@/types';

const seedanceSchema: VideoModelSchema = {
  name: 'seedance-2.0-guanfang-anmiao',
  params: [
    { name: 'mode', label: '生成模式', type: 'segment', options: [{ label: '首尾帧', value: 'shouweizhen' }, { label: '参考生', value: 'cankaosheng' }] },
    { name: 'version', label: '速度版本', type: 'select', required: true, options: [{ label: 'Mini', value: 'Mini' }, { label: '快速', value: '快速' }, { label: '标准', value: '标准' }] },
    { name: 'duration', label: '视频时长', type: 'select', required: true, options: [{ label: '4秒', value: '4' }, { label: '5秒', value: '5' }, { label: '6秒', value: '6' }] },
    { name: 'aspect_ratio', label: '宽高比', type: 'select', options: [{ label: '自适应', value: 'adaptive' }, { label: '16:9', value: '16:9' }] },
    { name: 'resolution', label: '画质', type: 'select', required: true, options: [{ label: '480p', value: '480p' }, { label: '720p', value: '720p' }] },
    { name: 'images', label: '首尾帧', type: 'upload' },
    { name: 'image_url', label: '参考图片', type: 'upload', description: '参考生模式（mode=cankaosheng）的参考图片' },
  ],
};

describe('视频模型 schema 默认参数', () => {
  it('用节点参数填充时长、画质、比例，并按模型名称选速度版本', () => {
    expect(fillVideoSchemaDefaults(seedanceSchema, {}, {
      model: 'seedance-2.0-guanfang-anmiao',
      seconds: 5,
      resolution: '720p',
      ratio: '16:9',
    })).toMatchObject({
      mode: 'shouweizhen',
      version: '标准',
      duration: '5',
      aspect_ratio: '16:9',
      resolution: '720p',
    });
  });

  it('时长不在模型可选值中时使用最近档位', () => {
    const schema = { ...seedanceSchema, params: seedanceSchema.params.map((spec) => (
      spec.name === 'duration' ? { ...spec, options: [{ label: '3秒', value: '3' }, { label: '6秒', value: '6' }, { label: '9秒', value: '9' }] } : spec
    )) };
    expect(fillVideoSchemaDefaults(schema, {}, {
      model: 'seedance-2.0-guanfang-anmiao', seconds: 5, resolution: '480p', ratio: '16:9',
    }).duration).toBe('6');
  });

  it('遇到模型不支持的持久化清晰度时回落到最近支持档', () => {
    const schema = { ...seedanceSchema, params: seedanceSchema.params.map((spec) => (
      spec.name === 'resolution' ? { ...spec, options: [{ label: '480p', value: '480p' }, { label: '720p', value: '720p' }] } : spec
    )) };
    expect(fillVideoSchemaDefaults(schema, { resolution: '1080p' }, {
      model: 'seedance-2.0-guanfang-anmiao', seconds: 5, resolution: '1080p', ratio: '16:9',
    }).resolution).toBe('720p');
  });

  it('保留用户已明确选过的 schema 参数', () => {
    expect(fillVideoSchemaDefaults(seedanceSchema, { version: 'Mini', duration: '6' }, {
      model: 'seedance-2.0-guanfang-anmiao', seconds: 5, resolution: '480p', ratio: '16:9',
    })).toMatchObject({ version: 'Mini', duration: '6' });
  });

  it('根据所选生成模式选择模型对应的上传字段', () => {
    expect(videoUploadParamForMode(seedanceSchema, 'shouweizhen')?.name).toBe('images');
    expect(videoUploadParamForMode(seedanceSchema, 'cankaosheng')?.name).toBe('image_url');
  });
});
