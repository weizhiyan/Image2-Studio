import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { VideoModelSchema, VideoParamSpec, VideoRatio, VideoReferenceMode, VideoResolution } from '@/types';
import { VIDEO_RATIOS, VIDEO_RESOLUTIONS } from '@/types';
import { fetchVideoPriceQuote, type VideoPriceQuote } from '@/lib/bridge';
import ParameterSlider from '@/components/ParameterSlider';
import QuantitySegments from '@/components/QuantitySegments';
import { ChevronGlyphIcon, ModelGlyphIcon, RatioGlyphIcon, VideoGlyphIcon } from './NodeToolbarIcons';
import './GenSettingsPopover.css';

type OpenMenu = 'model' | 'settings' | null;
const VIDEO_SECONDS_MIN = 4;
const VIDEO_SECONDS_MAX = 15;
const DEFAULT_VIDEO_SECONDS = 5;
/** 超过这个档位数的下拉改用原生 select：15 个时长档塞进分段控件会挤成一团。 */
const MAX_SEGMENT_OPTIONS = 6;

function segmentStyle(index: number, count: number): CSSProperties {
  return {
    '--gen-tab-index': String(index < 0 ? 0 : index),
    '--gen-tab-count': String(count),
  } as CSSProperties;
}

/* ── 按模型 schema 渲染的单参数控件 ──
   schema 来自中转站 /v1/skills/models/{name}，各家字段名与可选值都不一样：
   seedance 用 images、wan2.6 用 img_url、gk-video 又不同。所以这里只认 type，
   不认参数名。 */
