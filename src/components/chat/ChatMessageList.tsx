import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { activeThreadOf, useChatStore } from '@/stores/chatStore';
import type { ChatAskResponseSummary, ChatMessage, ChatToolCall } from '@/types';
import { chatInlineSegments } from '@/lib/chatInlineRefs';
import { CopyGlyphIcon, CopySuccessGlyphIcon, FoldGlyphIcon, IdGlyphIcon, LocateGlyphIcon, RetryGlyphIcon } from './ChatIcons';
import { AiGlyphIcon } from '@/components/canvas/NodeToolbarIcons';
import './ChatPanel.css';

/* ── 基础 Markdown（段落 / 列表 / 引用 / 代码块 / 行内代码与加粗）── */

/** 行内语法：`代码` 与 **加粗**。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(<code key={`${keyPrefix}-c${index}`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`${keyPrefix}-b${index}`}>{token.slice(2, -2)}</strong>);
    }
    index += 1;
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function MarkdownText({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = String(text || '').split('\n');
    const out: ReactNode[] = [];
    let paragraph: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    let quote: string[] = [];
    let code: string[] | null = null;
    let key = 0;

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      out.push(<p key={`p${key++}`}>{renderInline(paragraph.join(' '), `p${key}`)}</p>);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      const items = list.items.map((item, index) => <li key={`li${key}-${index}`}>{renderInline(item, `li${key}-${index}`)}</li>);
      out.push(list.ordered ? <ol key={`l${key++}`}>{items}</ol> : <ul key={`l${key++}`}>{items}</ul>);
      list = null;
    };
    const flushQuote = () => {
      if (quote.length === 0) return;
      out.push(<blockquote key={`q${key++}`}>{renderInline(quote.join(' '), `q${key}`)}</blockquote>);
      quote = [];
    };
    const flushCode = () => {
      if (!code) return;
      out.push(<pre key={`pre${key++}`}><code>{code.join('\n')}</code></pre>);
      code = null;
    };

    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (code) flushCode();
        else {
          flushParagraph();
          flushList();
          flushQuote();
          code = [];
        }
        continue;
      }
      if (code) {
        code.push(line);
        continue;
      }
      const heading = line.match(/^\s*(#{1,3})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        flushQuote();
        out.push(<p key={`h${key++}`}><strong>{renderInline(heading[2], `h${key}`)}</strong></p>);
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const ordered = line.match(/^\s*\d+[.、]\s*(.*)$/);
      if (bullet || ordered) {
        flushParagraph();
        flushQuote();
        if (!list || list.ordered !== Boolean(ordered)) {
          flushList();
          list = { ordered: Boolean(ordered), items: [] };
        }
        list.items.push((bullet || ordered)![1]);
        continue;
      }
      const quoteMatch = line.match(/^\s*>\s?(.*)$/);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        quote.push(quoteMatch[1]);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        flushQuote();
        continue;
      }
      flushList();
      flushQuote();
      paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
    flushQuote();
    flushCode();
    return out;
  }, [text]);
  return <div className="hb-chat-text">{blocks}</div>;
}

/* ── 工具调用过程卡 ── */

function contextLabel(context?: ChatMessage['context']): string {
  if (!context) return '';
  if (context.resetReason) return `上下文已重置：${context.resetReason}`;
  if (context.baseVersionId && context.responseId) {
    return context.referenceCount > 0
      ? `已续接上一轮上下文 · 参考图 ${context.referenceCount} 张`
      : '已续接上一轮上下文';
  }
  if (context.referenceCount > 0) return `参考图 ${context.referenceCount} 张 · 全新上下文`;
  return '全新上下文';
}

/** 工具参数摘要：只露关键字段，完整 JSON 在展开态里看。 */
function argsSummary(args: Record<string, unknown>): string {
  const prompt = String(args.prompt || '').trim();
  const bits: string[] = [];
  if (prompt) bits.push(prompt.length > 30 ? `${prompt.slice(0, 30)}…` : prompt);
  const count = Number(args.count) || 0;
  if (count > 1) bits.push(`${count} 张`);
  const refs = Array.isArray(args.referenceImages) ? args.referenceImages.length : 0;
  if (refs > 0) bits.push(`参考图 ${refs} 张`);
  if (args.referenceUsage === 'edit') bits.push('图生图');
  const ratio = String(args.ratio || '').trim();
  if (ratio) bits.push(ratio);
  return bits.join(' · ');
}

