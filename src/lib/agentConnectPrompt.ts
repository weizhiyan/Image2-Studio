export interface AgentConnectInput {
  canvasId?: string;
  canvasName?: string;
  mcpEntry: string;
  nodeCommand: string;
  nodePath?: string;
  platform?: string;
}

export interface AgentConnectCodeBlock {
  id: string;
  label: string;
  code: string;
}

export interface AgentConnectOption {
  id: 'codex' | 'claude' | 'workbuddy' | 'generic';
  label: string;
  summary: string;
  note?: string;
  blocks: AgentConnectCodeBlock[];
}

function shellQuote(value: string, platform?: string): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function canvasLabel(input: AgentConnectInput): string {
  const label = input.canvasName ? `「${input.canvasName}」` : '当前画布';
  return input.canvasId ? `${label}（${input.canvasId}）` : label;
}

function nodeBinary(input: AgentConnectInput): string {
  return input.nodePath || input.nodeCommand;
}

function codexToml(input: AgentConnectInput): string {
  return [
    '[mcp_servers.huiban]',
    `command = ${JSON.stringify(nodeBinary(input))}`,
    `args = [${JSON.stringify(input.mcpEntry)}]`,
  ].join('\n');
}

function claudeJson(input: AgentConnectInput): string {
  return JSON.stringify({
    mcpServers: {
      huiban: {
        command: nodeBinary(input),
        args: [input.mcpEntry],
      },
    },
  }, null, 2);
}

function workbuddyJson(input: AgentConnectInput): string {
  const command = input.platform === 'win32'
    ? nodeBinary(input)
    : (input.nodeCommand || nodeBinary(input));
  return JSON.stringify({
    mcpServers: {
      huiban: {
        type: 'stdio',
        command,
        args: [input.mcpEntry],
      },
    },
  }, null, 2);
}

export function buildAgentConnectPrompt(input: AgentConnectInput): string {
  const command = `${shellQuote(nodeBinary(input), input.platform)} ${shellQuote(input.mcpEntry, input.platform)}`;
  return [
    `请通过绘板 MCP 操作当前画布${canvasLabel(input)}。`,
    `MCP 服务名：huiban；stdio 启动命令：${command}`,
    '先调用 huiban_canvases 核对画布；找不到就停止，不要新建或改用其他画布。',
    '工具名以 tools/list 为准（通常是 huiban_generate、huiban_canvases、huiban_nodes、huiban_locate）。',
    '如果 huiban_canvases 不可用或调用失败，请停止操作，不要假装已连接。',
  ].join('\n');
}

export function buildAgentConnectOptions(input: AgentConnectInput): AgentConnectOption[] {
  const node = nodeBinary(input);
  const command = `${shellQuote(node, input.platform)} ${shellQuote(input.mcpEntry, input.platform)}`;
  return [
    {
      id: 'codex',
      label: 'Codex',
      summary: '在终端执行一次即可；Codex 会写入 ~/.codex/config.toml。',
      note: 'ChatGPT 桌面版 / IDE 在 Settings > MCP servers 里添加 STDIO 服务，command 和 args 填上面的值。',
      blocks: [
        {
          id: 'codex-command',
          label: '终端命令',
          code: `codex mcp add huiban -- ${command}`,
        },
        {
          id: 'codex-config',
          label: '或写入 ~/.codex/config.toml',
          code: codexToml(input),
        },
      ],
    },
    {
      id: 'claude',
      label: 'Claude Code',
      summary: '在项目目录执行一次；也可以写入项目 .mcp.json。',
      note: 'Claude Code 会从 .mcp.json 读取 stdio 服务，重启会话后生效。',
      blocks: [
        {
          id: 'claude-command',
          label: '终端命令',
          code: `claude mcp add --transport stdio huiban -- ${command}`,
        },
        {
          id: 'claude-json',
          label: '或写入 .mcp.json',
          code: claudeJson(input),
        },
      ],
    },
    {
      id: 'workbuddy',
      label: 'WorkBuddy',
      summary: '保存到 ~/.workbuddy/mcp.json（不是 .mcp.json），信任并重启 WorkBuddy。',
      note: 'WorkBuddy 的 PATH 可能没有 node，command 使用绝对路径；工具名会加 huiban_ 前缀，实际名称以 tools/list 为准。',
      blocks: [
        {
          id: 'workbuddy-json',
          label: 'mcp.json',
          code: workbuddyJson(input),
        },
      ],
    },
    {
      id: 'generic',
      label: '通用',
      summary: '把这段说明和启动命令发给任意支持 stdio MCP 的 Agent。',
      note: '如果客户端给工具加了命名空间前缀，以 tools/list 里的实际名称为准。',
      blocks: [
        {
          id: 'generic-prompt',
          label: '发给 Agent 的说明',
          code: buildAgentConnectPrompt(input),
        },
      ],
    },
  ];
}
