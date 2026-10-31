import { useEffect, useRef, useState } from 'react';
import type { AgentStatus } from '@/lib/bridge';
import { buildAgentConnectOptions, type AgentConnectOption } from '@/lib/agentConnectPrompt';
import AgentBrandIcon from './AgentBrandIcon';
import AgentConnectIcon from './AgentConnectIcon';
import './AgentConnectDialog.css';

function formatSeenAt(value?: string): string {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 剪贴板 API 不可用时回落到选区复制 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

function CopyGlyph({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3.2 8.4 6.4 11.6 12.8 4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.6" y="2.2" width="8.2" height="9.6" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.4 13.8H5a2 2 0 0 1-2-2V6.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

const PRIMARY_ORDER: AgentConnectOption['id'][] = ['claude', 'codex', 'workbuddy'];

const COPY_HINTS: Record<AgentConnectOption['id'], string> = {
  claude: '已复制 Claude Code 命令，在项目目录执行后重启会话。',
  codex: '已复制 Codex 命令，在终端执行即可。',
  workbuddy: '已复制 WorkBuddy 配置，保存到 ~/.workbuddy/mcp.json 后重启。',
  generic: '已复制通用连接指令，直接发给 Agent 即可。',
};

export default function AgentConnectDialog({
  open,
  status,
  canvasId,
  canvasName,
  onClose,
}: {
  open: boolean;
  status: AgentStatus;
  canvasId?: string;
  canvasName?: string;
  onClose: () => void;
}) {
  const [copiedId, setCopiedId] = useState('');
  const [copyError, setCopyError] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    setCopiedId('');
    setCopyError('');
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(copyTimerRef.current);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const ready = Boolean(status.mcpEntry && (status.nodePath || status.nodeCommand));
  const options = buildAgentConnectOptions({
    canvasId,
    canvasName,
    mcpEntry: status.mcpEntry || '',
    nodeCommand: status.nodeCommand || '',
    nodePath: status.nodePath,
    platform: status.platform,
  });
  const byId = new Map(options.map((option) => [option.id, option]));
  const primary = PRIMARY_ORDER.map((id) => byId.get(id)).filter((option): option is AgentConnectOption => Boolean(option));
  const generic = byId.get('generic');

  const copy = async (option: AgentConnectOption) => {
    const payload = option.blocks[0]?.code;
    if (!payload || !ready) return;
    const copied = await copyText(payload);
    if (!copied) {
      setCopiedId('');
      setCopyError('复制失败，请手动复制。');
      return;
    }
    setCopyError('');
    setCopiedId(option.id);
    window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopiedId(''), 2000);
  };

  return (
    <div className="agent-connect-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="agent-connect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-connect-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="agent-connect-dialog-header">
          <div className="agent-connect-dialog-heading">
            <span className={`agent-connect-dialog-icon${status.connected ? ' is-connected' : ''}`}>
              <AgentConnectIcon size={18} />
            </span>
            <div>
              <h2 id="agent-connect-title">让你的 Agent 直接调用绘板创作</h2>
              <p>连接绘板的 MCP，Agent 就能直接使用画布与生图工具。点击对应卡片复制配置。</p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="agent-connect-dialog-close"
            aria-label="关闭连接说明"
            onClick={onClose}
          >×</button>
        </header>

        <div className={`agent-connect-status${status.connected ? ' is-connected' : ''}`} role="status">
          <span className="agent-connect-status-dot" aria-hidden="true" />
          <span>
            {status.connected
              ? `Agent 已连接${status.lastSeenAt ? ` · ${formatSeenAt(status.lastSeenAt)}` : ''}`
              : '等待 Agent 连接'}
          </span>
        </div>

        <div className="agent-connect-agents">
          {primary.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`agent-connect-agent${copiedId === option.id ? ' is-copied' : ''}`}
              aria-label={`复制 ${option.label} 配置`}
              disabled={!ready}
              onClick={() => void copy(option)}
            >
              <span className={`agent-connect-agent-icon is-${option.id}`} aria-hidden="true">
                <AgentBrandIcon kind={option.id} />
              </span>
              <span className="agent-connect-agent-label">{option.label}</span>
              <span className="agent-connect-agent-copy" aria-hidden="true">
                <CopyGlyph copied={copiedId === option.id} />
              </span>
            </button>
          ))}
        </div>

        {generic ? (
          <section className="agent-connect-other" aria-label="其他 Agent">
            <span className="agent-connect-other-title">在其他 Agent 中使用绘板 MCP</span>
            <button
              type="button"
              className={`agent-connect-agent is-generic${copiedId === generic.id ? ' is-copied' : ''}`}
              aria-label="复制通用 Agent 配置"
              disabled={!ready}
              onClick={() => void copy(generic)}
            >
              <span className="agent-connect-agent-icon is-generic" aria-hidden="true">
                <AgentBrandIcon kind="generic" />
              </span>
              <span className="agent-connect-agent-label">通用 Agent</span>
              <span className="agent-connect-agent-hint">复制连接指令</span>
              <span className="agent-connect-agent-copy" aria-hidden="true">
                <CopyGlyph copied={copiedId === generic.id} />
              </span>
            </button>
          </section>
        ) : null}

        {copyError ? <p className="agent-connect-feedback is-error" role="alert">{copyError}</p> : null}
        {!copyError && copiedId ? (
          <p className="agent-connect-feedback is-copied" role="status">{COPY_HINTS[copiedId as AgentConnectOption['id']]}</p>
        ) : null}
      </section>
    </div>
  );
}
