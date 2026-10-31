import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AgentConnectDialog from '../src/components/AgentConnectDialog';
import type { AgentStatus } from '../src/lib/bridge';

const AGENT_CSS = readFileSync(new URL('../src/components/AgentConnectDialog.css', import.meta.url), 'utf8');

const status: AgentStatus = {
  connected: false,
  mcpEntry: '/opt/huiban/bridge/dist/index.js',
  nodeCommand: '/opt/huiban/bridge/mcp-launch.sh',
  nodePath: '/usr/local/bin/node',
  platform: 'darwin',
};

describe('连接第三方 Agent 弹窗', () => {
  it('用 Agent 卡片展示复制入口，不展示配置内容', () => {
    const html = renderToStaticMarkup(
      <AgentConnectDialog open status={status} canvasId="canvas_1" canvasName="平面图" onClose={() => {}} />,
    );

    expect(html).toContain('让你的 Agent 直接调用绘板创作');
    for (const label of ['Claude Code', 'Codex', 'WorkBuddy', '通用 Agent']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-label="复制 Claude Code 配置"');
    expect(html).toContain('aria-label="复制 Codex 配置"');
    expect(html).toContain('aria-label="复制 WorkBuddy 配置"');
    expect(html).toContain('aria-label="复制通用 Agent 配置"');
    expect(html).not.toContain('<pre');
    expect(html).not.toContain('codex mcp add');
    expect(html).not.toContain('mcp_servers.huiban');
  });

  it('状态未就绪时禁用所有复制卡片', () => {
    const html = renderToStaticMarkup(
      <AgentConnectDialog open status={{ connected: false }} canvasId="canvas_1" canvasName="平面图" onClose={() => {}} />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(4);
  });

  it('已连接时展示连接状态', () => {
    const html = renderToStaticMarkup(
      <AgentConnectDialog open status={{ ...status, connected: true, lastSeenAt: '2026-10-29T12:00:00.000Z' }} canvasId="canvas_1" canvasName="平面图" onClose={() => {}} />,
    );
    expect(html).toContain('Agent 已连接');
  });

  it('弹窗从 40% 居中缩放并淡入，同时尊重减少动态偏好', () => {
    expect(AGENT_CSS).toMatch(/\.agent-connect-overlay\s*\{[^}]*animation:\s*fade-in/s);
    expect(AGENT_CSS).toMatch(/\.agent-connect-dialog\s*\{[^}]*--enter-scale:\s*0\.4/s);
    expect(AGENT_CSS).toMatch(/\.agent-connect-dialog\s*\{[^}]*transform-origin:\s*center/s);
    expect(AGENT_CSS).toMatch(/\.agent-connect-dialog\s*\{[^}]*animation:\s*spring-in var\(--motion-slower\) var\(--ease-emphasized\)/s);
    expect(AGENT_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.agent-connect-dialog\s*\{[^}]*animation:\s*none/s);
  });
});
