import { useEffect, useRef, useState } from 'react';
import type { CanvasDoc } from '@/types';
import { ChevronIcon, EditIcon, TrashIcon } from '@/components/canvas/NodeChrome';
import AgentConnectDialog from '@/components/AgentConnectDialog';
import AgentConnectIcon from '@/components/AgentConnectIcon';
import AppModeTabs from '@/components/AppModeTabs';
import { getAgentStatus, type AgentStatus } from '@/lib/bridge';

interface TopBarProps {
  canvases: CanvasDoc[];
  activeId: string;
  settingsOpen: boolean;
  /** 智能生成开关的兼容值：true = Image API；false = Responses API。 */
  direct: boolean;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  /** 重命名指定画布：顶栏名称按钮改当前画布，菜单行的编辑icon改任意画布 */
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onToggleSettings: () => void;
}

/** 画布选择器：灵枢 TopNav 的 top-nav-workflow-* / workflow-menu-* 结构原样照搬。 */
export default function TopBar({
  canvases,
  activeId,
  settingsOpen,
  direct,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
  onToggleSettings,
}: TopBarProps) {
  const active = canvases.find((doc) => doc.id === activeId) || canvases[0];
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menuEditingId, setMenuEditingId] = useState('');
  const [nameDraft, setNameDraft] = useState(active?.name || '');
  const [deleteTarget, setDeleteTarget] = useState<CanvasDoc | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ connected: false });
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNameDraft(active?.name || '');
  }, [active?.id, active?.name]);

  // 点外面收起（灵枢同款）
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
        setMenuEditingId('');
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!deleteTarget) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDeleteTarget(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteTarget]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const next = await getAgentStatus();
        if (alive) setAgentStatus(next);
      } catch {
        if (alive) setAgentStatus({ connected: false });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    const targetId = menuEditingId || active?.id || '';
    const targetName = canvases.find((doc) => doc.id === targetId)?.name || '';
    if (trimmed && trimmed !== targetName) onRename(targetId, trimmed);
    else setNameDraft(targetName);
    setEditing(false);
    setMenuEditingId('');
  };

  return (
    <header className="hb-topbar">
      <AppModeTabs mode="canvas" />
      <div className="top-nav-workflow-wrap" ref={wrapRef}>
        <div className="top-nav-workflow-control">
          {editing ? (
            <input
              className="top-nav-workflow-input"
              value={nameDraft}
              aria-label="画布名称"
              autoFocus
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  setNameDraft(active?.name || '');
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="top-nav-workflow-name"
              title="重命名画布"
              onClick={() => {
                setMenuEditingId('');
                setEditing(true);
              }}
            >
              <span>{active?.name || '未命名画布'}</span>
            </button>
          )}
          <button
            type="button"
            className={`top-nav-workflow-menu-btn ${menuOpen ? 'open' : ''}`}
            onClick={() => setMenuOpen((open) => !open)}
            title="切换画布"
            aria-label="切换画布"
            aria-expanded={menuOpen}
          >
            <ChevronIcon />
          </button>
        </div>

        {menuOpen ? (
          <div className="workflow-menu" role="menu">
            <button
              type="button"
              className="workflow-menu-new"
              onClick={() => {
                setMenuOpen(false);
                onCreate();
              }}
            >
              新建画布
            </button>
            <div className="workflow-menu-list">
              {canvases.map((doc) => (
                <div
                  key={doc.id}
                  className={`workflow-menu-item ${doc.id === active?.id ? 'active' : ''} ${menuEditingId === doc.id ? 'is-editing' : ''}`}
                >
                  {menuEditingId === doc.id ? (
                    <input
                      className="workflow-menu-item-input"
                      value={nameDraft}
                      aria-label={`重命名画布 ${doc.name}`}
                      autoFocus
                      onChange={(event) => setNameDraft(event.target.value)}
                      onBlur={commitName}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        if (event.key === 'Escape') {
                          setNameDraft(doc.name);
                          setMenuEditingId('');
                        }
                        event.stopPropagation();
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="workflow-menu-item-main"
                      title={doc.name}
                      onClick={() => {
                        setMenuOpen(false);
                        onSwitch(doc.id);
                      }}
                    >
                      <span>{doc.name}</span>
                    </button>
                  )}
                  {/* 悬停这一行才浮出：重命名 + 删除。重命名就是顶栏名称那套逻辑，换个触发入口 */}
                  <div className="workflow-menu-item-actions">
                    <button
                      type="button"
                      className="workflow-menu-edit"
                      title="重命名画布"
                      aria-label={`重命名画布 ${doc.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setNameDraft(doc.name);
                        setMenuEditingId(doc.id);
                      }}
                    >
                      <EditIcon />
                    </button>
                    {canvases.length > 1 ? (
                      <button
                        type="button"
                        className="workflow-menu-delete"
                        title="删除画布"
                        aria-label={`删除画布 ${doc.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpen(false);
                          setDeleteTarget(doc);
                        }}
                      >
                        <TrashIcon />
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {deleteTarget ? (
        <div className="canvas-delete-confirm-overlay" role="presentation" onMouseDown={() => setDeleteTarget(null)}>
          <section
            className="canvas-delete-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="canvas-delete-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <strong id="canvas-delete-confirm-title">删除画布？</strong>
            <p>「{deleteTarget.name}」中的节点、连线和生成记录会从当前工作区移除。</p>
            <div className="canvas-delete-confirm-actions">
              <button type="button" onClick={() => setDeleteTarget(null)}>取消</button>
              <button
                type="button"
                className="is-danger"
                onClick={() => {
                  onDelete(deleteTarget.id);
                  setDeleteTarget(null);
                }}
              >删除画布</button>
            </div>
          </section>
        </div>
      ) : null}
      <div className="hb-topbar-spacer" />
      {/* 生图模式弱化提示：只读状态，切换在生成节点的工具栏里 */}
      <span
        className={`image-canvas-mode-hint ${direct ? 'is-direct' : 'is-enhance'}`}
        title={direct ? '直连生图：使用 Image API。可在生成节点工具栏打开「智能生成」' : '智能生成：使用 Responses API，由主模型理解上下文并支持连续编辑'}
      >
        {direct ? '直连生图 · Image API' : '智能生成 · Responses API'}
      </span>
      <button
        type="button"
        className={`agent-connect-btn${agentStatus.connected ? ' is-connected' : ''}`}
        aria-label={agentStatus.connected ? 'Agent 已连接，查看连接说明' : '连接第三方 Agent'}
        aria-haspopup="dialog"
        aria-expanded={agentOpen}
        onClick={() => {
          setAgentOpen(true);
          void getAgentStatus().then(setAgentStatus).catch(() => setAgentStatus({ connected: false }));
        }}
      >
        <AgentConnectIcon />
        <span className="agent-connect-btn-dot" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="image-canvas-btn"
        aria-pressed={settingsOpen}
        onClick={onToggleSettings}
      >
        模型设置
      </button>
      <AgentConnectDialog
        open={agentOpen}
        status={agentStatus}
        canvasId={active?.id}
        canvasName={active?.name}
        onClose={() => setAgentOpen(false)}
      />
    </header>
  );
}
