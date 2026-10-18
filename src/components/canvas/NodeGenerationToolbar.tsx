import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  AUTO_RATIO,
  MAX_IMAGE_COUNT,
  RESOLUTION_OPTIONS,
  clampImageCount,
  ratioToLabel,
  resolveAutoRatio,
} from '@/lib/aspect';
import type { ImageModelOption } from '@/lib/imageModelOptions';
import { AiGlyphIcon, ChevronGlyphIcon, ModelGlyphIcon, RatioGlyphIcon } from './NodeToolbarIcons';
import './GenSettingsPopover.css';

type OpenMenu = 'model' | 'gen' | null;

/** 比例弹窗 Tab 档位（Figma 2665:1983 只收四档）：自动打头，其后手动档从宽到窄。
 *  lib 的 RATIO_TOOLBAR_OPTIONS 是旧九档全量清单，弹窗 UI 只展示这四档。 */
const RATIO_TABS = [AUTO_RATIO, '1:1', '16:9', '9:16'] as const;

/** 数量弹窗档位：Figma 2665:1983 定稿四档（一张 ~ 四张）。
 *  lib 的 MAX_IMAGE_COUNT 是接口上限，超出的档位不进弹窗；老数据里 5~8 的历史取值
 *  临时放开显示，否则那一格会「一个档都没亮」，看着像坏了。 */
const COUNT_TABS = 4;

/** 分段滑块位置：把「当前档索引 / 总档数」写进行内变量，CSS 的 ::after 滑块据此位移。
 *  变量在 CSS 里有兜底声明（见 GenSettingsPopover.css），不会触发幽灵 Token 守护。 */
function segmentStyle(index: number, count: number): CSSProperties {
  return {
    '--gen-tab-index': String(index < 0 ? 0 : index),
    '--gen-tab-count': String(count),
  } as CSSProperties;
}

/** 一条可选项：多路生图配置里勾选的模型都汇到这里，带上来源配置名。 */
export type ModelOption = ImageModelOption;

