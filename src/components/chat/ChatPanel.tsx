import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatImageRef, ChatModelSelection } from '@/types';
import { activeThreadOf, allThreads, useChatStore } from '@/stores/chatStore';
import ChatComposer from './ChatComposer';
import ChatMessageList from './ChatMessageList';
import ClarificationModal from './ClarificationModal';
import { ChevronGlyphIcon, CloseGlyphIcon, NewThreadGlyphIcon, PencilGlyphIcon, TrashGlyphIcon } from './ChatIcons';
import './ChatPanel.css';

/** 面板宽度可调范围（方案 §5.2）。 */
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const CHAT_PANEL_ANIMATION_MS = 360;

/**
 * 对话面板（方案 §5/§6/§7）：右下角 AI 按钮 + 悬浮卡片。
 * 面板只负责界面与收集输入；起 run / 定位 / 预览等动作由 CanvasPage 接走。
 */
export default function ChatPanel({
  canvasNames,
  onSend,
  onStop,
  submitting = false,
  onLocate,
  onPreview,
  onRetry,
  onAnswerClarification,
  onWidthChange,
}: {
  /** 画布 id → 名字：历史菜单里显示最近结果落点（如有）。 */
  canvasNames: Record<string, string>;
  onSend: (text: string, refs: ChatImageRef[], modelSelection: ChatModelSelection) => void;
  /** 停止当前运行：入口只保留输入区那个，头部不再放重复按钮。 */
  onStop: () => void;
  submitting?: boolean;
  onLocate: (ref: { canvasId: string; nodeId: string; versionId?: string; force?: boolean }) => void;
  onPreview: (url: string, title: string) => void;
  onRetry: (messageId: string) => void;
  onAnswerClarification: (runId: string, callId: string, answers: Record<string, string[]> | null) => Promise<boolean>;
  onWidthChange?: (width: number) => void;
}) {
  const open = useChatStore((state) => state.open);
  const setOpen = useChatStore((state) => state.setOpen);
  const unread = useChatStore((state) => state.unread);
  const activeCanvasId = useChatStore((state) => state.activeCanvasId);
  const thread = useChatStore(activeThreadOf);
  const threads = useChatStore(allThreads);
  const activeRun = useChatStore((state) => state.activeRun);
  const threadRun = activeRun && activeRun.threadId === thread?.id ? activeRun : null;
  const pendingClarification = thread?.messages
    .flatMap((message) => message.clarifications || [])
    .find((item) => item.status === 'awaiting_input') || null;

  const [historyOpen, setHistoryOpen] = useState(false);
  const [renamingId, setRenamingId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [width, setWidth] = useState(360);
  const headerRef = useRef<HTMLElement>(null);

  const closePanel = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    setOpen(false);
  }, [leaving, setOpen]);

  useEffect(() => {
    onWidthChange?.(width);
  }, [onWidthChange, width]);

  // 收起动画播完再真正卸载：期间面板不拦截画布点击
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => {
      setLeaving(false);
    }, CHAT_PANEL_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  // 菜单外点击 / Escape 关闭历史菜单（方案 §7）
  useEffect(() => {
    if (!historyOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) {
        setHistoryOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHistoryOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [historyOpen]);

  // 左缘拖拽调宽
  const onResizeStart = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (move: PointerEvent) => {
      const next = startWidth - (move.clientX - startX);
      const nextWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next));
      setWidth(nextWidth);
      onWidthChange?.(nextWidth);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const canvasNameOf = (canvasId?: string): string => {
    const id = typeof canvasId === 'string' ? canvasId.trim() : '';
    return id && id !== '[object Object]' ? (canvasNames[id] || id) : '独立对话';
  };

  if (!open && !leaving) {
    return (
      <>
        <button
          type="button"
          className="hb-chat-fab"
          onClick={() => setOpen(true)}
          title="AI 对话"
          aria-label="打开 AI 对话"
        >
          <svg width="17" height="16" viewBox="0 0 17 16" fill="none" aria-hidden="true">
            <path d="M6.93741 2.07165C7.09267 2.07154 7.24339 2.12398 7.36505 2.22045C7.4867 2.31691 7.57212 2.45171 7.60741 2.6029V2.60415L7.60866 2.6079L7.61366 2.62915L7.63616 2.71915C7.76347 3.20801 7.91491 3.69027 8.08991 4.16415C8.41991 5.05415 8.87491 5.9979 9.41116 6.5354C9.94866 7.0729 10.8924 7.52665 11.7824 7.85665C12.2563 8.03162 12.7386 8.18305 13.2274 8.3104L13.3174 8.3329L13.3387 8.3379H13.3424C13.4937 8.37317 13.6287 8.45857 13.7253 8.58023C13.822 8.70189 13.8747 8.85265 13.8748 9.00803C13.875 9.16341 13.8226 9.31427 13.7261 9.43611C13.6297 9.55795 13.4949 9.6436 13.3437 9.67915H13.3424L13.3387 9.6804L13.3162 9.6854L13.2287 9.7079C12.7398 9.83525 12.2576 9.98668 11.7837 10.1617C10.8924 10.4917 9.94866 10.9466 9.41116 11.4841C8.87366 12.0216 8.41991 12.9642 8.08991 13.8542C7.91494 14.3281 7.7635 14.8103 7.63616 15.2992L7.61366 15.3892L7.60866 15.4104V15.4142C7.57339 15.5655 7.48799 15.7004 7.36633 15.7971C7.24467 15.8937 7.09391 15.9464 6.93853 15.9466C6.78315 15.9467 6.63229 15.8943 6.51045 15.7979C6.38861 15.7015 6.30296 15.5667 6.26741 15.4154V15.4142L6.26616 15.4104L6.26116 15.3879L6.23866 15.3004C6.11132 14.8116 5.95988 14.3293 5.78491 13.8554C5.45491 12.9642 4.99991 12.0204 4.46366 11.4829C3.92616 10.9454 2.98241 10.4917 2.09241 10.1617C1.61852 9.98665 1.13627 9.83522 0.647409 9.7079L0.557409 9.68415L0.537409 9.6804H0.532409C0.381086 9.64513 0.246134 9.55973 0.149479 9.43807C0.0528243 9.31641 0.000145107 9.16565 2.99341e-07 9.01027C-0.000144509 8.85489 0.0522536 8.70403 0.148682 8.58219C0.24511 8.46035 0.379902 8.3747 0.531159 8.33915H0.532409L0.536159 8.3379L0.557409 8.3329L0.647409 8.3104C1.13627 8.18308 1.61852 8.03165 2.09241 7.85665C2.98241 7.52665 3.92616 7.07165 4.46366 6.5354C5.00116 5.9979 5.45491 5.05415 5.78491 4.16415C5.95991 3.69027 6.11134 3.20801 6.23866 2.71915L6.26116 2.62915L6.26616 2.6079V2.60415C6.30145 2.45262 6.38701 2.31751 6.5089 2.22082C6.63079 2.12412 6.78183 2.07155 6.93741 2.07165ZM13.6183 1.04961e-07C13.7111 -6.62162e-05 13.8013 0.0312988 13.874 0.0889897C13.9468 0.146681 13.9979 0.2273 14.019 0.317725V0.31922L14.0205 0.325949L14.0279 0.355852L14.0601 0.471728C14.0885 0.571158 14.1304 0.707966 14.1857 0.858231C14.303 1.17446 14.4571 1.48321 14.623 1.64918C14.789 1.81514 15.0977 1.96915 15.414 2.08652C15.5787 2.14739 15.7464 2.20004 15.9163 2.24426L15.9462 2.25174L15.953 2.25323H15.9545C16.0451 2.27409 16.126 2.32507 16.184 2.39785C16.2419 2.47063 16.2735 2.56091 16.2735 2.65394C16.2735 2.74697 16.2419 2.83724 16.184 2.91003C16.126 2.98281 16.0451 3.03379 15.9545 3.05465H15.953L15.9462 3.05614L15.9163 3.06362C15.7464 3.10759 15.5787 3.15999 15.414 3.22061C15.0977 3.33873 14.789 3.49273 14.623 3.6587C14.4571 3.82466 14.303 4.13341 14.1857 4.44964C14.1249 4.6144 14.0722 4.78207 14.0279 4.95202L14.0205 4.98193L14.019 4.9894C13.9982 5.08008 13.9473 5.16104 13.8746 5.21905C13.8018 5.27705 13.7116 5.30868 13.6186 5.30877C13.5255 5.30886 13.4352 5.27739 13.3624 5.21952C13.2895 5.16165 13.2385 5.08079 13.2176 4.99015V4.98866L13.2161 4.98193L13.2086 4.95202C13.1646 4.78208 13.1122 4.61442 13.0516 4.44964C12.9335 4.13341 12.7795 3.82466 12.6135 3.6587C12.4475 3.49273 12.1388 3.33873 11.8226 3.22136C11.6578 3.16048 11.4901 3.10783 11.3202 3.06362L11.2903 3.05614L11.2835 3.05465H11.282C11.1914 3.03379 11.1105 2.98281 11.0525 2.91003C10.9946 2.83724 10.9631 2.74697 10.9631 2.65394C10.9631 2.56091 10.9946 2.47063 11.0525 2.39785C11.1105 2.32507 11.1914 2.27409 11.282 2.25323H11.2835L11.2903 2.25174L11.3202 2.24426L11.436 2.21211C11.5355 2.18371 11.6723 2.14184 11.8226 2.08652C12.1388 1.96915 12.4475 1.81514 12.6135 1.64918C12.7795 1.48321 12.9335 1.17446 13.0508 0.858231C13.1117 0.693473 13.1643 0.525808 13.2086 0.355852L13.2161 0.325949L13.2176 0.31922V0.317725C13.2387 0.2273 13.2897 0.146681 13.3625 0.0889897C13.4353 0.0312988 13.5254 -6.62162e-05 13.6183 1.04961e-07Z" fill="currentColor" />
          </svg>
          <span className="hb-chat-fab-label">与 AI 对话</span>
          {unread ? <span className="hb-chat-fab-dot" aria-hidden="true" /> : null}
        </button>
      </>
    );
  }

  return (
    <aside
      className={`hb-chat-panel ${leaving ? 'is-leaving' : ''}`}
      style={{ ['--hb-chat-width' as string]: `${width}px` }}
      aria-label="AI 对话"
    >
      <div
        className="hb-chat-resize"
        role="separator"
        aria-orientation="vertical"
        title="拖拽调整宽度"
        onPointerDown={onResizeStart}
      />
      <header className="hb-chat-header" ref={headerRef}>
        <button
          type="button"
          className="hb-chat-title-btn"
          aria-expanded={historyOpen}
          onClick={() => {
            setHistoryOpen((value) => {
              const next = !value;
              if (!next) setRenamingId('');
              return next;
            });
          }}
        >
            <strong>{thread?.title || '新对话'}</strong>
          <span>{canvasNameOf(activeCanvasId)}</span>
          <ChevronGlyphIcon up={historyOpen} />
        </button>
        <div className="hb-chat-actions">
          <button
            type="button"
            className="hb-chat-action"
            title="收起对话"
            aria-label="收起对话"
            onClick={closePanel}
          >
            <CloseGlyphIcon />
          </button>
        </div>
        {historyOpen ? (
          <div className="hb-chat-thread-menu" role="menu" aria-label="历史对话">
            <button
              type="button"
              className="hb-chat-thread-new"
              role="menuitem"
              onClick={() => {
                useChatStore.getState().createThread(activeCanvasId);
                setRenamingId('');
                setHistoryOpen(false);
              }}
            >
              <NewThreadGlyphIcon />
              新建对话
            </button>
            <div className="hb-chat-thread-list">
              {threads.length === 0 ? (
                <p className="hb-chat-menu-empty">还没有历史对话，发一句话就自动开一条</p>
              ) : threads.map((item) => (
                <div key={item.id} className={`hb-chat-thread-row ${renamingId === item.id ? 'is-renaming' : ''}`}>
                  {renamingId === item.id ? (
                    <div className="hb-chat-thread-rename">
                      <input
                        value={renameValue}
                        autoFocus
                        aria-label="对话新标题"
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            useChatStore.getState().renameThread(item.id, renameValue);
                            setRenamingId('');
                          } else if (event.key === 'Escape') {
                            setRenamingId('');
                          }
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          useChatStore.getState().renameThread(item.id, renameValue);
                          setRenamingId('');
                        }}
                      >
                        保存
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={`hb-chat-thread-item-main ${item.id === thread?.id ? 'is-active' : ''}`}
                        role="menuitem"
                        onClick={() => {
                          useChatStore.getState().switchThread(item.id);
                          setHistoryOpen(false);
                        }}
                      >
                        <strong>{item.title}</strong>
                        <span>
                          {typeof item.canvasId === 'string' && item.canvasId.trim() ? `${canvasNameOf(item.canvasId)} · ` : ''}{formatTime(item.updatedAt)}
                          {item.messages.length > 0 ? ` · ${item.messages.length} 条消息` : ''}
                        </span>
                      </button>
                      <div className="hb-chat-thread-actions" aria-label={`对话「${item.title}」的操作`}>
                        <button
                          type="button"
                          className="hb-chat-thread-action-button"
                          title="编辑对话名称"
                          aria-label={`编辑对话「${item.title}」名称`}
                          onClick={() => {
                            setRenamingId(item.id);
                            setRenameValue(item.title);
                          }}
                        >
                          <PencilGlyphIcon />
                        </button>
                        <button
                          type="button"
                          className="hb-chat-thread-action-button is-danger"
                          title="删除对话"
                          aria-label={`删除对话「${item.title}」`}
                          onClick={() => useChatStore.getState().deleteThread(item.id)}
                        >
                          <TrashGlyphIcon />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </header>
      <div className="hb-chat-panel-body">
        <ChatMessageList
          onLocate={onLocate}
          onPreview={onPreview}
          onRetry={onRetry}
        />
        {pendingClarification && threadRun ? (
          <ClarificationModal
            request={pendingClarification}
            onSubmit={(answers) => onAnswerClarification(threadRun.runId, pendingClarification.callId, answers)}
            onCancel={() => onAnswerClarification(threadRun.runId, pendingClarification.callId, null)}
          />
        ) : (
          <ChatComposer onSend={onSend} onStop={onStop} running={Boolean(threadRun)} submitting={submitting} />
        )}
      </div>
    </aside>
  );
}

/** 历史菜单里的更新时间：今天显示时刻，否则显示日期。 */
function formatTime(iso: string): string {
  const time = Date.parse(String(iso || ''));
  if (!Number.isFinite(time)) return '未知时间';
  const date = new Date(time);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const pad = (value: number) => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameDay ? clock : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
