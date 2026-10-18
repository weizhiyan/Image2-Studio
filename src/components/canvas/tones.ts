/**
 * 节点类型 → 色相：TS 侧的唯一副本。
 *
 * CSS 侧的对应表在 Nodes.css 顶部（`[data-tone="…"] { --tone-color: … }`），
 * 两边由 tokens.guard.test.ts 的 TONE_MAP 逐条锁住 —— 改色只需要改这两处，
 * 且必须同时改，否则 `npm test` 红。
 *
 * 为什么单独抽一个模块：P6 之前这张表在项目里存在四份（Nodes.css 里三份、
 * NodePanel.tsx 一份、NodeConfigPanel.tsx 一份），彼此都不一致，于是
 * "节点库里五颜六色，拖到画布上大半变灰"。CSS 侧已经合成一张，TS 侧合到这里。
 */

/** 画布节点类型 → 色相 Token。键与 canvasStore 的 node.type 一致。 */
export const NODE_TYPE_COLOR: Record<string, string> = {
  input: 'var(--color-accent-green)',
  identity: 'var(--color-accent-purple)',
  skill: 'var(--color-accent-amber)',
  memory: 'var(--color-accent-teal)',
  knowledge: 'var(--color-accent-teal)',
  agent: 'var(--color-accent-blue)',
  miniAgent: 'var(--color-text-secondary)',
  model: 'var(--color-accent-blue)',
  output: 'var(--color-text-tertiary)',
};

/**
 * 生图 Agent 与内置 Agent 是同一个节点类型（miniAgent + imageGeneration），
 * 只在色相上分一档紫。画布侧对应 `[data-tone="tone-mini-agent"][data-variant="image"]`。
 */
export const IMAGE_AGENT_COLOR = 'var(--color-accent-purple)';

/** 尚未实装的节点（Trigger / Publish 这类）在库里统一是中性灰，不进 tone 表。 */
export const COMING_SOON_COLOR = 'var(--color-text-tertiary)';
