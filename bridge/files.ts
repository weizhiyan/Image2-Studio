import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MEDIA_DIR } from './paths.js';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov'];

export interface SavedFile { fileName: string; url: string; filePath: string }

export async function saveBuffer(buffer: Buffer, extension: string): Promise<SavedFile> {
  const safeExt = imageExtensionOf(buffer, extension);
  const fileName = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const filePath = path.join(MEDIA_DIR, fileName);
  await fs.writeFile(filePath, buffer);
  return { fileName, url: `/api/files/${fileName}`, filePath };
}

/** 视频落盘：与图片分开命名（vid_ 前缀），扩展名按容器魔数判，不信中转站给的后缀。 */
export async function saveVideoBuffer(buffer: Buffer, hint = ''): Promise<SavedFile> {
  const safeExt = videoExtensionOf(buffer, hint);
  const fileName = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const filePath = path.join(MEDIA_DIR, fileName);
  await fs.writeFile(filePath, buffer);
  return { fileName, url: `/api/files/${fileName}`, filePath };
}

/** 删除媒体文件：节点被删 / 历史条目被删时调用，文件真没了才算删干净。 */
export async function deleteMediaFile(fileName: string): Promise<boolean> {
  const filePath = safeMediaPath(fileName);
  if (!filePath) return false;
  await fs.unlink(filePath).catch(() => undefined);
  return true;
}

/** 复制一份媒体文件：粘贴节点给副本用——同一路径被两个节点引用时，删谁都会把图弄没。 */
export async function copyMediaFile(fileName: string): Promise<SavedFile | null> {
  const filePath = safeMediaPath(fileName);
  if (!filePath) return null;
  const extension = path.extname(filePath).slice(1) || 'png';
  return saveBuffer(await fs.readFile(filePath), extension);
}

/** dataURL 落地成媒体文件（标注保存走这条：合成图必须进 media 才能被 /api/files 复用）。 */
export async function saveDataUrl(dataUrl: string): Promise<SavedFile> {
  const match = /^data:image\/([a-z0-9+]+);base64,([\s\S]+)$/i.exec(String(dataUrl || '').trim());
  if (!match) throw new Error('不是受支持的 dataURL 图片');
  return saveBuffer(Buffer.from(match[2], 'base64'), match[1] === 'jpeg' ? 'jpg' : match[1]);
}

export function contentTypeOf(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

/** 中转站有时会把图片 URL 后缀写成 topvimg...，按魔数归一化保存扩展名。 */
export function imageExtensionOf(buffer: Buffer, hint = ''): string {
  const normalized = String(hint || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(normalized) ? (normalized === 'jpeg' ? 'jpg' : normalized) : 'png';
}

/**
 * 视频容器识别：MP4/MOV 的 brand 盒（字节 4–8 是 'ftyp'），WebM/Matroska 的 EBML 魔数。
 * 认不出来时回退到调用方给的后缀，再不行按 mp4 存——总比存成 .png 被浏览器当图片打开强。
 */
export function videoExtensionOf(buffer: Buffer, hint = ''): string {
  const normalized = String(hint || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  return VIDEO_EXTENSIONS.includes(normalized) ? normalized : 'mp4';
}

/** 是不是视频容器：下载回来的内容先过这一关，别把错误页 / HTML 存成 mp4。 */
export function looksLikeVideo(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  return buffer.subarray(4, 8).toString('ascii') === 'ftyp'
    || buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

/** 文件名只允许安全字符：媒体目录里的文件名由服务端生成，这里防路径穿越。 */
export function safeMediaPath(fileName: string): string | null {
  const name = String(fileName || '').trim();
  if (!name || !/^[\w.-]+$/.test(name)) return null;
  const filePath = path.join(MEDIA_DIR, name);
  return path.dirname(filePath) === MEDIA_DIR ? filePath : null;
}

/**
 * 在系统文件管理器里定位这张图（macOS Finder / Windows 资源管理器 / Linux 文件管理器）。
 * 浏览器没有权限开本地窗口，这件事只能交给 bridge 进程做。
 */
export async function revealLocalFile(fileName: string): Promise<string> {
  // 不传文件名 = 打开媒体目录本身（历史面板的「打开本地文件」用这个）
  if (!String(fileName || '').trim()) {
    await fs.mkdir(MEDIA_DIR, { recursive: true }).catch(() => undefined);
    return revealPath(MEDIA_DIR);
  }
  const filePath = safeMediaPath(fileName);
  if (!filePath) throw new Error('非法的文件名');
  await fs.access(filePath).catch(() => { throw new Error('本地文件不存在，可能已被清理'); });
  return revealPath(filePath);
}

/** 真正拉起系统文件管理器；失败不抛给调用方（展示层只当“尽力而为”）。 */
function revealPath(target: string): Promise<string> {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer'
      : 'xdg-open';
  const args = process.platform === 'win32' ? [`/select,${target}`] : [target];
  return new Promise<string>((resolve) => {
    execFile(command, args, () => resolve(target));
  });
}

/** 读本地媒体文件转成 base64 data URL：MCP 的 /api/files 参考图要喂给生图编辑口。 */
export async function mediaFileToDataUrl(fileName: string): Promise<string | null> {
  const filePath = safeMediaPath(fileName);
  if (!filePath) return null;
  const buffer = await fs.readFile(filePath).catch(() => null);
  if (!buffer) return null;
  return `data:${contentTypeOf(filePath)};base64,${buffer.toString('base64')}`;
}
