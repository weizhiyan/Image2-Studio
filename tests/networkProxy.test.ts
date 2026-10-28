import { afterEach, describe, expect, it } from 'vitest';
import { detectSystemProxy, parseScutilProxy, parseWindowsProxy } from '../bridge/network.js';

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of ['HUIBAN_PROXY', 'HUIBAN_NO_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('系统代理解析', () => {
  it('macOS scutil：HTTPS 代理开启时生成 http://host:port', () => {
    const parsed = parseScutilProxy(`
      HTTPEnable : 1
      HTTPPort : 7890
      HTTPProxy : 127.0.0.1
      HTTPSEnable : 1
      HTTPSPort : 7890
      HTTPSProxy : 127.0.0.1
    `);
    expect(parsed).toMatchObject({
      http: 'http://127.0.0.1:7890',
      https: 'http://127.0.0.1:7890',
    });
    expect(parsed?.noProxy).toContain('127.0.0.1');
  });

  it('macOS scutil：代理关闭时返回 null', () => {
    expect(parseScutilProxy('HTTPSEnable : 0\nHTTPEnable : 0\n')).toBeNull();
  });

  it('Windows 注册表：ProxyEnable=1 + host:port', () => {
    const parsed = parseWindowsProxy(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    `);
    expect(parsed).toMatchObject({ http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890' });
  });

  it('Windows 注册表：分协议写法', () => {
    const parsed = parseWindowsProxy(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891
    `);
    expect(parsed).toMatchObject({ http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7891' });
  });

  it('HUIBAN_PROXY 显式覆盖优先', () => {
    process.env.HUIBAN_PROXY = 'http://10.0.0.2:8080';
    process.env.HUIBAN_NO_PROXY = 'localhost,example.com';
    expect(detectSystemProxy()).toEqual({
      http: 'http://10.0.0.2:8080',
      https: 'http://10.0.0.2:8080',
      noProxy: 'localhost,example.com',
    });
  });
});
