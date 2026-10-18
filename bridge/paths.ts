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
export const PORT = Number(process.env.HUIBAN_PORT || 3788);
export const HOST = '127.0.0.1';

/** bridge/dist/index.js → 项目根（dist 由 vite 产出在根下）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATIC_DIR = path.resolve(HERE, '..', '..', 'dist');
