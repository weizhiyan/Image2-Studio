import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import CanvasImage from './CanvasImage';
import { createAssetFolder, deleteAssetFolder, getAssets, moveAssetToFolder, removeAsset, renameAssetFolder, type AssetLibrary, type AssetItem } from '@/lib/bridge';
import './AssetLibraryPanel.css';

export default function AssetLibraryPanel({
  anchorRect,
  onClose,
  onPreview,
  onUsePrompt,
}: {
  anchorRect: { x: number; y: number } | null;
  onClose: () => void;
  onPreview: (item: AssetItem) => void;
  onUsePrompt: (prompt: string) => void;
}) {
  const [library, setLibrary] = useState<AssetLibrary>({ folders: [], items: [] });
  const [activeFolderId, setActiveFolderId] = useState('all');
  const [newFolderName, setNewFolderName] = useState('');
  const [folderDraft, setFolderDraft] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [position, setPosition] = useState<CSSProperties>({});

  const refresh = async () => {
    setLoading(true);
    try {
      setLibrary(await getAssets());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取资产库失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);
  useLayoutEffect(() => {
    setPosition(anchorRect ? { left: anchorRect.x, top: '50%', transform: 'translateY(-50%)' } : {});
  }, [anchorRect]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const visibleItems = useMemo(
    () => library.items.filter((item) => activeFolderId === 'all' || item.folderId === activeFolderId),
    [activeFolderId, library.items],
  );
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    library.items.forEach((item) => result.set(item.folderId, (result.get(item.folderId) || 0) + 1));
    return result;
  }, [library.items]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError('');
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '资产操作失败');
    } finally {
      setBusyId('');
    }
  };

  const handleCreateFolder = async (event: FormEvent) => {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    await run('folder-new', async () => {
      const folder = await createAssetFolder(name);
      setActiveFolderId(folder.id);
      setNewFolderName('');
    });
  };

  const saveRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!renamingFolderId) return;
    await run(renamingFolderId, async () => {
      await renameAssetFolder(renamingFolderId, folderDraft);
      setRenamingFolderId('');
      setFolderDraft('');
    });
  };

  return (
    <>
      <div className="asset-library-dismiss" role="presentation" aria-hidden="true" onClick={onClose} />
      <section
        className="image-history-panel asset-library-panel"
        role="dialog"
        aria-label="资产库"
        style={position}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="image-history-head">
          <div className="image-history-title"><strong>资产库</strong><span>{library.items.length}</span></div>
          <button type="button" aria-label="关闭资产库" title="关闭" onClick={onClose}>×</button>
        </header>
        <div className="asset-library-layout">
        <aside className="asset-library-folders" aria-label="资产文件夹">
          <button type="button" className={activeFolderId === 'all' ? 'is-active' : ''} onClick={() => setActiveFolderId('all')}>
            全部 <span>{library.items.length}</span>
          </button>
          {library.folders.map((folder) => (
            <div className={`asset-library-folder-row${activeFolderId === folder.id ? ' is-active' : ''}`} key={folder.id}>
              {renamingFolderId === folder.id ? (
                <form onSubmit={saveRename}>
                  <input aria-label="文件夹名称" value={folderDraft} autoFocus onChange={(event) => setFolderDraft(event.currentTarget.value)} />
                  <button type="submit" aria-label="保存文件夹名称">✓</button>
                </form>
              ) : (
                <button type="button" onClick={() => setActiveFolderId(folder.id)}>
                  <span>{folder.name}</span><span>{counts.get(folder.id) || 0}</span>
                </button>
              )}
              {folder.id !== 'folder_favorites' && renamingFolderId !== folder.id ? (
                <span className="asset-library-folder-actions">
                  <button type="button" aria-label={`重命名 ${folder.name}`} title="重命名" onClick={() => { setRenamingFolderId(folder.id); setFolderDraft(folder.name); }}>✎</button>
                  <button
                    type="button"
                    aria-label={`删除 ${folder.name}`}
                    title={counts.get(folder.id) ? '先移空文件夹' : '删除空文件夹'}
                    disabled={Boolean(counts.get(folder.id))}
                    onClick={() => void run(folder.id, () => deleteAssetFolder(folder.id))}
                  >×</button>
                </span>
              ) : null}
            </div>
          ))}
          <form className="asset-library-new-folder" onSubmit={handleCreateFolder}>
            <input
              value={newFolderName}
              maxLength={48}
              placeholder="新文件夹名称"
              aria-label="新文件夹名称"
              onChange={(event) => setNewFolderName(event.currentTarget.value)}
            />
            <button type="submit" disabled={!newFolderName.trim() || busyId === 'folder-new'} aria-label="新建文件夹">+</button>
          </form>
        </aside>
        <div className="asset-library-content">
          {error ? <div className="image-history-error" role="alert">{error}</div> : null}
          {loading ? <div className="image-history-empty" role="status">正在读取资产…</div> : null}
          {!loading && visibleItems.length === 0 ? <div className="image-history-empty">这个文件夹还没有收藏</div> : null}
          <div className="asset-library-grid">
            {visibleItems.map((item) => (
              <article className="asset-library-item" key={item.id}>
                <button type="button" className="asset-library-preview" onClick={() => onPreview(item)} title={item.prompt || '预览图片'}>
                  <CanvasImage src={item.url} alt={item.prompt || '收藏图片'} loading="lazy" draggable={false} />
                </button>
                <p title={item.prompt}>{item.prompt || '（无提示词）'}</p>
                <div className="asset-library-item-actions">
                  <button type="button" disabled={!item.prompt.trim()} onClick={() => onUsePrompt(item.prompt)}>用提示词</button>
                  <select
                    aria-label="移动到文件夹"
                    value={item.folderId}
                    disabled={busyId === item.id}
                    onChange={(event) => void run(item.id, () => moveAssetToFolder(item.id, event.currentTarget.value))}
                  >
                    {library.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                  </select>
                  <button type="button" disabled={busyId === item.id} onClick={() => void run(item.id, () => removeAsset(item.id))} aria-label="移除资产">删除</button>
                </div>
              </article>
            ))}
          </div>
        </div>
        </div>
      </section>
    </>
  );
}
