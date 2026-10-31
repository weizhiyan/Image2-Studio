import { createPortal } from 'react-dom';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import CanvasImage from './CanvasImage';
import {
  createAsset,
  createAssetFolder,
  deleteAssetFolder,
  getAssets,
  moveAssetToFolder,
  removeAsset,
  renameAssetFolder,
  type AssetItem,
  type AssetLibrary,
} from '@/lib/bridge';
import './AssetLibraryPanel.css';

type AssetListView = 'compact' | 'detail';

const FAVORITES_FOLDER_ID = 'folder_favorites';
const ASSET_MENU_WIDTH = 224;
const ASSET_MENU_MARGIN = 12;
const ASSET_MENU_GAP = 6;
const ASSET_MENU_MAX_HEIGHT = 360;

function downloadAsset(item: AssetItem) {
  const link = document.createElement('a');
  link.href = item.url;
  link.download = item.fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function assetMenuStyle(rect: DOMRect): CSSProperties {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(ASSET_MENU_WIDTH, viewportWidth - ASSET_MENU_MARGIN * 2);
  const rightAlignedLeft = rect.right + ASSET_MENU_GAP;
  const left = rightAlignedLeft + width <= viewportWidth - ASSET_MENU_MARGIN
    ? rightAlignedLeft
    : Math.max(ASSET_MENU_MARGIN, rect.left - ASSET_MENU_GAP - width);
  const spaceBelow = viewportHeight - rect.bottom - ASSET_MENU_MARGIN - ASSET_MENU_GAP;
  const spaceAbove = rect.top - ASSET_MENU_MARGIN - ASSET_MENU_GAP;
  const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
  const maxHeight = Math.max(
    120,
    Math.min(ASSET_MENU_MAX_HEIGHT, openAbove ? spaceAbove : spaceBelow),
  );
  return {
    left,
    width,
    maxHeight,
    ...(openAbove
      ? { bottom: viewportHeight - rect.top + ASSET_MENU_GAP }
      : { top: Math.max(ASSET_MENU_MARGIN, rect.top) }),
  };
}

interface AssetMenuState {
  kind: 'folder' | 'item';
  id: string;
  currentFolderId: string;
  view: 'root' | 'move';
  style: CSSProperties;
}

export default function AssetLibraryPanel({
  onClose,
  onPreview,
  onUsePrompt,
}: {
  onClose: () => void;
  onPreview: (item: AssetItem) => void;
  onUsePrompt: (prompt: string) => void;
}) {
  const [library, setLibrary] = useState<AssetLibrary>({ folders: [], items: [] });
  const [expandedFolderId, setExpandedFolderId] = useState(FAVORITES_FOLDER_ID);
  const [view, setView] = useState<AssetListView>('compact');
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const [menu, setMenu] = useState<AssetMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (library.folders.length === 0) return;
    if (library.folders.some((folder) => folder.id === expandedFolderId)) return;
    setExpandedFolderId(library.folders[0].id);
  }, [expandedFolderId, library.folders]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menu) {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        window.requestAnimationFrame(() => menuTriggerRef.current?.focus());
        return;
      }
      if (creatingFolder) {
        event.preventDefault();
        event.stopPropagation();
        setCreatingFolder(false);
        setNewFolderName('');
        return;
      }
      setClosing(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [creatingFolder, menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (target.closest?.('[data-asset-more-trigger="true"]')) return;
      setMenu(null);
    };
    const closeOnViewportChange = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnResize = () => setMenu(null);
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('scroll', closeOnViewportChange, true);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('scroll', closeOnViewportChange, true);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [menu]);

  useEffect(() => {
    if (!closing) return undefined;
    const timer = window.setTimeout(onClose, 400);
    return () => window.clearTimeout(timer);
  }, [closing, onClose]);

  const counts = useMemo(() => {
    const result = new Map<string, number>();
    library.items.forEach((item) => result.set(item.folderId, (result.get(item.folderId) || 0) + 1));
    return result;
  }, [library.items]);

  const itemsByFolder = useMemo(() => {
    const result = new Map<string, AssetItem[]>();
    library.items.forEach((item) => {
      const list = result.get(item.folderId) || [];
      list.push(item);
      result.set(item.folderId, list);
    });
    return result;
  }, [library.items]);

  const run = async (id: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusyId(id);
    setError('');
    try {
      await action();
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '资产操作失败');
      return false;
    } finally {
      setBusyId('');
    }
  };

  const closeMenu = (restoreFocus = false) => {
    setMenu(null);
    if (restoreFocus) window.requestAnimationFrame(() => menuTriggerRef.current?.focus());
  };

  const openMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    kind: AssetMenuState['kind'],
    id: string,
    currentFolderId: string,
  ) => {
    event.stopPropagation();
    if (menu?.kind === kind && menu.id === id) {
      closeMenu(true);
      return;
    }
    const trigger = event.currentTarget;
    menuTriggerRef.current = trigger;
    setMenu({
      kind,
      id,
      currentFolderId,
      view: 'root',
      style: assetMenuStyle(trigger.getBoundingClientRect()),
    });
  };

  const startCreateFolder = () => {
    closeMenu();
    setRenamingFolderId('');
    setFolderDraft('');
    setCreatingFolder(true);
    setNewFolderName('');
    window.requestAnimationFrame(() => {
      newFolderInputRef.current?.scrollIntoView({ block: 'nearest' });
      newFolderInputRef.current?.focus();
    });
  };

  const startRenameFolder = (folderId: string, folderName: string) => {
    closeMenu();
    setCreatingFolder(false);
    setNewFolderName('');
    setExpandedFolderId(folderId);
    setRenamingFolderId(folderId);
    setFolderDraft(folderName);
  };

  const handleCreateFolder = async (event: FormEvent) => {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    await run('folder-new', async () => {
      const folder = await createAssetFolder(name);
      setExpandedFolderId(folder.id);
      setNewFolderName('');
      setCreatingFolder(false);
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

  const duplicateNameFor = (folderName: string) => {
    const base = `${folderName} 副本`;
    let candidate = base;
    let index = 2;
    while (library.folders.some((folder) => folder.name.toLocaleLowerCase() === candidate.toLocaleLowerCase())) {
      candidate = `${base} ${index}`;
      index += 1;
    }
    return candidate;
  };

  const moveItemToFolder = async (item: AssetItem, targetFolderId: string) => {
    closeMenu();
    const moved = await run(item.id, () => moveAssetToFolder(item.id, targetFolderId));
    if (moved) setExpandedFolderId(targetFolderId);
  };

  const moveFolderContents = async (folderId: string, targetFolderId: string) => {
    closeMenu();
    const items = itemsByFolder.get(folderId) || [];
    if (items.length === 0) return;
    const moved = await run(`folder-move:${folderId}`, async () => {
      for (const item of items) await moveAssetToFolder(item.id, targetFolderId);
    });
    if (moved) setExpandedFolderId(targetFolderId);
  };

  const duplicateFolder = async (folderId: string) => {
    const folder = library.folders.find((entry) => entry.id === folderId);
    if (!folder) return;
    closeMenu();
    const copyName = duplicateNameFor(folder.name);
    const folderItems = itemsByFolder.get(folder.id) || [];
    await run(`folder-copy:${folder.id}`, async () => {
      const copy = await createAssetFolder(copyName);
      for (const item of folderItems) {
        await createAsset({
          folderId: copy.id,
          fileName: item.fileName,
          prompt: item.prompt,
          model: item.model,
          size: item.size,
          sourceKey: `${item.sourceKey}:copy:${copy.id}`,
        });
      }
      setExpandedFolderId(copy.id);
    });
  };

  const duplicateItem = async (item: AssetItem) => {
    closeMenu();
    await run(item.id, () => createAsset({
      folderId: item.folderId,
      fileName: item.fileName,
      prompt: item.prompt,
      model: item.model,
      size: item.size,
      sourceKey: `${item.sourceKey}:copy:${Date.now()}`,
    }));
  };

  const deleteFolder = async (folderId: string) => {
    closeMenu();
    await run(folderId, () => deleteAssetFolder(folderId));
  };

  const removeItem = async (itemId: string) => {
    closeMenu();
    await run(itemId, () => removeAsset(itemId));
  };

  const downloadAssets = (items: AssetItem[]) => {
    closeMenu();
    items.forEach((item, index) => {
      window.setTimeout(() => downloadAsset(item), index * 120);
    });
  };

  const renderMenu = () => {
    if (!menu) return null;
    const folder = menu.kind === 'folder'
      ? library.folders.find((entry) => entry.id === menu.id)
      : null;
    const item = menu.kind === 'item'
      ? library.items.find((entry) => entry.id === menu.id)
      : null;
    const folderItems = menu.kind === 'folder' ? (itemsByFolder.get(menu.id) || []) : [];
    const currentName = folder?.name || item?.prompt || item?.fileName || '资产';
    const currentFolderId = menu.currentFolderId;
    const targets = library.folders.filter((entry) => entry.id !== currentFolderId);

    return createPortal(
      <div
        ref={menuRef}
        id="asset-library-more-menu"
        className="asset-library-menu"
        style={menu.style}
        role="menu"
        aria-label={`${currentName} 的更多操作`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onWheelCapture={(event) => event.stopPropagation()}
      >
        {menu.view === 'move' ? (
          <>
            <div className="asset-library-menu-head">
              <button
                type="button"
                aria-label="返回更多操作"
                title="返回"
                onClick={() => setMenu({ ...menu, view: 'root' })}
              >
                <ChevronLeftIcon />
              </button>
              <span>移动到文件夹</span>
            </div>
            {targets.length === 0 ? (
              <p className="asset-library-menu-note">没有其他文件夹</p>
            ) : targets.map((target) => (
              <button
                key={target.id}
                type="button"
                role="menuitem"
                disabled={Boolean(busyId)}
                onClick={() => {
                  if (menu.kind === 'folder') void moveFolderContents(menu.id, target.id);
                  else if (item) void moveItemToFolder(item, target.id);
                }}
              >
                <FolderIcon />
                <span className="asset-library-menu-label">{target.name}</span>
                <span className="asset-library-menu-meta">{counts.get(target.id) || 0}</span>
              </button>
            ))}
          </>
        ) : menu.kind === 'folder' && folder ? (
          <>
            <button type="button" role="menuitem" onClick={startCreateFolder}>
              <PlusIcon />
              <span className="asset-library-menu-label">新建文件夹</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={folder.id === FAVORITES_FOLDER_ID}
              title={folder.id === FAVORITES_FOLDER_ID ? '默认收藏夹不能重命名' : undefined}
              onClick={() => startRenameFolder(folder.id, folder.name)}
            >
              <EditIcon />
              <span className="asset-library-menu-label">重命名</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={folderItems.length === 0 || targets.length === 0}
              title={folderItems.length === 0 ? '文件夹内还没有素材' : targets.length === 0 ? '没有其他文件夹' : '移动这个文件夹里的全部素材'}
              onClick={() => setMenu({ ...menu, view: 'move' })}
            >
              <MoveIcon />
              <span className="asset-library-menu-label">移动内容到…</span>
            </button>
            <button type="button" role="menuitem" disabled={Boolean(busyId)} onClick={() => void duplicateFolder(folder.id)}>
              <CopyIcon />
              <span className="asset-library-menu-label">创建副本</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={folderItems.length === 0}
              onClick={() => downloadAssets(folderItems)}
            >
              <DownloadIcon />
              <span className="asset-library-menu-label">下载</span>
            </button>
            <div className="asset-library-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              disabled={folder.id === FAVORITES_FOLDER_ID || folderItems.length > 0 || busyId === folder.id}
              title={
                folder.id === FAVORITES_FOLDER_ID
                  ? '默认收藏夹不能删除'
                  : folderItems.length > 0
                    ? '请先移动或删除文件夹内的素材'
                    : '删除文件夹'
              }
              onClick={() => void deleteFolder(folder.id)}
            >
              <TrashIcon />
              <span className="asset-library-menu-label">删除</span>
            </button>
          </>
        ) : item ? (
          <>
            <button
              type="button"
              role="menuitem"
              disabled={!item.prompt.trim()}
              onClick={() => {
                closeMenu();
                onUsePrompt(item.prompt);
              }}
            >
              <PromptIcon />
              <span className="asset-library-menu-label">使用提示词</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={targets.length === 0}
              title={targets.length === 0 ? '没有其他文件夹' : undefined}
              onClick={() => setMenu({ ...menu, view: 'move' })}
            >
              <MoveIcon />
              <span className="asset-library-menu-label">移动到…</span>
            </button>
            <button type="button" role="menuitem" disabled={Boolean(busyId)} onClick={() => void duplicateItem(item)}>
              <CopyIcon />
              <span className="asset-library-menu-label">创建副本</span>
            </button>
            <button type="button" role="menuitem" onClick={() => downloadAssets([item])}>
              <DownloadIcon />
              <span className="asset-library-menu-label">下载</span>
            </button>
            <div className="asset-library-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              disabled={busyId === item.id}
              onClick={() => void removeItem(item.id)}
            >
              <TrashIcon />
              <span className="asset-library-menu-label">从资产库移除</span>
            </button>
          </>
        ) : (
          <p className="asset-library-menu-note">这项资产已不存在</p>
        )}
      </div>,
      document.body,
    );
  };

  return (
    <>
      <div
        className="asset-library-dismiss"
        role="presentation"
        aria-hidden="true"
        onClick={() => setClosing(true)}
      />
      <section
        className={`image-history-panel is-canvas-panel asset-library-panel${closing ? ' is-leaving' : ''}`}
        role="dialog"
        aria-label="资产库"
        onClick={(event) => event.stopPropagation()}
        onAnimationEnd={(event) => {
          if (closing && event.target === event.currentTarget) onClose();
        }}
      >
        <header className="image-history-head">
          <div className="image-history-title">
            <strong>资产库</strong>
            <span>({loading ? '…' : library.items.length})</span>
          </div>
          <div className="image-history-head-actions">
            <button
              type="button"
              className="asset-library-view-toggle"
              aria-pressed={view === 'detail'}
              aria-label={view === 'compact' ? '切换为详细列表' : '切换为紧凑列表'}
              title={view === 'compact' ? '切换为详细列表' : '切换为紧凑列表'}
              onClick={() => setView((current) => (current === 'compact' ? 'detail' : 'compact'))}
            >
              {view === 'compact' ? <DetailedListIcon /> : <CompactListIcon />}
            </button>
            <button type="button" aria-label="关闭资产库" title="关闭" onClick={() => setClosing(true)}>
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="asset-library-scroll">
          {error ? <div className="image-history-error" role="alert">{error}</div> : null}
          {loading ? <div className="image-history-empty" role="status">正在读取资产…</div> : null}
          {!loading && library.folders.length === 0 ? (
            <div className="image-history-empty">还没有资产文件夹</div>
          ) : null}

          <div className="asset-library-tree" aria-label="资产库文件夹">
            {library.folders.map((folder) => {
              const expanded = expandedFolderId === folder.id;
              const folderItems = itemsByFolder.get(folder.id) || [];
              const folderCount = counts.get(folder.id) || 0;
              const panelId = `asset-folder-panel-${folder.id}`;

              return (
                <section
                  className={`asset-library-tree-section${expanded ? ' is-expanded' : ''}`}
                  key={folder.id}
                >
                  <div className="asset-library-folder-row">
                    {renamingFolderId === folder.id ? (
                      <form className="asset-library-folder-rename" onSubmit={saveRename}>
                        <input
                          aria-label="文件夹名称"
                          value={folderDraft}
                          autoFocus
                          maxLength={48}
                          onChange={(event) => setFolderDraft(event.currentTarget.value)}
                        />
                        <button type="submit" aria-label="保存文件夹名称" title="保存">✓</button>
                        <button
                          type="button"
                          aria-label="取消重命名"
                          title="取消"
                          onClick={() => {
                            setRenamingFolderId('');
                            setFolderDraft('');
                          }}
                        >
                          ×
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="asset-library-folder-main"
                          aria-expanded={expanded}
                          aria-controls={panelId}
                          onClick={() => setExpandedFolderId(folder.id)}
                        >
                          <span className="asset-library-folder-chevron" aria-hidden="true"><ChevronIcon /></span>
                          <span className="asset-library-folder-icon" aria-hidden="true"><FolderIcon /></span>
                          <span className="asset-library-folder-name">{folder.name}</span>
                          <span className="asset-library-folder-count">{folderCount}</span>
                        </button>
                        <button
                          type="button"
                          className="asset-library-more-button"
                          data-asset-more-trigger="true"
                          aria-label={`更多操作：${folder.name}`}
                          aria-haspopup="menu"
                          aria-expanded={menu?.kind === 'folder' && menu.id === folder.id}
                          aria-controls="asset-library-more-menu"
                          title="更多"
                          onClick={(event) => openMenu(event, 'folder', folder.id, folder.id)}
                        >
                          <MoreIcon />
                        </button>
                      </>
                    )}
                  </div>

                  {expanded ? (
                    <div
                      className="asset-library-folder-content"
                      id={panelId}
                      role="region"
                      aria-label={`${folder.name}中的收藏`}
                    >
                      {folderItems.length === 0 ? (
                        <div className="asset-library-empty">这个文件夹还没有收藏素材</div>
                      ) : (
                        <div className={`asset-library-list is-${view}`}>
                          {folderItems.map((item) => {
                            const displayName = item.prompt || item.fileName || '未命名收藏';
                            const meta = [item.model, item.size].filter(Boolean).join(' · ');
                            return (
                              <article className="asset-library-list-item" key={item.id}>
                                <button
                                  type="button"
                                  className="asset-library-item-thumb"
                                  onClick={() => onPreview(item)}
                                  title={item.prompt || '预览图片'}
                                  aria-label={`预览 ${displayName}`}
                                >
                                  <CanvasImage src={item.url} alt={displayName} loading="lazy" draggable={false} />
                                </button>
                                <button
                                  type="button"
                                  className="asset-library-item-copy"
                                  onClick={() => onPreview(item)}
                                  title={displayName}
                                >
                                  <span className="asset-library-item-prompt">{displayName}</span>
                                  <span className="asset-library-item-meta">
                                    {meta || '未记录模型与尺寸'}
                                  </span>
                                  {view === 'detail' ? (
                                    <span className="asset-library-item-file">{item.fileName}</span>
                                  ) : null}
                                </button>
                                <button
                                  type="button"
                                  className="asset-library-more-button"
                                  data-asset-more-trigger="true"
                                  aria-label={`更多操作：${displayName}`}
                                  aria-haspopup="menu"
                                  aria-expanded={menu?.kind === 'item' && menu.id === item.id}
                                  aria-controls="asset-library-more-menu"
                                  title="更多"
                                  onClick={(event) => openMenu(event, 'item', item.id, item.folderId)}
                                >
                                  <MoreIcon />
                                </button>
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })}
            {creatingFolder ? (
              <form className="asset-library-folder-create" onSubmit={handleCreateFolder}>
                <FolderPlusIcon />
                <input
                  ref={newFolderInputRef}
                  value={newFolderName}
                  maxLength={48}
                  placeholder="新建文件夹"
                  aria-label="新文件夹名称"
                  autoFocus
                  onChange={(event) => setNewFolderName(event.currentTarget.value)}
                />
                <button
                  type="submit"
                  disabled={!newFolderName.trim() || busyId === 'folder-new'}
                  aria-label="创建文件夹"
                  title="创建"
                >
                  ✓
                </button>
                <button
                  type="button"
                  aria-label="取消新建文件夹"
                  title="取消"
                  onClick={() => {
                    setCreatingFolder(false);
                    setNewFolderName('');
                  }}
                >
                  ×
                </button>
              </form>
            ) : null}
          </div>
        </div>
        {renderMenu()}
      </section>
    </>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.25" fill="currentColor" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.25" fill="currentColor" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 11.5v5M9.5 14h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m14.8 5.2 4 4M5 19l3.7-.8L19 7.9a1.4 1.4 0 0 0 0-2l-1.9-1.9a1.4 1.4 0 0 0-2 0L5.8 14.3 5 19Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 7h15M9.5 3.8h5M7 7l.7 12.1a1.7 1.7 0 0 0 1.7 1.6h5.2a1.7 1.7 0 0 0 1.7-1.6L17 7M10 10.5v6.2M14 10.5v6.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PromptIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 6.5h14M5 11h9M5 15.5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m17 13.5 3.2 3.2-4.3 4.3-3.8.6.6-3.8 4.3-4.3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function MoveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 13.5h6M13 11.5l2 2-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="8.2" y="8.2" width="11.3" height="11.3" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M15.5 8.2V6.7a2 2 0 0 0-2-2H6.7a2 2 0 0 0-2 2v6.8a2 2 0 0 0 2 2h1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.8v10.7M8 10.8l4 4 4-4M5 19.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CompactListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 6.5h11M9 12h11M9 17.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="4.8" cy="6.5" r="1.1" fill="currentColor" />
      <circle cx="4.8" cy="12" r="1.1" fill="currentColor" />
      <circle cx="4.8" cy="17.5" r="1.1" fill="currentColor" />
    </svg>
  );
}

function DetailedListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.2" y="4.5" width="6.2" height="6.2" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.2 6h8.4M12.2 9.2h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="3.2" y="13.3" width="6.2" height="6.2" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.2 14.8h8.4M12.2 18h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
