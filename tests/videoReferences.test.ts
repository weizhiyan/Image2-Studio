import { describe, expect, it } from 'vitest';
import { classifyVideoImageReference } from '@/lib/videoReferences';

describe('图生视频参考图片地址', () => {
  it('识别公网 HTTPS、Bridge 本地文件和旧版 data URL', () => {
    expect(classifyVideoImageReference('https://cdn.example/image.png')).toEqual({
      kind: 'remote',
      value: 'https://cdn.example/image.png',
    });
    expect(classifyVideoImageReference('/api/files/my%20image.png?size=small')).toEqual({
      kind: 'local-file',
      value: 'my image.png',
    });
    expect(classifyVideoImageReference('data:image/png;base64,AAAA')).toEqual({
      kind: 'data-url',
      value: 'data:image/png;base64,AAAA',
    });
  });

  it('拒绝不受支持的链接，不把参考图静默丢掉', () => {
    expect(classifyVideoImageReference('http://example.com/image.png')).toEqual({
      kind: 'unsupported',
      value: 'http://example.com/image.png',
    });
  });
});
