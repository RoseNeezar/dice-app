import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Folder, ID, ScanDocument, SortKey } from '@/types';
import { useStore, type Route } from '@/state/store';
import * as repo from '@/lib/db/repository';
import { DocCard, formatBytes, useDocumentBytes, useLongPress } from '@/features/docs/DocCard';
import { FolderPicker, PromptDialog } from '@/features/docs/FolderPicker';
import { SelectionBar, type SelectionAction } from '@/features/docs/SelectionBar';
import { collectTags, searchDocuments, type SearchSnippet } from '@/features/docs/search';
import { ExportSheet } from '@/features/export/ExportSheet';
import { Icon } from '@/ui/Icon';
import { Button, EmptyState, Fab, IconButton, ProgressBar, Spinner, TopBar } from '@/ui/primitives';
import { Dialog, MenuSheet, Sheet, type MenuItem } from '@/ui/Sheet';
import './HomeScreen.css';

/** How long the search box waits before re-running the query. */
const SEARCH_DEBOUNCE = 200;

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: 'Last modified' },
  { key: 'created', label: 'Date created' },
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size' },
];

type SheetName = 'sort' | 'overflow' | 'move' | 'folder' | null;
type DialogName = 'newFolder' | 'renameFolder' | 'deleteFolder' | 'tag' | 'emptyTrash' | 'purge' | null;

/**
 * The library: folders, documents, search and the trash. One screen serves the
 * `home`, `folder`, `trash` and `search` routes because they differ only in
 * which documents they list and which actions apply to them.
 */
