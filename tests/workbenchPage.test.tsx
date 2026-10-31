import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HistoryItem, VideoModelSchema } from '@/types';
import ParameterSlider from '@/components/ParameterSlider';
import QuantitySegments from '@/components/QuantitySegments';
import HistoryPanel from '@/components/canvas/HistoryPanel';
import WorkbenchPage, {
  applyVideoMode,
  isWorkbenchPath,
  mergeWorkbenchHistory,
  referenceLabel,
  videoQuantityRange,
  videoQuantityValues,
  videoControlParams,
  visibleVideoParams,
  WorkbenchStageBackdrop,
  workbenchStageState,
  type WorkbenchResult,
} from '@/pages/WorkbenchPage';

const CSS = readFileSync(
  fileURLToPath(new URL('../src/pages/workbench-page.css', import.meta.url)),
  'utf8',
);
const GLOBAL_CSS = readFileSync(
  fileURLToPath(new URL('../src/styles/global.css', import.meta.url)),
  'utf8',
);
const WORKBENCH_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/pages/WorkbenchPage.tsx', import.meta.url)),
  'utf8',
);
const SLIDER_CSS = readFileSync(
  fileURLToPath(new URL('../src/components/ParameterSlider.css', import.meta.url)),
  'utf8',
);
const HISTORY_CSS = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/HistoryPanel.css', import.meta.url)),
  'utf8',
);

const schema: VideoModelSchema = {
  name: 'video-model',
  params: [
    { name: 'duration', label: '时长', type: 'select', options: [{ label: '5 秒', value: '5' }] },
    { name: 'prompt', label: '提示词', type: 'textarea' },
    { name: 'image', label: '首帧', type: 'upload' },
    { name: 'mode', label: '模式', type: 'radio', options: [{ label: '图生视频', value: 'image' }] },
  ],
};

function result(overrides: Partial<WorkbenchResult> = {}): WorkbenchResult {
  return {
    id: 'current',
    url: '/api/files/current.png',
    mediaType: 'image',
    title: '当前结果',
    prompt: '一只白色纸船',
    model: 'image-model',
    size: '1024x1024',
    fileName: 'current.png',
    canvasId: 'workbench',
    createdAt: '2026-10-25T10:00:00.000Z',
    ...overrides,
  };
}

function history(overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    mediaType: 'image',
    url: '/api/files/history.png',
    prompt: '历史图片',
    enhancedPrompt: '',
    revisedPrompt: '',
    model: 'image-model',
    size: '1024x1024',
    fileName: 'history.png',
    canvasId: 'canvas-1',
    canvasName: '画布一',
    createdAt: '2026-10-24T10:00:00.000Z',
    source: 'browser',
    ...overrides,
  };
}

