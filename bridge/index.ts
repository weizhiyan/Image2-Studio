import fs from 'node:fs';
import { DATA_DIR, MEDIA_DIR } from './paths.js';
import { listenHttpServer } from './http.js';
import { createMcpServer } from './mcp.js';
import { reconcileLostRuns } from './runs.js';

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  await listenHttpServer();

  // bridge 重启后内存里的 run 全丢了：把上次未结束的消息标记成「运行状态未知」，
  // 不伪装成完成（方案 §17）
  await reconcileLostRuns();

  const server = createMcpServer();
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await server.connect(new StdioServerTransport());
  // stdio 协议下只能写 stderr，stdout 是协议通道
  console.error('[huiban] MCP stdio 已就绪（Codex 连接后即可调用 huiban_generate）');
}

void main();
