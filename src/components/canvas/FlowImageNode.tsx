import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CanvasNodeData } from '@/types';
import {
  emitEvent,
  onEvent,
  NODE_ANIMATION_EVENTS,
  NODE_EVENTS,
  type NodeAnimationDoneDetail,
  type NodeConnectDetail,
  type NodePromptDetail,
  type NodeReferenceRemoveDetail,
  type NodeReferenceReorderDetail,
  type NodeResizeStartDetail,
  type NodePreviewDetail,
  type NodeReditCancelDetail,
  type NodeRunDetail,
  type NodeUploadDetail,
  type NodeVersionSetMainDetail,
  type NodeVersionsExpandDetail,
  type NodeVersionsFitDetail,
} from '@/lib/events';
import { nodeAspectRatio, nodeBoxFor, nodeWidthFor } from '@/lib/aspect';
import { hasUsableTextReference } from '@/lib/references';
import { activeVersionOf, newestVersionsFirst, normalizeVersions, versionIndexOf, versionLabel } from '@/lib/versions';
import CanvasImage from './CanvasImage';
import './RunningGlow.css';
import './NodeHandleMotion.css';
import './NodeVersionGrid.css';

/** 注入给 ImageNodes.css 的 JS 变量：宽度定卡片，比例定图片不变形（变量是宽/高，与 CSS aspect-ratio 同向）。 */
function nodeStyleVars(data: CanvasNodeData): Record<string, string> {
  const hasManualHeight = data.nodeHeightManual === true;
  const box = nodeBoxFor(data);
  return {
    '--image-node-width': `${nodeWidthFor(data)}px`,
    '--image-aspect-ratio': String(Math.round(nodeAspectRatio(data) * 100) / 100),
    ...(hasManualHeight ? { '--image-node-height': `${box.height}px` } : {}),
  };
}


function runningStageTitle(data: CanvasNodeData): string {
  if (data.status === 'error') return '生成失败';
  if (data.stage === 'enhance') return '正在整理提示词';
  return '正在生成图像';
}

/**
 * 右上角「图片总数 + 箭头」角标：收起时压在主图上，展开时改挂在当前版本那张卡上，
 * 位置始终是节点的右上角——展开 / 收起不用重新找按钮。
 */
function NodeVersionBadge({ total, expanded, onToggle }: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="image-node-version-badge nodrag nowheel"
      aria-label={`历史版本：共 ${total} 张`}
      aria-expanded={expanded}
      title={`共 ${total} 张图片 · 点击${expanded ? '收起' : '展开'}`}
      onClick={onToggle}
    >
      <span>{total}</span>
      <ChevronDownIcon />
    </button>
  );
}

/** 运行中每秒重渲染，让计时器走字（对齐灵枢的 useRunningElapsedLabel）。 */
function useElapsedLabel(startedAt: string | undefined, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const start = startedAt ? Date.parse(startedAt) : now;
  if (!Number.isFinite(start)) return '0s';
  return `${Math.max(0, Math.floor((now - start) / 1000))}s`;
}

/** 版本宫格退场时长：要同时盖住位移（300ms）和尾段淡出（230ms 延迟 + 140ms = 370ms），
    留 10ms 余量——再长就会在卡片淡完后、主图接位前露出画布底色。 */
const NODE_VERSION_EXIT_MS = 380;

