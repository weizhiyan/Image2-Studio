import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AssetLibraryPanel from '@/components/canvas/AssetLibraryPanel';

const ASSET_CSS = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/AssetLibraryPanel.css', import.meta.url)),
  'utf8',
);
const ASSET_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/AssetLibraryPanel.tsx', import.meta.url)),
  'utf8',
);
const HISTORY_CSS = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/HistoryPanel.css', import.meta.url)),
  'utf8',
);

describe('AssetLibraryPanel', () => {
  it('复用生成历史的 400px 面板壳层与单列文件夹树', () => {
    const html = renderToStaticMarkup(
      <AssetLibraryPanel
        onClose={() => undefined}
        onPreview={() => undefined}
        onUsePrompt={() => undefined}
      />,
    );

    expect(html).toContain('image-history-panel is-canvas-panel asset-library-panel');
    expect(html).toContain('aria-label="关闭资产库"');
    expect(html).toContain('aria-label="资产库文件夹"');
    expect(html).toContain('aria-label="切换为详细列表"');
    expect(html).not.toContain('asset-library-footer');
    expect(html).not.toContain('asset-library-new-folder');
    expect(html).not.toContain('asset-library-layout');
    expect(html).not.toContain('asset-library-grid');

    expect(HISTORY_CSS).toMatch(
      /\.image-history-panel\.is-canvas-panel\s*\{[^}]*--hb-history-panel-width:\s*400px;/s,
    );
    expect(ASSET_CSS).not.toMatch(/--hb-history-panel-width/);
    expect(ASSET_CSS).not.toMatch(/\.asset-library-grid/);
    expect(ASSET_CSS).toMatch(/\.asset-library-folder-main\s*\{/s);
    expect(ASSET_CSS).toMatch(/\.asset-library-list\s*\{[^}]*flex-direction:\s*column;/s);
  });

  it('生成历史与资产库统一从左侧滑入', () => {
    expect(HISTORY_CSS).toMatch(
      /@keyframes history-canvas-pop\s*\{[^}]*transform:\s*translateX\(calc\(var\(--spacing-3\) \* -1\)\) scale\(0\.992\)/s,
    );
    expect(ASSET_SOURCE).not.toContain('anchorRect');
  });

  it('文件夹和图片都通过行尾更多菜单提供真实操作', () => {
    expect(ASSET_SOURCE).toContain('createPortal');
    expect(ASSET_SOURCE).toContain('asset-library-more-button');
    expect(ASSET_SOURCE).toContain('aria-haspopup="menu"');
    expect(ASSET_SOURCE).toContain('新建文件夹');
    expect(ASSET_SOURCE).toContain('重命名');
    expect(ASSET_SOURCE).toContain('移动内容到…');
    expect(ASSET_SOURCE).toContain('移动到…');
    expect(ASSET_SOURCE).toContain('创建副本');
    expect(ASSET_SOURCE).toContain('从资产库移除');
    expect(ASSET_SOURCE).toContain('asset-library-folder-create');
    expect(ASSET_SOURCE).toContain('startCreateFolder');
    expect(ASSET_SOURCE).not.toContain('asset-library-footer');
    expect(ASSET_SOURCE).not.toContain('asset-library-move');

    expect(ASSET_CSS).toMatch(
      /\.asset-library-menu\s*\{[^}]*background:\s*var\(--surface-popover-glass-bg\);/s,
    );
    expect(ASSET_CSS).toMatch(
      /\.asset-library-menu\s*\{[^}]*backdrop-filter:\s*var\(--surface-popover-glass-blur\);/s,
    );
    expect(ASSET_CSS).toMatch(
      /\.asset-library-more-button\s*\{[^}]*opacity:\s*0;/s,
    );
    expect(ASSET_CSS).toMatch(
      /\.asset-library-folder-row:hover \.asset-library-more-button,[\s\S]*\.asset-library-list-item:hover \.asset-library-more-button/s,
    );
    expect(ASSET_CSS).toMatch(
      /\.asset-library-menu button\.is-danger:hover:not\(:disabled\),[\s\S]*background:\s*var\(--color-feedback-error-bg\);/s,
    );
    expect(ASSET_CSS).not.toMatch(/\.asset-library-footer\s*\{/s);
    expect(ASSET_CSS).not.toMatch(/\.asset-library-new-folder\s*\{/s);
  });
});
