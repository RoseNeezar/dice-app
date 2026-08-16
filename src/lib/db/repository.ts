import type { AppSettings, Folder, ID, Page, PageEdits, ScanDocument, Size } from '@/types';
import { DEFAULT_EDITS, DEFAULT_SETTINGS } from '@/types';
import { STORE, clearStore, del, delMany, get, getAll, getAllByIndex, put, putMany, requestToPromise, transact } from './idb';

/** Blob record. Blobs live in their own store so page rows stay small. */
export interface BlobRecord {
  id: ID;
  blob: Blob;
  createdAt: number;
}

export function newId(prefix = ''): ID {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${random}` : random;
}

/* ------------------------------------------------------------------ */
/* Blobs                                                               */
/* ------------------------------------------------------------------ */

export async function putBlob(blob: Blob, id: ID = newId('b')): Promise<ID> {
  const record: BlobRecord = { id, blob, createdAt: Date.now() };
  await put(STORE.blobs, record);
  return id;
}

export async function getBlob(id: ID | null | undefined): Promise<Blob | null> {
  if (!id) return null;
  const record = await get<BlobRecord>(STORE.blobs, id);
  return record?.blob ?? null;
}

export async function deleteBlobs(ids: (ID | null | undefined)[]): Promise<void> {
  const real = ids.filter((id): id is ID => typeof id === 'string' && id.length > 0);
  await delMany(STORE.blobs, real);
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export async function listDocuments(): Promise<ScanDocument[]> {
  return getAll<ScanDocument>(STORE.docs);
}

export async function getDocument(id: ID): Promise<ScanDocument | undefined> {
  return get<ScanDocument>(STORE.docs, id);
}

export async function saveDocument(doc: ScanDocument): Promise<void> {
  await put(STORE.docs, doc);
}

export async function saveDocuments(docs: ScanDocument[]): Promise<void> {
  await putMany(STORE.docs, docs);
}

export function createDocument(partial: Partial<ScanDocument> = {}): ScanDocument {
  const now = Date.now();
  return {
    id: newId('d'),
    title: partial.title ?? defaultDocumentTitle(now),
    folderId: partial.folderId ?? null,
    pageIds: partial.pageIds ?? [],
    tags: partial.tags ?? [],
    color: partial.color ?? 'none',
    deletedAt: partial.deletedAt ?? null,
    locked: partial.locked ?? false,
    starred: partial.starred ?? false,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

/** "Scan 2026-08-16 14.31" — sortable, and unique enough in practice. */
export function defaultDocumentTitle(at = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

/** Move to the trash. Blobs survive until the trash is emptied. */
export async function trashDocument(id: ID): Promise<void> {
  const doc = await getDocument(id);
  if (!doc) return;
  await saveDocument({ ...doc, deletedAt: Date.now(), updatedAt: Date.now() });
}

export async function restoreDocument(id: ID): Promise<void> {
  const doc = await getDocument(id);
  if (!doc) return;
  await saveDocument({ ...doc, deletedAt: null, updatedAt: Date.now() });
}

/** Permanently delete a document, its pages and every blob they own. */
export async function purgeDocument(id: ID): Promise<void> {
  const doc = await getDocument(id);
  const pages = await listPages(id);
  const blobIds: (ID | null)[] = [];
  for (const page of pages) {
    blobIds.push(page.originalBlobId, page.processedBlobId, page.thumbBlobId);
    for (const annotation of page.annotations) {
      if ('blobId' in annotation) blobIds.push(annotation.blobId);
    }
  }
  await deleteBlobs(blobIds);
  await delMany(
    STORE.pages,
    pages.map((p) => p.id),
  );
  if (doc) await del(STORE.docs, id);
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

export async function listPages(docId: ID): Promise<Page[]> {
  return getAllByIndex<Page>(STORE.pages, 'docId', docId);
}

export async function getPage(id: ID): Promise<Page | undefined> {
  return get<Page>(STORE.pages, id);
}

export async function savePage(page: Page): Promise<void> {
  await put(STORE.pages, page);
}

export async function savePages(pages: Page[]): Promise<void> {
  await putMany(STORE.pages, pages);
}

export async function deletePage(id: ID): Promise<void> {
  const page = await getPage(id);
  if (!page) return;
  const blobIds: (ID | null)[] = [page.originalBlobId, page.processedBlobId, page.thumbBlobId];
  for (const annotation of page.annotations) {
    if ('blobId' in annotation) blobIds.push(annotation.blobId);
  }
  await deleteBlobs(blobIds);
  await del(STORE.pages, id);
}

export function createPage(docId: ID, originalBlobId: ID, source: Size, edits: Partial<PageEdits> = {}): Page {
  const now = Date.now();
  return {
    id: newId('p'),
    docId,
    originalBlobId,
    processedBlobId: null,
    thumbBlobId: null,
    source,
    processed: null,
    edits: { ...DEFAULT_EDITS, ...edits, adjust: { ...DEFAULT_EDITS.adjust, ...edits.adjust } },
    annotations: [],
    ocr: null,
    note: '',
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Folders                                                             */
/* ------------------------------------------------------------------ */

export async function listFolders(): Promise<Folder[]> {
  return getAll<Folder>(STORE.folders);
}

export async function saveFolder(folder: Folder): Promise<void> {
  await put(STORE.folders, folder);
}

export function createFolder(name: string, parentId: ID | null = null): Folder {
  const now = Date.now();
  return {
    id: newId('f'),
    name,
    parentId,
    color: 'none',
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Delete a folder. Descendant folders are deleted too; documents inside them
 * are moved to the trash rather than destroyed, so a mis-tap is recoverable.
 */
export async function deleteFolderTree(id: ID): Promise<void> {
  const folders = await listFolders();
  const docs = await listDocuments();
  const doomed = new Set<ID>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && doomed.has(folder.parentId) && !doomed.has(folder.id)) {
        doomed.add(folder.id);
        grew = true;
      }
    }
  }
  const now = Date.now();
  // Every document in a deleted folder loses its folder reference, including
  // ones already in the trash: leaving a stale id behind would file them into
  // a folder that no longer exists when they are restored, hiding them from
  // every view. Only documents that were still live are additionally trashed.
  const touched = docs
    .filter((doc) => doc.folderId !== null && doomed.has(doc.folderId))
    .map((doc) => ({
      ...doc,
      folderId: null,
      deletedAt: doc.deletedAt ?? now,
      updatedAt: now,
    }));
  await saveDocuments(touched);
  await delMany(STORE.folders, [...doomed]);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<AppSettings> {
  try {
    const stored = await get<Partial<AppSettings>>(STORE.kv, SETTINGS_KEY);
    if (!stored) return { ...DEFAULT_SETTINGS };
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      defaultPdf: { ...DEFAULT_SETTINGS.defaultPdf, ...(stored.defaultPdf ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await put(STORE.kv, settings, SETTINGS_KEY);
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return get<T>(STORE.kv, key);
}

export async function setKv<T>(key: string, value: T): Promise<void> {
  await put(STORE.kv, value, key);
}

/* ------------------------------------------------------------------ */
/* Maintenance                                                         */
/* ------------------------------------------------------------------ */

export interface StorageUsage {
  usage: number;
  quota: number;
  documents: number;
  pages: number;
}

export async function storageUsage(): Promise<StorageUsage> {
  const docs = await listDocuments();
  const pages = await getAll<Page>(STORE.pages);
  let usage = 0;
  let quota = 0;
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    usage = estimate.usage ?? 0;
    quota = estimate.quota ?? 0;
  }
  return { usage, quota, documents: docs.filter((d) => d.deletedAt === null).length, pages: pages.length };
}

/**
 * Delete blobs no page or annotation references any more. Interrupted edits
 * (app killed mid-render) are the usual source.
 */
export async function collectGarbage(): Promise<number> {
  // Pages, signatures and blob keys are read — and the orphans deleted — in a
  // single transaction. Reading them separately leaves a window in which a
  // page saved between the two reads has its brand-new blob collected.
  return transact([STORE.pages, STORE.kv, STORE.blobs], async (stores) => {
    const pages = (await requestToPromise(stores[STORE.pages].getAll())) as Page[];
    const live = new Set<ID>();
    for (const page of pages) {
      if (page.originalBlobId) live.add(page.originalBlobId);
      if (page.processedBlobId) live.add(page.processedBlobId);
      if (page.thumbBlobId) live.add(page.thumbBlobId);
      for (const annotation of page.annotations) {
        if ('blobId' in annotation && annotation.blobId) live.add(annotation.blobId);
      }
    }

    const signatures = ((await requestToPromise(stores[STORE.kv].get('signatures'))) ?? []) as ID[];
    for (const id of signatures) live.add(id);

    const keys = (await requestToPromise(stores[STORE.blobs].getAllKeys())) as ID[];
    let removed = 0;
    for (const key of keys) {
      if (live.has(key)) continue;
      stores[STORE.blobs].delete(key);
      removed++;
    }
    return removed;
  });
}

/** Permanently empty the trash. */
export async function emptyTrash(): Promise<number> {
  const docs = await listDocuments();
  const doomed = docs.filter((doc) => doc.deletedAt !== null);
  for (const doc of doomed) await purgeDocument(doc.id);
  return doomed.length;
}

/** Wipe everything — used by "reset app" in settings. */
export async function wipeAll(): Promise<void> {
  await clearStore(STORE.docs);
  await clearStore(STORE.pages);
  await clearStore(STORE.folders);
  await clearStore(STORE.blobs);
  await clearStore(STORE.kv);
}
