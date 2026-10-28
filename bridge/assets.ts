import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './paths.js';
import { copyMediaFile, deleteMediaFile } from './files.js';

const ASSETS_FILE = path.join(DATA_DIR, 'assets.json');
const DEFAULT_FOLDER_ID = 'folder_favorites';

export interface AssetFolder {
  id: string;
  name: string;
  createdAt: string;
}

export interface AssetItem {
  id: string;
  folderId: string;
  fileName: string;
  url: string;
  prompt: string;
  model: string;
  size: string;
  sourceKey: string;
  createdAt: string;
}

interface AssetStore {
  folders: AssetFolder[];
  items: AssetItem[];
}

let writeChain: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

function emptyStore(): AssetStore {
  return {
    folders: [{ id: DEFAULT_FOLDER_ID, name: '收藏', createdAt: new Date().toISOString() }],
    items: [],
  };
}

async function readStore(): Promise<AssetStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(ASSETS_FILE, 'utf8')) as Partial<AssetStore>;
    const store: AssetStore = {
      folders: Array.isArray(parsed.folders) ? parsed.folders.filter((item) => item?.id && item?.name) : [],
      items: Array.isArray(parsed.items) ? parsed.items.filter((item) => item?.id && item?.fileName && item?.url) : [],
    };
    if (!store.folders.some((folder) => folder.id === DEFAULT_FOLDER_ID)) {
      store.folders.unshift({ id: DEFAULT_FOLDER_ID, name: '收藏', createdAt: new Date().toISOString() });
    }
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.copyFile(ASSETS_FILE, `${ASSETS_FILE}.corrupt-${stamp}`).catch(() => undefined);
    }
    return emptyStore();
  }
}

async function writeStore(store: AssetStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${ASSETS_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(temp, ASSETS_FILE);
}

export async function listAssets(): Promise<AssetStore> {
  return readStore();
}

export async function createAssetFolder(name: string): Promise<AssetFolder> {
  const label = String(name || '').trim().slice(0, 48);
  if (!label) throw new Error('文件夹名称不能为空');
  return withWriteLock(async () => {
    const store = await readStore();
    if (store.folders.some((folder) => folder.name.toLocaleLowerCase() === label.toLocaleLowerCase())) {
      throw new Error('已存在同名文件夹');
    }
    const folder = { id: `folder_${randomUUID()}`, name: label, createdAt: new Date().toISOString() };
    store.folders.push(folder);
    await writeStore(store);
    return folder;
  });
}

export async function renameAssetFolder(folderId: string, name: string): Promise<AssetFolder> {
  const label = String(name || '').trim().slice(0, 48);
  if (!label) throw new Error('文件夹名称不能为空');
  return withWriteLock(async () => {
    const store = await readStore();
    const folder = store.folders.find((item) => item.id === folderId);
    if (!folder) throw new Error('找不到这个文件夹');
    if (folderId === DEFAULT_FOLDER_ID) throw new Error('默认收藏夹不能重命名');
    if (store.folders.some((item) => item.id !== folderId && item.name.toLocaleLowerCase() === label.toLocaleLowerCase())) {
      throw new Error('已存在同名文件夹');
    }
    folder.name = label;
    await writeStore(store);
    return folder;
  });
}

export async function deleteAssetFolder(folderId: string): Promise<void> {
  await withWriteLock(async () => {
    const store = await readStore();
    if (folderId === DEFAULT_FOLDER_ID) throw new Error('默认收藏夹不能删除');
    if (store.items.some((item) => item.folderId === folderId)) throw new Error('请先移动或删除文件夹内的资产');
    const next = store.folders.filter((folder) => folder.id !== folderId);
    if (next.length === store.folders.length) throw new Error('找不到这个文件夹');
    await writeStore({ ...store, folders: next });
  });
}

export async function addAsset(input: {
  folderId?: string;
  fileName: string;
  prompt?: string;
  model?: string;
  size?: string;
  sourceKey?: string;
}): Promise<AssetItem> {
  const sourceFileName = String(input.fileName || '').trim();
  if (!/\.(?:png|jpe?g|webp|gif)$/i.test(sourceFileName)) throw new Error('资产库目前只收藏图片');
  return withWriteLock(async () => {
    const store = await readStore();
    const folderId = store.folders.some((folder) => folder.id === input.folderId)
      ? String(input.folderId)
      : DEFAULT_FOLDER_ID;
    const sourceKey = String(input.sourceKey || input.fileName).slice(0, 500);
    const existing = store.items.find((item) => item.sourceKey === sourceKey);
    if (existing) return existing;
    const copied = await copyMediaFile(sourceFileName);
    if (!copied) throw new Error('原图片文件不存在，无法收藏');
    const item: AssetItem = {
      id: `asset_${randomUUID()}`,
      folderId,
      fileName: copied.fileName,
      url: copied.url,
      prompt: String(input.prompt || '').slice(0, 20_000),
      model: String(input.model || '').slice(0, 300),
      size: String(input.size || '').slice(0, 100),
      sourceKey,
      createdAt: new Date().toISOString(),
    };
    store.items.unshift(item);
    await writeStore(store);
    return item;
  });
}

export async function moveAsset(itemId: string, folderId: string): Promise<AssetItem> {
  return withWriteLock(async () => {
    const store = await readStore();
    const item = store.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error('找不到这项资产');
    if (!store.folders.some((folder) => folder.id === folderId)) throw new Error('找不到目标文件夹');
    item.folderId = folderId;
    await writeStore(store);
    return item;
  });
}

export async function deleteAsset(itemId: string): Promise<void> {
  await withWriteLock(async () => {
    const store = await readStore();
    const item = store.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error('找不到这项资产');
    await writeStore({ ...store, items: store.items.filter((entry) => entry.id !== itemId) });
    await deleteMediaFile(item.fileName);
  });
}
