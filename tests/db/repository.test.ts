import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Adjustments, Annotation, AppSettings, ID, Page, ScanDocument } from '@/types';
import { DEFAULT_PDF_OPTIONS, DEFAULT_SETTINGS } from '@/types';
import { STORE, count, del, get, put } from '@/lib/db/idb';
import {
  collectGarbage,
  createDocument,
  createFolder,
  createPage,
  defaultDocumentTitle,
  deleteBlobs,
  deleteFolderTree,
  deletePage,
  emptyTrash,
  getBlob,
  getDocument,
  getKv,
  getPage,
  listDocuments,
  listFolders,
  listPages,
  loadSettings,
  newId,
  purgeDocument,
  putBlob,
  restoreDocument,
  saveDocument,
  saveDocuments,
  saveFolder,
  savePage,
  savePages,
  saveSettings,
  setKv,
  storageUsage,
  trashDocument,
  wipeAll,
} from '@/lib/db/repository';

const SIZE = { width: 1200, height: 1600 };

function textBlob(text: string): Blob {
  return new Blob([text], { type: 'text/plain' });
}

/** Remove only the document row, simulating a write interrupted half way. */
async function wipeDocumentRowOnly(id: ID): Promise<void> {
  await del(STORE.docs, id);
}

/** A document with `pageCount` pages, each owning an original and a thumb blob. */
async function seedDocument(pageCount = 2, partial: Partial<ScanDocument> = {}) {
  const doc = createDocument({ title: 'Seed', ...partial });
  const pages: Page[] = [];
  for (let i = 0; i < pageCount; i++) {
    const original = await putBlob(textBlob(`original-${doc.id}-${i}`));
    const thumb = await putBlob(textBlob(`thumb-${doc.id}-${i}`));
    const page = createPage(doc.id, original, SIZE);
    page.thumbBlobId = thumb;
    pages.push(page);
  }
  doc.pageIds = pages.map((p) => p.id);
  await saveDocument(doc);
  await savePages(pages);
  return { doc, pages };
}

beforeEach(async () => {
  await wipeAll();
});

describe('newId', () => {
  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
  });

  it('prefixes when asked', () => {
    expect(newId('p')).toMatch(/^p_/);
    expect(newId()).not.toContain('_');
  });
});

describe('blobs', () => {
  it('round-trips content and type', async () => {
    const id = await putBlob(textBlob('hello scanner'));
    const back = await getBlob(id);
    expect(back).not.toBeNull();
    expect(await (back as Blob).text()).toBe('hello scanner');
    expect((back as Blob).type).toBe('text/plain');
  });

  it('honours an explicit id and overwrites it on a second put', async () => {
    await putBlob(textBlob('first'), 'fixed');
    await putBlob(textBlob('second'), 'fixed');
    expect(await (await getBlob('fixed') as Blob).text()).toBe('second');
    expect(await count(STORE.blobs)).toBe(1);
  });

  it('returns null for a missing, null or empty id', async () => {
    expect(await getBlob('nope')).toBeNull();
    expect(await getBlob(null)).toBeNull();
    expect(await getBlob(undefined)).toBeNull();
    expect(await getBlob('')).toBeNull();
  });

  it('deletes the ids it is given and ignores the holes', async () => {
    const a = await putBlob(textBlob('a'));
    const b = await putBlob(textBlob('b'));
    await deleteBlobs([a, null, undefined, '', 'never-existed']);
    expect(await getBlob(a)).toBeNull();
    expect(await getBlob(b)).not.toBeNull();
  });

  it('does nothing for an empty delete list', async () => {
    const a = await putBlob(textBlob('a'));
    await deleteBlobs([]);
    await deleteBlobs([null, undefined]);
    expect(await getBlob(a)).not.toBeNull();
  });
});

