import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FilterId, ID } from '@/types';
import { useStore } from '@/state/store';
import * as repo from '@/lib/db/repository';
import { recognizeImage } from '@/lib/ocr/ocr';
import {
  DOCUMENT_COLORS,
  documentColorVar,
  formatBytes,
  formatPageCount,
  formatRelative,
  useDocumentBytes,
} from '@/features/docs/DocCard';
import { FolderPicker, PromptDialog } from '@/features/docs/FolderPicker';
import { PageGrid } from '@/features/docs/PageGrid';
import { SelectionBar, type SelectionAction } from '@/features/docs/SelectionBar';
import { ExportSheet } from '@/features/export/ExportSheet';
import { Icon, type IconName } from '@/ui/Icon';
import { Button, EmptyState, IconButton, ProgressBar, ToolButton, Toolbar, TopBar } from '@/ui/primitives';
import { Dialog, MenuSheet, Sheet, type MenuItem } from '@/ui/Sheet';
import './DocumentScreen.css';

/** Stable empty list so the page selector never returns a fresh array. */
const NO_PAGES: ID[] = [];

const FILTERS: { id: FilterId; label: string; icon: IconName }[] = [
  { id: 'original', label: 'Original', icon: 'image' },
  { id: 'magic', label: 'Magic colour', icon: 'magic' },
  { id: 'enhance', label: 'Enhance', icon: 'sun' },
  { id: 'gray', label: 'Greyscale', icon: 'contrast' },
  { id: 'bw', label: 'Black & white', icon: 'droplet' },
  { id: 'ink', label: 'Ink', icon: 'pen' },
];

type SheetName = 'add' | 'overflow' | 'folder' | 'colour' | 'filter' | 'movePages' | 'mergeInto' | null;
type DialogName = 'rename' | 'tag' | 'trash' | 'deletePages' | null;

/** Progress of the "read every page" job. */
interface OcrJob {
  total: number;
  done: number;
  /** 0..1 within the page currently being read. */
  progress: number;
  status: string;
}

/**
 * One document: its pages, their order, and everything you can do to the
 * document as a whole. Page edits live in the editor; this screen is about the
 * document — naming, filing, sharing, reading and rearranging.
 */
