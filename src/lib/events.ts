import type { CanvasGroupColor, CanvasNodeVersion } from '@/types';

/** 节点组件 ↔ 页面协调层走自定义事件：节点保持纯展示，页面持有 ReactFlow 实例。 */

export function emitEvent<TDetail>(name: string, detail: TDetail): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function onEvent<TDetail>(name: string, handler: (detail: TDetail) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<TDetail>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}

/** 节点动效相关：动画播完通知页面摘 class / 手柄开始拉伸（灵枢 lingshu:image-node-* 同款语义）。 */
export const NODE_ANIMATION_EVENTS = {
  done: 'hb:image-node-animation-end',
  resizeStart: 'hb:image-node-resize-start',
} as const;

export interface NodeAnimationDoneDetail { nodeId: string }
export interface NodeResizeStartDetail {
  nodeId: string;
  clientX: number;
  clientY: number;
  pointerId?: number;
  pointerTarget?: HTMLElement;
}

export const NODE_EVENTS = {
  prompt: 'hb:image-node-prompt',
  run: 'hb:image-node-run',
  focus: 'hb:image-node-focus',
  referenceRemove: 'hb:image-node-reference-remove',
  preview: 'hb:image-node-preview',
  upload: 'hb:image-node-upload',
  connect: 'hb:image-node-connect',
  /** 结果图节点的「二次编辑」：就地转成生成态，在原图上继续迭代（图生图）。 */
  redit: 'hb:image-node-redit',
  /** 取消二次编辑：节点从生成态退回图片态，主图不变。 */
  reditCancel: 'hb:image-node-redit-cancel',
  /** 版本宫格里把某一版设为主图。 */
  versionSetMain: 'hb:image-node-version-set-main',
  /** 全部版本宫格收起：点空白处 / 换选节点 / 按 Esc 时广播。 */
  versionsCollapse: 'hb:image-node-versions-collapse',
  /** 指定节点摊开版本宫格：历史面板「定位」用，别的节点不响应。 */
  versionsExpand: 'hb:image-node-versions-expand',
  /** 版本宫格摊开后把视角收进来：节点摊成两列后会超出视口，这一步负责退到看得全。 */
  versionsFit: 'hb:image-node-versions-fit',
  /** composer：参考图 chips 拖拽换序（影响「图一 / 图二」编号与发送顺序）。 */
  referenceReorder: 'hb:image-node-reference-reorder',
  /* ── 视频节点（kind: 'video'）──
     视频是长任务，事件语义与图片的 run 不同：提交后节点进入进度态，
     bridge 轮询到结果经 SSE 回填，取消只是摘掉本地监听、上游任务照样跑（省得重复计费）。 */
  videoRun: 'hb:video-node-run',
  videoOptimize: 'hb:video-node-optimize',
  videoCancel: 'hb:video-node-cancel',
  videoRecover: 'hb:video-node-recover',
  videoRedit: 'hb:video-node-redit',
  textContent: 'hb:canvas-text-content',
  textOptimize: 'hb:canvas-text-optimize',
  textOptimizeResult: 'hb:canvas-text-optimize-result',
} as const;

/** 编组节点只负责发意图；改图、撤销与级联删除仍由 CanvasPage 统一处理。 */
export const CANVAS_GROUP_EVENTS = {
  rename: 'hb:canvas-group-rename',
  color: 'hb:canvas-group-color',
  dissolve: 'hb:canvas-group-dissolve',
} as const;

export interface CanvasGroupRenameDetail { nodeId: string; label: string }
export interface CanvasGroupColorDetail { nodeId: string; color: CanvasGroupColor }
export interface CanvasGroupActionDetail { nodeId: string }

export interface NodePromptDetail { nodeId: string; prompt: string }
export interface NodeRunDetail { nodeId: string; prompt: string }
export interface NodeFocusDetail { nodeId: string }
export interface NodeReferenceRemoveDetail { nodeId: string; url: string; referenceId?: string }
/** 开灯箱：默认看节点当前主图；传 version 则看版本宫格里指定那一版。 */
export interface NodePreviewDetail { nodeId: string; version?: CanvasNodeVersion }
export interface NodeUploadDetail { nodeId: string; reference?: boolean }
/** 点击节点左右两侧连接手柄的「+」：打开可连接节点菜单（灵枢 image-node-connect 同款）。 */
export interface NodeReditDetail { nodeId: string }
export interface NodeReditCancelDetail { nodeId: string }
export interface NodeVersionSetMainDetail { nodeId: string; versionId: string }
export interface NodeVersionsExpandDetail { nodeId: string }
export interface NodeVersionsFitDetail { nodeId: string }
/** 参考图换序：order 是 reference id 数组，页面据此落库（referenceOrder）。 */
export interface NodeReferenceReorderDetail { nodeId: string; order: string[] }
export interface NodeConnectDetail {
  nodeId: string;
  clientX: number;
  clientY: number;
  direction: 'source' | 'target';
}

/** 视频节点提交：参数已保存在节点 data，页面按节点当前值提交。 */
export interface NodeVideoRunDetail { nodeId: string; prompt: string }
export interface NodeVideoOptimizeDetail { nodeId: string; prompt: string; action?: 'optimize' | 'undo' }
export interface NodeVideoCancelDetail { nodeId: string }
export interface NodeVideoRecoverDetail { nodeId: string }
export interface NodeTextContentDetail { nodeId: string; text: string }
export interface NodeTextOptimizeDetail { nodeId: string; text: string }
export interface NodeTextOptimizeResultDetail { nodeId: string; text?: string; error?: string }
/** 视频完成后「再生成一版」：节点退回输入态，提示词与参数保留。 */
export interface NodeVideoReditDetail { nodeId: string }