/** 运行态视觉：内部动画与灵枢保持一致，外层描边再区分直连和智能生成。 */
function NodeRunningVisual({ data, elapsed }: { data: CanvasNodeData; elapsed: string }) {
  const runningMode = data.runningDirect === false ? 'is-running-enhanced' : 'is-running-direct';
  return (
    <>
      <span className={`image-node-running-dots ${runningMode}`} aria-hidden="true" />
      <span className={`image-node-running-glow ${runningMode}`} aria-hidden="true" />
      {data.size ? <span className="image-node-running-size">{data.size}</span> : null}
      <span className="image-node-running-meta">
        <strong>{runningStageTitle(data)}</strong>
        {/* 计时脉冲点：让"正在计时"在静态数字之外也可感知 */}
        <span className="image-node-running-timer" aria-hidden="true" />
        <time>{elapsed}</time>
      </span>
    </>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M14.5823 1.95466L1.71081 5.91364C0.815138 6.18919 0.652241 7.3866 1.44187 7.89142L5.24484 10.3225C5.4426 10.4488 5.6756 10.5087 5.90979 10.4931C6.14398 10.4776 6.36706 10.3876 6.54643 10.2362L11.2929 6.23098C11.5502 6.01387 11.8974 6.36082 11.6803 6.61839L7.67534 11.3657C7.52399 11.545 7.43401 11.7681 7.41854 12.0022C7.40308 12.2364 7.46295 12.4693 7.58939 12.667L10.0199 16.4694C10.5245 17.2588 11.7221 17.0959 11.9977 16.2005L15.9567 3.32923C16.2161 2.48539 15.4259 1.69524 14.5823 1.95466Z" fill="currentColor" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 9.5 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 置顶图标：箭头送入顶线——「把这一版设为主图」的新形式（换掉图钉，语义更直白）。 */
function PinTopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 4h15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 20V8m0 0-4.5 4.5M12 8l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4v11m0 0 4-4m-4 4-4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 18.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseSmallIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8m0-8l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CopyImageIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.25" y="4.25" width="7.5" height="8" rx="1.25" stroke="currentColor" strokeWidth="1.25" />
      <path d="M3.75 10.25H3A1.25 1.25 0 0 1 1.75 9V3A1.25 1.25 0 0 1 3 1.75h5A1.25 1.25 0 0 1 9.25 3v.75" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export default function FlowImageNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as CanvasNodeData;
  const kind = d.kind;
  const imageUrl = String(d.imageUrl || d.referenceDataUrl || '').trim();
  const isComposer = kind === 'composer';
  const isRunning = d.status === 'running';
  const sizeLabel = String(d.size || '').trim();
  /* ── 版本链：同一节点上历次生成 / 二次编辑的产物，主图 = activeVersion ── */
  const versions = normalizeVersions(d);
  const activeVersion = activeVersionOf(d);
  const versionCount = versions.length;
  // 版本大于 1 才有“多版本”语言：卡片背后叠层 + 右上角数字箭头角标
  const hasVersions = versionCount > 1;
  const [versionsExpanded, setVersionsExpanded] = useState(false);
  // 展开 → 收起之间留一段退场：宫格卡片先散着消失，节点再缩回单图尺寸
  const [versionsRendered, setVersionsRendered] = useState(false);
  const [imageCopied, setImageCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  // 二次编辑态：kind 是 composer 且钉着基准图版本；输入区里那张不可移除的引用就是它
  const isRedit = isComposer && Boolean(String(d.reditBaseVersionId || '').trim());
  const reditBase = isRedit
    ? (versions.find((item) => item.id === String(d.reditBaseVersionId)) || activeVersion)
    : null;
  const [promptDraft, setPromptDraft] = useState(String(d.prompt || ''));
  const references = Array.isArray(d.references) ? d.references : [];
  /** chips 拖拽换序的本地顺序（引用键数组）：松手立即就地重排，再 emit 让页面落库；
      页面增删引用时派生顺序自动吸纳（新引用排末尾、被删的自动蒸发），不冲掉已排好的队。 */
  const [referenceReorder, setReferenceReorder] = useState<string[] | null>(null);
  /** 拖拽态：来源 chip 半透明、目标位高亮描边（样式见 NodeHandleMotion.css）。 */
  const [dragReferenceKey, setDragReferenceKey] = useState<string | null>(null);
  const [dropReferenceKey, setDropReferenceKey] = useState<string | null>(null);
  /** 引用键与渲染 key / 发送数组下标同规则：id 优先，老数据缺 id 时退回 url。 */
  const referenceKeyOf = (reference: { id?: string; url?: string }) => String(reference.id || reference.url || '');
  /** 展示顺序：没拖过就按 data 原样；拖过则按本地顺序排，不在名单里的引用保持相对次序垫末位。 */
  const orderedReferences = useMemo(() => {
    if (!referenceReorder || referenceReorder.length === 0) return references;
    const rank = new Map(referenceReorder.map((key, index) => [key, index]));
    return references
      .map((reference, index) => ({ reference, index }))
      .sort((left, right) => {
        const leftRank = rank.get(referenceKeyOf(left.reference));
        const rightRank = rank.get(referenceKeyOf(right.reference));
        if (leftRank === undefined && rightRank === undefined) return left.index - right.index;
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        return leftRank - rightRank;
      })
      .map((item) => item.reference);
  }, [references, referenceReorder]);
  /** 多图编号：render 前预计算，key 同 references 去重键。模块级单图场景留空即不显示徽标。 */
  const refNumbers = new Map<string, number>();
  // 连着上游文案节点时，输入框可以空着发送：文案会以「参考：…」并进提示词，
  // 用户没必要把同一段话抄两遍（曾因强制非空，文案节点连上来也发不出去）
  const textReferenceReady = hasUsableTextReference(references);
  const canSend = !isRunning && Boolean(promptDraft.trim() || textReferenceReady);
  // 选中后再次点击输入区才进入可输入态：平时输入框不吃指针事件，卡片整体可以拖
  const isEditing = isComposer && !imageUrl && d.composerEditing === true && !isRunning;
  const elapsed = useElapsedLabel(d.createdAt, isRunning);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  /** 手动拉伸过高度：卡片不再跟随内容自适应，输入框交给 flex 铺满 */
  const hasManualHeight = isComposer && !imageUrl && d.nodeHeightManual === true;
  /**
   * 发送按钮下方那排报错：status 置 error 是硬失败（没配模型、参考图在跑、接口报错…），
   * error 字段在运行中非空是软提示（提示词整理失败、已按原文生图）——都要摊在卡片上，
   * 只弹 toast 的话错误撑不过 3 秒，画布上找不到原因。
   */
  const composerError = String(d.error || '').trim()
    || (d.status === 'error' ? '生成失败，请重新发送' : '');

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const copyImage = async (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!imageUrl) return;
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      } else {
        await navigator.clipboard?.writeText(imageUrl);
      }
      setImageCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setImageCopied(false), 1400);
    } catch {
      await navigator.clipboard?.writeText(imageUrl).catch(() => undefined);
    }
  };

  // 运行中不覆盖本地草稿：失败后原文还在，改几个字就能重发
  useEffect(() => {
    if (!isRunning) setPromptDraft(String(d.prompt || ''));
  }, [d.prompt, isRunning]);

  useEffect(() => {
    if (!isEditing) return;
    const input = composerInputRef.current;
    if (!input) { console.warn('[HBDBG] editing but no ref', id); return; }
    let frame = 0;
    let tries = 0;
    const placeCaret = () => {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      // React Flow 在节点测量完成前会给 .react-flow__node 挂 visibility: hidden，
      // 那一帧 focus() 会静默失败（新建节点时必踩）。最多跟几帧，等 visibility 翻回来。
      if (document.activeElement !== input && tries < 8) {
        tries += 1;
        frame = window.requestAnimationFrame(placeCaret);
      }
    };
    placeCaret();
    return () => window.cancelAnimationFrame(frame);
  }, [isEditing]);

  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    if (hasManualHeight) {
      input.style.height = '';
      return;
    }
    input.style.height = '0px';
    input.style.height = `${Math.min(220, Math.max(72, input.scrollHeight))}px`;
  }, [promptDraft, isRunning, references.length, hasManualHeight]);

  // 宫格同时只展开一个：从选中态被点掉（换选节点 / 点空白）、按 Esc 都收起。
  // 这里只认“曾经选中过”：角标点击不抢选中态时，节点没被选中过也不该自己秒收。
  const wasSelectedRef = useRef(false);
  useEffect(() => {
    if (selected) {
      wasSelectedRef.current = true;
      return undefined;
    }
    if (!wasSelectedRef.current) return undefined;
    wasSelectedRef.current = false;
    setVersionsExpanded(false);
  }, [selected]);

  useEffect(() => {
    if (!versionsExpanded) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVersionsExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [versionsExpanded]);

  useEffect(() => onEvent(NODE_EVENTS.versionsCollapse, () => setVersionsExpanded(false)), []);

  /** 摊开宫格：节点从单图变成两列，视角要退一步才看得全（历史面板定位也走这条）。 */
  const expandVersions = useCallback(() => {
    if (!hasVersions) return;
    setVersionsExpanded(true);
  }, [hasVersions]);

  // 宫格展示按生成时间倒序：重新生成完成后最新一版始终在最上方。
  const gridVersions = newestVersionsFirst({ ...d, versions });
  const toggleVersions = useCallback(() => {
    if (versionsExpanded) setVersionsExpanded(false);
    else expandVersions();
  }, [versionsExpanded, expandVersions]);

  // 历史面板「定位」：只摊开被点名的那个节点
  useEffect(() => onEvent<NodeVersionsExpandDetail>(NODE_EVENTS.versionsExpand, ({ nodeId }) => {
    if (nodeId === id) expandVersions();
  }), [id, expandVersions]);

  useEffect(() => {
    if (versionsExpanded) {
      setVersionsRendered(true);
      return undefined;
    }
    if (!versionsRendered) return undefined;
    const timer = window.setTimeout(() => setVersionsRendered(false), NODE_VERSION_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [versionsExpanded, versionsRendered]);

  /* 宫格真正上屏后才发「退视角」事件：versionsRendered 要等展开那次 commit 之后的 effect
     才置真，此刻卡片已在 DOM 里。早一帧发的话，页面量到的是 width 已变、height=0、卡片数=0
     的中间态，fit 直接失败——表现就是「点角标展开后视角不动、卡溢出屏幕」（踩过）。 */
  useEffect(() => {
    if (!versionsExpanded || !versionsRendered) return;
    emitEvent<NodeVersionsFitDetail>(NODE_EVENTS.versionsFit, { nodeId: id });
  }, [versionsExpanded, versionsRendered, id]);

  /** 文本引用进入提示词：点击 chip 即把上游生成节点的提示词拼进来（灵枢同款）。 */
  const appendReferenceText = (reference: { text?: string; url?: string }) => {
    const text = String(reference.text || reference.url || '').trim();
    if (!text) return;
    const next = promptDraft.trim() ? `${promptDraft.trim()}\n${text}` : text;
    setPromptDraft(next);
    emitEvent<NodePromptDetail>(NODE_EVENTS.prompt, { nodeId: id, prompt: next });
  };

  /** 拖拽落位：把来源 chip 抽出来插到目标位。order 覆盖全部 references（含文本 chip），
      二次编辑的基准图不进 references、也不进 order——它恒为「图 1」，不参与排序。 */
  const reorderReferences = (targetKey: string) => {
    const from = orderedReferences.findIndex((reference) => referenceKeyOf(reference) === dragReferenceKey);
    const to = orderedReferences.findIndex((reference) => referenceKeyOf(reference) === targetKey);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...orderedReferences];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const order = next.map((reference) => referenceKeyOf(reference));
    setReferenceReorder(order);
    emitEvent<NodeReferenceReorderDetail>(NODE_EVENTS.referenceReorder, { nodeId: id, order });
  };

  /** 右下角手柄：同时改宽高（灵枢同款，节点未选中也能拖） */
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    emitEvent<NodeResizeStartDetail>(NODE_ANIMATION_EVENTS.resizeStart, {
      nodeId: id,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      pointerTarget: event.currentTarget,
    });
  };

  return (
    <div
      className={`image-flow-node image-node-${kind} ${isComposer && !imageUrl ? 'image-node-composer-card' : ''} ${hasManualHeight ? 'has-manual-height' : ''} ${imageUrl ? 'has-image' : 'is-empty'} ${selected ? 'selected' : ''} ${isRunning ? 'is-running' : ''} ${d.status === 'error' && !isRunning ? 'is-error' : ''} ${hasVersions ? 'has-versions' : ''} ${versionsExpanded ? 'versions-expanded' : (versionsRendered ? 'versions-leaving' : '')} ${isRedit ? 'is-redit' : ''}`}
      style={nodeStyleVars(d) as CSSProperties}
      // 入场 / 退场 / 新鲜高亮播完即通知页面摘 class，比定时器兜底精确
      onAnimationEnd={(event) => {
        event.stopPropagation();
        emitEvent<NodeAnimationDoneDetail>(NODE_ANIMATION_EVENTS.done, { nodeId: id });
      }}
    >
      {isRunning ? (
        // 智能生成是紫色流光，直连生成保留白色流光，内部矩阵负责点阵涟漪。
        <span
          className={`image-node-running-border ${d.runningDirect === false ? 'is-running-enhanced' : 'is-running-direct'}`}
          aria-hidden="true"
        />
      ) : null}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className={`image-handle image-handle-target image-node-connect-add ${kind}`}
        aria-label="添加上游参考图"
        title="添加上游参考图"
        onClick={(event) => {
          // 灵枢同款：点头像手柄的「+」不直接拖线，而是弹出可连接节点菜单
          event.stopPropagation();
          emitEvent<NodeConnectDetail>(NODE_EVENTS.connect, {
            nodeId: id,
            clientX: event.clientX,
            clientY: event.clientY,
            direction: 'target',
          });
        }}
      >
        <span className="image-node-connect-ring" aria-hidden="true" />
      </Handle>
      <div className={`image-node-body ${sizeLabel ? 'has-size-badge' : ''}`}>
        {isComposer && !imageUrl ? (
          <div className={`image-node-composer-shell ${isRunning ? 'running' : ''} ${isEditing ? 'editing' : ''}`}>
            {isRunning ? (
              <div className="image-node-composer-running" role="status" aria-live="polite">
                <NodeRunningVisual data={d} elapsed={elapsed} />
              </div>
            ) : null}
            <div className="image-node-composer-content">
              {(isRedit && reditBase) || references.length > 0 ? (
                <div className="image-node-composer-refs">
                  {/* 连线图片从图 1 开始编号；二次编辑基准图是上一版结果，不参与用户描述编号。 */}
                  {(() => {
                    let seq = 0;
                    for (const reference of orderedReferences) {
                      if (reference.kind === 'text' || !String(reference.url || '').trim()) continue;
                      seq += 1;
                      refNumbers.set(referenceKeyOf(reference), seq);
                    }
                    return null;
                  })()}
                  {isRedit && reditBase ? (
                    <figure
                      className="image-node-composer-ref is-redit-base"
                      title="二次编辑基准图：上次生成结果，不计入图1、图2编号"
                      aria-label="二次编辑基准图：上次生成结果，不计入图1、图2编号"
                    >
                      <CanvasImage src={reditBase.imageUrl} alt="" draggable={false} />
                      <span className="image-node-composer-ref-base-tag">基准图</span>
                    </figure>
                  ) : null}
                  {orderedReferences.map((reference) => {
                    const isText = reference.kind === 'text' || (!String(reference.url || '').trim() && Boolean(String(reference.text || '').trim()));
                    if (isText) {
                      return (
                        <div
                          className="image-node-composer-ref image-node-composer-ref-text nodrag"
                          draggable={false}
                          key={reference.id || reference.text}
                          title={String(reference.text || reference.title || '')}
                          onClick={(event) => {
                            event.stopPropagation();
                            appendReferenceText(reference);
                          }}
                        >
                          <span className="image-node-composer-ref-text-icon" aria-hidden="true">T</span>
                          <button
                            type="button"
                            className="image-node-composer-ref-remove nodrag"
                            aria-label={`移除${reference.title || '文本引用'}`}
                            title="移除文本引用"
                            onClick={(event) => {
                              event.stopPropagation();
                              emitEvent<NodeReferenceRemoveDetail>(NODE_EVENTS.referenceRemove, { nodeId: id, referenceId: reference.id, url: reference.url });
                            }}
                          >
                            <CloseSmallIcon />
                          </button>
                        </div>
                      );
                    }
                    const referenceKey = referenceKeyOf(reference);
                    const number = refNumbers.get(referenceKey);
                    const isDragging = dragReferenceKey === referenceKey;
                    const isDropTarget = dropReferenceKey === referenceKey;
                    return (
                      <figure
                        className={`image-node-composer-ref${isDragging ? ' is-dragging' : ''}${isDropTarget ? ' is-drop-target' : ''} nodrag`}
                        key={referenceKey}
                        draggable
                        onDragStart={(event) => {
                          // 拖图片 chip 不拖节点：事件在这里截住，不让 React Flow 的节点拖拽接管
                          event.stopPropagation();
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', referenceKey);
                          // 自定义类型给画布级文件拖放层当暗号：chip 内拖拽排序不是「拖图片进画布」，
                          // 少了它，window 那层 drag 监听会把 <img> 自带的 text/uri-list 当成外来图片，
                          // 弹出「松开添加到画布」还关不掉（chip 的 drop 被 React root 截走，window 收不到）
                          event.dataTransfer.setData('application/x-huiban-reference', referenceKey);
                          setDragReferenceKey(referenceKey);
                        }}
                        onDragOver={(event) => {
                          if (!dragReferenceKey || dragReferenceKey === referenceKey) return;
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = 'move';
                          setDropReferenceKey(referenceKey);
                        }}
                        onDragLeave={() => setDropReferenceKey((current) => (current === referenceKey ? null : current))}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          reorderReferences(referenceKey);
                        }}
                        onDragEnd={() => {
                          setDragReferenceKey(null);
                          setDropReferenceKey(null);
                        }}
                      >
                        {number ? <span className="image-node-composer-ref-index">{number}</span> : null}
                        <CanvasImage src={reference.url} alt="" />
                        <button
                          type="button"
                          className="image-node-composer-ref-remove nodrag"
                          aria-label={`移除参考图${number ? ` 图${number}` : ''} ${reference.title}`}
                          title="移除参考图"
                          onClick={(event) => {
                            event.stopPropagation();
                            emitEvent<NodeReferenceRemoveDetail>(NODE_EVENTS.referenceRemove, { nodeId: id, referenceId: reference.id, url: reference.url });
                          }}
                        >
                          <CloseSmallIcon />
                        </button>
                      </figure>
                    );
                  })}
                </div>
              ) : null}
              <textarea
                ref={composerInputRef}
                className={`${isEditing ? 'nodrag nowheel' : ''}`}
                value={promptDraft}
                disabled={isRunning}
                readOnly={!isEditing}
                tabIndex={isEditing ? 0 : -1}
                rows={1}
                placeholder={textReferenceReady ? '描述你想生成的画面...（留空则按连接的文案生成）' : '描述你想生成的画面...'}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setPromptDraft(value);
                  emitEvent<NodePromptDetail>(NODE_EVENTS.prompt, { nodeId: id, prompt: value });
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    if (canSend) emitEvent<NodeRunDetail>(NODE_EVENTS.run, { nodeId: id, prompt: promptDraft });
                  }
                }}
              />
            </div>
            <div className="image-node-composer-foot">
              <button
                type="button"
                className="image-node-composer-add nodrag"
                aria-label="上传参考图"
                title="上传参考图"
                disabled={isRunning}
                onClick={(event) => {
                  event.stopPropagation();
                  emitEvent<NodeUploadDetail>(NODE_EVENTS.upload, { nodeId: id, reference: true });
                }}
              >
                <PlusIcon />
              </button>
              <span className="hb-hint">{isRunning ? '生成中，可稍候…' : (isRedit ? 'Enter 发送新版本 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行')}</span>
              {isRedit ? (
                <button
                  type="button"
                  className="image-node-composer-redit-cancel nodrag"
                  title="取消二次编辑，节点回到图片"
                  aria-label="取消二次编辑"
                  disabled={isRunning}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!isRunning) emitEvent<NodeReditCancelDetail>(NODE_EVENTS.reditCancel, { nodeId: id });
                  }}
                >
                  取消二次编辑
                </button>
              ) : null}
              <button
                type="button"
                className="image-node-composer-send nodrag"
                aria-label={isRunning ? '生成中' : (promptDraft.trim() ? '发送生成' : '按连接的文案生成')}
                title={isRunning ? '生成中' : (promptDraft.trim() ? '发送生成' : '按连接的文案生成')}
                disabled={!canSend}
                onClick={(event) => {
                  event.stopPropagation();
                  if (canSend) emitEvent<NodeRunDetail>(NODE_EVENTS.run, { nodeId: id, prompt: promptDraft });
                }}
              >
                {isRunning ? <span className="image-composer-submit-spinner" aria-hidden="true" /> : <SendIcon />}
              </button>
            </div>
            {composerError ? (
              <em
                className={`image-node-composer-error${isRunning ? ' is-pending' : ''}`}
                role={isRunning ? 'note' : 'alert'}
              >{composerError}</em>
            ) : null}
          </div>
        ) : null}

        {/* 图片节点：可整块拖拽（不带 nodrag），双击开大图预览由页面层 onNodeDoubleClick 处理 */}
        {/* 多版本提示层：卡片背后两张错位旋转的复印件，一眼看出“这张图还有别的版本” */}
        {hasVersions && imageUrl && !isRunning ? <span className="image-node-version-stack" aria-hidden="true"><i /><i /></span> : null}
        {imageUrl && !isRunning ? (
          <div
            className="image-node-media"
            aria-label={d.prompt || d.label}
            title={d.prompt || d.label}
          >
            <CanvasImage src={imageUrl} alt={d.prompt || d.label} missingNote={d.prompt} draggable={false} />
            {hasVersions ? (
              <NodeVersionBadge
                total={versionCount}
                expanded={versionsExpanded}
                onToggle={toggleVersions}
              />
            ) : null}
            {sizeLabel ? (
              <div className="image-node-meta-badges">
                <span className="image-node-size-badge">{sizeLabel}</span>
                <button
                  type="button"
                  className="image-node-copy-button nodrag nowheel"
                  title={imageCopied ? '已复制图片' : '复制图片'}
                  aria-label={imageCopied ? '已复制图片' : '复制图片'}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={copyImage}
                >
                  <CopyImageIcon />
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 版本宫格：展开后整块替换主图——当前版本打头、新→旧铺成两列，每张与收起时等大；
            点空白 / Esc / 换选自动收起，双击某一版开灯箱，hover 可下载；
            非主图卡还能一键置顶为主图（主图卡自己就是最上方，不出现置顶钮） */}
        {hasVersions && versionsRendered && !isRunning ? (
          <div className="image-node-versions" role="group" aria-label="历史版本">
            {gridVersions.map((version) => {
              const isActive = version.id === String(activeVersion?.id || '');
              const label = versionLabel(versionIndexOf(d, version.id));
              return (
                <figure
                  key={version.id}
                  className={`image-node-version ${isActive ? 'is-active' : ''}`}
                  title={version.prompt || version.fileName}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    emitEvent<NodePreviewDetail>(NODE_EVENTS.preview, { nodeId: id, version });
                  }}
                >
                  <CanvasImage src={version.imageUrl} alt={version.prompt || label} missingNote={version.fileName} loading="lazy" draggable={false} />
                  <span className="image-node-version-tag">{label}</span>
                  {/* 右上角收成同一行：下载 / 置顶靠左，展开角标钉在右端。装进同一个 flex 排里，
                      操作钮才不会掉到「角标下面第二行」（ImageNodes.css 的 top:38px 让位写法）；
                      角标放排尾，整行始终贴着节点右上角，下载跟在它的左手边；
                      置顶在主图卡上整块不渲染——它已经是最上方那张了。 */}
                  <div className="image-node-version-top">
                    <div className="image-node-version-actions">
                      <a
                        className="image-node-version-action nodrag"
                        href={version.imageUrl}
                        download={version.fileName || `${label}.png`}
                        title={`下载 ${label}`}
                        aria-label={`下载 ${label}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <DownloadIcon />
                      </a>
                      {isActive ? null : (
                        <button
                          type="button"
                          className="image-node-version-action nodrag"
                          title={`把 ${label} 置顶为主图`}
                          aria-label={`把 ${label} 置顶为主图`}
                          onClick={(event) => {
                            event.stopPropagation();
                            emitEvent<NodeVersionSetMainDetail>(NODE_EVENTS.versionSetMain, { nodeId: id, versionId: version.id });
                          }}
                        >
                          <PinTopIcon />
                        </button>
                      )}
                    </div>
                    {isActive ? (
                      <NodeVersionBadge
                        total={versionCount}
                        expanded
                        onToggle={toggleVersions}
                      />
                    ) : null}
                  </div>
                </figure>
              );
            })}
          </div>
        ) : null}

        {isComposer && !imageUrl && !isRunning ? (
          <button
            type="button"
            className="image-node-resize-handle nodrag nowheel"
            aria-label="拉伸卡片宽高"
            title="拉伸卡片宽高"
            onPointerDown={startResize}
          />
        ) : null}

        {!imageUrl && !isComposer ? (
          <div className={`image-node-placeholder ${isRunning ? 'running' : ''} ${d.status === 'error' ? 'failed' : ''}`}>
            {sizeLabel && !isRunning ? <span className="image-node-size-badge">{sizeLabel}</span> : null}
            {isRunning ? <NodeRunningVisual data={d} elapsed={elapsed} /> : null}
            {!isRunning && d.status !== 'error' ? (
              <span>{kind === 'reference' ? '参考图' : '空节点'}</span>
            ) : null}
            {d.status === 'error' ? <em className="image-node-error-note" role="alert">{d.error || '请重新发送'}</em> : null}
          </div>
        ) : null}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className={`image-handle image-handle-source image-node-connect-add ${kind}`}
        aria-label="作为参考图连到下游"
        title="作为参考图连到下游"
        onClick={(event) => {
          event.stopPropagation();
          emitEvent<NodeConnectDetail>(NODE_EVENTS.connect, {
            nodeId: id,
            clientX: event.clientX,
            clientY: event.clientY,
            direction: 'source',
          });
        }}
      >
        <span className="image-node-connect-ring" aria-hidden="true" />
      </Handle>
    </div>
  );
}
