export interface AgentConnectPromptInput {
  canvasId?: string;
  canvasName?: string;
  mcpEntry: string;
  nodeCommand: string;
}

export function buildAgentConnectPrompt({
  canvasId,
  canvasName,
  mcpEntry,
  nodeCommand,
}: AgentConnectPromptInput): string {
  const canvasLabel = canvasName ? `「${canvasName}」` : '当前画布';
  const canvasRef = canvasId ? `${canvasLabel}（${canvasId}）` : canvasLabel;
  const config = [
    '[mcp_servers.huiban]',
    `command = ${JSON.stringify(nodeCommand)}`,
    `args = [${JSON.stringify(mcpEntry)}]`,
  ].join('\n');
  const workbuddyConfig = JSON.stringify({
    mcpServers: {
      huiban: {
        type: 'stdio',
        command: nodeCommand,
        args: [mcpEntry],
      },
    },
  }, null, 2);

  return [
    `请通过绘板 MCP 操作当前画布${canvasRef}。先调用 huiban_canvases（WorkBuddy 中实际名称是 huiban_huiban_canvases），按 ID 核对画布；找不到就停止，不要新建或改用其他画布。`,
    '确认存在后，只在这张画布上执行我的后续指令。',
    '',
    '如果 huiban_canvases 不可用或调用失败，请停止操作，不要假装已连接。',
    'WorkBuddy 会给工具名加连接器命名空间前缀，生图等工具对应 huiban_huiban_generate；以 tools/list 里的实际名称为准，不要因为找不到无前缀名字就判定未连接。',
    '',
    '若我在使用 WorkBuddy，请让我打开「专家·技能·连接器 > 连接器 > 自定义连接器 > MCP 服务管理 > 配置 MCP」，把下面 JSON 保存到编辑器里。WorkBuddy 的实际配置文件是 ~/.workbuddy/mcp.json，注意不是 ~/.workbuddy/.mcp.json。保存后按提示信任并重启 WorkBuddy：',
    workbuddyConfig,
    '',
    'WorkBuddy 启动 MCP 时 PATH 里没有 node，command 必须用上面的绝对路径启动脚本，不要改成 node。',
    '',
    '若我在使用 Codex，请告诉我到设置 > MCP servers 添加以下配置并重启：',
    config,
    '',
    '这是本机 stdio 接入，不提供远程 URL。若当前 Agent 是 ChatGPT 等托管服务，请说明它不能直接启动本机 MCP，并且不要编造远程地址。',
  ].join('\n');
}