export function DocumentScreen({ docId }: { docId: ID }) {
  const doc = useStore((s) => s.docs[docId]);
  const selection = useStore((s) => s.selection);
  const pageIds = doc?.pageIds ?? NO_PAGES;

  const [sheet, setSheet] = useState<SheetName>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [exportPages, setExportPages] = useState<ID[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [ocrJob, setOcrJob] = useState<OcrJob | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const cancelOcr = useRef(false);

  const docIds = useMemo(() => [docId], [docId]);
  const sizes = useDocumentBytes(docIds);
  const bytes = sizes[docId];

  const selecting = selectMode || selection.length > 0;
  const selected = useMemo(
    () => selection.filter((id) => pageIds.includes(id)),
    [pageIds, selection],
  );

  const closeSheet = useCallback(() => setSheet(null), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  const run = useCallback(async (task: () => Promise<unknown>, failure: string) => {
    try {
      await task();
    } catch (error) {
      useStore.getState().notify(error instanceof Error ? error.message : failure, 'error');
    }
  }, []);

  const leaveSelection = useCallback(() => {
    useStore.getState().clearSelection();
    setSelectMode(false);
  }, []);

  // An unfinished read must not keep running once the screen is gone.
  useEffect(
    () => () => {
      cancelOcr.current = true;
    },
    [],
  );

  /* ---------------- pages ---------------- */

  const openPage = useCallback(
    (pageId: ID) => {
      if (selecting) {
        useStore.getState().toggleSelect(pageId);
        return;
      }
      useStore.getState().navigate({ name: 'viewer', docId, pageId });
    },
    [docId, selecting],
  );

  const beginSelection = useCallback((pageId: ID) => {
    setSelectMode(true);
    const state = useStore.getState();
    if (!state.selection.includes(pageId)) state.toggleSelect(pageId);
  }, []);

  const editPage = useCallback(() => {
    const pageId = selected[0] ?? pageIds[0];
    if (!pageId) return;
    useStore.getState().navigate({ name: 'edit', docId, pageId });
  }, [docId, pageIds, selected]);

  const rotateSelected = useCallback(async () => {
    const state = useStore.getState();
    for (const pageId of selected) await state.rotatePage(pageId, 90);
  }, [selected]);

  const splitSelected = useCallback(async () => {
    const newId = await useStore.getState().splitDocument(docId, selected);
    leaveSelection();
    if (!newId) {
      useStore.getState().notify('Those pages could not be split out', 'error');
      return;
    }
    useStore.getState().notify('Split into a new document', 'success');
    useStore.getState().navigate({ name: 'doc', docId: newId });
  }, [docId, leaveSelection, selected]);

  /* ---------------- OCR ---------------- */

  const readAllPages = useCallback(async () => {
    const state = useStore.getState();
    const targets = (state.docs[docId]?.pageIds ?? []).filter((id) => !state.pages[id]?.ocr);
    if (targets.length === 0) {
      state.notify('Every page has already been read');
      return;
    }
    cancelOcr.current = false;
    setOcrJob({ total: targets.length, done: 0, progress: 0, status: 'Starting' });
    let done = 0;
    try {
      for (const pageId of targets) {
        if (cancelOcr.current) break;
        const page = useStore.getState().pages[pageId];
        if (!page) continue;
        const blob = await repo.getBlob(page.processedBlobId ?? page.originalBlobId);
        if (!blob) throw new Error('That page is missing its image, so it cannot be read.');
        const result = await recognizeImage(blob, useStore.getState().settings.ocrLanguage, (progress) => {
          setOcrJob((current) =>
            current ? { ...current, progress: progress.progress, status: progress.status } : current,
          );
        });
        if (cancelOcr.current) break;
        await useStore.getState().setPageOcr(pageId, result);
        done += 1;
        setOcrJob((current) => (current ? { ...current, done, progress: 0 } : current));
      }
      if (cancelOcr.current) {
        useStore.getState().notify(done === 0 ? 'Stopped before any page was read' : `Read ${done} of ${targets.length} pages`);
      } else {
        useStore.getState().notify(`Read the text on ${done === 1 ? '1 page' : `${done} pages`}`, 'success');
      }
    } catch (error) {
      useStore
        .getState()
        .notify(error instanceof Error ? error.message : 'The text on this document could not be read', 'error');
    } finally {
      setOcrJob(null);
    }
  }, [docId]);

  /* ---------------- menus ---------------- */

  const overflowItems: MenuItem[] = doc
    ? [
        { icon: 'edit', label: 'Rename', onSelect: () => setDialog('rename') },
        { icon: 'folder', label: 'Move to folder', onSelect: () => setSheet('folder') },
        { icon: 'tag', label: 'Tags', hint: doc.tags.join(', ') || undefined, onSelect: () => setDialog('tag') },
        { icon: 'droplet', label: 'Colour', onSelect: () => setSheet('colour') },
        {
          icon: 'star',
          label: doc.starred ? 'Remove star' : 'Add star',
          onSelect: () => void run(() => useStore.getState().toggleStar(docId), 'Could not star this document'),
        },
        {
          icon: doc.locked ? 'unlock' : 'lock',
          label: doc.locked ? 'Unlock' : 'Lock',
          hint: doc.locked ? undefined : 'Needs the app passcode to open',
          onSelect: () =>
            void run(
              () => useStore.getState().setDocumentLocked(docId, !doc.locked),
              'Could not change the lock',
            ),
        },
        {
          icon: 'copy',
          label: 'Duplicate',
          onSelect: () =>
            void run(async () => {
              const copy = await useStore.getState().duplicateDocument(docId);
              if (copy) useStore.getState().navigate({ name: 'doc', docId: copy });
            }, 'Could not duplicate this document'),
        },
        { icon: 'merge', label: 'Merge into…', onSelect: () => setSheet('mergeInto') },
        {
          icon: 'split',
          label: 'Split out selected pages',
          disabled: selected.length === 0,
          onSelect: () => void splitSelected(),
        },
        { icon: 'trash', label: 'Delete document', tone: 'danger', onSelect: () => setDialog('trash') },
      ]
    : [];

  const selectionActions: SelectionAction[] = [
    { icon: 'share', label: 'Share', onSelect: () => setExportPages(selected) },
    { icon: 'rotateCw', label: 'Rotate', onSelect: () => void run(rotateSelected, 'Could not rotate those pages') },
    { icon: 'move', label: 'Move to…', onSelect: () => setSheet('movePages') },
    { icon: 'split', label: 'Split', onSelect: () => void splitSelected() },
    { icon: 'magic', label: 'Filter all', onSelect: () => setSheet('filter') },
    { icon: 'trash', label: 'Delete', tone: 'danger', onSelect: () => setDialog('deletePages') },
  ];

  /* ---------------- render ---------------- */

  if (!doc) {
    return (
      <div className="screen">
        <TopBar title="Document" onBack={() => useStore.getState().back()} />
        <EmptyState
          icon="info"
          title="This document is gone"
          body="It was deleted, or it was never finished saving."
          action={
            <Button variant="primary" onClick={() => useStore.getState().replace({ name: 'home' })}>
              Back to the library
            </Button>
          }
        />
      </div>
    );
  }

  const subtitle = `${formatPageCount(pageIds.length)} · ${
    bytes === undefined ? '…' : formatBytes(bytes)
  } · ${formatRelative(doc.updatedAt)}`;

  return (
    <div className="screen doc">
      <TopBar
        onBack={() => useStore.getState().back()}
        backLabel="Back to the library"
        title={
          <button
            type="button"
            className="doc__title"
            aria-label={`Rename ${doc.title}`}
            onClick={() => setDialog('rename')}
          >
            {doc.color !== 'none' && (
              <span className="doc__flag" style={{ background: documentColorVar(doc.color) }} aria-hidden="true" />
            )}
            <span className="truncate">{doc.title}</span>
            <Icon name="edit" size={13} />
          </button>
        }
        subtitle={subtitle}
        right={
          <>
            {doc.starred && (
              <span className="doc__star" role="img" aria-label="Starred" title="Starred">
                <Icon name="star" size={18} filled />
              </span>
            )}
            <IconButton icon="more" label="Document options" onClick={() => setSheet('overflow')} />
          </>
        }
      />

      <div className="screen__body">
        {pageIds.length === 0 ? (
          <EmptyState
            icon="camera"
            title="No pages yet"
            body="Scan a page with the camera, or bring in photos you already have."
            action={
              <Button variant="primary" icon="plus" onClick={() => setSheet('add')}>
                Add pages
              </Button>
            }
          />
        ) : (
          <PageGrid
            pageIds={pageIds}
            selecting={selecting}
            selection={selected}
            busy={ocrJob !== null}
            onOpen={openPage}
            onToggle={(pageId) => useStore.getState().toggleSelect(pageId)}
            onLongPress={beginSelection}
            onReorder={(next) => void run(() => useStore.getState().reorderPages(docId, next), 'Could not reorder')}
          />
        )}
      </div>

      {ocrJob && (
        <div className="doc__job">
          <div className="doc__job-head">
            <span aria-live="polite">
              {ocrJob.status} — page {Math.min(ocrJob.done + 1, ocrJob.total)} of {ocrJob.total}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                cancelOcr.current = true;
                setOcrJob((current) => (current ? { ...current, status: 'Finishing this page' } : current));
              }}
            >
              Stop
            </Button>
          </div>
          <ProgressBar value={(ocrJob.done + ocrJob.progress) / ocrJob.total} label="Reading the text on every page" />
        </div>
      )}

      {selecting ? (
        <SelectionBar
          count={selected.length}
          total={pageIds.length}
          noun="page"
          actions={selectionActions}
          onSelectAll={() => useStore.getState().selectAll(pageIds)}
          onDone={leaveSelection}
        />
      ) : (
        <Toolbar>
          <ToolButton icon="plus" label="Add pages" onClick={() => setSheet('add')} />
          <ToolButton
            icon="share"
            label="Share"
            disabled={pageIds.length === 0}
            onClick={() => {
              setExportPages(null);
              setExporting(true);
            }}
          />
          <ToolButton
            icon="textScan"
            label="Read text"
            disabled={pageIds.length === 0 || ocrJob !== null}
            onClick={() => void readAllPages()}
          />
          <ToolButton icon="sliders" label="Edit" disabled={pageIds.length === 0} onClick={editPage} />
        </Toolbar>
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
          if (files.length === 0) return;
          void run(() => useStore.getState().importImages(files, { docId }), 'Those images could not be imported');
        }}
      />

      <MenuSheet
        open={sheet === 'add'}
        title="Add pages"
        onClose={closeSheet}
        items={[
          {
            icon: 'camera',
            label: 'Scan with the camera',
            hint: 'New pages are added to the end',
            onSelect: () => void run(() => useStore.getState().beginCapture({ docId }), 'Could not open the camera'),
          },
          {
            icon: 'image',
            label: 'Import photos',
            hint: 'From your gallery or files',
            onSelect: () => fileRef.current?.click(),
          },
        ]}
      />

      <MenuSheet open={sheet === 'overflow'} title={doc.title} onClose={closeSheet} items={overflowItems} />

      <MenuSheet
        open={sheet === 'filter'}
        title="Apply a filter to every page"
        onClose={closeSheet}
        items={FILTERS.map((filter) => ({
          icon: filter.icon,
          label: filter.label,
          onSelect: () => {
            leaveSelection();
            void run(() => useStore.getState().applyFilterToAll(docId, filter.id), 'Could not apply that filter');
          },
        }))}
      />

      <Sheet open={sheet === 'colour'} title="Colour" onClose={closeSheet}>
        <div className="doc__colours" role="radiogroup" aria-label="Document colour">
          {DOCUMENT_COLORS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={doc.color === option.value}
              aria-label={option.label}
              className={`doc__swatch ${doc.color === option.value ? 'is-on' : ''}`}
              style={{ background: documentColorVar(option.value) }}
              onClick={() => {
                closeSheet();
                void run(
                  () => useStore.getState().setDocumentColor(docId, option.value),
                  'Could not change the colour',
                );
              }}
            >
              {option.value === 'none' ? <Icon name="close" size={16} /> : doc.color === option.value && <Icon name="check" size={18} />}
            </button>
          ))}
        </div>
      </Sheet>

      <FolderPicker
        open={sheet === 'folder'}
        title="Move to folder"
        currentFolderId={doc.folderId}
        onClose={closeSheet}
        onPick={(folderId) => {
          closeSheet();
          void run(() => useStore.getState().moveDocuments([docId], folderId), 'Could not move this document');
        }}
      />

      <DocumentPicker
        open={sheet === 'movePages'}
        title={`Move ${selected.length === 1 ? 'this page' : `${selected.length} pages`} to…`}
        excludeId={docId}
        onClose={closeSheet}
        onPick={(target) => {
          closeSheet();
          void run(async () => {
            await useStore.getState().movePages(selected, target);
            leaveSelection();
            useStore.getState().notify('Pages moved', 'success');
          }, 'Could not move those pages');
        }}
      />

      <DocumentPicker
        open={sheet === 'mergeInto'}
        title="Merge into…"
        excludeId={docId}
        onClose={closeSheet}
        onPick={(target) => {
          closeSheet();
          void run(async () => {
            const merged = await useStore.getState().mergeDocuments([target, docId]);
            if (merged) useStore.getState().replace({ name: 'doc', docId: merged });
          }, 'Could not merge those documents');
        }}
      />

      <PromptDialog
        open={dialog === 'rename'}
        title="Rename document"
        label="Title"
        initial={doc.title}
        confirmLabel="Rename"
        onClose={closeDialog}
        onConfirm={(value) => {
          closeDialog();
          void run(() => useStore.getState().renameDocument(docId, value), 'Could not rename this document');
        }}
      />

      <PromptDialog
        open={dialog === 'tag'}
        title="Tags"
        label="Tags"
        hint="Separate several tags with commas. Clearing them all removes every tag."
        initial={doc.tags.join(', ')}
        confirmLabel="Save"
        onClose={closeDialog}
        onConfirm={(value) => {
          closeDialog();
          void run(
            () => useStore.getState().setDocumentTags(docId, value.split(',').map((tag) => tag.trim())),
            'Could not save those tags',
          );
        }}
      />

      <Dialog
        open={dialog === 'trash'}
        title="Move to trash?"
        body="You can restore it from the trash until you empty it."
        confirmLabel="Move to trash"
        destructive
        onClose={closeDialog}
        onConfirm={() => {
          closeDialog();
          void run(async () => {
            await useStore.getState().trashDocuments([docId]);
            useStore.getState().back();
          }, 'Could not move this document to the trash');
        }}
      />

      <Dialog
        open={dialog === 'deletePages'}
        title={selected.length === 1 ? 'Delete this page?' : `Delete ${selected.length} pages?`}
        body="The scans behind them are deleted too. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onClose={closeDialog}
        onConfirm={() => {
          closeDialog();
          void run(async () => {
            await useStore.getState().deletePages(selected);
            leaveSelection();
          }, 'Could not delete those pages');
        }}
      />

      <ExportSheet
        open={exporting || exportPages !== null}
        docId={docId}
        pageIds={exportPages}
        onClose={() => {
          setExporting(false);
          setExportPages(null);
        }}
      />
    </div>
  );
}

/** Sheet listing the other documents, for moving pages or merging. */
function DocumentPicker({
  open,
  title,
  excludeId,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  excludeId: ID;
  onPick: (docId: ID) => void;
  onClose: () => void;
}) {
  const docs = useStore((s) => s.docs);
  const list = useMemo(
    () =>
      Object.values(docs)
        .filter((item) => item.deletedAt === null && item.id !== excludeId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [docs, excludeId],
  );

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      {list.length === 0 ? (
        <p className="muted doc__picker-empty">There is no other document to choose yet.</p>
      ) : (
        <ul className="menu">
          {list.map((item) => (
            <li key={item.id}>
              <button type="button" className="menu__item" onClick={() => onPick(item.id)}>
                <Icon name="fileText" size={20} />
                <span className="menu__label truncate">
                  {item.title}
                  <span className="menu__hint">{formatPageCount(item.pageIds.length)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
