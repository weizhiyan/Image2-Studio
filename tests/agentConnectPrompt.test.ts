import { describe, expect, it } from 'vitest';
import { buildAgentConnectPrompt } from '../src/lib/agentConnectPrompt';

describe('Agent 连接指令', () => {
  it('要求核对当前画布，并在工具不可用时提供真实 MCP 配置', () => {
    const prompt = buildAgentConnectPrompt({
      canvasId: 'canvas_test_123',
      canvasName: '工作画布',
      mcpEntry: '/Users/example/My Projects/绘板/bridge/dist/index.js',
      nodeCommand: '/Users/example/My Projects/绘板/bridge/mcp-launch.sh',
    });

    expect(prompt).toContain('先调用 huiban_canvases');
    expect(prompt).toContain('WorkBuddy 中实际名称是 huiban_huiban_canvases');
    expect(prompt).toContain('huiban_huiban_generate');
    expect(prompt).toContain('「工作画布」（canvas_test_123）');
    expect(prompt).toContain('找不到就停止，不要新建或改用其他画布');
    expect(prompt).toContain('不要假装已连接');
    expect(prompt).toContain('设置 > MCP servers');
    expect(prompt).toContain('[mcp_servers.huiban]');
    expect(prompt).toContain('command = "/Users/example/My Projects/绘板/bridge/mcp-launch.sh"');
    expect(prompt).toContain('args = ["/Users/example/My Projects/绘板/bridge/dist/index.js"]');
    expect(prompt).toContain('~/.workbuddy/mcp.json');
    expect(prompt).toContain('"command": "/Users/example/My Projects/绘板/bridge/mcp-launch.sh"');
    expect(prompt).toContain('"type": "stdio"');
    expect(prompt).toContain('~/.workbuddy/.mcp.json');
    expect(prompt).toContain('保存后按提示信任并重启 WorkBuddy');
    expect(prompt).toContain('command 必须用上面的绝对路径启动脚本，不要改成 node');
    expect(prompt).toContain('不提供远程 URL');
    expect(prompt).toContain('不要编造远程地址');
  });
});
