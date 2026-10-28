import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AddMenu from '../src/components/AddMenu';

describe('画布添加菜单', () => {
  it('按上传图片、图像生成、视频生成的顺序显示入口', () => {
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

    expect(labels).toEqual(['上传图片', '图像生成', '视频生成', 'Markdown 文本']);
  });
});
