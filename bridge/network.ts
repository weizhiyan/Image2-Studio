import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * 出站网络代理。
 *
 * 为什么需要：Node 自带的 fetch（undici）**不会**读 macOS/Windows 的系统代理设置，
 * 而浏览器会。用户开着 Clash/Surge 时，浏览器能打开中转站，bridge 却直连超时
 * （更糟的是被污染 DNS 指到 1.31.13.x / face:b00c 这类地址）。
 * 这里在进程启动时探测系统代理，把全局 fetch 切到代理；探测不到就保持直连。
 *
 * 优先级：HUIBAN_PROXY 环境变量 > 标准 HTTPS_PROXY/HTTP_PROXY > 系统代理。
 * 本地地址永远直连（NO_PROXY），不影响 bridge 自己的回环请求。
 */

export interface DetectedProxy {
  http?: string;
  https?: string;
  noProxy: string;
}

export function parseScutilProxy(output: string): DetectedProxy | null {
  const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(output);
  const httpEnabled = /HTTPEnable\s*:\s*1/.test(output);
  const httpsHost = /HTTPSProxy\s*:\s*(\S+)/.exec(output)?.[1];
  const httpsPort = /HTTPSPort\s*:\s*(\d+)/.exec(output)?.[1];
  const httpHost = /HTTPProxy\s*:\s*(\S+)/.exec(output)?.[1];
  const httpPort = /HTTPPort\s*:\s*(\d+)/.exec(output)?.[1];
  const toUrl = (host?: string, port?: string) => (host && port ? `http://${host}:${port}` : undefined);
  const https = httpsEnabled ? toUrl(httpsHost, httpsPort) : undefined;
  const http = httpEnabled ? toUrl(httpHost, httpPort) : undefined;
  if (!https && !http) return null;
  return { https: https || http, http: http || https, noProxy: 'localhost,127.0.0.1,::1' };
}

export function parseWindowsProxy(output: string): DetectedProxy | null {
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(output);
  const server = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(output)?.[1];
  if (!enabled || !server) return null;
  // ProxyServer 可能是 "host:port" 或 "http=host:port;https=host:port"
  if (server.includes('=')) {
    const parts = Object.fromEntries(server.split(';').map((part) => part.split('=') as [string, string]));
    const http = parts.http ? `http://${parts.http}` : undefined;
    const https = parts.https ? `http://${parts.https}` : http;
    return http || https ? { http, https, noProxy: 'localhost,127.0.0.1,::1' } : null;
  }
  const url = server.includes('://') ? server : `http://${server}`;
  return { http: url, https: url, noProxy: 'localhost,127.0.0.1,::1' };
}

/** 读环境变量或系统代理；读不到返回 null。 */
export function detectSystemProxy(): DetectedProxy | null {
  const explicit = String(process.env.HUIBAN_PROXY || '').trim();
  if (explicit) {
    return { http: explicit, https: explicit, noProxy: process.env.HUIBAN_NO_PROXY || 'localhost,127.0.0.1,::1' };
  }
  const envProxy = String(
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '',
  ).trim();
  if (envProxy) {
    const http = String(process.env.HTTP_PROXY || process.env.http_proxy || envProxy).trim();
    const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || 'localhost,127.0.0.1,::1').trim();
    return { http, https: envProxy, noProxy };
  }
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000 });
      return parseScutilProxy(output);
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 2000 },
      );
      return parseWindowsProxy(output);
    } catch {
      return null;
    }
  }
  return null;
}

function proxyHostPort(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80) };
  } catch {
    return null;
  }
}

/** 代理端口没开就别切：否则所有出站请求会比直连失败得更慢。 */
export async function isProxyReachable(url: string, timeoutMs = 600): Promise<boolean> {
  const target = proxyHostPort(url);
  if (!target) return false;
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 启动时调用一次：探测到可用代理就把全局 fetch 切过去。
 * 返回值用于日志（成功时是代理地址，失败/无代理是 null）。
 */
export async function configureNetworkProxy(): Promise<string | null> {
  const detected = detectSystemProxy();
  const candidate = detected?.https || detected?.http;
  if (!detected || !candidate) return null;
  if (!(await isProxyReachable(candidate))) {
    console.warn(`[huiban] 检测到系统代理 ${candidate}，但端口不可达，仍使用直连`);
    return null;
  }
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent({
      httpProxy: detected.http,
      httpsProxy: detected.https,
      noProxy: detected.noProxy,
    }));
    return candidate;
  } catch (err) {
    console.warn('[huiban] 初始化网络代理失败，继续直连：', err instanceof Error ? err.message : err);
    return null;
  }
}