function formatDuration(ms?: number): string {
  if (!Number.isFinite(ms) || (ms as number) < 0) return '';
  const seconds = (ms as number) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function useElapsed(startedAt?: string, active = false, finalMs?: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  if (finalMs !== undefined) return formatDuration(finalMs);
  const start = Date.parse(String(startedAt || ''));
  if (!Number.isFinite(start)) return '0.0s';
  return formatDuration(Math.max(0, now - start));
}

async function copyTextWithFallback(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 局域网 HTTP 页面通常没有 Clipboard API，继续走同步降级路径。
  }
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

/** 复制到剪贴板 + 1.6s「已复制」反馈：兼容 localhost 与局域网 HTTP 页面。 */
function useCopyFeedback(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const copy = (text: string) => {
    void copyTextWithFallback(text).then((success) => {
      if (!success) return;
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1600);
    });
  };
  return [copied, copy];
}

function ToolCallCard({ call, onRetry }: { call: ChatToolCall; onRetry?: () => void }) {
  const [open, setOpen] = useState(call.status === 'error');
  // 失败自动展开：卡片常先以 running 挂载（消息 append 时 toolCalls 还是空的或 running），
  // error 是 tool_finished 后到的事件，useState 初值抓不到——不同步的话折叠态只有卡外一行红字
  useEffect(() => {
    if (call.status === 'error') setOpen(true);
  }, [call.status]);
  const statusText = call.status === 'running' ? '进行中' : call.status === 'error' ? '失败' : call.status === 'stopped' ? '已停止' : '已完成';
  const summary = argsSummary(call.args);
  const elapsed = useElapsed(call.startedAt, call.status === 'running', call.durationMs);
  return (
    <div className="hb-chat-tool">
      <button
        type="button"
        className="hb-chat-tool-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <FoldGlyphIcon open={open} />
        <span className="hb-chat-tool-head-text">
          调用生图 · {call.status === 'running' ? '生成中' : statusText}
          {call.model ? ` · ${call.model}` : ''}
          {summary ? ` · ${summary}` : ''}
        </span>
        <span className={`hb-chat-tool-status ${call.status === 'error' ? 'is-error' : ''}`}>{statusText}</span>
      </button>
      {/* 失败原因常驻在卡外：折叠态也看得到，不再要求用户先展开才能发现报错 */}
      {call.status === 'error' && call.error ? (
        <div className="hb-chat-error hb-chat-error-pinned">{call.error}</div>
      ) : null}
      {open ? (
        <div className="hb-chat-tool-body">
          <div className="hb-chat-tool-args">{JSON.stringify(call.args, null, 2)}</div>
          {call.steps.length > 0 ? (
            <ol className="hb-chat-tool-steps">
              {call.steps.map((step, index) => <li key={`${call.id}-s${index}`}>{step}</li>)}
            </ol>
          ) : null}
          {call.profileName || call.model || call.size || elapsed ? (
            <div className="hb-chat-tool-meta">
              {call.profileName ? <span>配置：{call.profileName}</span> : null}
              {call.model ? <span>模型：{call.model}</span> : null}
              {call.size ? <span>尺寸：{call.size}</span> : null}
              {elapsed ? <span>耗时：{elapsed}</span> : null}
            </div>
          ) : null}
          {call.status === 'error' && onRetry ? (
            <button type="button" className="hb-chat-tool-retry" onClick={onRetry}>
              <RetryGlyphIcon />
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      {call.status === 'running' ? (
        <div className="hb-chat-generation-stage" role="status" aria-label="正在生成图片">
          <div className="hb-chat-generation-matrix" aria-hidden="true">
            <span className="image-node-running-dots" />
            <span className="image-node-running-glow" />
          </div>
          <div className="hb-chat-generation-meta">
            {call.size ? <span>{call.size}</span> : null}
            <span>{elapsed}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AskResponseCard({ response }: { response: ChatAskResponseSummary }) {
  const [expanded, setExpanded] = useState(false);
  const totalAnswers = response.questions.reduce((sum, question) => sum + question.answers.length, 0);
  return (
    <div className={`hb-chat-ask-response ${expanded ? 'is-expanded' : ''}`}>
      <button
        type="button"
        className="hb-chat-ask-response-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="hb-chat-ask-response-mark" aria-hidden="true">?</span>
        <span className="hb-chat-ask-response-title">
          <strong>{response.title}</strong>
          <small>{response.questions.length} 个问题 · {totalAnswers} 个选择</small>
        </span>
        <FoldGlyphIcon open={expanded} />
      </button>
      {expanded ? (
        <div className="hb-chat-ask-response-body">
          {response.questions.map((question) => (
            <div className="hb-chat-ask-response-question" key={question.id}>
              <strong>{question.title}</strong>
              <div className="hb-chat-ask-response-answer-list">
                {question.answers.map((answer) => <span key={answer}>{answer}</span>)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UserMessageContent({
  message,
  onLocate,
}: {
  message: ChatMessage;
  onLocate: (ref: { canvasId: string; nodeId: string; versionId?: string; force?: boolean }) => void;
}) {
  const attachments = message.attachments || [];
  const usesInlineRefs = attachments.some((attachment) => attachment.position !== undefined);
  const showLegacyAttachmentList = attachments.length > 0 && !usesInlineRefs;
  return (
    <>
      {showLegacyAttachmentList ? (
        <div className="hb-chat-msg-attachments" aria-label="引用的图片">
          {attachments.map((attachment, index) => (
            <button
              type="button"
              className="hb-chat-msg-attachment"
              key={`${attachment.nodeId}-${index}`}
              title="定位到画布上的这张图"
              aria-label={`定位到 ${attachment.title || `图 ${index + 1}`}`}
              onClick={() => onLocate({ canvasId: attachment.canvasId, nodeId: attachment.nodeId, versionId: attachment.versionId, force: true })}
            >
              <img src={attachment.url || ''} alt={attachment.title || `图 ${index + 1}`} />
              <em>{attachment.title || `图 ${index + 1}`}</em>
              <span className="hb-chat-msg-attachment-preview" aria-hidden="true">
                <img src={attachment.url || ''} alt="" />
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {message.askResponse ? <AskResponseCard response={message.askResponse} /> : null}
      {!message.askResponse && (message.content || usesInlineRefs) ? (
        <div className="hb-chat-user-copy">
          {usesInlineRefs
            ? chatInlineSegments(message.content, attachments).map((segment, index) => segment.type === 'text' ? (
              <span key={`text-${index}`}>{segment.text}</span>
            ) : (
              <button
                type="button"
                className="hb-chat-msg-inline-ref"
                key={`ref-${segment.reference.nodeId}-${index}`}
                title="定位到画布上的这张图"
                aria-label={`定位到 ${segment.reference.title || '引用图片'}`}
                onClick={() => onLocate({
                  canvasId: segment.reference.canvasId,
                  nodeId: segment.reference.nodeId,
                  versionId: segment.reference.versionId,
                  force: true,
                })}
              >
                <img src={segment.reference.url || ''} alt="" />
                <span>{segment.reference.title || '图片'}</span>
              </button>
            ))
            : message.content}
        </div>
      ) : null}
    </>
  );
}

/* ── 消息行 ── */

/** 消息定位串：用户报 bug 时复制它，AI 拿着就能定位到是哪条消息。 */
function messageLocator(message: ChatMessage, threadId: string): string {
  return [
    `对话ID: ${threadId}`,
    `消息ID: ${message.id}`,
    `角色: ${message.role === 'user' ? '用户' : 'AI'}`,
    `时间: ${message.createdAt}`,
  ].join('\n');
}

function MessageRow({
  message,
  onLocate,
  onPreview,
  onRetry,
}: {
  message: ChatMessage;
  onLocate: (ref: { canvasId: string; nodeId: string; versionId?: string; force?: boolean }) => void;
  onPreview: (url: string, title: string) => void;
  onRetry: (messageId: string) => void;
}) {
  const thread = useChatStore(activeThreadOf);
  const [copied, copyText] = useCopyFeedback();
  const [copiedId, copyIdText] = useCopyFeedback();
  const copyMessageId = (target: ChatMessage) => copyIdText(messageLocator(target, thread?.id || ''));
  /** 生图失败汇总：agent 常用文字兜底回复，错误不能只躺在折叠的工具卡里。 */
  const failedCalls = (message.toolCalls || []).filter((call) => call.status === 'error');

  if (message.role === 'user') {
    return (
      <div className="hb-chat-msg hb-chat-msg-user">
        {message.attachments && message.attachments.length > 0 || message.content ? (
          <div className="hb-chat-bubble hb-chat-user-bubble">
            <UserMessageContent message={message} onLocate={onLocate} />
          </div>
        ) : null}
        <div className="hb-chat-text-actions hb-chat-text-actions-user">
          <button
            type="button"
            title={copiedId ? '消息 ID 已复制' : '复制消息 ID'}
            aria-label={`复制消息 ID ${message.id}`}
            onClick={() => copyMessageId(message)}
          >
            {copiedId ? <CopySuccessGlyphIcon /> : <IdGlyphIcon />}
          </button>
          {message.content ? (
            <button
              type="button"
              title={copied ? '消息内容已复制' : '复制消息内容'}
              aria-label="复制消息内容"
              onClick={() => copyText(message.content)}
            >
              {copied ? <CopySuccessGlyphIcon /> : <CopyGlyphIcon />}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const label = contextLabel(message.context);
  const canRetry = message.status === 'error' || message.status === 'stopped' || message.status === 'unknown';
  const hasRunningToolCall = (message.toolCalls || []).some((call) => call.status === 'running');
  return (
    <div className="hb-chat-msg hb-chat-msg-assistant">
      {message.status === 'awaiting_input' && !message.content ? (
        <div className="hb-chat-pending" role="status">
          <span className="hb-chat-dots" aria-hidden="true"><i /><i /><i /></span>
          <em>等待你补充信息…</em>
        </div>
      ) : null}
      {message.status === 'running' && !message.content && !hasRunningToolCall ? (
        <div className="hb-chat-pending" role="status">
          <span className="hb-chat-dots" aria-hidden="true">
            <i /><i /><i />
          </span>
          <em>正在思考…</em>
        </div>
      ) : null}
      {message.content ? <MarkdownText text={message.content} /> : null}
      {message.toolCalls?.map((call) => (
        <ToolCallCard key={call.id} call={call} onRetry={canRetry ? () => onRetry(message.id) : undefined} />
      ))}
      {message.media && message.media.length > 0 ? (
        <div className={`hb-chat-media ${message.media.length === 1 ? 'is-single' : ''}`} aria-label="生成图片">
          {message.media.map((item, index) => (
            <div className="hb-chat-media-cell" key={`${item.versionId}-${index}`}>
              <img
                src={item.url}
                alt={item.prompt || '生成结果'}
                loading="lazy"
                onClick={() => onPreview(item.url, item.prompt || '生成结果')}
              />
              <span className="hb-chat-media-index">图 {index + 1}</span>
              <div className="hb-chat-media-actions">
                <button
                  type="button"
                  title="定位到画布上的这张图"
                  aria-label={`定位第 ${index + 1} 张图到画布`}
                  onClick={() => onLocate({ canvasId: item.canvasId || '', nodeId: item.nodeId, versionId: item.versionId, force: true })}
                >
                  <LocateGlyphIcon />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {message.status === 'stopped' ? <div className="hb-chat-stopped">已停止，结果未继续生成</div> : null}
      {message.status === 'unknown' ? (
        <div className="hb-chat-error">
          运行状态未知：bridge 可能重启过，这一轮的结果不完整。可点「重试」重新发送。
        </div>
      ) : null}
      {/* 失败原因常驻展开：不再折叠在工具卡里，用户一眼能看到哪轮为什么红。
          error 文案缺失时也要有兜底——绝不能出现"红了但看不到原因"。 */}
      {message.status === 'error' ? (
        <div className="hb-chat-error">{message.error || '这一轮出错了（未拿到具体原因），可点「重试」重发；点消息上的「ID」复制定位信息反馈给开发者。'}</div>
      ) : null}
      {/* 生图失败汇总：消息整体 done 但中间有工具失败时，错误摘要单独一行，
         不要求用户去展开工具卡才发现「哦原来失败过」。 */}
      {message.status !== 'error' && failedCalls.length > 0 ? (
        <div className="hb-chat-error">
          本轮有 {failedCalls.length} 次生图失败：{failedCalls[0].error || '未知错误'}
        </div>
      ) : null}
      {canRetry && message.status !== 'unknown' ? (
        <button type="button" className="hb-chat-tool-retry" onClick={() => onRetry(message.id)}>
          <RetryGlyphIcon />
          重试
        </button>
      ) : null}
      {label ? <div className="hb-chat-context">{label}</div> : null}
      <div className={`hb-chat-text-actions ${message.content ? '' : 'hb-chat-text-actions-idle'}`}>
        <button
          type="button"
          title={copiedId ? '消息 ID 已复制' : '复制消息 ID'}
          aria-label={`复制消息 ID ${message.id}`}
          onClick={() => copyMessageId(message)}
        >
          {copiedId ? <CopySuccessGlyphIcon /> : <IdGlyphIcon />}
        </button>
        {message.content ? (
          <button
            type="button"
            title={copied ? '回复已复制' : '复制回复'}
            aria-label="复制回复内容"
            onClick={() => copyText(message.content)}
          >
            {copied ? <CopySuccessGlyphIcon /> : <CopyGlyphIcon />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 消息流：空态引导 + 用户气泡 / Agent 回复 / 工具卡 / 图片结果。新消息自动滚到底。 */
export default function ChatMessageList({
  onLocate,
  onPreview,
  onRetry,
}: {
  onLocate: (ref: { canvasId: string; nodeId: string; versionId?: string; force?: boolean }) => void;
  onPreview: (url: string, title: string) => void;
  onRetry: (messageId: string) => void;
}) {
  const thread = useChatStore(activeThreadOf);
  const scrollRef = useRef<HTMLDivElement>(null);
  const setMessageScrollTop = useChatStore((state) => state.setMessageScrollTop);
  const messageScrollTop = useChatStore((state) => state.messageScrollTop);
  const messages = thread?.messages || [];
  const lastMessage = messages[messages.length - 1];
  const lastRunning = lastMessage?.status === 'running' || lastMessage?.status === 'awaiting_input';
  const lastMessageSignature = `${lastMessage?.id || ''}:${lastMessage?.status || ''}:${lastMessage?.content?.length || 0}:${lastMessage?.media?.length || 0}:${lastMessage?.toolCalls?.length || 0}`;

  // 展开 / 切线程时恢复滚动位置；运行中跟到底
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (lastRunning) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    if (messageScrollTop > 0) element.scrollTop = messageScrollTop;
  }, [thread?.id, lastRunning, messageScrollTop, messages.length, lastMessageSignature]);

  if (messages.length === 0) {
    return (
      <div className="hb-chat-messages hb-chat-messages-empty">
        <div className="hb-chat-empty">
          <div className="hb-chat-empty-icon" aria-hidden="true"><AiGlyphIcon /></div>
          <strong>和 AI 对话，把图改出来</strong>
          <span>聊需求、聊方向，它会自己判断什么时候生图；结果落在画布上，点定位图标随时找回去</span>
          <span>点击画布图片即可引用，也可以输入 @ 带图修改</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="hb-chat-messages"
      ref={scrollRef}
      onScroll={(event) => setMessageScrollTop(event.currentTarget.scrollTop)}
    >
      {messages.map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          onLocate={onLocate}
          onPreview={onPreview}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}