function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: VideoParamSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const options = spec.options || [];

  const quantityOptions = !/^(duration|seconds|video_seconds)$/i.test(spec.name)
    && /(?:^|[^a-z])(?:n|count|quantity|qty|num|number)(?:$|[^a-z])|数量|张数|个数|批次/i.test(`${spec.name} ${spec.label}`)
    ? options.map((option) => Number(option.value))
    : [];
  if (quantityOptions.length > 0 && quantityOptions.every(Number.isInteger) && new Set(quantityOptions).size === quantityOptions.length) {
    return (
      <QuantitySegments
        ariaLabel={spec.label}
        min={Math.min(...quantityOptions)}
        max={Math.max(...quantityOptions)}
        options={quantityOptions}
        value={Number(value ?? quantityOptions[0])}
        onChange={(quantity) => onChange(options.find((option) => Number(option.value) === quantity)?.value)}
      />
    );
  }

  if (/^(duration|seconds|video_seconds)$/i.test(spec.name) && options.length > 1) {
    const numericOptions = options.map((option) => Number(option.value));
    if (numericOptions.every(Number.isFinite)) {
      const currentIndex = Math.max(0, options.findIndex((option) => option.value === String(value ?? '')));
      return (
        <ParameterSlider
          ariaLabel={spec.label}
          min={0}
          max={options.length - 1}
          value={currentIndex}
          valueLabel={options[currentIndex].label}
          minLabel={options[0].label}
          maxLabel={options[options.length - 1].label}
          onChange={(index) => onChange(options[index].value)}
        />
      );
    }
  }

  if (spec.type === 'switch') {
    const on = value === true || value === 'true';
    return (
      <div className="video-settings-audio-row">
        <span>{spec.label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={spec.label}
          className={`image-node-toolbar-item image-node-toolbar-switch ${on ? 'on' : ''}`}
          onClick={() => onChange(!on)}
        >
          <span className="image-node-toolbar-switch-track" aria-hidden="true"><i /></span>
        </button>
      </div>
    );
  }

  if (spec.type === 'number') {
    return (
      <input
        className="video-param-input"
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
        aria-label={spec.label}
        onChange={(event) => onChange(event.currentTarget.value === '' ? '' : Number(event.currentTarget.value))}
      />
    );
  }

  if (options.length === 0) {
    return (
      <input
        className="video-param-input"
        type="text"
        value={value === undefined || value === null ? '' : String(value)}
        aria-label={spec.label}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }

  if (options.length <= MAX_SEGMENT_OPTIONS) {
    const index = options.findIndex((option) => option.value === String(value ?? ''));
    return (
      <div
        className="gen-settings-tabs"
        role="radiogroup"
        aria-label={spec.label}
        style={segmentStyle(index, options.length)}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === String(value ?? '')}
            className={`gen-settings-tab ${option.value === String(value ?? '') ? 'active' : ''}`}
            title={`${spec.label} ${option.label}`}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <select
      className="video-param-select"
      value={String(value ?? '')}
      aria-label={spec.label}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

/** schema 驱动的参数面板：字段名、可选值、必填全按模型自己声明走。 */
export function SchemaSettingsPopover({
  schema,
  values,
  onChange,
  schemaLoading,
  schemaError,
  priceQuote,
  priceLoading,
  priceError,
}: {
  schema: VideoModelSchema;
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  schemaLoading?: boolean;
  schemaError?: string;
  priceQuote?: VideoPriceQuote | null;
  priceLoading?: boolean;
  priceError?: string;
}) {
  const uploadParams = schema.params.filter((spec) => spec.type === 'upload');
  const visible = schema.params.filter((spec) => spec.type !== 'upload' && spec.type !== 'textarea');
  return (
    <div className="image-node-settings-popover gen-settings-popover video-settings-popover nowheel" role="dialog" aria-label="视频参数">
      {schemaError ? <p className="video-param-hint is-error">{schemaError}</p> : null}
      {schemaLoading ? <p className="video-param-hint">正在读取模型参数…</p> : null}
      <VideoPriceHint quote={priceQuote} loading={priceLoading} error={priceError} />
      {visible.map((spec) => (
        <div className="gen-settings-block" key={spec.name}>
          <span className="gen-settings-block-title">
            {spec.label}
            {spec.required ? <em className="video-param-required" aria-label="必填"> *</em> : null}
          </span>
          <ParamControl
            spec={spec}
            value={values[spec.name]}
            onChange={(value) => onChange(spec.name, value)}
          />
        </div>
      ))}
      {uploadParams.length > 0 ? (
        <p className="video-param-hint">
          {uploadParams.map((spec) => spec.label).join(' / ')}：由画布上连到本节点的图片提供
        </p>
      ) : null}
    </div>
  );
}

export interface VideoSettingsPopoverProps {
  seconds: number;
  resolution: VideoResolution;
  ratio: VideoRatio;
  generateAudio: boolean;
  referenceMode?: VideoReferenceMode;
  schemaError?: string;
  schemaLoading?: boolean;
  priceQuote?: VideoPriceQuote | null;
  priceLoading?: boolean;
  priceError?: string;
  onSelectSeconds: (seconds: number) => void;
  onSelectResolution: (resolution: VideoResolution) => void;
  onSelectRatio: (ratio: VideoRatio) => void;
  onSelectReferenceMode?: (mode: VideoReferenceMode) => void;
  onToggleAudio: () => void;
}

/** 旧协议的兜底面板：没有 schema 的配置（OpenAI Videos / GrsAI）继续用这套固定三件套。 */
export function VideoSettingsPopover({
  seconds,
  resolution,
  ratio,
  generateAudio,
  referenceMode = 'first_frame',
  schemaError,
  schemaLoading,
  priceQuote,
  priceLoading,
  priceError,
  onSelectSeconds,
  onSelectResolution,
  onSelectRatio,
  onSelectReferenceMode,
  onToggleAudio,
}: VideoSettingsPopoverProps) {
  return (
    <div className="image-node-settings-popover gen-settings-popover video-settings-popover nowheel" role="dialog" aria-label="视频参数">
      {schemaError ? <p className="video-param-hint is-error" role="alert">{schemaError}</p> : null}
      {!schemaError && schemaLoading ? <p className="video-param-hint" role="status">正在读取模型参数…</p> : null}
      <VideoPriceHint quote={priceQuote} loading={priceLoading} error={priceError} />
      <div className="gen-settings-block">
        <span className="gen-settings-block-title" id="video-ratio-title">比例</span>
        <div
          className="gen-settings-tabs video-settings-ratio-tabs"
          role="radiogroup"
          aria-labelledby="video-ratio-title"
          style={segmentStyle(VIDEO_RATIOS.indexOf(ratio), VIDEO_RATIOS.length)}
        >
          {VIDEO_RATIOS.map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={item === ratio}
              className={`gen-settings-tab ${item === ratio ? 'active' : ''}`}
              title={`视频比例 ${item}`}
              onClick={() => onSelectRatio(item)}
            >
              <span>{item}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="gen-settings-block">
        <span className="gen-settings-block-title" id="video-resolution-title">画质</span>
        <div
          className="gen-settings-tabs"
          role="radiogroup"
          aria-labelledby="video-resolution-title"
          style={segmentStyle(VIDEO_RESOLUTIONS.indexOf(resolution), VIDEO_RESOLUTIONS.length)}
        >
          {VIDEO_RESOLUTIONS.map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={item === resolution}
              className={`gen-settings-tab ${item === resolution ? 'active' : ''}`}
              title={`${item} 画质`}
              onClick={() => onSelectResolution(item)}
            >
              <span>{item}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="gen-settings-block">
        <span className="gen-settings-block-title">时长</span>
        <ParameterSlider
          ariaLabel="视频时长"
          min={VIDEO_SECONDS_MIN}
          max={VIDEO_SECONDS_MAX}
          value={seconds}
          valueLabel={`${seconds}s`}
          minLabel={`${VIDEO_SECONDS_MIN}s`}
          maxLabel={`${VIDEO_SECONDS_MAX}s`}
          onChange={onSelectSeconds}
        />
      </div>

      <div className="gen-settings-block">
        <span className="gen-settings-block-title" id="video-reference-mode-title">连接图片用途</span>
        <div
          className="gen-settings-tabs"
          role="radiogroup"
          aria-labelledby="video-reference-mode-title"
          style={segmentStyle(['first_frame', 'last_frame', 'style'].indexOf(referenceMode), 3)}
        >
          {([
            ['first_frame', '首帧'],
            ['last_frame', '尾帧'],
            ['style', '风格'],
          ] as Array<[VideoReferenceMode, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={referenceMode === value}
              className={`gen-settings-tab ${referenceMode === value ? 'active' : ''}`}
              onClick={() => onSelectReferenceMode?.(value)}
            >
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="video-settings-audio-row">
        <span>生成声音</span>
        <button
          type="button"
          role="switch"
          aria-checked={generateAudio}
          aria-label="生成声音"
          className={`image-node-toolbar-item image-node-toolbar-switch ${generateAudio ? 'on' : ''}`}
          onClick={onToggleAudio}
        >
          <span className="image-node-toolbar-switch-track" aria-hidden="true"><i /></span>
        </button>
      </div>
    </div>
  );
}

export interface VideoModelOption {
  key: string;
  model: string;
  profileId: string;
  profileName: string;
}

/** 工具栏按钮上的参数摘要：schema 模式下取前几个已选值，旧协议走固定三件套。 */
function schemaSummary(schema: VideoModelSchema | null | undefined, values: Record<string, unknown>): string {
  if (!schema) return '';
  const parts: string[] = [];
  const priorityNames = [/^(aspect_ratio|ratio)$/i, /^(resolution|quality)$/i, /^(duration|seconds|video_seconds)$/i];
  const priority = priorityNames.flatMap((pattern) => schema.params.filter((spec) => pattern.test(spec.name)));
  const ordered = [...priority, ...schema.params.filter((spec) => !priority.includes(spec))];
  for (const spec of ordered) {
    if (spec.type === 'upload' || spec.type === 'textarea') continue;
    const value = values[spec.name];
    if (value === undefined || value === null || value === '') continue;
    if (spec.type === 'switch') {
      if (value === true || value === 'true') parts.push(spec.label);
      continue;
    }
    const hit = spec.options?.find((option) => option.value === String(value));
    parts.push(hit ? hit.label : String(value));
    if (parts.length >= 3) break;
  }
  return parts.join(' · ');
}

function VideoPriceHint({ quote, loading, error }: {
  quote?: VideoPriceQuote | null;
  loading?: boolean;
  error?: string;
}) {
  if (loading) return <p className="video-param-hint video-price-hint" role="status">正在查询余额与最低参考价…</p>;
  if (error) return <p className="video-param-hint video-price-hint" role="note">费用预览暂不可用：{error}</p>;
  if (!quote) return null;
  if (!quote.supported) return null;
  const unit = quote.unit || '算力';
  const balance = Number.isFinite(quote.balance) ? `${quote.balance} ${unit}` : '余额未知';
  const estimate = Number.isFinite(quote.minimumEstimate)
    ? `最低参考约 ${quote.minimumEstimate!.toFixed(3)} ${unit} / ${quote.seconds} 秒`
    : `按 ${quote.billingMethod || '未知方式'} 计费，无法准确预估`;
  const lowBalance = Number.isFinite(quote.balance) && Number.isFinite(quote.minimumEstimate)
    && quote.balance! < quote.minimumEstimate!;
  return (
    <p className={`video-param-hint video-price-hint${lowBalance ? ' is-low' : ''}`} role="note">
      {balance} · {estimate}。{quote.warning}
    </p>
  );
}

export default function NodeVideoToolbar({
  style,
  model,
  profileId,
  modelOptions,
  seconds,
  resolution,
  ratio,
  generateAudio,
  schema,
  schemaLoading,
  schemaError,
  priceQuote: externalPriceQuote,
  priceLoading: externalPriceLoading,
  priceError: externalPriceError,
  paramValues,
  onChangeParam,
  onSelectModel,
  onSelectSeconds,
  onSelectResolution,
  onSelectRatio,
  referenceMode,
  onSelectReferenceMode,
  onToggleAudio,
}: {
  style?: CSSProperties;
  model: string;
  profileId: string;
  modelOptions: VideoModelOption[];
  seconds: number;
  resolution: VideoResolution;
  ratio: VideoRatio;
  generateAudio: boolean;
  /** 当前模型的参数定义；为空时回落到旧的固定三件套。 */
  schema?: VideoModelSchema | null;
  schemaLoading?: boolean;
  schemaError?: string;
  priceQuote?: VideoPriceQuote | null;
  priceLoading?: boolean;
  priceError?: string;
  /** 按 schema 选出的参数值。 */
  paramValues?: Record<string, unknown>;
  onChangeParam?: (name: string, value: unknown) => void;
  referenceMode?: VideoReferenceMode;
  onSelectModel: (model: string, profileId: string) => void;
  onSelectSeconds: (seconds: number) => void;
  onSelectResolution: (resolution: VideoResolution) => void;
  onSelectRatio: (ratio: VideoRatio) => void;
  onSelectReferenceMode?: (mode: VideoReferenceMode) => void;
  onToggleAudio: () => void;
}) {
  const [open, setOpen] = useState<OpenMenu>(null);
  const [fetchedPriceQuote, setFetchedPriceQuote] = useState<VideoPriceQuote | null>(null);
  const [fetchedPriceLoading, setFetchedPriceLoading] = useState(false);
  const [fetchedPriceError, setFetchedPriceError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const toggle = (menu: Exclude<OpenMenu, null>) => {
    setOpen((current) => (current === menu ? null : menu));
  };
  const activeOption = modelOptions.find((option) => option.model === model && option.profileId === profileId);
  const modelLabel = model || '选择模型';
  const selectedSeconds = Math.min(VIDEO_SECONDS_MAX, Math.max(VIDEO_SECONDS_MIN, Math.floor(Number(seconds) || DEFAULT_VIDEO_SECONDS)));
  const selectedRatio = (VIDEO_RATIOS as readonly string[]).includes(ratio) ? ratio : '16:9';
  const selectedResolution = (VIDEO_RESOLUTIONS as readonly string[]).includes(resolution) ? resolution : '480p';
  const dynamicSummary = schemaSummary(schema, paramValues || {});
  const durationParam = schema?.params.find((spec) => /^(duration|seconds|video_seconds)$/i.test(spec.name));
  const quoteSeconds = Number(paramValues?.[durationParam?.name || '']) || selectedSeconds;
  const currentPriceQuote = externalPriceQuote ?? fetchedPriceQuote;
  const currentPriceLoading = externalPriceLoading ?? fetchedPriceLoading;
  const currentPriceError = externalPriceError ?? fetchedPriceError;
  const settingsLabel = dynamicSummary
    || `${selectedRatio} · ${selectedResolution} · ${selectedSeconds}s · ${generateAudio ? '有声音' : '无声音'}`;

  useEffect(() => {
    if (open !== 'settings' || !profileId || !model || externalPriceQuote !== undefined) return undefined;
    let alive = true;
    const timer = window.setTimeout(() => {
      setFetchedPriceQuote(null);
      setFetchedPriceLoading(true);
      setFetchedPriceError('');
      void fetchVideoPriceQuote(profileId, model, quoteSeconds).then((quote) => {
        if (alive) setFetchedPriceQuote(quote);
      }).catch((error: unknown) => {
        if (alive) setFetchedPriceError(error instanceof Error ? error.message : '查询失败');
      }).finally(() => {
        if (alive) setFetchedPriceLoading(false);
      });
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [externalPriceQuote, model, open, profileId, quoteSeconds]);

  return (
    <div ref={rootRef} className="image-node-toolbar hb-video-toolbar" style={style} role="toolbar" aria-label="视频生成设置">
      <span className="hb-video-model-anchor">
        <button
          className="image-node-toolbar-item image-node-toolbar-model active"
          type="button"
          aria-expanded={open === 'model'}
          aria-haspopup="menu"
          aria-label={`视频模型：${activeOption?.profileName ? `${activeOption.profileName}，` : ''}${modelLabel}`}
          onClick={() => toggle('model')}
        >
          <ModelGlyphIcon />
          <span className="hb-video-model-label" title={activeOption ? `${activeOption.profileName} · ${modelLabel}` : modelLabel}>{modelLabel}</span>
          <ChevronGlyphIcon />
        </button>
        {open === 'model' ? (
          <div className="image-model-picker image-node-model-picker nowheel" role="menu" aria-label="视频模型">
            {modelOptions.length === 0 ? (
              <div className="image-model-empty">暂无可用的视频模型，请先在「模型设置」里添加并勾选</div>
            ) : (
              <div className="image-model-options">
                {modelOptions.map((option) => {
                  const active = option.model === model && option.profileId === profileId;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={active ? 'active' : ''}
                      onClick={() => {
                        onSelectModel(option.model, option.profileId);
                        setOpen(null);
                      }}
                    >
                      <span className="image-model-option-text">
                        <strong>{option.model}</strong>
                        <small>{option.profileName}</small>
                      </span>
                      {active ? (
                        <span className="image-model-option-check" aria-hidden="true">
                          <svg viewBox="0 0 16 16" fill="none">
                            <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </span>

      <button
        className={`image-node-toolbar-item hb-video-settings-button ${open === 'settings' ? 'active' : ''}`}
        type="button"
        aria-expanded={open === 'settings'}
        aria-haspopup="dialog"
        aria-label={`视频参数：${settingsLabel}`}
        title={settingsLabel}
        onClick={() => toggle('settings')}
      >
        <VideoGlyphIcon />
        <span className="hb-video-settings-label">{settingsLabel}</span>
        <ChevronGlyphIcon />
      </button>

      {open === 'settings' ? (
        schema ? (
          <SchemaSettingsPopover
            schema={schema}
            values={paramValues || {}}
            onChange={(name, value) => onChangeParam?.(name, value)}
            schemaLoading={schemaLoading}
            schemaError={schemaError}
            priceQuote={currentPriceQuote}
            priceLoading={currentPriceLoading}
            priceError={currentPriceError}
          />
        ) : (
          <VideoSettingsPopover
            seconds={selectedSeconds}
            resolution={selectedResolution}
            ratio={selectedRatio}
            generateAudio={generateAudio}
            referenceMode={referenceMode || 'first_frame'}
            schemaError={schemaError}
            schemaLoading={schemaLoading}
            priceQuote={currentPriceQuote}
            priceLoading={currentPriceLoading}
            priceError={currentPriceError}
            onSelectSeconds={onSelectSeconds}
            onSelectResolution={onSelectResolution}
            onSelectRatio={onSelectRatio}
            onSelectReferenceMode={onSelectReferenceMode}
            onToggleAudio={onToggleAudio}
          />
        )
      ) : null}
    </div>
  );
}

export { RatioGlyphIcon };
