import { create } from 'zustand';
import type {
  Annotation,
  AppSettings,
  CaptureMode,
  DocumentColor,
  Folder,
  ID,
  OcrResult,
  Page,
  PageEdits,
  Quad,
  Rotation,
  ScanDocument,
  Size,
  SortKey,
  ViewMode,
} from '@/types';
import { DEFAULT_EDITS, DEFAULT_SETTINGS } from '@/types';
import * as repo from '@/lib/db/repository';
import { cv } from '@/lib/cv/client';
import { blobSize } from '@/lib/image/io';
import { releaseBlobUrls } from '@/lib/image/blobUrls';

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

export type Route =
  | { name: 'home' }
  | { name: 'folder'; folderId: ID }
  | { name: 'trash' }
  | { name: 'search' }
  | { name: 'doc'; docId: ID }
  | { name: 'camera'; docId: ID; returnTo: Route }
  | { name: 'review'; docId: ID }
  | { name: 'edit'; docId: ID; pageId: ID }
  | { name: 'viewer'; docId: ID; pageId: ID }
  | { name: 'settings' };

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
}

export interface CaptureSession {
  docId: ID;
  mode: CaptureMode;
  /** Pages added during this session, in order. */
  pageIds: ID[];
  /** Whether the document existed before the session (append vs new). */
  appending: boolean;
  /** Front side buffer for ID-card mode. */
  pendingIdFront: ID | null;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export interface AppState {
  ready: boolean;
  error: string | null;

  docs: Record<ID, ScanDocument>;
  pages: Record<ID, Page>;
  folders: Record<ID, Folder>;
  settings: AppSettings;

  route: Route;
  stack: Route[];
  toasts: Toast[];
  /** True once the passcode has been entered this session. */
  unlocked: boolean;
  /** Pages currently being re-rendered, by page id. */
  rendering: Record<ID, boolean>;
  session: CaptureSession | null;
  selection: ID[];
  query: string;

  init: () => Promise<void>;

  /* navigation */
  navigate: (route: Route) => void;
  replace: (route: Route) => void;
  back: () => void;

  /* toasts */
  notify: (message: string, tone?: Toast['tone'], action?: Toast['action']) => void;
  dismissToast: (id: number) => void;

  /* documents */
  newDocument: (folderId?: ID | null, title?: string) => Promise<ID>;
  renameDocument: (docId: ID, title: string) => Promise<void>;
  setDocumentColor: (docId: ID, color: DocumentColor) => Promise<void>;
  toggleStar: (docId: ID) => Promise<void>;
  setDocumentTags: (docId: ID, tags: string[]) => Promise<void>;
  moveDocuments: (docIds: ID[], folderId: ID | null) => Promise<void>;
  trashDocuments: (docIds: ID[]) => Promise<void>;
  restoreDocuments: (docIds: ID[]) => Promise<void>;
  purgeDocuments: (docIds: ID[]) => Promise<void>;
  emptyTrash: () => Promise<void>;
  duplicateDocument: (docId: ID) => Promise<ID | null>;
  mergeDocuments: (docIds: ID[], title?: string) => Promise<ID | null>;
  setDocumentLocked: (docId: ID, locked: boolean) => Promise<void>;

  /* folders */
  newFolder: (name: string, parentId?: ID | null) => Promise<ID>;
  renameFolder: (folderId: ID, name: string) => Promise<void>;
  deleteFolder: (folderId: ID) => Promise<void>;

  /* capture */
  beginCapture: (options: { docId?: ID; folderId?: ID | null; mode?: CaptureMode; returnTo?: Route }) => Promise<void>;
  addCapture: (blob: Blob, edits?: Partial<PageEdits>) => Promise<ID | null>;
  endCapture: (options?: { discard?: boolean }) => Promise<void>;
  setCaptureMode: (mode: CaptureMode) => void;

  /* pages */
  importImages: (files: File[], options?: { docId?: ID; folderId?: ID | null; title?: string }) => Promise<ID | null>;
  updateEdits: (pageId: ID, edits: Partial<PageEdits>) => Promise<void>;
  setQuad: (pageId: ID, quad: Quad | null) => Promise<void>;
  rotatePage: (pageId: ID, delta: 90 | -90) => Promise<void>;
  applyFilterToAll: (docId: ID, filter: PageEdits['filter']) => Promise<void>;
  deletePages: (pageIds: ID[]) => Promise<void>;
  reorderPages: (docId: ID, pageIds: ID[]) => Promise<void>;
  movePages: (pageIds: ID[], targetDocId: ID) => Promise<void>;
  splitDocument: (docId: ID, pageIds: ID[], title?: string) => Promise<ID | null>;
  setAnnotations: (pageId: ID, annotations: Annotation[]) => Promise<void>;
  setPageNote: (pageId: ID, note: string) => Promise<void>;
  setPageOcr: (pageId: ID, ocr: OcrResult | null) => Promise<void>;
  replacePageSource: (pageId: ID, blob: Blob) => Promise<void>;
  rerenderPage: (pageId: ID) => Promise<void>;

  /* settings */
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setViewMode: (mode: ViewMode) => Promise<void>;
  setSort: (key: SortKey, asc?: boolean) => Promise<void>;
  unlock: () => void;

  /* selection */
  toggleSelect: (id: ID) => void;
  clearSelection: () => void;
  selectAll: (ids: ID[]) => void;
  setQuery: (query: string) => void;
}

let toastSeq = 1;

export const useStore = create<AppState>()((set, get) => ({
  ready: false,
  error: null,
  docs: {},
  pages: {},
  folders: {},
  settings: { ...DEFAULT_SETTINGS },
  route: { name: 'home' },
  stack: [],
  toasts: [],
  unlocked: false,
  rendering: {},
  session: null,
  selection: [],
  query: '',

  async init() {
    try {
      const [docs, folders, settings] = await Promise.all([
        repo.listDocuments(),
        repo.listFolders(),
        repo.loadSettings(),
      ]);
      const pages: Record<ID, Page> = {};
      await Promise.all(
        docs.map(async (doc) => {
          for (const page of await repo.listPages(doc.id)) pages[page.id] = page;
        }),
      );
      set({
        docs: Object.fromEntries(docs.map((d) => [d.id, d])),
        folders: Object.fromEntries(folders.map((f) => [f.id, f])),
        pages,
        settings,
        ready: true,
        unlocked: settings.passcodeHash === null,
      });
      void repo.collectGarbage();
    } catch (error) {
      set({ ready: true, error: error instanceof Error ? error.message : String(error) });
    }
  },

  /* ---------------- navigation ---------------- */

  navigate(route) {
    set((state) => ({ stack: [...state.stack, state.route], route, selection: [] }));
  },

  replace(route) {
    set({ route, selection: [] });
  },

  back() {
    set((state) => {
      if (state.stack.length === 0) return { route: { name: 'home' } as Route, selection: [] };
      const stack = [...state.stack];
      const route = stack.pop() as Route;
      return { stack, route, selection: [] };
    });
  },

  /* ---------------- toasts ---------------- */

  notify(message, tone = 'info', action) {
    const toast: Toast = { id: toastSeq++, message, tone, action };
    set((state) => ({ toasts: [...state.toasts, toast] }));
    setTimeout(() => get().dismissToast(toast.id), action ? 6000 : 3200);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  /* ---------------- documents ---------------- */

  async newDocument(folderId = null, title) {
    const doc = repo.createDocument({ folderId, ...(title ? { title } : {}) });
    await repo.saveDocument(doc);
    set((state) => ({ docs: { ...state.docs, [doc.id]: doc } }));
    return doc.id;
  },

  async renameDocument(docId, title) {
    const doc = get().docs[docId];
    if (!doc) return;
    const next = { ...doc, title: title.trim() || doc.title, updatedAt: Date.now() };
    await repo.saveDocument(next);
    set((state) => ({ docs: { ...state.docs, [docId]: next } }));
  },

  async setDocumentColor(docId, color) {
    const doc = get().docs[docId];
    if (!doc) return;
    const next = { ...doc, color, updatedAt: Date.now() };
    await repo.saveDocument(next);
    set((state) => ({ docs: { ...state.docs, [docId]: next } }));
  },

  async toggleStar(docId) {
    const doc = get().docs[docId];
    if (!doc) return;
    const next = { ...doc, starred: !doc.starred, updatedAt: Date.now() };
    await repo.saveDocument(next);
    set((state) => ({ docs: { ...state.docs, [docId]: next } }));
  },

  async setDocumentTags(docId, tags) {
    const doc = get().docs[docId];
    if (!doc) return;
    const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    const next = { ...doc, tags: cleaned, updatedAt: Date.now() };
    await repo.saveDocument(next);
    set((state) => ({ docs: { ...state.docs, [docId]: next } }));
  },

  async moveDocuments(docIds, folderId) {
    const { docs } = get();
    const now = Date.now();
    const updated = docIds
      .map((id) => docs[id])
      .filter(Boolean)
      .map((doc) => ({ ...doc, folderId, updatedAt: now }));
    await repo.saveDocuments(updated);
    set((state) => ({
      docs: { ...state.docs, ...Object.fromEntries(updated.map((d) => [d.id, d])) },
      selection: [],
    }));
  },

  async trashDocuments(docIds) {
    const { docs } = get();
    const now = Date.now();
    const updated = docIds
      .map((id) => docs[id])
      .filter(Boolean)
      .map((doc) => ({ ...doc, deletedAt: now, updatedAt: now }));
    await repo.saveDocuments(updated);
    set((state) => ({
      docs: { ...state.docs, ...Object.fromEntries(updated.map((d) => [d.id, d])) },
      selection: [],
    }));
    get().notify(updated.length === 1 ? 'Moved to trash' : `${updated.length} moved to trash`, 'info', {
      label: 'Undo',
      run: () => void get().restoreDocuments(docIds),
    });
  },

  async restoreDocuments(docIds) {
    const { docs } = get();
    const now = Date.now();
    const updated = docIds
      .map((id) => docs[id])
      .filter(Boolean)
      .map((doc) => ({ ...doc, deletedAt: null, updatedAt: now }));
    await repo.saveDocuments(updated);
    set((state) => ({
      docs: { ...state.docs, ...Object.fromEntries(updated.map((d) => [d.id, d])) },
      selection: [],
    }));
  },

  async purgeDocuments(docIds) {
    const { docs, pages } = get();
    const goneBlobUrls: (ID | null)[] = [];
    for (const docId of docIds) {
      for (const pageId of docs[docId]?.pageIds ?? []) {
        const page = pages[pageId];
        if (page) goneBlobUrls.push(page.processedBlobId, page.thumbBlobId, page.originalBlobId);
      }
      await repo.purgeDocument(docId);
    }
    releaseBlobUrls(goneBlobUrls.filter((id): id is ID => Boolean(id)));
    set((state) => {
      const nextDocs = { ...state.docs };
      const nextPages = { ...state.pages };
      for (const docId of docIds) {
        for (const pageId of nextDocs[docId]?.pageIds ?? []) delete nextPages[pageId];
        delete nextDocs[docId];
      }
      return { docs: nextDocs, pages: nextPages, selection: [] };
    });
  },

  async emptyTrash() {
    const trashed = Object.values(get().docs)
      .filter((doc) => doc.deletedAt !== null)
      .map((doc) => doc.id);
    await get().purgeDocuments(trashed);
    get().notify('Trash emptied');
  },

  async duplicateDocument(docId) {
    const state = get();
    const doc = state.docs[docId];
    if (!doc) return null;
    const copy = repo.createDocument({ title: `${doc.title} copy`, folderId: doc.folderId, tags: doc.tags });
    const newPages: Page[] = [];
    for (const pageId of doc.pageIds) {
      const page = state.pages[pageId];
      if (!page) continue;
      const original = await repo.getBlob(page.originalBlobId);
      const processed = await repo.getBlob(page.processedBlobId);
      const thumb = await repo.getBlob(page.thumbBlobId);
      if (!original) continue;
      const originalId = await repo.putBlob(original);
      const processedId = processed ? await repo.putBlob(processed) : null;
      const thumbId = thumb ? await repo.putBlob(thumb) : null;
      newPages.push({
        ...page,
        id: repo.newId('p'),
        docId: copy.id,
        originalBlobId: originalId,
        processedBlobId: processedId,
        thumbBlobId: thumbId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    copy.pageIds = newPages.map((p) => p.id);
    await repo.savePages(newPages);
    await repo.saveDocument(copy);
    set((s) => ({
      docs: { ...s.docs, [copy.id]: copy },
      pages: { ...s.pages, ...Object.fromEntries(newPages.map((p) => [p.id, p])) },
    }));
    return copy.id;
  },

  async mergeDocuments(docIds, title) {
    const state = get();
    const sources = docIds.map((id) => state.docs[id]).filter(Boolean);
    if (sources.length < 2) return null;
    const target = repo.createDocument({
      title: title ?? `${sources[0].title} merged`,
      folderId: sources[0].folderId,
    });
    const moved: Page[] = [];
    for (const doc of sources) {
      for (const pageId of doc.pageIds) {
        const page = state.pages[pageId];
        if (page) moved.push({ ...page, docId: target.id, updatedAt: Date.now() });
      }
    }
    target.pageIds = moved.map((p) => p.id);
    await repo.savePages(moved);
    await repo.saveDocument(target);
    const emptied = sources.map((doc) => ({ ...doc, pageIds: [], deletedAt: Date.now(), updatedAt: Date.now() }));
    await repo.saveDocuments(emptied);
    set((s) => ({
      docs: {
        ...s.docs,
        ...Object.fromEntries(emptied.map((d) => [d.id, d])),
        [target.id]: target,
      },
      pages: { ...s.pages, ...Object.fromEntries(moved.map((p) => [p.id, p])) },
      selection: [],
    }));
    return target.id;
  },

  async setDocumentLocked(docId, locked) {
    const doc = get().docs[docId];
    if (!doc) return;
    const next = { ...doc, locked, updatedAt: Date.now() };
    await repo.saveDocument(next);
    set((state) => ({ docs: { ...state.docs, [docId]: next } }));
  },

  /* ---------------- folders ---------------- */

  async newFolder(name, parentId = null) {
    const folder = repo.createFolder(name.trim() || 'New folder', parentId);
    await repo.saveFolder(folder);
    set((state) => ({ folders: { ...state.folders, [folder.id]: folder } }));
    return folder.id;
  },

  async renameFolder(folderId, name) {
    const folder = get().folders[folderId];
    if (!folder) return;
    const next = { ...folder, name: name.trim() || folder.name, updatedAt: Date.now() };
    await repo.saveFolder(next);
    set((state) => ({ folders: { ...state.folders, [folderId]: next } }));
  },

  async deleteFolder(folderId) {
    await repo.deleteFolderTree(folderId);
    const [docs, folders] = await Promise.all([repo.listDocuments(), repo.listFolders()]);
    set({
      docs: Object.fromEntries(docs.map((d) => [d.id, d])),
      folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    });
  },

  /* ---------------- capture ---------------- */

  async beginCapture({ docId, folderId = null, mode, returnTo }) {
    const state = get();
    const appending = Boolean(docId);
    const targetId = docId ?? (await state.newDocument(folderId));
    set({
      session: {
        docId: targetId,
        mode: mode ?? state.settings.defaultCaptureMode,
        pageIds: [],
        appending,
        pendingIdFront: null,
      },
    });
    state.navigate({ name: 'camera', docId: targetId, returnTo: returnTo ?? state.route });
  },

  setCaptureMode(mode) {
    set((state) => (state.session ? { session: { ...state.session, mode } } : {}));
  },

  async addCapture(blob, edits) {
    const state = get();
    const session = state.session;
    if (!session) return null;
    const pageId = await addPageToDocument(set, get, session.docId, blob, edits);
    if (pageId) {
      set((s) => (s.session ? { session: { ...s.session, pageIds: [...s.session.pageIds, pageId] } } : {}));
    }
    return pageId;
  },

  async endCapture({ discard = false } = {}) {
    const state = get();
    const session = state.session;
    if (!session) return;
    const doc = get().docs[session.docId];
    const empty = !doc || doc.pageIds.length === 0;
    set({ session: null });

    if (discard || empty) {
      if (!session.appending && doc) {
        await get().purgeDocuments([session.docId]);
      }
      get().back();
      return;
    }
    get().replace({ name: 'review', docId: session.docId });
  },

  /* ---------------- pages ---------------- */

  async importImages(files, options = {}) {
    const state = get();
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) {
      state.notify('No images found in that selection', 'error');
      return null;
    }
    const docId = options.docId ?? (await state.newDocument(options.folderId ?? null, options.title));
    for (const file of images) {
      // Imported photos are usually already cropped, so no auto-detect here.
      await addPageToDocument(set, get, docId, file, { quad: null });
    }
    return docId;
  },

  async updateEdits(pageId, edits) {
    const page = get().pages[pageId];
    if (!page) return;
    const next: Page = {
      ...page,
      edits: { ...page.edits, ...edits, adjust: { ...page.edits.adjust, ...(edits.adjust ?? {}) } },
      updatedAt: Date.now(),
    };
    set((state) => ({ pages: { ...state.pages, [pageId]: next } }));
    await repo.savePage(next);
    await get().rerenderPage(pageId);
  },

  async setQuad(pageId, quad) {
    await get().updateEdits(pageId, { quad });
  },

  async rotatePage(pageId, delta) {
    const page = get().pages[pageId];
    if (!page) return;
    const rotation = (((page.edits.rotation + delta) % 360) + 360) % 360;
    await get().updateEdits(pageId, { rotation: rotation as Rotation });
  },

  async applyFilterToAll(docId, filter) {
    const state = get();
    const doc = state.docs[docId];
    if (!doc) return;
    for (const pageId of doc.pageIds) {
      await state.updateEdits(pageId, { filter });
    }
    get().notify('Filter applied to every page');
  },

  async deletePages(pageIds) {
    const state = get();
    const affected = new Set<ID>();
    for (const pageId of pageIds) {
      const page = state.pages[pageId];
      if (!page) continue;
      affected.add(page.docId);
      releaseBlobUrls([page.processedBlobId, page.thumbBlobId, page.originalBlobId].filter((id): id is ID => Boolean(id)));
      await repo.deletePage(pageId);
    }
    const docsUpdate: Record<ID, ScanDocument> = {};
    for (const docId of affected) {
      const doc = get().docs[docId];
      if (!doc) continue;
      const next = {
        ...doc,
        pageIds: doc.pageIds.filter((id) => !pageIds.includes(id)),
        updatedAt: Date.now(),
      };
      docsUpdate[docId] = next;
      await repo.saveDocument(next);
    }
    set((s) => {
      const pages = { ...s.pages };
      for (const pageId of pageIds) delete pages[pageId];
      return { pages, docs: { ...s.docs, ...docsUpdate }, selection: [] };
    });
  },

  async reorderPages(docId, pageIds) {
    const doc = get().docs[docId];
    if (!doc) return;
    const next = { ...doc, pageIds, updatedAt: Date.now() };
    await repo.saveDocument(next);
    set((state) => ({ docs: { ...state.docs, [docId]: next } }));
  },

  async movePages(pageIds, targetDocId) {
    const state = get();
    const target = state.docs[targetDocId];
    if (!target) return;
    const moved: Page[] = [];
    const sourceDocs = new Set<ID>();
    for (const pageId of pageIds) {
      const page = state.pages[pageId];
      if (!page || page.docId === targetDocId) continue;
      sourceDocs.add(page.docId);
      moved.push({ ...page, docId: targetDocId, updatedAt: Date.now() });
    }
    if (moved.length === 0) return;
    await repo.savePages(moved);
    const docUpdates: Record<ID, ScanDocument> = {
      [targetDocId]: {
        ...target,
        pageIds: [...target.pageIds, ...moved.map((p) => p.id)],
        updatedAt: Date.now(),
      },
    };
    for (const docId of sourceDocs) {
      const doc = state.docs[docId];
      if (!doc) continue;
      docUpdates[docId] = {
        ...doc,
        pageIds: doc.pageIds.filter((id) => !pageIds.includes(id)),
        updatedAt: Date.now(),
      };
    }
    await repo.saveDocuments(Object.values(docUpdates));
    set((s) => ({
      docs: { ...s.docs, ...docUpdates },
      pages: { ...s.pages, ...Object.fromEntries(moved.map((p) => [p.id, p])) },
      selection: [],
    }));
  },

  async splitDocument(docId, pageIds, title) {
    const state = get();
    const doc = state.docs[docId];
    if (!doc || pageIds.length === 0) return null;
    const target = repo.createDocument({ title: title ?? `${doc.title} (split)`, folderId: doc.folderId });
    await repo.saveDocument(target);
    set((s) => ({ docs: { ...s.docs, [target.id]: target } }));
    await get().movePages(pageIds, target.id);
    return target.id;
  },

  async setAnnotations(pageId, annotations) {
    const page = get().pages[pageId];
    if (!page) return;
    const next = { ...page, annotations, updatedAt: Date.now() };
    await repo.savePage(next);
    set((state) => ({ pages: { ...state.pages, [pageId]: next } }));
  },

  async setPageNote(pageId, note) {
    const page = get().pages[pageId];
    if (!page) return;
    const next = { ...page, note, updatedAt: Date.now() };
    await repo.savePage(next);
    set((state) => ({ pages: { ...state.pages, [pageId]: next } }));
  },

  async setPageOcr(pageId, ocr) {
    const page = get().pages[pageId];
    if (!page) return;
    const next = { ...page, ocr, updatedAt: Date.now() };
    await repo.savePage(next);
    set((state) => ({ pages: { ...state.pages, [pageId]: next } }));
  },

  async replacePageSource(pageId, blob) {
    const page = get().pages[pageId];
    if (!page) return;
    const size = await blobSize(blob);
    const originalBlobId = await repo.putBlob(blob);
    await repo.deleteBlobs([page.originalBlobId]);
    const next: Page = { ...page, originalBlobId, source: size, updatedAt: Date.now() };
    await repo.savePage(next);
    set((state) => ({ pages: { ...state.pages, [pageId]: next } }));
    await get().rerenderPage(pageId);
  },

  async rerenderPage(pageId) {
    const state = get();
    const page = state.pages[pageId];
    if (!page) return;
    set((s) => ({ rendering: { ...s.rendering, [pageId]: true } }));
    try {
      const original = await repo.getBlob(page.originalBlobId);
      if (!original) throw new Error('The original capture is missing');
      const { settings } = get();
      const result = await cv.render(original, page.edits, {
        maxEdge: settings.maxProcessedEdge,
        quality: settings.jpegQuality,
      });
      const stale = [page.processedBlobId, page.thumbBlobId].filter((id): id is ID => Boolean(id));
      const processedBlobId = await repo.putBlob(result.full);
      const thumbBlobId = await repo.putBlob(result.thumb);
      await repo.deleteBlobs(stale);
      releaseBlobUrls(stale);
      const next: Page = {
        ...get().pages[pageId],
        processedBlobId,
        thumbBlobId,
        processed: result.size,
        updatedAt: Date.now(),
      };
      await repo.savePage(next);
      set((s) => ({ pages: { ...s.pages, [pageId]: next } }));
      const doc = get().docs[page.docId];
      if (doc) {
        const touched = { ...doc, updatedAt: Date.now() };
        await repo.saveDocument(touched);
        set((s) => ({ docs: { ...s.docs, [doc.id]: touched } }));
      }
    } catch (error) {
      get().notify(error instanceof Error ? error.message : 'Could not process the page', 'error');
    } finally {
      set((s) => {
        const rendering = { ...s.rendering };
        delete rendering[pageId];
        return { rendering };
      });
    }
  },

  /* ---------------- settings ---------------- */

  async updateSettings(patch) {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    await repo.saveSettings(next);
  },

  async setViewMode(mode) {
    await get().updateSettings({ viewMode: mode });
  },

  async setSort(key, asc) {
    const settings = get().settings;
    await get().updateSettings({ sortKey: key, sortAsc: asc ?? (settings.sortKey === key ? !settings.sortAsc : false) });
  },

  unlock() {
    set({ unlocked: true });
  },

  /* ---------------- selection ---------------- */

  toggleSelect(id) {
    set((state) => ({
      selection: state.selection.includes(id)
        ? state.selection.filter((s) => s !== id)
        : [...state.selection, id],
    }));
  },

  clearSelection() {
    set({ selection: [] });
  },

  selectAll(ids) {
    set({ selection: ids });
  },

  setQuery(query) {
    set({ query });
  },
}));

/**
 * Store a capture, create its page, then render it. Shared by the camera and
 * the image importer.
 */
async function addPageToDocument(
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
  docId: ID,
  blob: Blob,
  edits?: Partial<PageEdits>,
): Promise<ID | null> {
  try {
    const size: Size = await blobSize(blob);
    const originalBlobId = await repo.putBlob(blob);
    const settings = get().settings;
    const page = repo.createPage(docId, originalBlobId, size, {
      ...DEFAULT_EDITS,
      filter: settings.defaultFilter,
      ...edits,
    });
    await repo.savePage(page);
    const doc = get().docs[docId];
    if (!doc) return null;
    const nextDoc = { ...doc, pageIds: [...doc.pageIds, page.id], updatedAt: Date.now() };
    await repo.saveDocument(nextDoc);
    set((state) => ({
      pages: { ...state.pages, [page.id]: page },
      docs: { ...state.docs, [docId]: nextDoc },
    }));
    await get().rerenderPage(page.id);
    return page.id;
  } catch (error) {
    get().notify(error instanceof Error ? error.message : 'Could not add the page', 'error');
    return null;
  }
}
