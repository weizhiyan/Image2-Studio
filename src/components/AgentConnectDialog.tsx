import { useEffect, useRef, useState } from 'react';
import type { AgentStatus } from '@/lib/bridge';
import { buildAgentConnectPrompt } from '@/lib/agentConnectPrompt';
import AgentConnectIcon from './AgentConnectIcon';
import './AgentConnectDialog.css';

function formatSeenAt(value?: string): string {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

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
  const [copied, setCopied] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  const mcpEntry = status.mcpEntry || '<项目绝对路径>/bridge/dist/index.js';
  const canvasLabel = canvasName ? `「${canvasName}」` : '当前画布';
  const connectPrompt = buildAgentConnectPrompt({
    canvasId,
    canvasName,
    mcpEntry,
    nodeCommand: status.nodeCommand || '<项目绝对路径>/bridge/mcp-launch.sh',
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(connectPrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时保留内容供手动选择 */
    }
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
              <h2 id="agent-connect-title">连接第三方 Agent</h2>
              <p>复制下面的连接指令发给 Agent，即可操作{canvasLabel}。</p>
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

        <section className="agent-connect-config">
          <div className="agent-connect-config-head">
            <span>发给 Agent 的连接指令</span>
            <button type="button" className="agent-connect-copy" onClick={() => void copy()}>
              {copied ? '已复制' : '复制指令'}
            </button>
          </div>
        </section>
      </section>
    </div>
  );
}
