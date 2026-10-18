/**
 * 生图编辑接口能稳定接收的浏览器参考图格式。
 * 画布里的参考图可能来自 SVG / WebP / AVIF / 非 base64 data URL，
 * 这些格式能在浏览器显示，但不一定能直接作为 multipart 图片交给上游。
 */
const BASE64_REFERENCE_PATTERN = /^data:image\/(?:png|jpeg);base64,[a-z0-9+/=\s]+$/i;

export function isBase64ReferenceDataUrl(value: string): boolean {
  return BASE64_REFERENCE_PATTERN.test(String(value || '').trim());
}

/**
 * 把浏览器可显示的图片 data URL 转成上游最兼容的 PNG data URL。
 * 已经是 PNG/JPEG base64 时原样返回，避免每次生成都重复编码。
 */
export function normalizeReferenceDataUrl(value: string): Promise<string> {
  const source = String(value || '').trim();
  if (!source.startsWith('data:image/')) {
    return Promise.reject(new Error('参考图不是可识别的图片 data URL'));
  }
  if (isBase64ReferenceDataUrl(source)) return Promise.resolve(source);

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error('参考图没有有效尺寸'));
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('浏览器不支持图片格式转换'));
        return;
      }
      context.drawImage(image, 0, 0);
      try {
        resolve(canvas.toDataURL('image/png'));
      } catch {
        reject(new Error('参考图格式转换失败'));
      }
    };
    image.onerror = () => reject(new Error('参考图无法读取'));
    image.src = source;
  });
}
