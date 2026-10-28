import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import CanvasImage from './CanvasImage';
import { useNearViewport } from './useNearViewport';
import type { HistoryItem } from '@/types';
import { deleteImageIfUnused, revealLocalFile } from '@/lib/bridge';
import './HistoryPanel.css';

/**
 * 已删除的历史条目（模块级 Set）：面板一关就整体卸载，而 CanvasPage 里 historyItems 加载过
 * 就不会再拉一次列表，所以删除记录不能只存在组件 state 里——否则再打开面板，删掉的那些
 * 又会从旧数据里冒回来。key 与列表 item key 同一套规则：canvasId + fileName + createdAt。
 */
const hiddenKeys = new Set<string>();

/** 历史条目的稳定标识：删除隐藏、勾选计数都用它。 */
function historyKeyOf(item: HistoryItem): string {
  return `${item.mediaType || 'image'}:${item.canvasId}:${item.fileName}:${item.createdAt}`;
}

/** 展示形式：宫格（只放图）/ 列表（按天分组 + 小图 + 两行文字）。 */
type HistoryView = 'grid' | 'list';
type HistoryMediaFilter = 'all' | 'image' | 'video';

/** 列表视图的一“天”：组标题日期 + 当天条目（进组前 list 已按时间排好序）。 */
type HistoryDayGroup = { key: string; label: string; items: HistoryItem[] };

