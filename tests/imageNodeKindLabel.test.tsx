import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../src/components/canvas/FlowImageNode.tsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../src/components/canvas/ImageNodes.css', import.meta.url), 'utf8');

describe('图片 / 视频节点标题', () => {
  it('显示提示词而不是类型名，并限制预览长度', () => {
    expect(SOURCE).toContain('image-node-kind-text');
    expect(SOURCE).toContain('activePromptOf(d)');
    expect(SOURCE).toContain('promptPreview || kindLabel');
    expect(SOURCE).toContain('promptText.slice(0, 36)');
    expect(CSS).toMatch(/\.image-node-kind-text\s*\{[^}]*text-overflow:\s*ellipsis/s);
    expect(CSS).toMatch(/\.image-node-kind-text\s*\{[^}]*flex:\s*0 1 auto/s);
    expect(CSS).toMatch(/\.image-node-kind-text\s*\{[^}]*max-width:\s*68%/s);
  });

  it('悬停出现复制按钮，点击复制完整提示词', () => {
    expect(SOURCE).toContain('image-node-kind-copy');
    expect(SOURCE).toContain('copyTextWithFallback(promptText)');
    expect(SOURCE).toContain('已复制提示词');
    expect(CSS).toMatch(/\.image-node-kind-label:hover \.image-node-kind-copy/s);
    expect(CSS).toMatch(/\.image-node-kind-copy\.is-copied/s);
  });
});
