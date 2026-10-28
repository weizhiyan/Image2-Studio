import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 数据根目录：三平台统一放用户主目录下，可用 HUIBAN_DATA_ROOT 覆盖。 */
export const DATA_DIR = process.env.HUIBAN_DATA_ROOT || path.join(os.homedir(), '.huiban');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const CANVASES_FILE = path.join(DATA_DIR, 'canvases.json');
export const CANVAS_DOCS_FILE = path.join(DATA_DIR, 'canvas-docs.json');
export const CHAT_DOCS_FILE = path.join(DATA_DIR, 'chat-docs.json');
/** 视频任务态：提交后立刻落盘，bridge 重启 / 浏览器关闭都能接着轮询。 */
export const VIDEO_TASKS_FILE = path.join(DATA_DIR, 'video-tasks.json');
/** 图床配置：图生视频要把本机图片转成公网 HTTPS 地址，配置单独存，不塞进 settings.json。 */
export const IMAGE_HOST_FILE = path.join(DATA_DIR, 'image-host.json');
export const PORT = Number(process.env.HUIBAN_PORT || 3788);
export const HOST = '127.0.0.1';

/** 源码运行在 bridge/，构建后运行在 bridge/dist/；两种情况都定位到项目根。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.basename(HERE) === 'dist'
  ? path.resolve(HERE, '..', '..')
  : path.resolve(HERE, '..');
export const STATIC_DIR = path.join(PROJECT_DIR, 'dist');
