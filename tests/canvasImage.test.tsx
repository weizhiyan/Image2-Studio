/** 图片文件丢失降级：空 src 不露浏览器裂图，换成统一占位卡（带语义与上下文）。 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CanvasImage from '@/components/canvas/CanvasImage';

describe('CanvasImage', () => {
  it('正常 src 渲染 img（走 CanvasImage 才能挂 onError 降级）', () => {
    const html = renderToStaticMarkup(<CanvasImage src="/api/files/img_ok.png" alt="一只柴犬" />);
    expect(html).toContain('<img');
    expect(html).toContain('src="/api/files/img_ok.png"');
    expect(html).not.toContain('canvas-image-missing');
  });

  it('空 src 直接出占位卡，不渲染 img（引用未就位也不露裂图）', () => {
    const html = renderToStaticMarkup(<CanvasImage src="" alt="" />);
    expect(html).not.toContain('<img');
    expect(html).toContain('canvas-image-missing');
    expect(html).toContain('图片文件丢失');
  });

  it('占位卡带提示词说明（丢失的图也能追溯原来画的是什么）', () => {
    const html = renderToStaticMarkup(<CanvasImage src="" alt="丢了的图" missingNote="雨夜巷口的斗笠柴犬" />);
    expect(html).toContain('图片文件丢失');
    expect(html).toContain('雨夜巷口的斗笠柴犬');
  });

  it('占位卡保留 alt 语义，读屏软件能读出"这里曾有一张图"', () => {
    const html = renderToStaticMarkup(<CanvasImage src="" alt="第 2 版：加霓虹" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="第 2 版：加霓虹"');
  });
});
