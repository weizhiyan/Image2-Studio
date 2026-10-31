import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../src/components/canvas/ImagePreviewLightbox.tsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../src/components/canvas/ImagePreviewLightbox.css', import.meta.url), 'utf8');

describe('大图预览', () => {
  it('提示词面板默认更高，并支持拖拽调高和持久化', () => {
    expect(SOURCE).toContain('DEFAULT_PROMPT_HEIGHT = 160');
    expect(SOURCE).toContain('PREVIEW_PROMPT_HEIGHTS_KEY');
    expect(SOURCE).toContain('image-generation-preview-prompt-resize');
    expect(SOURCE).toContain('startPromptResize');
    expect(SOURCE).toContain('nudgePromptHeight');
    expect(CSS).toMatch(/\.image-generation-preview-prompt\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/s);
    expect(CSS).toMatch(/\.image-generation-preview-prompt-resize\s*\{[^}]*cursor:\s*ns-resize/s);
  });

  it('滚轮缩放走非 passive 原生监听并按帧合并', () => {
    expect(SOURCE).toContain("stage.addEventListener('wheel', onWheel, { passive: false })");
    expect(SOURCE).toContain('requestAnimationFrame');
    expect(SOURCE).not.toContain('onWheel={isVideo');
  });

  it('交互缩放不套过渡，只给舞台点击切换保留动画', () => {
    expect(CSS).toMatch(/\.image-generation-preview-stage img\s*\{[^}]*will-change:\s*transform/s);
    expect(CSS).not.toMatch(/\.image-generation-preview-stage img\s*\{[^}]*transition:/s);
    expect(CSS).toMatch(/\.image-generation-preview-stage img\.is-smooth-zoom\s*\{[^}]*transition:\s*transform/s);
    expect(SOURCE).toContain('is-smooth-zoom');
  });

  it('大图预览从喜欢改为可选择文件夹的资产收藏', () => {
    expect(SOURCE).toContain('添加到资产库');
    expect(SOURCE).toContain('AssetGlyphIcon');
    expect(SOURCE).toContain('选择资产文件夹');
    expect(SOURCE).toContain('assetButtonRef');
    expect(SOURCE).toContain('assetPickerPosition');
    expect(SOURCE).toContain("savedAssetFolderName || '添加到资产库'");
    expect(SOURCE).toContain('getAssets');
    expect(SOURCE).toContain('createAsset');
    expect(SOURCE).toContain('moveAssetToFolder');
    expect(SOURCE).toContain('assetSourceKey');
    expect(SOURCE).not.toContain('postPreferenceAction');
    expect(SOURCE).not.toContain('喜欢');
    expect(SOURCE).not.toContain('已添加到');
    expect(CSS).toMatch(/\.image-generation-preview-asset-picker\s*\{[^}]*position:\s*fixed;/s);
    expect(CSS).toMatch(
      /\.image-generation-preview-asset-picker\s*\{[^}]*background:\s*var\(--surface-popover-glass-bg\);/s,
    );
    expect(CSS).not.toMatch(/\.image-generation-preview-like\s*\{/s);
  });

  it('大图预览遮罩与 Agent 弹窗保持一致', () => {
    expect(CSS).toMatch(/\.image-generation-preview-backdrop\s*\{[^}]*background:\s*var\(--dialog-scrim\)/s);
    expect(CSS).toMatch(/\.image-generation-preview-backdrop\s*\{[^}]*backdrop-filter:\s*var\(--surface-modal-backdrop-blur\)/s);
  });
});
