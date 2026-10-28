import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalRoot = process.env.HUIBAN_DATA_ROOT;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'huiban-assets-'));
process.env.HUIBAN_DATA_ROOT = testRoot;
const { MEDIA_DIR } = await import('../bridge/paths');
const { addAsset, createAssetFolder, deleteAsset, deleteAssetFolder, listAssets, moveAsset } = await import('../bridge/assets');

beforeAll(async () => {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.writeFile(path.join(MEDIA_DIR, 'source.png'), Buffer.from('source image'));
});

afterAll(async () => {
  if (originalRoot === undefined) delete process.env.HUIBAN_DATA_ROOT;
  else process.env.HUIBAN_DATA_ROOT = originalRoot;
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('资产库文件与文件夹', () => {
  it('收藏时复制图片并保留提示词，移动后可删除资产和空文件夹', async () => {
    const folder = await createAssetFolder('产品图');
    const asset = await addAsset({
      folderId: folder.id,
      fileName: 'source.png',
      prompt: '白底产品图',
      model: 'image-model',
      size: '1024x1024',
      sourceKey: 'canvas:node:v1',
    });
    expect(asset).toMatchObject({ folderId: folder.id, prompt: '白底产品图', model: 'image-model' });
    expect(asset.fileName).not.toBe('source.png');
    await expect(deleteAssetFolder(folder.id)).rejects.toThrow(/先移动或删除/);

    const moved = await moveAsset(asset.id, 'folder_favorites');
    expect(moved.folderId).toBe('folder_favorites');
    await deleteAsset(asset.id);
    await deleteAssetFolder(folder.id);
    expect((await listAssets()).items).toEqual([]);
    await expect(fs.access(path.join(MEDIA_DIR, asset.fileName))).rejects.toThrow();
  });

  it('同一来源重复收藏会去重，视频文件不能进入图片资产库', async () => {
    const first = await addAsset({ fileName: 'source.png', sourceKey: 'same-source' });
    const duplicate = await addAsset({ fileName: 'missing.png', sourceKey: 'same-source' });
    expect(duplicate.id).toBe(first.id);
    await expect(addAsset({ fileName: 'clip.mp4' })).rejects.toThrow(/只收藏图片/);
  });
});