function HistoryVideoPreview({ item }: { item: HistoryItem }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const nearViewport = useNearViewport(videoRef, Boolean(item.url));

  return <video ref={videoRef} src={item.url} muted playsInline preload={nearViewport ? 'metadata' : 'none'} />;
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m12 3.8 2.5 5.1 5.6.8-4.1 4 .9 5.6-4.9-2.6-4.9 2.6.9-5.6-4.1-4 5.6-.8L12 3.8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** 历史面板：贴在左侧功能竖条旁的长方形弹窗，滚轮/触控板滚动查看，点条目开大图。 */
export default function HistoryPanel({
  items,
  loading,
  error,
  onSelect,
  onLocate,
  onSaveAsset,
  onClose,
  onRequestClose,
  onClosed,
  closing,
  anchorRect,
  inline = false,
}: {
  items: HistoryItem[];
  loading: boolean;
  error: string;
  onSelect: (item: HistoryItem) => void;
  /** 定位到该图所属的结果节点：必要时先切画布，再在画布上摊开它的版本宫格。 */
  onLocate?: (item: HistoryItem) => void;
  onSaveAsset?: (item: HistoryItem) => void;
  /** 立即关闭（选中条目开大图这类不等动画的场景）。 */
  onClose: () => void;
  /** 请求关闭（Esc / 点空白）：先播收起动画，动画结束再回调 onClosed 卸载。 */
  onRequestClose?: () => void;
  /** 收起动画播完：父组件这时才真正卸载面板。 */
  onClosed?: () => void;
  /** 收起动画播放中：面板挂 is-leaving 并屏蔽指针。 */
  closing?: boolean;
  /** 触发按钮的屏幕锚点：面板贴着它右侧展开。 */
  anchorRect?: { x: number; y: number } | null;
  /** 工作台内联展开：跟随结果区排版，不使用画布的固定浮层定位。 */
  inline?: boolean;
}) {
  /* hidden 是模块级 hiddenKeys 的本地镜像：删完改镜像触发一次重渲染，条目当场消失，
     模块级那份负责跨「关闭再打开」记住删过谁。 */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(hiddenKeys));
  const list = useMemo(() => {
    const visible = items.filter((item) => !hidden.has(historyKeyOf(item)));
    // 分组前先按时间稳定排序（新的在前，与 bridge 返回顺序一致）：分组顺序不随 props 顺序漂移
    visible.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return visible.slice(0, 300);
  }, [items, hidden]);
  const [mediaFilter, setMediaFilter] = useState<HistoryMediaFilter>('all');
  const imageCount = list.filter((item) => item.mediaType !== 'video').length;
  const videoCount = list.length - imageCount;
  const visibleList = useMemo(
    () => mediaFilter === 'all'
      ? list
      : list.filter((item) => (item.mediaType || 'image') === mediaFilter),
    [list, mediaFilter],
  );
  // 同一节点的版本id → 序号：把 baseVersionId 翻译成“基于 V1”
  const versionIndexById = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of list) {
      if (item.nodeId && item.versionId && item.versionIndex) {
        map.set(`${item.nodeId}:${item.versionId}`, item.versionIndex);
      }
    }
    return map;
  }, [list]);
  /* 列表视图按天分组：同一天的条目收进同一束，组标题就是那天的日期 */
  const groups = useMemo<HistoryDayGroup[]>(() => {
    const out: HistoryDayGroup[] = [];
    const atOf = new Map<string, number>();
    for (const item of visibleList) {
      const label = formatHistoryDay(item.createdAt);
      const index = atOf.get(label);
      if (index === undefined) {
        atOf.set(label, out.length);
        out.push({ key: label, label, items: [item] });
      } else {
        out[index].items.push(item);
      }
    }
    return out;
  }, [visibleList]);
  const rootRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});

  /* 视图与多选删除：视图关上面板就重置（多选同理），删除记录走模块级 hiddenKeys */
  const [view, setView] = useState<HistoryView>('grid');
  const [multi, setMulti] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set<string>());
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const selectedItems = useMemo(
    () => visibleList.filter((item) => selected.has(historyKeyOf(item))),
    [visibleList, selected],
  );
  const selectedCount = selectedItems.length;

  // 贴着锚点右侧展开，竖向居中：宫格内容更高，贴按钮定位容易顶出屏幕
  useLayoutEffect(() => {
    if (inline) {
      setPosition({});
      return;
    }
    if (!anchorRect) {
      setPosition({});
      return;
    }
    setPosition({ left: anchorRect.x, top: '50%', transform: 'translateY(-50%)' });
  }, [anchorRect, inline, list.length]);

  const [revealError, setRevealError] = useState('');
  const revealFolder = useCallback(() => {
    setRevealError('');
    revealLocalFile('')
      .then(() => setRevealError(''))
      .catch((err: unknown) => {
        // bridge 拉起 Finder 失败要把原因说出来：以前整条吞掉，用户点完什么都不发生
        setRevealError(err instanceof Error ? err.message : '打开本地文件夹失败');
      });
  }, []);
  useEffect(() => {
    if (!revealError) return undefined;
    const timer = window.setTimeout(() => setRevealError(''), 4000);
    return () => window.clearTimeout(timer);
  }, [revealError]);

  /* 删除失败也走内联提示：红色 role="alert"，4 秒后自己退场，不弹 alert() */
  useEffect(() => {
    if (!deleteError) return undefined;
    const timer = window.setTimeout(() => setDeleteError(''), 4000);
    return () => window.clearTimeout(timer);
  }, [deleteError]);

  /* 「再点一次确认」只给 2 秒：超时没再点就当作误触，按钮退回普通删除态 */
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = window.setTimeout(() => setConfirming(false), 2000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  /* Esc 收起：右上角不再放关闭按钮，键盘仍是关掉的通道 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (onRequestClose) onRequestClose();
        else onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, onRequestClose]);

  /* 收起动画播完再卸载。animationend 之外加定时兜底：prefers-reduced-motion 下
     动画被跳过、事件不发，只有定时器能让面板正常消失。 */
  useEffect(() => {
    if (!closing) return undefined;
    const timer = window.setTimeout(() => onClosed?.(), 400);
    return () => window.clearTimeout(timer);
  }, [closing, onClosed]);

  /** 多选开关：关掉时把勾选与确认态一起清干净，避免下次进来带着旧选择 */
  const toggleMulti = () => {
    const next = !multi;
    setMulti(next);
    if (!next) {
      setSelected(new Set());
      setConfirming(false);
      setDeleteError('');
    }
  };

  /** 点条目：普通态开大图，多选态只切换勾选（定位按钮在这时也让位给勾选圈） */
  const onItemClick = (item: HistoryItem) => {
    if (!multi) {
      onSelect(item);
      return;
    }
    const key = historyKeyOf(item);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 删除按钮：第一下只是「上膛」，2 秒内第二下才真删，避免误删 */
  const onDeleteClick = () => {
    if (deleting || selectedCount === 0) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    void runDelete();
  };

  /** 真删：逐条 DELETE /api/files/:name（bridge 路由），成功的记进模块级隐藏表 */
  const runDelete = async () => {
    const targets = selectedItems;
    if (targets.length === 0) return;
    setDeleting(true);
    setDeleteError('');
    const failed: string[] = [];
    await Promise.all(targets.map(async (item) => {
      try {
        const deleted = await deleteImageIfUnused(item.fileName);
        if (!deleted) throw new Error('文件仍被画布或对话引用');
        hiddenKeys.add(historyKeyOf(item));
      } catch {
        failed.push(item.fileName);
      }
    }));
    const targetKeys = new Set(targets.map(historyKeyOf));
    const remaining = list.filter((item) => !targetKeys.has(historyKeyOf(item))).length;
    setHidden(new Set(hiddenKeys));
    setSelected(new Set());
    setConfirming(false);
    setDeleting(false);
    if (failed.length > 0) {
      setDeleteError(`删除失败：${failed.length} 个文件没删掉，请重试`);
    } else if (remaining === 0) {
      // 全删完了：收起多选态，让空态文案干干净净地露出来
      setMulti(false);
    }
  };

  /* 单条目渲染：宫格只放缩略图（勾选圈、定位按钮都压在图上）；
     列表才是小图 + 两行文字（第一排提示词、第二排版本/画布/来源/时刻）。 */
  const renderItem = (item: HistoryItem) => {
    const isSelected = selected.has(historyKeyOf(item));
    const versionTag = versionTagOf(item, versionIndexById);
    return (
      <div
        key={historyKeyOf(item)}
        className={`image-history-item${view === 'list' ? ' is-list' : ' is-grid'}${isSelected ? ' is-selected' : ''}${item.mediaType === 'video' ? ' is-video' : ''}`}
      >
        <button
          type="button"
          className="image-history-item-main"
          onClick={() => onItemClick(item)}
          aria-pressed={multi ? isSelected : undefined}
          title={item.prompt || item.canvasName}
        >
          <span className="image-history-item-thumb">
            {item.mediaType === 'video' ? (
              <>
                <HistoryVideoPreview item={item} />
                <span className="image-history-video-mark" aria-hidden="true"><PlayIcon /></span>
              </>
            ) : (
              <CanvasImage src={item.url} alt={item.prompt || '生成图'} loading="lazy" draggable={false} />
            )}
            {/* 多选态：图片左上角勾选圈，未选空心、选中实心勾，图片同时压暗一档 */}
            {multi ? (
              <span className={`image-history-check${isSelected ? ' is-on' : ''}`} aria-hidden="true">
                {isSelected ? <CheckIcon /> : null}
              </span>
            ) : null}
          </span>
          {view === 'list' ? (
            <span className="image-history-item-body">
              <span className="image-history-item-prompt">{item.prompt || '（无提示词）'}</span>
              <span className="image-history-item-meta">{historyMetaOf(item, versionTag)}</span>
            </span>
          ) : null}
        </button>
        {/* 定位按钮浮在缩略图右上角：小圆底 + 图标，多选态让位给勾选圈 */}
        {onLocate && item.nodeId && !multi ? (
          <button
            type="button"
            className="image-history-item-locate nodrag"
            onClick={() => onLocate(item)}
            title="定位到画布上的这个节点"
            aria-label="定位到画布节点"
          >
            <LocateIcon />
          </button>
        ) : null}
        {onSaveAsset && item.mediaType !== 'video' && item.fileName && !multi ? (
          <button
            type="button"
            className="image-history-item-save nodrag"
            onClick={() => onSaveAsset(item)}
            title="收藏到资产库"
            aria-label="收藏到资产库"
          >
            <StarIcon />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <section
      ref={rootRef}
      className={`image-history-panel${inline ? ' is-inline' : ''}${closing ? ' is-leaving' : ''}`}
      role="dialog"
      aria-label="生成历史"
      style={position}
      onClick={(event) => event.stopPropagation()}
      onAnimationEnd={(event) => {
        // 只认面板自己的收起动画：子元素（图片等）的动画结束也会冒泡上来
        if (closing && event.target === event.currentTarget) onClosed?.();
      }}
    >
      {!inline ? <header className="image-history-head">
        <div className="image-history-title">
          <strong>生成历史</strong>
          <span>({loading ? '…' : list.length})</span>
        </div>
        <div className="image-history-head-actions">
          <button
            type="button"
            className={`image-history-multi${multi ? ' is-exit' : ''}`}
            aria-pressed={multi}
            onClick={toggleMulti}
            title={multi ? '取消多选并清空勾选' : '多选删除'}
          >
            <CheckCircleIcon />
            <span>{multi ? '取消多选' : '多选'}</span>
          </button>
          {multi ? (
            <button
              type="button"
              className={`image-history-delete${confirming ? ' is-armed' : ''}`}
              onClick={onDeleteClick}
              disabled={deleting || selectedCount === 0}
              title={confirming ? '再点一次确认删除' : '删除选中的媒体文件'}
            >
              {deleting ? '删除中…' : confirming ? '确认删除' : `删除(${selectedCount})`}
            </button>
          ) : null}
        </div>
        {revealError ? (
          <span className="image-history-reveal-error" role="alert">{revealError}</span>
        ) : null}
        <div className="image-history-views">
          <button
            type="button"
            className="image-history-view-btn"
            aria-pressed={view === 'grid'}
            aria-label="宫格视图"
            title="宫格视图"
            onClick={() => setView('grid')}
          >
            <GridIcon />
          </button>
          <button
            type="button"
            className="image-history-view-btn"
            aria-pressed={view === 'list'}
            aria-label="列表视图"
            title="列表视图"
            onClick={() => setView('list')}
          >
            <ListIcon />
          </button>
        </div>
        <button type="button" onClick={revealFolder} aria-label="打开本地文件" title="打开本地文件">
          <FolderIcon />
        </button>
      </header> : null}
      <nav className="image-history-filter" aria-label="生成历史分类">
        {([
          ['all', '全部', list.length],
          ['image', '图片', imageCount],
          ['video', '视频', videoCount],
        ] as const).map(([filter, label, count]) => (
          <button
            key={filter}
            type="button"
            className="image-history-filter-btn"
            aria-pressed={mediaFilter === filter}
            onClick={() => {
              setMediaFilter(filter);
              setSelected(new Set());
              setConfirming(false);
            }}
          >
            {label}<span>{count}</span>
          </button>
        ))}
        {inline ? (
          <div className="image-history-filter-actions">
            {revealError ? <span className="image-history-reveal-error" role="alert">{revealError}</span> : null}
            <div className="image-history-views">
              <button
                type="button"
                className="image-history-view-btn"
                aria-pressed={view === 'grid'}
                aria-label="宫格视图"
                title="宫格视图"
                onClick={() => setView('grid')}
              ><GridIcon /></button>
              <button
                type="button"
                className="image-history-view-btn"
                aria-pressed={view === 'list'}
                aria-label="列表视图"
                title="列表视图"
                onClick={() => setView('list')}
              ><ListIcon /></button>
            </div>
            <button type="button" onClick={revealFolder} aria-label="打开本地文件" title="打开本地文件">
              <FolderIcon />
            </button>
            <button type="button" className="image-history-close" onClick={onClose} aria-label="关闭生成历史" title="关闭生成历史">
              <CloseIcon />
            </button>
          </div>
        ) : null}
      </nav>
      <div className={`image-history-scroll${view === 'list' ? ' is-list' : ''}`}>
        {error ? <div className="image-history-error" role="alert">{error}</div> : null}
        {deleteError ? <div className="image-history-error" role="alert">{deleteError}</div> : null}
        {!loading && !error && visibleList.length === 0 ? (
          <div className="image-history-empty">
            {list.length === 0 ? '还没有生成记录，去画布上发送第一条提示词吧' : `暂无${mediaFilter === 'video' ? '视频' : '图片'}记录`}
          </div>
        ) : null}
        {/* 宫格只放图：prompt/meta/版本文字一律不渲染，信息都在列表视图里 */}
        {view === 'grid'
          ? visibleList.map((item) => renderItem(item))
          : groups.map((group) => (
            <section className="image-history-day" key={group.key}>
              <div className="image-history-day-label">{group.label}</div>
              {group.items.map((item) => renderItem(item))}
            </section>
          ))}
      </div>
    </section>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function LocateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="6.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 2.6v3.2M12 18.2v3.2M2.6 12h3.2M18.2 12h3.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m9 6.5 9 5.5-9 5.5v-11Z" fill="currentColor" />
    </svg>
  );
}

/** 宫格视图：四小格。 */
function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.6" y="3.6" width="7.4" height="7.4" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13" y="3.6" width="7.4" height="7.4" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.6" y="13" width="7.4" height="7.4" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13" y="13" width="7.4" height="7.4" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** 列表视图：圆点 + 横条的竖排。 */
function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8.2 6.5h12M8.2 12h12M8.2 17.5h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="4.2" cy="6.5" r="1.3" fill="currentColor" />
      <circle cx="4.2" cy="12" r="1.3" fill="currentColor" />
      <circle cx="4.2" cy="17.5" r="1.3" fill="currentColor" />
    </svg>
  );
}

/** 多选开关：圈里一个勾。 */
function CheckCircleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="m8.3 12.4 2.6 2.6 4.9-5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 勾选圈里的勾：压在图片上要够粗才看得清。 */
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12.9 4.4 4.4L19 7.3" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 版本谱系角标：V2 · 共 4 版 · 基于 V1。
 * 没有版本链的老节点（versionCount 为空）不显示——那里只有一张图，没什么可谱。
 */
function versionTagOf(item: HistoryItem, indexById: Map<string, number>): string {
  if (!item.versionCount || item.versionCount <= 0) return '';
  const label = item.versionIndex ? `V${item.versionIndex}` : '';
  const parts = [label, `共 ${item.versionCount} 版`].filter(Boolean);
  if (item.baseVersionId) {
    const baseIndex = indexById.get(`${item.nodeId}:${item.baseVersionId}`);
    parts.push(`基于 ${baseIndex ? `V${baseIndex}` : '上一版'}`);
  }
  return parts.join(' · ');
}

/** 列表条目第二排元信息：版本 → 画布 → 来源 → 时刻，弱化小字，超长自己收省略号 */
function historyMetaOf(item: HistoryItem, versionTag: string): string {
  const parts = [
    item.mediaType === 'video' ? '视频' : '图片',
    versionTag,
    item.canvasName,
    item.source === 'mcp' ? 'Codex' : '浏览器',
    formatHistoryClock(item.createdAt),
  ];
  return parts.filter(Boolean).join(' · ');
}

function historyDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 列表视图按天分组的组标题：2026-07-10，组标题与列表小图左缘对齐 */
function formatHistoryDay(value: string): string {
  const date = historyDate(value);
  if (!date) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 列表条目第二排的时刻：时:分 */
function formatHistoryClock(value: string): string {
  const date = historyDate(value);
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
