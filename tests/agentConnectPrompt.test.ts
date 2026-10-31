import { describe, expect, it } from 'vitest';
import { buildAgentConnectOptions, buildAgentConnectPrompt } from '../src/lib/agentConnectPrompt';

const input = {
  canvasId: 'canvas_test_123',
  canvasName: '工作画布',
  mcpEntry: '/Users/example/My Projects/绘板/bridge/dist/index.js',
  nodeCommand: '/Users/example/My Projects/绘板/bridge/mcp-launch.sh',
  nodePath: '/usr/local/bin/node',
  platform: 'darwin',
};

function optionsOf(value: typeof input) {
  return Object.fromEntries(buildAgentConnectOptions(value).map((option) => [option.id, option]));
}

describe('Agent 连接指令', () => {
  it('Codex 提供可直接执行的命令和 config.toml 备选', () => {
    const codex = optionsOf(input).codex;
    const command = codex.blocks.find((block) => block.id === 'codex-command')!;
    const config = codex.blocks.find((block) => block.id === 'codex-config')!;

    expect(command.code).toBe(
      "codex mcp add huiban -- '/usr/local/bin/node' '/Users/example/My Projects/绘板/bridge/dist/index.js'",
    );
    expect(config.code).toContain('[mcp_servers.huiban]');
    expect(config.code).toContain('command = "/usr/local/bin/node"');
    expect(config.code).toContain('args = ["/Users/example/My Projects/绘板/bridge/dist/index.js"]');
    expect(codex.note).toContain('Settings > MCP servers');
  });

  it('Claude Code 提供 CLI 命令和 .mcp.json 备选', () => {
    const claude = optionsOf(input).claude;
    const command = claude.blocks.find((block) => block.id === 'claude-command')!;
    const json = claude.blocks.find((block) => block.id === 'claude-json')!;
    const config = JSON.parse(json.code);

    expect(command.code).toBe(
      "claude mcp add --transport stdio huiban -- '/usr/local/bin/node' '/Users/example/My Projects/绘板/bridge/dist/index.js'",
    );
    expect(config.mcpServers.huiban.command).toBe('/usr/local/bin/node');
    expect(config.mcpServers.huiban.args).toEqual(['/Users/example/My Projects/绘板/bridge/dist/index.js']);
  });

  it('WorkBuddy 使用启动脚本并保留命名空间提示', () => {
    const workbuddy = optionsOf(input).workbuddy;
    const config = JSON.parse(workbuddy.blocks[0].code);

    expect(config.mcpServers.huiban).toMatchObject({
      type: 'stdio',
      command: '/Users/example/My Projects/绘板/bridge/mcp-launch.sh',
      args: ['/Users/example/My Projects/绘板/bridge/dist/index.js'],
    });
    expect(workbuddy.note).toContain('huiban_');
  });

  it('通用说明包含当前画布、启动命令与工具名兜底', () => {
    const prompt = buildAgentConnectPrompt(input);
    const generic = optionsOf(input).generic;

    expect(generic.blocks[0].code).toBe(prompt);
    expect(prompt).toContain('「工作画布」（canvas_test_123）');
    expect(prompt).toContain("'/usr/local/bin/node' '/Users/example/My Projects/绘板/bridge/dist/index.js'");
    expect(prompt).toContain('先调用 huiban_canvases');
    expect(prompt).toContain('找不到就停止，不要新建或改用其他画布');
    expect(prompt).toContain('huiban_generate');
    expect(prompt).toContain('不要假装已连接');
  });

  it('Windows 下使用双引号包裹路径，WorkBuddy 直接使用 node.exe', () => {
    const windows = optionsOf({
      ...input,
      platform: 'win32',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    });
    const codexCommand = windows.codex.blocks.find((block) => block.id === 'codex-command')!;
    const workbuddy = JSON.parse(windows.workbuddy.blocks[0].code);

    expect(codexCommand.code).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(workbuddy.mcpServers.huiban.command).toBe('C:\\Program Files\\nodejs\\node.exe');
  });
});
