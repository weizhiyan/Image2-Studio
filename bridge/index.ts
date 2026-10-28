import fs from 'node:fs';
import { DATA_DIR, MEDIA_DIR } from './paths.js';
import { listenHttpServer } from './http.js';
import { createMcpServer } from './mcp.js';
import { reconcileLostRuns } from './runs.js';
import { startVideoPoller } from './videoTasks.js';
import { configureNetworkProxy } from './network.js';

/**
 * Node 22 的原生 fetch（undici）不读 NO_PROXY：只要环境里有 HTTP_PROXY，
 * 连 http://127.0.0.1:xxx 这种本机地址也会被塞进代理。
 * 沙箱 / IDE 注入的代理通常只对外网有效（例如指向 127.0.0.1:50010 的透明代理），
 * 把本机请求丢给它只会得到 ECONNREFUSED 或「fetch failed」。
 *
 * 这里按**目标地址**判断：目标在本机 / 私网 / .local 时清掉代理变量，公网照旧。
 * 注意不能按「代理是否在本机」判断——本机代理恰恰是最常见的情况，那样等于永远不绕过。
 */
function bypassProxyForLocalTargets(): void {
  const targets = [
    process.env.HUIBAN_VIDEO_BASE_URL,
    process.env.HUIBAN_IMAGE_BASE_URL,
    process.env.HUIBAN_TEXT_BASE_URL,
  ].filter(Boolean) as string[];
  const shouldBypass = targets.length === 0 || targets.some((url) => isLocalUrl(url));
  if (!shouldBypass) return;
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[key];
  }
}

function isLocalUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '[::1]'
      || host.endsWith('.local')
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // 先按环境变量/系统设置初始化代理（Linux 只认环境变量，必须在清理之前读），
  // 再清理沙箱注入的代理变量；代理实例已经拿到显式配置，不受后续删除影响。
  const proxy = await configureNetworkProxy();
  if (proxy) console.error(`[huiban] 出站网络使用系统代理 ${proxy}`);
  bypassProxyForLocalTargets();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const ownsPort = await listenHttpServer();

  // bridge 重启后内存里的 run 全丢了：把上次未结束的消息标记成「运行状态未知」，
  // 不伪装成完成（方案 §17）
  await reconcileLostRuns();

  // 视频是长任务：重启后接着轮询上次没出结果的那些。
  // 只有绑住端口的那个进程跑——MCP stdio 进程起来时端口常被占用，它也跑就会重复查询。
  if (ownsPort) startVideoPoller();

  const server = createMcpServer();
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  process.stdin.once('end', () => {
    void server.close();
  });
  await server.connect(new StdioServerTransport());
  // stdio 协议下只能写 stderr，stdout 是协议通道
  console.error('[huiban] MCP stdio 已就绪（Codex 连接后即可调用 huiban_generate）');
}

void main();
