/** 剪贴板里的图片文件：截图、访达复制的文件、网页「拷贝图像」都走这里。
 *  不依赖 DOM 类型，入参是结构化的 files / items，方便单测（jsdom 没有 DataTransfer）。 */
export interface ClipboardFileLike {
  type: string;
  name?: string;
}

export interface ClipboardItemLike {
  kind: string;
  type: string;
  getAsFile: () => ClipboardFileLike | null;
}

export function findClipboardImages(input: {
  files?: ClipboardFileLike[] | null;
  items?: ClipboardItemLike[] | null;
}): ClipboardFileLike[] {
  const fromFiles = Array.from(input.files || []).filter((item) => item.type.startsWith('image/'));
  if (fromFiles.length > 0) return fromFiles;

  return Array.from(input.items || [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is ClipboardFileLike => Boolean(file));
}

export function findClipboardImage(input: {
  files?: ClipboardFileLike[] | null;
  items?: ClipboardItemLike[] | null;
}): ClipboardFileLike | null {
  return findClipboardImages(input)[0] || null;
}

export function extractClipboardImageUrl(values: Array<{ type: string; text: string }>): string {
  const html = values.find((item) => item.type === 'text/html')?.text || '';
  const htmlSource = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html)?.[1]?.trim() || '';
  if (/^(https?:\/\/|data:image\/)/i.test(htmlSource)) return htmlSource;

  const uriList = values.find((item) => item.type === 'text/uri-list')?.text || '';
  const uri = uriList.split(/\r?\n/).map((line) => line.trim()).find((line) => /^(https?:\/\/|data:image\/)/i.test(line));
  if (uri) return uri;

  const plainText = values.find((item) => item.type === 'text/plain')?.text.trim() || '';
  return /^(https?:\/\/|data:image\/)/i.test(plainText) ? plainText : '';
}