describe('documents', () => {
  it('creates a document with sane defaults', () => {
    const doc = createDocument();
    expect(doc.id).toMatch(/^d_/);
    expect(doc.pageIds).toEqual([]);
    expect(doc.folderId).toBeNull();
    expect(doc.deletedAt).toBeNull();
    expect(doc.locked).toBe(false);
    expect(doc.starred).toBe(false);
    expect(doc.color).toBe('none');
    expect(doc.title).toBe(defaultDocumentTitle(doc.createdAt));
  });

  it('takes every field from the partial when given', () => {
    const doc = createDocument({
      title: 'Contract',
      folderId: 'f_1',
      pageIds: ['p_1'],
      tags: ['legal'],
      color: 'red',
      deletedAt: 123,
      locked: true,
      starred: true,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(doc).toMatchObject({
      title: 'Contract',
      folderId: 'f_1',
      pageIds: ['p_1'],
      tags: ['legal'],
      color: 'red',
      deletedAt: 123,
      locked: true,
      starred: true,
      createdAt: 1,
      updatedAt: 2,
    });
  });

  it('formats the default title as a sortable local timestamp', () => {
    const at = new Date(2026, 7, 16, 9, 4).getTime();
    expect(defaultDocumentTitle(at)).toBe('Scan 2026-08-16 09.04');
  });

  it('saves, reads back and lists', async () => {
    const doc = createDocument({ title: 'One' });
    await saveDocument(doc);
    expect(await getDocument(doc.id)).toEqual(doc);
    expect(await listDocuments()).toEqual([doc]);
  });

  it('returns undefined for a document that is not there', async () => {
    expect(await getDocument('missing')).toBeUndefined();
  });

  it('saves many at once and tolerates an empty batch', async () => {
    const docs = [createDocument({ title: 'A' }), createDocument({ title: 'B' })];
    await saveDocuments(docs);
    await saveDocuments([]);
    expect((await listDocuments()).length).toBe(2);
  });
});

describe('pages', () => {
  it('creates a page with the default edits merged under the overrides', () => {
    const page = createPage('d_1', 'b_1', SIZE, { filter: 'bw', rotation: 90 });
    expect(page.id).toMatch(/^p_/);
    expect(page.edits.filter).toBe('bw');
    expect(page.edits.rotation).toBe(90);
    expect(page.edits.quad).toBeNull();
    expect(page.edits.deskew).toBe(0);
    expect(page.edits.adjust).toEqual({ brightness: 0, contrast: 0, saturation: 0, detail: 0 });
    expect(page.processedBlobId).toBeNull();
    expect(page.thumbBlobId).toBeNull();
    expect(page.processed).toBeNull();
    expect(page.annotations).toEqual([]);
    expect(page.ocr).toBeNull();
    expect(page.note).toBe('');
  });

  it('fills in adjustment fields a half-written edit object is missing', () => {
    // The signature asks for a complete `Adjustments`, but the body spreads
    // over the defaults — which is what keeps a page persisted by an older
    // build (before `detail` existed) loadable today.
    const legacy = { brightness: 20 } as Adjustments;
    const page = createPage('d_1', 'b_1', SIZE, { adjust: legacy });
    expect(page.edits.adjust).toEqual({ brightness: 20, contrast: 0, saturation: 0, detail: 0 });
  });

  it('does not share the default adjust object between pages', () => {
    const a = createPage('d_1', 'b_1', SIZE);
    const b = createPage('d_1', 'b_2', SIZE);
    a.edits.adjust.brightness = 99;
    expect(b.edits.adjust.brightness).toBe(0);
  });

  it('lists exactly the pages of one document', async () => {
    const first = await seedDocument(3);
    const second = await seedDocument(2);
    const listed = await listPages(first.doc.id);
    expect(listed.map((p) => p.id).sort()).toEqual(first.pages.map((p) => p.id).sort());
    expect(await listPages(second.doc.id)).toHaveLength(2);
    expect(await listPages('no-such-doc')).toEqual([]);
  });

  it('saves and reads back a single page', async () => {
    const page = createPage('d_1', 'b_1', SIZE);
    await savePage(page);
    expect(await getPage(page.id)).toEqual(page);
    expect(await getPage('missing')).toBeUndefined();
  });

  it('deletes a page and every blob it owned', async () => {
    const { pages } = await seedDocument(2);
    const signature = await putBlob(textBlob('signature'));
    const annotation: Annotation = {
      id: 'a_1',
      kind: 'signature',
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.1,
      rotation: 0,
      opacity: 1,
      blobId: signature,
    };
    const target = { ...pages[0], annotations: [annotation] };
    await savePage(target);

    await deletePage(target.id);
    expect(await getPage(target.id)).toBeUndefined();
    expect(await getBlob(target.originalBlobId)).toBeNull();
    expect(await getBlob(target.thumbBlobId)).toBeNull();
    expect(await getBlob(signature)).toBeNull();
    // The sibling page is untouched.
    expect(await getBlob(pages[1].originalBlobId)).not.toBeNull();
  });

  it('is a no-op when deleting a page that does not exist', async () => {
    const { pages } = await seedDocument(1);
    await deletePage('missing');
    expect(await getPage(pages[0].id)).toBeDefined();
  });

  it('saves many pages at once and tolerates an empty batch', async () => {
    await savePages([]);
    const pages = [createPage('d_9', 'b_1', SIZE), createPage('d_9', 'b_2', SIZE)];
    await savePages(pages);
    expect(await listPages('d_9')).toHaveLength(2);
  });
});

describe('trash', () => {
  it('marks a document deleted without touching its pages or blobs', async () => {
    const { doc, pages } = await seedDocument(2);
    await trashDocument(doc.id);
    const trashed = await getDocument(doc.id);
    expect(trashed?.deletedAt).toBeTypeOf('number');
    expect(await listPages(doc.id)).toHaveLength(2);
    expect(await getBlob(pages[0].originalBlobId)).not.toBeNull();
  });

  it('restores a trashed document', async () => {
    const { doc } = await seedDocument(1);
    await trashDocument(doc.id);
    await restoreDocument(doc.id);
    expect((await getDocument(doc.id))?.deletedAt).toBeNull();
  });

  it('ignores trash and restore for an unknown id', async () => {
    await trashDocument('missing');
    await restoreDocument('missing');
    expect(await listDocuments()).toEqual([]);
  });

  it('purges the document, its pages and its blobs', async () => {
    const { doc, pages } = await seedDocument(3);
    const other = await seedDocument(1);

    await purgeDocument(doc.id);
    expect(await getDocument(doc.id)).toBeUndefined();
    expect(await listPages(doc.id)).toEqual([]);
    for (const page of pages) {
      expect(await getBlob(page.originalBlobId)).toBeNull();
      expect(await getBlob(page.thumbBlobId)).toBeNull();
    }
    // The other document survives intact.
    expect(await getDocument(other.doc.id)).toBeDefined();
    expect(await getBlob(other.pages[0].originalBlobId)).not.toBeNull();
  });

  it('purges annotation blobs too', async () => {
    const { doc, pages } = await seedDocument(1);
    const stamp = await putBlob(textBlob('stamp'));
    await savePage({
      ...pages[0],
      annotations: [
        {
          id: 'a_1',
          kind: 'image',
          x: 0,
          y: 0,
          width: 0.1,
          height: 0.1,
          rotation: 0,
          opacity: 1,
          blobId: stamp,
        },
      ],
    });
    await purgeDocument(doc.id);
    expect(await getBlob(stamp)).toBeNull();
  });

  it('still cleans up orphaned pages when the document row is already gone', async () => {
    const { doc, pages } = await seedDocument(2);
    await wipeDocumentRowOnly(doc.id);
    await purgeDocument(doc.id);
    expect(await listPages(doc.id)).toEqual([]);
    expect(await getBlob(pages[0].originalBlobId)).toBeNull();
  });

  it('empties the trash and leaves live documents alone', async () => {
    const live = await seedDocument(1);
    const dead = await seedDocument(2);
    const alsoDead = await seedDocument(1);
    await trashDocument(dead.doc.id);
    await trashDocument(alsoDead.doc.id);

    expect(await emptyTrash()).toBe(2);
    expect((await listDocuments()).map((d) => d.id)).toEqual([live.doc.id]);
    expect(await getBlob(dead.pages[0].originalBlobId)).toBeNull();
    expect(await getBlob(live.pages[0].originalBlobId)).not.toBeNull();
    expect(await emptyTrash()).toBe(0);
  });
});

describe('folders', () => {
  it('creates a folder with defaults', () => {
    const folder = createFolder('Invoices');
    expect(folder.id).toMatch(/^f_/);
    expect(folder.name).toBe('Invoices');
    expect(folder.parentId).toBeNull();
    expect(folder.color).toBe('none');
    expect(folder.deletedAt).toBeNull();
  });

  it('saves and lists folders', async () => {
    const a = createFolder('A');
    const b = createFolder('B', a.id);
    await saveFolder(a);
    await saveFolder(b);
    expect((await listFolders()).map((f) => f.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('cascades a delete to every descendant folder', async () => {
    const root = createFolder('Root');
    const child = createFolder('Child', root.id);
    const grandchild = createFolder('Grandchild', child.id);
    const sibling = createFolder('Sibling');
    for (const folder of [root, child, grandchild, sibling]) await saveFolder(folder);

    await deleteFolderTree(root.id);
    expect((await listFolders()).map((f) => f.id)).toEqual([sibling.id]);
  });

  it('trashes the documents inside the deleted tree instead of destroying them', async () => {
    const root = createFolder('Root');
    const child = createFolder('Child', root.id);
    await saveFolder(root);
    await saveFolder(child);
    const inRoot = await seedDocument(1, { folderId: root.id });
    const inChild = await seedDocument(1, { folderId: child.id });
    const outside = await seedDocument(1);

    await deleteFolderTree(root.id);

    for (const seeded of [inRoot, inChild]) {
      const doc = await getDocument(seeded.doc.id);
      expect(doc?.deletedAt).toBeTypeOf('number');
      expect(doc?.folderId).toBeNull();
      // Recoverable: the pages and their blobs are still there.
      expect(await listPages(seeded.doc.id)).toHaveLength(1);
      expect(await getBlob(seeded.pages[0].originalBlobId)).not.toBeNull();
    }
    const untouched = await getDocument(outside.doc.id);
    expect(untouched?.deletedAt).toBeNull();
  });

  it('leaves an already-trashed document pointing at a folder that no longer exists', async () => {
    // A document already in the trash must still lose its folder reference:
    // restoring it later would otherwise file it into a folder that no longer
    // exists, hiding it from every view.
    const folder = createFolder('Old');
    await saveFolder(folder);
    const seeded = await seedDocument(1, { folderId: folder.id });
    await trashDocument(seeded.doc.id);

    await deleteFolderTree(folder.id);

    const doc = await getDocument(seeded.doc.id);
    expect(doc?.folderId).toBeNull();
    expect(await listFolders()).toEqual([]);
  });

  it('terminates on a corrupt parent cycle', async () => {
    const a = createFolder('A');
    const b = createFolder('B', a.id);
    a.parentId = b.id;
    await saveFolder(a);
    await saveFolder(b);
    await deleteFolderTree(a.id);
    expect(await listFolders()).toEqual([]);
  });

  it('is a no-op for a folder id that does not exist', async () => {
    const keep = createFolder('Keep');
    await saveFolder(keep);
    await deleteFolderTree('missing');
    expect((await listFolders()).map((f) => f.id)).toEqual([keep.id]);
  });
});

describe('collectGarbage', () => {
  it('deletes only the blobs no page references', async () => {
    const { pages } = await seedDocument(2);
    const orphan = await putBlob(textBlob('orphan'));
    const secondOrphan = await putBlob(textBlob('orphan 2'));

    expect(await collectGarbage()).toBe(2);
    expect(await getBlob(orphan)).toBeNull();
    expect(await getBlob(secondOrphan)).toBeNull();
    for (const page of pages) {
      expect(await getBlob(page.originalBlobId)).not.toBeNull();
      expect(await getBlob(page.thumbBlobId)).not.toBeNull();
    }
  });

  it('keeps processed and annotation blobs alive', async () => {
    const { pages } = await seedDocument(1);
    const processed = await putBlob(textBlob('processed'));
    const drawn = await putBlob(textBlob('signature'));
    await savePage({
      ...pages[0],
      processedBlobId: processed,
      annotations: [
        {
          id: 'a_1',
          kind: 'signature',
          x: 0,
          y: 0,
          width: 0.1,
          height: 0.1,
          rotation: 0,
          opacity: 1,
          blobId: drawn,
        },
      ],
    });

    expect(await collectGarbage()).toBe(0);
    expect(await getBlob(processed)).not.toBeNull();
    expect(await getBlob(drawn)).not.toBeNull();
  });

  it('never deletes a blob listed in the signatures key', async () => {
    const saved = await putBlob(textBlob('my signature'));
    const alsoSaved = await putBlob(textBlob('initials'));
    const junk = await putBlob(textBlob('junk'));
    await setKv<ID[]>('signatures', [saved, alsoSaved]);

    expect(await collectGarbage()).toBe(1);
    expect(await getBlob(saved)).not.toBeNull();
    expect(await getBlob(alsoSaved)).not.toBeNull();
    expect(await getBlob(junk)).toBeNull();
  });

  it('copes with a missing signatures key', async () => {
    const junk = await putBlob(textBlob('junk'));
    expect(await collectGarbage()).toBe(1);
    expect(await getBlob(junk)).toBeNull();
  });

  it('keeps blobs belonging to a trashed document, which is still recoverable', async () => {
    const { doc, pages } = await seedDocument(2);
    await trashDocument(doc.id);
    expect(await collectGarbage()).toBe(0);
    expect(await getBlob(pages[0].originalBlobId)).not.toBeNull();
  });

  it('reports zero on an empty database', async () => {
    expect(await collectGarbage()).toBe(0);
  });

  it('is idempotent', async () => {
    await seedDocument(1);
    await putBlob(textBlob('orphan'));
    expect(await collectGarbage()).toBe(1);
    expect(await collectGarbage()).toBe(0);
  });
});

describe('settings', () => {
  it('returns the defaults when nothing is stored', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges a partial stored value over the defaults', async () => {
    await put(STORE.kv, { theme: 'dark', ocrLanguage: 'deu' }, 'settings');
    const settings = await loadSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.ocrLanguage).toBe('deu');
    expect(settings.defaultFilter).toBe(DEFAULT_SETTINGS.defaultFilter);
    expect(settings.maxProcessedEdge).toBe(DEFAULT_SETTINGS.maxProcessedEdge);
    expect(settings.defaultPdf).toEqual(DEFAULT_PDF_OPTIONS);
  });

  it('merges a partial defaultPdf over the default pdf options', async () => {
    await put(STORE.kv, { defaultPdf: { pageSize: 'a4', password: 'secret' } }, 'settings');
    const settings = await loadSettings();
    expect(settings.defaultPdf.pageSize).toBe('a4');
    expect(settings.defaultPdf.password).toBe('secret');
    expect(settings.defaultPdf.quality).toBe(DEFAULT_PDF_OPTIONS.quality);
    expect(settings.defaultPdf.author).toBe(DEFAULT_PDF_OPTIONS.author);
  });

  it('survives a stored value with a null defaultPdf', async () => {
    await put(STORE.kv, { theme: 'light', defaultPdf: null }, 'settings');
    expect((await loadSettings()).defaultPdf).toEqual(DEFAULT_PDF_OPTIONS);
  });

  it('round-trips a full save', async () => {
    const settings = { ...DEFAULT_SETTINGS, theme: 'dark' as const, jpegQuality: 0.5 };
    await saveSettings(settings);
    expect(await loadSettings()).toEqual(settings);
  });

  it('does not hand out the shared default object', async () => {
    const settings = await loadSettings();
    settings.theme = 'dark';
    expect(DEFAULT_SETTINGS.theme).toBe('system');
    expect((await loadSettings()).theme).toBe('system');
  });

  it('keeps unknown persisted keys rather than dropping them', async () => {
    // Forwards compatibility: a newer build's settings must survive a downgrade.
    await put(STORE.kv, { theme: 'dark', futureFlag: true }, 'settings');
    expect(await get<Record<string, unknown>>(STORE.kv, 'settings')).toMatchObject({ futureFlag: true });
    const loaded = (await loadSettings()) as AppSettings & { futureFlag?: boolean };
    expect(loaded.futureFlag).toBe(true);
    expect(loaded.theme).toBe('dark');
  });
});

describe('kv', () => {
  it('stores and reads arbitrary values', async () => {
    await setKv('signatures', ['a', 'b']);
    expect(await getKv<string[]>('signatures')).toEqual(['a', 'b']);
    expect(await getKv('nothing')).toBeUndefined();
  });

  it('overwrites on a second write', async () => {
    await setKv('k', 1);
    await setKv('k', 2);
    expect(await getKv<number>('k')).toBe(2);
  });
});

describe('storageUsage', () => {
  it('counts live documents and every page', async () => {
    await seedDocument(2);
    const trashed = await seedDocument(3);
    await trashDocument(trashed.doc.id);

    const usage = await storageUsage();
    expect(usage.documents).toBe(1);
    expect(usage.pages).toBe(5);
    expect(usage.usage).toBeGreaterThanOrEqual(0);
    expect(usage.quota).toBeGreaterThanOrEqual(0);
  });
});

describe('wipeAll', () => {
  it('clears every store', async () => {
    await seedDocument(2);
    await saveFolder(createFolder('F'));
    await setKv('signatures', ['x']);

    await wipeAll();

    expect(await listDocuments()).toEqual([]);
    expect(await listFolders()).toEqual([]);
    expect(await count(STORE.pages)).toBe(0);
    expect(await count(STORE.blobs)).toBe(0);
    expect(await getKv('signatures')).toBeUndefined();
  });
});
