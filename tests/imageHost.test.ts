import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultImageHost, describeImageHostFailure, effectiveImageHost, isLegacyDefaultImageHost, uploadToImageHost } from '../bridge/imageHost';

afterEach(() => vi.unstubAllGlobals());

describe('图床网络错误说明', () => {
  it('指出远端关闭连接，并说明视频请求尚未提交', () => {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const error = new TypeError('fetch failed', { cause });

    const message = describeImageHostFailure(error, 'https://catbox.moe/user/api.php');

    expect(message).toContain('catbox.moe');
    expect(message).toContain('UND_ERR_SOCKET');
    expect(message).toContain('视频服务尚未收到生成请求');
  });

  it('不会把图床 URL 中的凭据或查询参数放进错误信息', () => {
    const message = describeImageHostFailure(
      new Error('connection failed'),
      'https://user:secret@example.com/upload?token=private',
    );

    expect(message).toContain('example.com');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('private');
  });

  it('把图床上传超时转换成清晰的中文提示', () => {
    const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const message = describeImageHostFailure(error, 'https://litterbox.catbox.moe/upload');

    expect(message).toContain('等待图床响应超时');
    expect(message).toContain('60 秒');
  });

  it('服务端返回 HTML 错误页时不把整页源码塞进节点提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<!doctype html><html><title>500 | Internal Server Error</title></html>',
      { status: 500, headers: { 'content-type': 'text/html' } },
    )));

    await expect(uploadToImageHost(defaultImageHost(), {
      buffer: Buffer.from('pixel'),
      fileName: 'pixel.png',
      contentType: 'image/png',
    })).rejects.toThrow('图床服务端返回错误页面');
  });
});

describe('默认图床', () => {
  it('默认使用 ImgDB，返回字段与一小时保留时间正确', () => {
    const host = defaultImageHost();
    expect(host.uploadUrl).toBe('https://imgdb.io/api/v1/upload?ttl=3600');
    expect(host.fileField).toBe('file');
    expect(host.urlField).toBe('url');
  });

  it('旧版 Catbox 与 Litterbox 默认配置被识别并自动迁移', () => {
    expect(isLegacyDefaultImageHost({
      uploadUrl: 'https://catbox.moe/user/api.php',
      fileField: 'file',
      urlField: '',
      headers: {},
      extraFields: { reqtype: 'fileupload' },
    })).toBe(true);
    expect(isLegacyDefaultImageHost({
      uploadUrl: 'https://litterbox.catbox.moe/resources/internals/api.php',
      fileField: 'fileToUpload',
      urlField: '',
      headers: {},
      extraFields: { reqtype: 'fileupload', time: '1h' },
    })).toBe(true);
  });

  it('真正的自定义图床不会被误判', () => {
    const customHost = {
      uploadUrl: 'https://my.host/upload',
      fileField: 'file',
      urlField: '',
      headers: { Authorization: 'Bearer x' },
      extraFields: {},
    };
    expect(isLegacyDefaultImageHost(customHost)).toBe(false);
    expect(effectiveImageHost(customHost)).toEqual(customHost);
  });

  it('未配置或旧版默认配置时使用内置临时图床', () => {
    expect(effectiveImageHost(null)).toEqual(defaultImageHost());
    expect(effectiveImageHost({
      uploadUrl: 'https://catbox.moe/user/api.php',
      fileField: 'file',
      urlField: '',
      headers: {},
      extraFields: { reqtype: 'fileupload' },
    })).toEqual(defaultImageHost());
  });

  it('临时网络错误只重试一次，成功后返回图床地址', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('The operation was aborted due to timeout'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://imgdb.io/i/abc.png' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const url = await uploadToImageHost(defaultImageHost(), {
      buffer: Buffer.from('pixel'),
      fileName: 'pixel.png',
      contentType: 'image/png',
    });

    expect(url).toBe('https://imgdb.io/i/abc.png');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [requestUrl, requestInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(requestUrl).toBe('https://imgdb.io/api/v1/upload?ttl=3600');
    expect((requestInit.body as FormData).get('file')).toBeInstanceOf(Blob);
  });

  it('HTTP 拒绝不重试，避免重复上传非瞬时错误', async () => {
    const fetchMock = vi.fn(async () => new Response('invalid request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadToImageHost(defaultImageHost(), {
      buffer: Buffer.from('pixel'),
      fileName: 'pixel.png',
      contentType: 'image/png',
    })).rejects.toThrow('HTTP 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
