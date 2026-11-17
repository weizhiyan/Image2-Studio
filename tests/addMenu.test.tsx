import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AddMenu from '../src/components/AddMenu';

describe('画布添加菜单', () => {
  it('按图像生成、视频生成、文本、上传图片的顺序显示入口', () => {
    const html = renderToStaticMarkup(
      <AddMenu
        x={0}
        y={0}
        onCreateGenerationNode={() => undefined}
        onUploadImage={() => undefined}
        onCreateVideoNode={() => undefined}
        onCreateTextNode={() => undefined}
      />,
    );
    const labels = Array.from(html.matchAll(/<strong>(.*?)<\/strong>/g), (match) => match[1]);

    expect(labels).toEqual(['图像生成', '视频生成', '文本', '上传图片']);
  });
});