/** 灵枢同款节点工具栏：选中生成节点时浮在节点上方，选模型 / 选画幅。 */
export default function NodeGenerationToolbar({
  style,
  model,
  modelOptions,
  ratio,
  prompt,
  references,
  direct,
  onSelectModel,
  onSelectRatio,
  onToggleDirect,
  resolution,
  onSelectResolution,
  imageCount,
  onSelectImageCount,
}: {
  style?: CSSProperties;
  model: string;
  modelOptions: ModelOption[];
  ratio: string;
  /** 当前提示词：「自动」比例档按它推导画幅（提示词显式写法 > 参考图 > 1:1）。 */
  prompt?: string;
  /** 当前参考图尺寸列表：同上，参与自动比例推导；缺传时自动退回 1:1。 */
  references?: Array<{ width?: number; height?: number }>;
  /** 智能生成总开关的兼容存储：true = Image API；false = Responses API。 */
  direct: boolean;
  onSelectModel: (model: string, profileId: string) => void;
  onSelectRatio: (ratio: string) => void;
  onToggleDirect: () => void;
  /** 分辨率档位（1K / 2K / 4K）。 */
  resolution: string;
  onSelectResolution: (resolution: string) => void;
  /** 一次生成几张（1~4）。 */
  imageCount: number;
  onSelectImageCount: (count: number) => void;
}) {
  const [open, setOpen] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点工具栏外面收起点开的浮层（画布点击由页面层再收一次）。
  // 模型是「选完即走」：选中某一项就收起，省一次点空白。
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const toggle = (menu: Exclude<OpenMenu, null>) => {
    setOpen((current) => (current === menu ? null : menu));
  };

  const activeOption = modelOptions.find((option) => option.model === model);
  const modelLabel = model || '选择模型';
  const ratioLabel = ratio === AUTO_RATIO ? '自动' : ratio;
  // 「自动」档真正生效的比例要等生成时才按「提示词显式写法 > 参考图 > 1:1」推导出来
  // （resolveAutoRatio），选项上只写「自动」两个字，用户无从确认最终会出什么画幅，
  // 所以在「自动」旁边用小字实时显示推导值；prompt / references 都缺传时推导没有输入，
  // 此时不显示推导值，只留「自动」二字。
  const autoRatioHint = prompt === undefined && references === undefined
    ? ''
    : ratioToLabel(resolveAutoRatio({ prompt, references }));

  return (
    <div ref={rootRef} className="image-node-toolbar" style={style} role="toolbar" aria-label="生成设置">
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <button
          className="image-node-toolbar-item image-node-toolbar-model active"
          type="button"
          aria-expanded={open === 'model'}
          aria-haspopup="menu"
          onClick={() => toggle('model')}
        >
          <ModelGlyphIcon />
          <span title={activeOption ? `${activeOption.profileName} · ${modelLabel}` : modelLabel}>{modelLabel}</span>
          <ChevronGlyphIcon />
        </button>
        {open === 'model' ? (
          <div className="image-model-picker image-node-model-picker nowheel" role="menu" aria-label="生成模型">
            {modelOptions.length === 0 ? (
              <div className="image-model-empty">暂无可用的模型，请先在「模型设置」里勾选</div>
            ) : (
              <div className="image-model-options">
                {modelOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.model === model && option.profileId === activeOption?.profileId}
                    className={option.model === model && option.profileId === activeOption?.profileId ? 'active' : ''}
                    onClick={() => {
                      onSelectModel(option.model, option.profileId);
                      setOpen(null);
                    }}
                  >
                    <span className="image-model-option-text">
                      <strong>{option.model}</strong>
                      <small>{option.profileName}</small>
                    </span>
                    {option.model === model && option.profileId === activeOption?.profileId ? (
                      <span className="image-model-option-check" aria-hidden="true">
                        <svg viewBox="0 0 16 16" fill="none">
                          <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </span>
      <button
        className={`image-node-toolbar-item ${open === 'gen' ? 'active' : ''}`}
        type="button"
        aria-expanded={open === 'gen'}
        aria-haspopup="menu"
        onClick={() => toggle('gen')}
        title={ratio === AUTO_RATIO && autoRatioHint ? `自动比例（当前推导 ${autoRatioHint}）` : '生成比例'}
      >
        <RatioGlyphIcon />
        {/* 固定宽度槽：自动 ↔ 16:9 ↔ 9:16 字数不同，不钉宽的话工具栏会随档位左右抖 */}
        <span className="image-node-toolbar-ratio-label">{ratioLabel}</span>
        <ChevronGlyphIcon />
      </button>
      {/* 单一入口：关闭直连 Image API；开启由 Responses 主模型理解并调用图像工具。 */}
      <button
        type="button"
        role="switch"
        aria-checked={!direct}
        aria-label="智能生成"
        title={direct ? '当前直连 Image API；打开后由 Responses API 智能编排，并支持连续编辑' : '当前使用 Responses API 智能生成；关闭后直连 Image API'}
        className={`image-node-toolbar-item image-node-toolbar-switch ${direct ? '' : 'on'}`}
        onClick={onToggleDirect}
      >
        <AiGlyphIcon />
        <span>智能生成</span>
        <span className="image-node-toolbar-switch-track" aria-hidden="true"><i /></span>
      </button>
      {open === 'gen' ? (
        <div className="image-node-settings-popover gen-settings-popover nowheel" role="menu" aria-label="生成设置">
          {/* 比例 / 画质 / 数量 三段平铺（Figma 2665:1983）：全部横向 Tab，不做纵向列表 */}
          <div className="gen-settings-block">
            <span className="gen-settings-block-title">比例</span>
            <div className="gen-settings-tabs" style={segmentStyle(RATIO_TABS.findIndex((item) => item === ratio), RATIO_TABS.length)}>
              {RATIO_TABS.map((item) => {
                const isAuto = item === AUTO_RATIO;
                const active = item === ratio;
                return (
                  <button
                    key={item}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={`gen-settings-tab gen-settings-tab-stack ${active ? 'active' : ''}`}
                    title={
                      isAuto
                        ? autoRatioHint
                          ? `自动比例（当前推导 ${autoRatioHint}：提示词显式写法 > 参考图 > 1:1）`
                          : '自动比例：提示词显式写法 > 参考图 > 1:1'
                        : `生成比例 ${item}`
                    }
                    onClick={() => onSelectRatio(item)}
                  >
                    {isAuto ? <RatioGlyphIcon /> : <RatioShapeGlyph label={item} />}
                    <span>{isAuto ? '自动' : item}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="gen-settings-block">
            <span className="gen-settings-block-title">画质</span>
            <div className="gen-settings-tabs" style={segmentStyle(RESOLUTION_OPTIONS.findIndex((item) => item === resolution), RESOLUTION_OPTIONS.length)}>
              {RESOLUTION_OPTIONS.map((item) => {
                const active = item === resolution;
                return (
                  <button
                    key={item}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={`gen-settings-tab ${active ? 'active' : ''}`}
                    title={item === '4K' ? '4K 高清大图：细节最多，但更慢也更贵' : `${item} 画质`}
                    onClick={() => onSelectResolution(item)}
                  >
                    <span>{item}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="gen-settings-block">
            <span className="gen-settings-block-title">数量</span>
            <div
              className="gen-settings-tabs"
              style={segmentStyle(clampImageCount(imageCount) - 1, Math.min(MAX_IMAGE_COUNT, Math.max(COUNT_TABS, imageCount)))}
            >
              {Array.from({ length: Math.min(MAX_IMAGE_COUNT, Math.max(COUNT_TABS, imageCount)) }, (_, index) => {
                const count = index + 1;
                const active = count === imageCount;
                return (
                  <button
                    key={count}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={`gen-settings-tab ${active ? 'active' : ''}`}
                    title={`一次生成 ${count} 张`}
                    onClick={() => onSelectImageCount(count)}
                  >
                    <span>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 比例 Tab 的形状缩略：一条边框画出宽窄（Figma 2665:2015~2025），
 *  选中态由 CSS 提亮边框；宽高按 label 走，1:1 正方、16:9 横条、9:16 竖条。 */
function RatioShapeGlyph({ label }: { label: string }) {
  return <i className="gen-settings-shape" data-shape={label} aria-hidden="true" />;
}
