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

export function findClipboardImage(input: {
  files?: ClipboardFileLike[] | null;
  items?: ClipboardItemLike[] | null;
}): ClipboardFileLike | null {
  const fromFiles = Array.from(input.files || []).find((item) => item.type.startsWith('image/'));
  if (fromFiles) return fromFiles;
  // 某些环境（WebKit / 应用内浏览器）paste 事件的 files 是空的，文件只挂在 items 上
  for (const item of Array.from(input.items || [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}
