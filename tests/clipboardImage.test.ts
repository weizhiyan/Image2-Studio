import { describe, expect, it } from 'vitest';
import { findClipboardImage } from '../src/lib/clipboardImage';
import { isBase64ReferenceDataUrl } from '../src/lib/imageData';

const img = (name: string) => ({ type: 'image/png', name });

describe('剪贴板取图', () => {
  it('优先从 files 里拿图片（截图 / 访达复制的文件）', () => {
    const file = findClipboardImage({
      files: [{ type: 'text/plain' }, img('shot.png')],
      items: [],
    });
    expect(file?.name).toBe('shot.png');
  });

  it('files 为空时回落 items 里的 file 类型（WebKit / 应用内浏览器）', () => {
    const file = findClipboardImage({
      files: [],
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/jpeg', getAsFile: () => img('copied.jpg') },
      ],
    });
    expect(file?.name).toBe('copied.jpg');
  });

  it('没有图片时返回 null，且不误取 string 项', () => {
    expect(findClipboardImage({ files: [], items: [{ kind: 'string', type: 'text/html', getAsFile: () => null }] })).toBeNull();
    expect(findClipboardImage({})).toBeNull();
    expect(findClipboardImage({ files: [{ type: 'application/x-thing' }] })).toBeNull();
  });

  it('只把 PNG/JPEG base64 data URL 当作可直接发送的参考图', () => {
    expect(isBase64ReferenceDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isBase64ReferenceDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    expect(isBase64ReferenceDataUrl('data:image/svg+xml,%3Csvg%3E')).toBe(false);
    expect(isBase64ReferenceDataUrl('data:image/webp;base64,UklGRg==')).toBe(false);
    expect(isBase64ReferenceDataUrl('/api/files/reference.webp')).toBe(false);
  });
});
