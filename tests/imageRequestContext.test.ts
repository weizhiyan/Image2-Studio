import { describe, expect, it } from 'vitest';
import { resolveImageContinuation, resolveResponseModel } from '../bridge/imageRequestContext';

const profile = { id: 'provider-a', model: 'image-model', responsesModel: 'reasoner' };
const base = {
  responseId: 'resp_base', imageGenerationCallId: 'ig_base',
  responseProfileId: 'provider-a', responseModel: 'reasoner', model: 'image-model',
};
const input = { base, profile, apiMode: 'responses' as const, isEdit: true, hasNewReferences: false };

describe('图像请求模型与续接', () => {
  it('独立解析同一路供应商的外层模型，忽略历史 GPT 占位值', () => {
    expect(resolveResponseModel(profile)).toBe('reasoner');
    expect(resolveResponseModel(profile, ' outer-override ')).toBe('outer-override');
    expect(resolveResponseModel(profile, 'GPT')).toBe('reasoner');
    expect(resolveResponseModel({ responsesModel: ' GPT ' })).toBe('gpt-5.5');
    expect(resolveResponseModel({ responsesModel: ' ' })).toBe('gpt-5.5');
  });

  it('同一基准及有效 outer/tool 配置可续接，带上明确去重许可', () => {
    expect(resolveImageContinuation(input)).toEqual({
      previousResponseId: 'resp_base', previousImageGenerationCallId: 'ig_base', reusePreviousImage: true,
    });
  });

  it.each([
    ['新增参考', { hasNewReferences: true }],
    ['新需求', { isEdit: false }],
    ['切换图像工具模型', { model: 'image-v2' }],
    ['切换外层模型', { profile: { ...profile, responsesModel: 'reasoner-v2' } }],
    ['切换供应商配置', { profile: { ...profile, id: 'provider-b' } }],
    ['切换接口', { apiMode: 'images' as const }],
    ['旧版本缺少工具身份', { base: { ...base, model: undefined } }],
    ['无基准', { base: undefined }],
    ['基准没有 response ID', { base: { ...base, responseId: undefined } }],
  ])('%s 时断链，不遗留 call ID 或去重许可', (_name, changes) => {
    const result = resolveImageContinuation({ ...input, ...changes });
    expect(result.previousResponseId).toBeUndefined();
    expect(result.previousImageGenerationCallId).toBeUndefined();
    expect(result.reusePreviousImage).toBeUndefined();
  });

  it('断链原因区分新增素材和模型配置改变', () => {
    expect(resolveImageContinuation({ ...input, hasNewReferences: true }).resetReason).toContain('参考图');
    expect(resolveImageContinuation({ ...input, model: 'image-v2' }).resetReason).toContain('模型');
  });
});
