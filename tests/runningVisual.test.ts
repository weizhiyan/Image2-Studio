import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const TOKENS = readSource('../src/styles/tokens.css');
const MATRIX_FIELD = readSource('../src/components/canvas/RunningMatrixField.tsx');
const MATRIX_CSS = readSource('../src/components/canvas/RunningMatrixField.css');
const RUNNING_GLOW = readSource('../src/components/canvas/RunningGlow.css');
const IMAGE_NODES = readSource('../src/components/canvas/ImageNodes.css');

describe('生成中节点视觉', () => {
  it('矩阵按不受画布缩放影响的布局尺寸绘制', () => {
    expect(MATRIX_FIELD).toContain('box.clientWidth');
    expect(MATRIX_FIELD).toContain('box.clientHeight');
    expect(MATRIX_FIELD).not.toContain('box.getBoundingClientRect()');
  });

  it('浅色智能生成卡片与矩阵底都使用纯白', () => {
    const backgrounds = [...TOKENS.matchAll(/--running-card-bg:\s*([^;]+);/g)]
      .map((match) => match[1].trim());

    expect(backgrounds).toEqual([
      'color-mix(in srgb, var(--color-bg-base) 88%, var(--color-ui-panel))',
      'var(--color-paper)',
    ]);
    expect(IMAGE_NODES).toMatch(
      /\.image-node-composer-running\.is-enhanced\s*\{[^}]*background:\s*var\(--running-card-bg\)/s,
    );
    expect(MATRIX_CSS).toMatch(
      /\.running-matrix\s*\{[^}]*background:\s*var\(--running-card-bg\)/s,
    );
  });

  it('渐变描边外圈随探出宽度扩圆角，并同步卡片的超椭圆形状', () => {
    expect(RUNNING_GLOW).toMatch(
      /\.image-node-running-border\s*\{[^}]*corner-shape:\s*var\(--corner-smooth\)/s,
    );
    expect(RUNNING_GLOW).toMatch(
      /\.image-node-running-border::before\s*\{[^}]*border-radius:\s*calc\(var\(--radius-lg\) \+ var\(--image-node-running-border-width\)\)[^}]*corner-shape:\s*var\(--corner-smooth\)/s,
    );
  });

  it('智能生成矩阵铺满卡片并继承外层圆角形状', () => {
    expect(MATRIX_CSS).toMatch(
      /\.running-matrix\.is-inline\s*\{[^}]*inset:\s*0[^}]*corner-shape:\s*inherit/s,
    );
    expect(IMAGE_NODES).toMatch(
      /\.image-node-composer-running\s*\{[^}]*corner-shape:\s*inherit/s,
    );
  });

  it('AI 对话占位卡片沿用节点圆角，流光位于内容层之上', () => {
    expect(IMAGE_NODES).toMatch(/\.image-node-body\s*\{[^}]*border-radius:\s*inherit[^}]*corner-shape:\s*inherit/s);
    expect(IMAGE_NODES).toMatch(/\.image-node-placeholder\s*\{[^}]*border-radius:\s*inherit[^}]*corner-shape:\s*inherit/s);
    expect(RUNNING_GLOW).toMatch(/\.image-node-running-border\s*\{[^}]*z-index:\s*6/s);
  });
});