describe('WorkbenchPage', () => {
  it('只匹配工作台路径', () => {
    expect(isWorkbenchPath('/workbench')).toBe(true);
    expect(isWorkbenchPath('/workbench/')).toBe(true);
    expect(isWorkbenchPath('/workbench?tab=video')).toBe(true);
    expect(isWorkbenchPath('/')).toBe(false);
    expect(isWorkbenchPath('/workbench-extra')).toBe(false);
  });

  it('渲染图像与视频入口、提示词和空状态', () => {
    const html = renderToStaticMarkup(<WorkbenchPage />);
    expect(html).toContain('图像生成');
    expect(html).toContain('视频生成');
    expect(html).toContain('无限画布');
    expect(html).toContain('提示词');
    expect(html).toContain('上传参考图');
    expect(html).toContain('生成图片');
    expect(html).toContain('生成结果');
    expect(html).toContain('打开生成历史');
    expect(html).toContain('从一段描述开始');
    expect(html).toContain('尚未配置生图模型');
    expect(html).toContain('class="workbench-header hb-topbar"');
    expect(html).toContain('模型设置');
    expect(html).toContain('aria-label="连接第三方 Agent"');
    expect(html).toContain('class="workbench-prompt-composer"');
    expect(html).toContain('aria-label="提示词"');
    expect(html).toContain('class="workbench-parameter-row"');
    expect(html).toContain('aria-label="图片比例"');
    expect(html).toContain('aria-label="图片清晰度"');
    expect(html).toContain('aria-label="图片数量"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('workbench-canvas-link');
    expect(html).not.toContain('0/2000');
    expect(html).not.toContain('workbench-video-tabs');
    expect(html).not.toContain('将使用当前模型配置生成');
  });

  it('图片上传状态决定图生视频或文生视频，不需要额外模式 Tab', () => {
    expect(WORKBENCH_SOURCE).toContain("const videoMode: WorkbenchVideoMode = primaryReference ? 'image' : 'text';");
    expect(WORKBENCH_SOURCE).not.toContain('handleVideoModeChange');
    expect(WORKBENCH_SOURCE).not.toContain('workbench-video-tabs');
  });

  it('多张参考图按顺序标注并继续使用现有参考图数组接口', () => {
    expect(referenceLabel(0)).toBe('1');
    expect(referenceLabel(2)).toBe('3');
    expect(referenceLabel(10)).toBe('11');
    expect(WORKBENCH_SOURCE).toContain('multiple={mode === \'image\'}');
    expect(WORKBENCH_SOURCE).toContain('references.map((item) => item.dataUrl)');
    expect(WORKBENCH_SOURCE).toContain('继续添加参考图');
    expect(CSS).toContain('.workbench-reference-grid');
    expect(CSS).toContain('.workbench-reference-remove');
    expect(CSS).toMatch(/\.workbench-reference-card\s*\{[^}]*width: 80px[^}]*height: 80px/s);
    expect(CSS).toMatch(/\.workbench-reference-remove\s*\{[^}]*opacity: 0/s);
    expect(CSS).toMatch(/\.workbench-reference-card\s*\{[^}]*overflow: visible/s);
    expect(CSS).toMatch(/\.workbench-reference-remove\s*\{[^}]*top: -8px[^}]*right: -8px/s);
    expect(CSS).toMatch(/\.workbench-reference-card:hover \.workbench-reference-remove[^{]*\{[^}]*opacity: 1/s);
  });

  it('视频模型参数只展示可编辑的生成参数', () => {
    expect(visibleVideoParams(schema).map((param) => param.name)).toEqual(['duration', 'mode']);
    expect(videoControlParams(schema).map((param) => param.name)).toEqual(['duration']);
  });

  it('文生视频和图生视频切换会选中模型对应的模式参数', () => {
    const modeSchema: VideoModelSchema = {
      name: 'mode-model',
      params: [{
        name: 'generation_mode',
        label: '生成模式',
        type: 'radio',
        options: [
          { label: '文生视频', value: 'text2video' },
          { label: '图生视频', value: 'image2video' },
        ],
      }],
    };

    expect(applyVideoMode(modeSchema, {}, 'text')).toMatchObject({ generation_mode: 'text2video' });
    expect(applyVideoMode(modeSchema, {}, 'image')).toMatchObject({ generation_mode: 'image2video' });
  });

  it('历史记录按媒体、画布、文件和完成时间去重并倒序合并', () => {
    const current = result();
    const duplicate = history({
      mediaType: 'image',
      canvasId: 'workbench',
      fileName: 'current.png',
      createdAt: current.createdAt,
      prompt: '不应覆盖当前结果',
    });
    const older = history();
    const video = history({
      mediaType: 'video',
      canvasId: 'workbench',
      fileName: 'clip.mp4',
      createdAt: '2026-10-25T11:00:00.000Z',
      videoSeconds: 5,
      videoResolution: '720p',
      videoRatio: '16:9',
    });

    const merged = mergeWorkbenchHistory([current], [duplicate, older, video]);
    expect(merged).toHaveLength(3);
    expect(merged[0].mediaType).toBe('video');
    expect(merged.find((item) => item.id === 'current')?.prompt).toBe('一只白色纸船');
    expect(merged.some((item) => item.prompt === '不应覆盖当前结果')).toBe(false);
  });

  it('样式复用玻璃与 motion Token，并支持减少动态偏好', () => {
    expect(CSS).toContain('var(--surface-popover-glass-bg)');
    expect(CSS).toContain('var(--surface-popover-glass-blur)');
    expect(CSS).toContain('var(--surface-popover-glass-shadow)');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS).toContain('transition: transform var(--motion-fast) var(--ease-out)');
    expect(CSS).toContain('transition: transform var(--motion-normal) var(--ease-out)');
    expect(CSS).not.toMatch(/transition:\s*all/);
  });

  it('左侧设置区为独立玻璃卡片，右侧结果区融入画布背景', () => {
    expect(CSS).toMatch(/\.workbench-composer\s*\{[^}]*border-radius: var\(--radius-lg\)/s);
    expect(CSS).toMatch(/\.workbench-composer\s*\{[^}]*border: 1px solid var\(--surface-popover-border\)/s);
    expect(CSS).toMatch(/\.workbench-composer\s*\{[^}]*min-width: 0/s);
    expect(CSS).toMatch(/\.workbench-results\s*\{[^}]*background: transparent/s);
    expect(CSS).toMatch(/\.workbench-result-stage\s*\{[^}]*border: 0[^}]*background: transparent/s);
  });

  it('工作台与画布共用透明顶栏，缺省纹理只显示在结果区', () => {
    expect(GLOBAL_CSS).toMatch(/\.hb-topbar\s*\{[^}]*border-bottom: none[^}]*background: transparent/s);
    expect(CSS).toMatch(/\.workbench-page\s*\{[^}]*background-color: var\(--color-bg-canvas\)/s);
    expect(CSS).not.toMatch(/\.workbench-page\s*\{[^}]*background-image:/s);
    expect(CSS).toMatch(/\.workbench-result-media\s*\{[^}]*background: transparent/s);
    expect(CSS).toMatch(/\.workbench-stage-backdrop::before\s*\{[^}]*background-image: radial-gradient\(circle, var\(--color-canvas-dot\)/s);
    expect(CSS).toMatch(/\.workbench-stage-backdrop::before\s*\{[^}]*mask-image: radial-gradient\(ellipse at center/s);
    expect(CSS).toMatch(/\.workbench-stage-ripples i\s*\{[^}]*animation: workbench-ripple/s);
    expect(CSS).toMatch(/\.workbench-stage-dot-spotlight\s*\{[^}]*background-image: radial-gradient\(circle, var\(--color-text-primary\)/s);
    expect(CSS).toMatch(/\.workbench-stage-dot-spotlight\s*\{[^}]*circle 112px at var\(--workbench-dot-x\) var\(--workbench-dot-y\)/s);
    expect(CSS).not.toContain('@keyframes workbench-dot-wave');
    expect(WORKBENCH_SOURCE).toContain("--workbench-dot-spotlight-opacity', '0.22'");
    expect(WORKBENCH_SOURCE).toContain('const stiffness = 46');
    expect(WORKBENCH_SOURCE).toContain('const damping = 13.5');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS).not.toMatch(/\.workbench-header\s*\{[^}]*(?:background|border-bottom)/s);

    expect(workbenchStageState(false, false)).toBe('empty');
    expect(workbenchStageState(true, false)).toBe('running');
    expect(workbenchStageState(false, true)).toBe('result');
    const idleBackdrop = renderToStaticMarkup(<WorkbenchStageBackdrop running={false} />);
    const runningBackdrop = renderToStaticMarkup(<WorkbenchStageBackdrop running />);
    expect(idleBackdrop).toContain('workbench-stage-backdrop');
    expect(idleBackdrop).toContain('workbench-stage-dot-spotlight');
    expect(idleBackdrop).not.toContain('workbench-stage-ripples');
    expect(runningBackdrop).toContain('workbench-stage-backdrop is-running');
    expect(runningBackdrop).not.toContain('workbench-stage-dot-spotlight');
    expect(runningBackdrop.match(/<i>/g)).toHaveLength(3);
  });

  it('工作台顶栏按钮复用画布尺寸，并在平板宽度同步隐藏模式提示', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/pages/WorkbenchPage.tsx', import.meta.url)),
      'utf8',
    );

    expect(source).toContain('className="image-canvas-btn workbench-settings-button"');
    expect(CSS).toMatch(/\.workbench-settings-button\s*\{\s*height: 34px;\s*\}/);
    expect(CSS).not.toMatch(/\.workbench-settings-button\s*\{[^}]*(?:border|flex|padding|font-size)/s);
    expect(CSS).toMatch(/@media \(max-width: 760px\)\s*\{\s*\.workbench-header \.image-canvas-mode-hint\s*\{\s*display: none;/s);
  });

  it('工作台历史视图留在视口高度内，内部历史列表独立滚动', () => {
    expect(CSS).toMatch(/\.workbench-shell\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s);
    expect(CSS).toMatch(/\.workbench-results\.has-history\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s);
    expect(HISTORY_CSS).toMatch(/\.image-history-scroll\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s);
    expect(HISTORY_CSS).toMatch(/\.image-history-filter-actions \.image-history-views button svg\s*\{[^}]*width: var\(--icon-glyph-sm\)[^}]*height: var\(--icon-glyph-sm\)/s);
  });

  it('提示词与参考图共用玻璃底色，优化入口位于编辑器内部右下角', () => {
    expect(CSS).toMatch(/\.workbench-prompt-composer\s*\{[^}]*border: 0[^}]*border-radius: var\(--radius-md\)[^}]*background: var\(--chat-composer-glass-bg\)/s);
    expect(CSS).toMatch(/\.workbench-prompt-composer\s*\{[^}]*flex: 0 0 auto/s);
    expect(CSS).toMatch(/\.workbench-prompt-editor textarea\s*\{[^}]*height: 168px[^}]*resize: none[^}]*border: 0[^}]*background: transparent/s);
    expect(CSS).toMatch(/\.workbench-upload\s*\{[^}]*border: 1px dashed var\(--control-border-hover\)[^}]*background: var\(--color-bg-canvas\)/s);
    expect(CSS).toMatch(/\.workbench-reference-card\s*\{[^}]*background: var\(--color-ui-control\)/s);
    expect(CSS).toMatch(/\.workbench-prompt-actions\s*\{[^}]*position: absolute[^}]*justify-content: flex-end/s);
  });

  it('参数区不再额外描边', () => {
    expect(CSS).toMatch(/\.workbench-parameters\s*\{[^}]*border: 0/s);
  });

  it('历史记录在结果区内部向下展开，不影响画布的固定浮层模式', () => {
    expect(WORKBENCH_SOURCE).toContain('<HistoryPanel\n              inline');
    expect(WORKBENCH_SOURCE).toContain("className={`workbench-results${historyOpen ? ' has-history' : ''}`}");
    expect(WORKBENCH_SOURCE).not.toContain('historyAnchor');
    expect(CSS).toMatch(/\.workbench-results\s*\{[^}]*grid-template-rows: auto minmax\(0, 1fr\)/s);
    expect(CSS).toMatch(/\.workbench-results\.has-history\s*\{[^}]*grid-template-rows: minmax\(0, 1fr\)/s);
    expect(HISTORY_CSS).toMatch(/\.image-history-panel\.is-inline\s*\{[^}]*position: relative[^}]*width: 100%/s);
    expect(HISTORY_CSS).toMatch(/\.image-history-panel\.is-inline\s*\{[^}]*height: 100%[^}]*min-height: 0[^}]*max-height: none/s);
    expect(HISTORY_CSS).toMatch(/\.image-history-panel\.is-inline\s*\{[^}]*background: transparent[^}]*box-shadow: none/s);

    const html = renderToStaticMarkup(
      <HistoryPanel
        inline
        items={[history()]}
        loading={false}
        error=""
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('image-history-panel is-inline');
    expect(html).toContain('aria-label="关闭生成历史"');
    expect(html).not.toContain('image-history-multi');
    expect(html).not.toContain('<strong>生成历史</strong>');
    expect(html).not.toContain('style="left:');

    const canvasHistory = renderToStaticMarkup(
      <HistoryPanel
        items={[history()]}
        loading={false}
        error=""
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(canvasHistory).toContain('<strong>生成历史</strong>');
    expect(canvasHistory).toContain('image-history-multi');
  });

  it('参数控件横向自适应，模型使用自定义下拉，其余参数直接展示', () => {
    expect(CSS).toMatch(/\.workbench-composer\s*\{[^}]*padding: var\(--spacing-3\)/s);
    expect(CSS).toMatch(/\.workbench-parameters\s*\{[^}]*gap: var\(--spacing-4\)/s);
    expect(CSS).toMatch(/\.workbench-parameter-row\s*\{[^}]*grid-template-columns: minmax\(52px, 0\.2fr\) minmax\(0, 1fr\)[^}]*gap: var\(--spacing-3\)/s);
    expect(CSS).toMatch(/\.workbench-parameter-stack,\s*\.workbench-schema-fields\s*\{[^}]*gap: var\(--spacing-4\)/s);
    expect(CSS).toMatch(/\.workbench-choice-group\s*\{[^}]*width: 100%[^}]*flex-wrap: nowrap/s);
    expect(CSS).toMatch(/\.workbench-choice-group button\s*\{[^}]*flex: 1 1 0[^}]*min-height: var\(--control-height-compact\)/s);
    expect(CSS).toMatch(/\.workbench-select-menu\s*\{[^}]*background: var\(--surface-popover-glass-bg\)/s);
    expect(CSS).toMatch(/\.workbench-choice-thumb\s*\{[^}]*background: var\(--segment-thumb-bg\)/s);
    expect(CSS).not.toMatch(/(?:^|\n)\s*select\s*\{/);
  });

  it('数量使用分段选择，时长继续使用滑块', () => {
    const html = renderToStaticMarkup(
      <QuantitySegments
        ariaLabel="图片数量"
        min={1}
        max={4}
        value={2}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('role="radiogroup" aria-label="图片数量"');
    expect(html.match(/role="radio"/g)).toHaveLength(4);
    expect(html).toContain('aria-checked="true"');
    const durationHtml = renderToStaticMarkup(
      <ParameterSlider ariaLabel="视频时长" min={0} max={4} value={1} valueLabel="5s" onChange={() => {}} />,
    );
    expect(durationHtml).toContain('type="range"');
    expect(durationHtml).toContain('aria-label="视频时长"');
    expect(SLIDER_CSS).toContain('var(--parameter-slider-ratio)');
    expect(SLIDER_CSS).toContain('var(--segment-thumb-bg)');
  });

  it('分段数量支持服务商的不连续合法值', () => {
    const options = [1, 3, 5].map((value) => ({ label: `${value} 张`, value: String(value) }));
    const values = videoQuantityValues({ name: 'count', label: '生成数量', type: 'select', options });
    expect(values).toEqual([1, 3, 5]);
    const html = renderToStaticMarkup(
      <QuantitySegments ariaLabel="生成数量" min={1} max={5} options={values} value={3} onChange={() => {}} />,
    );
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('>5</button>');
  });

  it('视频模型提供连续整数数量选项时使用数量分段控件', () => {
    expect(videoQuantityRange({
      name: 'n',
      label: '生成数量',
      type: 'select',
      options: [1, 2, 3, 4].map((value) => ({ label: String(value), value: String(value) })),
    })).toEqual({ min: 1, max: 4 });
    expect(videoQuantityRange({
      name: 'duration',
      label: '视频时长',
      type: 'select',
      options: [4, 5, 6].map((value) => ({ label: `${value}s`, value: String(value) })),
    })).toBeUndefined();
    expect(videoQuantityRange({
      name: 'count',
      label: '输出数量',
      type: 'select',
      options: [{ label: '1', value: '1' }, { label: '3', value: '3' }],
    })).toBeUndefined();
  });

  it('生成按钮禁用时保留纯白底色和清晰前景', () => {
    expect(CSS).toMatch(/\.workbench-generate:disabled\s*\{[^}]*color: var\(--color-action-send-icon\)[^}]*background: var\(--color-action-send\)[^}]*opacity: 1/s);
  });
});