export function HomeScreen({ route }: { route: Route }) {
  const docs = useStore((s) => s.docs);
  const pages = useStore((s) => s.pages);
  const folders = useStore((s) => s.folders);
  const settings = useStore((s) => s.settings);
  const selection = useStore((s) => s.selection);
  const query = useStore((s) => s.query);

  const folderId = route.name === 'folder' ? route.folderId : null;
  const inTrash = route.name === 'trash';
  const searching = route.name === 'search';

  const [sheet, setSheet] = useState<SheetName>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [menuFolderId, setMenuFolderId] = useState<ID | null>(null);
  /* Selection mode belongs to one listing: naming the listing it was entered
     from is what makes it end by itself when the route changes. */
  const [selectScope, setSelectScope] = useState<string | null>(null);
  const [starredOnly, setStarredOnly] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [draft, setDraft] = useState(query);
  const [importing, setImporting] = useState(false);
  const [exportDocId, setExportDocId] = useState<ID | null>(null);
  const [storage, setStorage] = useState<repo.StorageUsage | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const closeSheet = useCallback(() => setSheet(null), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  const run = useCallback(async (task: () => Promise<unknown>, failure: string) => {
    try {
      await task();
    } catch (error) {
      useStore.getState().notify(error instanceof Error ? error.message : failure, 'error');
    }
  }, []);

  /* ---------------- data ---------------- */

  const scoped = useMemo(() => {
    const all = Object.values(docs);
    if (inTrash) return all.filter((doc) => doc.deletedAt !== null);
    const live = all.filter((doc) => doc.deletedAt === null);
    if (searching) return live;
    return live.filter((doc) => doc.folderId === folderId);
  }, [docs, folderId, inTrash, searching]);

  const tags = useMemo(() => collectTags(scoped), [scoped]);

  const filtered = useMemo(() => {
    let list = scoped;
    if (starredOnly) list = list.filter((doc) => doc.starred);
    if (activeTag) list = list.filter((doc) => doc.tags.includes(activeTag));
    return list;
  }, [activeTag, scoped, starredOnly]);

  const filteredIds = useMemo(() => filtered.map((doc) => doc.id), [filtered]);
  const sizes = useDocumentBytes(filteredIds, settings.sortKey === 'size' && !searching);

  const hits = useMemo(
    () => (searching ? searchDocuments(query, filtered, pages) : []),
    [filtered, pages, query, searching],
  );

  const listed = useMemo(() => {
    if (searching) {
      const byId = new Map(filtered.map((doc) => [doc.id, doc]));
      return hits.map((hit) => byId.get(hit.docId)).filter((doc): doc is ScanDocument => Boolean(doc));
    }
    const direction = settings.sortAsc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (settings.sortKey) {
        case 'name':
          return a.title.localeCompare(b.title) * direction;
        case 'created':
          return (a.createdAt - b.createdAt) * direction;
        case 'size':
          return ((sizes[a.id] ?? 0) - (sizes[b.id] ?? 0)) * direction;
        default:
          return (a.updatedAt - b.updatedAt) * direction;
      }
    });
  }, [filtered, hits, searching, settings.sortAsc, settings.sortKey, sizes]);

  const snippets = useMemo(() => {
    const map = new Map<ID, SearchSnippet>();
    for (const hit of hits) if (hit.snippet) map.set(hit.docId, hit.snippet);
    return map;
  }, [hits]);

  const childFolders = useMemo(
    () =>
      Object.values(folders)
        .filter((folder) => folder.parentId === folderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folderId, folders],
  );

  const folderCounts = useMemo(() => {
    const counts = new Map<ID, number>();
    for (const doc of Object.values(docs)) {
      if (doc.deletedAt !== null || doc.folderId === null) continue;
      counts.set(doc.folderId, (counts.get(doc.folderId) ?? 0) + 1);
    }
    return counts;
  }, [docs]);

  const folder = folderId ? folders[folderId] : null;
  const menuFolder = menuFolderId ? folders[menuFolderId] : null;
  const scope = `${route.name}:${folderId ?? ''}`;
  const selecting = selectScope === scope || selection.length > 0;
  const selectedDocs = useMemo(
    () => selection.map((id) => docs[id]).filter((doc): doc is ScanDocument => Boolean(doc)),
    [docs, selection],
  );

  /* ---------------- effects ---------------- */

  useEffect(() => {
    if (!searching) return;
    searchRef.current?.focus();
  }, [searching]);

  useEffect(() => {
    const timer = window.setTimeout(() => useStore.getState().setQuery(draft), SEARCH_DEBOUNCE);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    if (sheet !== 'overflow') return;
    let alive = true;
    void repo
      .storageUsage()
      .then((usage) => {
        if (alive) setStorage(usage);
      })
      .catch(() => {
        if (alive) setStorage(null);
      });
    return () => {
      alive = false;
    };
  }, [sheet]);

  // A folder deleted from elsewhere must not leave the user on a dead route.
  useEffect(() => {
    if (route.name === 'folder' && !folders[route.folderId]) useStore.getState().replace({ name: 'home' });
  }, [folders, route]);

  /* ---------------- actions ---------------- */

  const leaveSelection = useCallback(() => {
    useStore.getState().clearSelection();
    setSelectScope(null);
  }, []);

  const openDoc = useCallback(
    (doc: ScanDocument) => {
      if (selecting) {
        useStore.getState().toggleSelect(doc.id);
        return;
      }
      if (doc.deletedAt !== null) {
        useStore.getState().notify('Restore this document to open it');
        return;
      }
      useStore.getState().navigate({ name: 'doc', docId: doc.id });
    },
    [selecting],
  );

  const beginSelection = useCallback(
    (docId: ID) => {
      setSelectScope(scope);
      const state = useStore.getState();
      if (!state.selection.includes(docId)) state.toggleSelect(docId);
    },
    [scope],
  );

  const onImport = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setImporting(true);
      try {
        const docId = await useStore.getState().importImages(files, { folderId });
        // Imports land in the crop review, exactly as a capture does: the
        // detected corners are a suggestion, and this is where they get
        // confirmed or nudged before the document is filed away.
        if (docId) useStore.getState().navigate({ name: 'review', docId });
      } catch (error) {
        useStore
          .getState()
          .notify(error instanceof Error ? error.message : 'Those images could not be imported', 'error');
      } finally {
        setImporting(false);
      }
    },
    [folderId],
  );

  const addTags = useCallback(
    async (value: string) => {
      const added = value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      if (added.length === 0) return;
      const state = useStore.getState();
      for (const doc of selectedDocs) {
        await state.setDocumentTags(doc.id, [...doc.tags, ...added]);
      }
      state.notify(`Tagged ${selectedDocs.length === 1 ? 'document' : `${selectedDocs.length} documents`}`, 'success');
      leaveSelection();
    },
    [leaveSelection, selectedDocs],
  );

  const merge = useCallback(async () => {
    const docId = await useStore.getState().mergeDocuments(selection);
    if (!docId) {
      useStore.getState().notify('Select at least two documents to merge', 'error');
      return;
    }
    leaveSelection();
    useStore.getState().navigate({ name: 'doc', docId });
  }, [leaveSelection, selection]);

  const selectionActions: SelectionAction[] = inTrash
    ? [
        {
          icon: 'undo',
          label: 'Restore',
          onSelect: () => {
            void run(() => useStore.getState().restoreDocuments(selection), 'Could not restore');
            setSelectScope(null);
          },
        },
        {
          icon: 'trash',
          label: 'Delete',
          tone: 'danger',
          onSelect: () => setDialog('purge'),
        },
      ]
    : [
        {
          icon: 'share',
          label: 'Export',
          disabled: selection.length !== 1,
          onSelect: () => setExportDocId(selection[0] ?? null),
        },
        { icon: 'folder', label: 'Move', onSelect: () => setSheet('move') },
        { icon: 'merge', label: 'Merge', disabled: selection.length < 2, onSelect: () => void merge() },
        { icon: 'tag', label: 'Tag', onSelect: () => setDialog('tag') },
        {
          icon: 'trash',
          label: 'Delete',
          tone: 'danger',
          onSelect: () => {
            void run(() => useStore.getState().trashDocuments(selection), 'Could not move to trash');
            setSelectScope(null);
          },
        },
      ];

  const overflowItems: MenuItem[] = [
    {
      icon: 'folderPlus',
      label: 'New folder',
      onSelect: () => setDialog('newFolder'),
    },
    {
      icon: 'check',
      label: 'Select documents',
      disabled: listed.length === 0,
      onSelect: () => setSelectScope(scope),
    },
    {
      icon: settings.viewMode === 'grid' ? 'list' : 'grid',
      label: settings.viewMode === 'grid' ? 'Show as list' : 'Show as grid',
      onSelect: () => void useStore.getState().setViewMode(settings.viewMode === 'grid' ? 'list' : 'grid'),
    },
    {
      icon: 'trash',
      label: 'Trash',
      onSelect: () => useStore.getState().navigate({ name: 'trash' }),
    },
    {
      icon: 'settings',
      label: 'Settings',
      onSelect: () => useStore.getState().navigate({ name: 'settings' }),
    },
  ];

  /* ---------------- header ---------------- */

  const title = inTrash ? 'Trash' : folder ? folder.name : 'OpenScan';

  const header = searching ? (
    <TopBar
      onBack={() => {
        setDraft('');
        useStore.getState().setQuery('');
        useStore.getState().back();
      }}
      backLabel="Close search"
      title={
        <div className="home__searchbox">
          <Icon name="search" size={18} />
          <input
            ref={searchRef}
            type="search"
            value={draft}
            placeholder="Search titles, tags and text"
            aria-label="Search documents"
            enterKeyHint="search"
            onChange={(event) => setDraft(event.target.value)}
          />
          {draft !== '' && (
            <IconButton
              icon="close"
              label="Clear search"
              onClick={() => {
                setDraft('');
                searchRef.current?.focus();
              }}
            />
          )}
        </div>
      }
    />
  ) : (
    <TopBar
      title={title}
      subtitle={inTrash && listed.length > 0 ? `${listed.length} in trash` : undefined}
      onBack={route.name === 'home' ? undefined : () => useStore.getState().back()}
      right={
        inTrash ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={listed.length === 0}
            onClick={() => setDialog('emptyTrash')}
          >
            Empty
          </Button>
        ) : (
          <>
            <IconButton
              icon="search"
              label="Search documents"
              onClick={() => useStore.getState().navigate({ name: 'search' })}
            />
            <IconButton
              icon={settings.viewMode === 'grid' ? 'list' : 'grid'}
              label={settings.viewMode === 'grid' ? 'Show as list' : 'Show as grid'}
              onClick={() => void useStore.getState().setViewMode(settings.viewMode === 'grid' ? 'list' : 'grid')}
            />
            <IconButton icon="sort" label="Sort documents" onClick={() => setSheet('sort')} />
            <IconButton icon="more" label="More options" onClick={() => setSheet('overflow')} />
          </>
        )
      }
    />
  );

  /* ---------------- body ---------------- */

  const hasAnything = Object.values(docs).some((doc) => doc.deletedAt === null) || childFolders.length > 0;
  const filtersActive = starredOnly || activeTag !== null;

  let body: ReactNode;
  if (listed.length > 0) {
    body = (
      <div className={`home__docs home__docs--${settings.viewMode}`}>
        {listed.map((doc) => (
          <DocCard
            key={doc.id}
            doc={doc}
            view={settings.viewMode}
            selecting={selecting}
            selected={selection.includes(doc.id)}
            snippet={snippets.get(doc.id)}
            onOpen={() => openDoc(doc)}
            onLongPress={() => beginSelection(doc.id)}
            onToggleStar={
              inTrash ? undefined : () => void run(() => useStore.getState().toggleStar(doc.id), 'Could not star')
            }
          />
        ))}
      </div>
    );
  } else if (searching) {
    body =
      query.trim() === '' ? (
        <EmptyState
          icon="search"
          title="Search your library"
          body="Titles, tags and every word OpenScan has read from your pages."
        />
      ) : (
        <EmptyState
          icon="search"
          title="No results"
          body={`Nothing matches “${query.trim()}”. Pages only become searchable once their text has been read.`}
        />
      );
  } else if (inTrash) {
    body = (
      <EmptyState icon="trash" title="Trash is empty" body="Documents you delete wait here until you empty it." />
    );
  } else if (filtersActive) {
    body = (
      <EmptyState
        icon="tag"
        title="Nothing matches"
        body="No document here has those filters."
        action={
          <Button
            onClick={() => {
              setStarredOnly(false);
              setActiveTag(null);
            }}
          >
            Clear filters
          </Button>
        }
      />
    );
  } else if (folder) {
    body = (
      <EmptyState
        icon="folder"
        title="This folder is empty"
        body="Scan straight into it with the camera button, or move documents here from the library."
      />
    );
  } else {
    body = (
      <EmptyState
        icon={hasAnything ? 'folder' : 'camera'}
        title={hasAnything ? 'Nothing here yet' : 'Scan your first document'}
        body={
          hasAnything
            ? 'Your documents are filed in the folders above.'
            : 'Tap the camera button to scan, or import photos you already have. Everything stays on this device.'
        }
      />
    );
  }

  return (
    <div className="screen home">
      {header}

      <div className="screen__body">
        {!inTrash && !searching && childFolders.length > 0 && (
          <ul className="home__folders" aria-label="Folders">
            {childFolders.map((item) => (
              <FolderChip
                key={item.id}
                folder={item}
                count={folderCounts.get(item.id) ?? 0}
                onOpen={() => useStore.getState().navigate({ name: 'folder', folderId: item.id })}
                onMenu={() => {
                  setMenuFolderId(item.id);
                  setSheet('folder');
                }}
              />
            ))}
          </ul>
        )}

        {!inTrash && (tags.length > 0 || scoped.some((doc) => doc.starred)) && (
          <div className="home__filters" role="group" aria-label="Filters">
            <button
              type="button"
              className={`home__chip ${starredOnly ? 'is-on' : ''}`}
              aria-pressed={starredOnly}
              onClick={() => setStarredOnly((on) => !on)}
            >
              <Icon name="star" size={15} filled={starredOnly} />
              Starred
            </button>
            {tags.map(({ tag, count }) => (
              <button
                key={tag}
                type="button"
                className={`home__chip ${activeTag === tag ? 'is-on' : ''}`}
                aria-pressed={activeTag === tag}
                onClick={() => setActiveTag((current) => (current === tag ? null : tag))}
              >
                {tag}
                <span className="home__chip-count">{count}</span>
              </button>
            ))}
          </div>
        )}

        {searching && query.trim() !== '' && (
          <p className="home__results" aria-live="polite">
            {listed.length === 1 ? '1 result' : `${listed.length} results`}
          </p>
        )}

        {body}
      </div>

      {!selecting && !inTrash && !searching && (
        <div className="home__fabs">
          <button
            type="button"
            className="home__import"
            aria-label="Import images"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            {importing ? <Spinner size={20} label="Importing" /> : <Icon name="image" size={20} />}
          </button>
          <Fab
            icon="camera"
            label="Scan a document"
            onClick={() => void run(() => useStore.getState().beginCapture({ folderId }), 'Could not open the camera')}
          />
        </div>
      )}

      {selecting && (
        <SelectionBar
          count={selection.length}
          total={listed.length}
          noun="document"
          actions={selectionActions}
          onSelectAll={() => useStore.getState().selectAll(listed.map((doc) => doc.id))}
          onDone={leaveSelection}
        />
      )}

      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          void onImport(files);
        }}
      />

      <MenuSheet
        open={sheet === 'sort'}
        title="Sort by"
        onClose={closeSheet}
        items={SORT_OPTIONS.map((option) => ({
          icon: settings.sortKey === option.key ? 'check' : 'sort',
          label: option.label,
          hint:
            settings.sortKey === option.key
              ? `${settings.sortAsc ? 'Ascending' : 'Descending'} — choose again to reverse`
              : undefined,
          onSelect: () => void useStore.getState().setSort(option.key),
        }))}
      />

      <MenuSheet
        open={sheet === 'folder'}
        title={menuFolder?.name}
        onClose={closeSheet}
        items={[
          { icon: 'edit', label: 'Rename', onSelect: () => setDialog('renameFolder') },
          { icon: 'trash', label: 'Delete folder', tone: 'danger', onSelect: () => setDialog('deleteFolder') },
        ]}
      />

      <Sheet open={sheet === 'overflow'} title="OpenScan" onClose={closeSheet}>
        <ul className="menu">
          {overflowItems.map((item) => (
            <li key={item.label}>
              <button
                type="button"
                className="menu__item"
                disabled={item.disabled}
                onClick={() => {
                  closeSheet();
                  item.onSelect();
                }}
              >
                <Icon name={item.icon} size={20} />
                <span className="menu__label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="home__storage">
          {storage ? (
            <>
              <div className="home__storage-head">
                <span>
                  {storage.documents === 1 ? '1 document' : `${storage.documents} documents`} ·{' '}
                  {storage.pages === 1 ? '1 page' : `${storage.pages} pages`}
                </span>
                <span className="tiny muted">
                  {formatBytes(storage.usage)}
                  {storage.quota > 0 ? ` of ${formatBytes(storage.quota)}` : ''}
                </span>
              </div>
              {storage.quota > 0 && (
                <ProgressBar value={storage.usage / storage.quota} label="Storage used on this device" />
              )}
            </>
          ) : (
            <span className="tiny muted">Measuring storage…</span>
          )}
        </div>
      </Sheet>

      <FolderPicker
        open={sheet === 'move'}
        title={selection.length === 1 ? 'Move document' : `Move ${selection.length} documents`}
        currentFolderId={folderId}
        onClose={closeSheet}
        onPick={(target) => {
          closeSheet();
          void run(async () => {
            await useStore.getState().moveDocuments(selection, target);
            setSelectScope(null);
          }, 'Could not move those documents');
        }}
      />

      <PromptDialog
        open={dialog === 'newFolder'}
        title="New folder"
        label="Folder name"
        confirmLabel="Create"
        onClose={closeDialog}
        onConfirm={(value) => {
          closeDialog();
          void run(() => useStore.getState().newFolder(value, folderId), 'Could not create that folder');
        }}
      />

      <PromptDialog
        open={dialog === 'renameFolder'}
        title="Rename folder"
        label="Folder name"
        initial={menuFolder?.name ?? ''}
        confirmLabel="Rename"
        onClose={closeDialog}
        onConfirm={(value) => {
          closeDialog();
          if (!menuFolderId) return;
          void run(() => useStore.getState().renameFolder(menuFolderId, value), 'Could not rename that folder');
        }}
      />

      <PromptDialog
        open={dialog === 'tag'}
        title="Add tags"
        label="Tags"
        hint="Separate several tags with commas."
        confirmLabel="Add"
        onClose={closeDialog}
        onConfirm={(value) => {
          closeDialog();
          void run(() => addTags(value), 'Could not tag those documents');
        }}
      />

      <Dialog
        open={dialog === 'deleteFolder'}
        title={`Delete “${menuFolder?.name ?? ''}”?`}
        body="The folder and any folders inside it are removed. The documents they hold are moved to the trash, not deleted."
        confirmLabel="Delete"
        destructive
        onClose={closeDialog}
        onConfirm={() => {
          closeDialog();
          if (!menuFolderId) return;
          void run(() => useStore.getState().deleteFolder(menuFolderId), 'Could not delete that folder');
        }}
      />

      <Dialog
        open={dialog === 'emptyTrash'}
        title="Empty the trash?"
        body="Every document in the trash is permanently deleted. This cannot be undone."
        confirmLabel="Empty trash"
        destructive
        onClose={closeDialog}
        onConfirm={() => {
          closeDialog();
          void run(() => useStore.getState().emptyTrash(), 'Could not empty the trash');
        }}
      />

      <Dialog
        open={dialog === 'purge'}
        title={selection.length === 1 ? 'Delete this document?' : `Delete ${selection.length} documents?`}
        body="They are permanently deleted, along with every page and scan inside them."
        confirmLabel="Delete forever"
        destructive
        onClose={closeDialog}
        onConfirm={() => {
          closeDialog();
          void run(async () => {
            await useStore.getState().purgeDocuments(selection);
            setSelectScope(null);
          }, 'Could not delete those documents');
        }}
      />

      <ExportSheet
        open={exportDocId !== null}
        docId={exportDocId ?? ''}
        pageIds={null}
        onClose={() => setExportDocId(null)}
      />
    </div>
  );
}

/** A folder tile: tap to open, press and hold for rename and delete. */
function FolderChip({
  folder,
  count,
  onOpen,
  onMenu,
}: {
  folder: Folder;
  count: number;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const press = useLongPress({ onLongPress: onMenu, onClick: onOpen });
  return (
    <li>
      <button type="button" className="home__folder" {...press}>
        <Icon name="folder" size={20} />
        <span className="home__folder-name truncate">{folder.name}</span>
        <span className="home__folder-count">{count}</span>
      </button>
    </li>
  );
}
