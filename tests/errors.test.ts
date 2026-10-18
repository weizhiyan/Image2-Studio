import { describe, expect, it } from 'vitest';
import { describeRequestError } from '../src/lib/errors';

describe('describeRequestError', () => {
  it('fetch 底层报错翻译成带 Base URL 的人话', () => {
    const message = describeRequestError(new TypeError('fetch failed'), 'https://api.example.com/v1');
    expect(message).toContain('连接失败');
    expect(message).toContain('https://api.example.com/v1');
    expect(message).not.toContain('fetch failed');
  });

  it('拒连 / 域名不存在 / 超时一类底层字样同样翻译', () => {
    for (const raw of ['connect ECONNREFUSED 127.0.0.1:9', 'getaddrinfo ENOTFOUND api.example.com', 'connect ETIMEDOUT 1.2.3.4:443', "Couldn't connect to server"]) {
      expect(describeRequestError(new Error(raw), 'http://127.0.0.1:9/v1')).toContain('连接失败');
    }
  });

  it('服务商返回的业务报错原样透出，不被兜底文案盖掉', () => {
    expect(describeRequestError(new Error('尚未配置 API Key：请先填写并保存'), 'https://api.example.com/v1'))
      .toBe('尚未配置 API Key：请先填写并保存');
  });

  it('Base URL 为空时有占位，不出现 undefined', () => {
    expect(describeRequestError(new TypeError('fetch failed'), '')).toContain('该地址');
  });
});
