import { describe, expect, it } from 'vitest';
import type { ID, OcrResult, Page, ScanDocument } from '@/types';
import { DEFAULT_EDITS } from '@/types';
import { collectTags, fold, makeSnippet, parseQuery, searchDocuments } from '@/features/docs/search';

let seq = 0;

function ocr(text: string): OcrResult {
  return { language: 'eng', text, lines: [], confidence: 0.9, completedAt: 1 };
}

function page(docId: ID, text: string | null): Page {
  const id = `p${++seq}`;
  return {
    id,
    docId,
    originalBlobId: `b${id}`,
    processedBlobId: null,
    thumbBlobId: null,
    source: { width: 1000, height: 1400 },
    processed: null,
    edits: DEFAULT_EDITS,
    annotations: [],
    ocr: text === null ? null : ocr(text),
    note: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

interface DocSpec {
  title: string;
  tags?: string[];
  texts?: (string | null)[];
  updatedAt?: number;
}

/** Build a library from compact specs; returns what `searchDocuments` wants. */
function library(specs: DocSpec[]): { docs: ScanDocument[]; pages: Record<ID, Page> } {
  const docs: ScanDocument[] = [];
  const pages: Record<ID, Page> = {};
  specs.forEach((spec, index) => {
    const id = `d${index + 1}`;
    const pageIds: ID[] = [];
    for (const text of spec.texts ?? []) {
      const built = page(id, text);
      pages[built.id] = built;
      pageIds.push(built.id);
    }
    docs.push({
      id,
      title: spec.title,
      folderId: null,
      pageIds,
      tags: spec.tags ?? [],
      color: 'none',
      deletedAt: null,
      locked: false,
      starred: false,
      createdAt: 1,
      updatedAt: spec.updatedAt ?? 1,
    });
  });
  return { docs, pages };
}

/** Re-slice a snippet by its ranges — what the UI renders as <mark>. */
function marked(text: string, ranges: { start: number; end: number }[]): string[] {
  return ranges.map((range) => text.slice(range.start, range.end));
}

describe('fold', () => {
  it('lowercases and strips diacritics one unit at a time', () => {
    expect(fold('Café RÉSUMÉ')).toBe('cafe resume');
    expect(fold('Ångström')).toBe('angstrom');
  });

  it('never changes the length, so offsets stay valid', () => {
    for (const sample of ['Café', 'İstanbul', 'straße', 'naïve — ünïcode', '日本語', '🙂 ok']) {
      expect(fold(sample)).toHaveLength(sample.length);
    }
  });
});

describe('parseQuery', () => {
  it('folds, splits and de-duplicates', () => {
    expect(parseQuery('  Invoice   ACME invoice ')).toEqual(['invoice', 'acme']);
  });

  it('returns nothing for blank input', () => {
    expect(parseQuery('   ')).toEqual([]);
  });
});

describe('searchDocuments', () => {
  it('matches on the title', () => {
    const { docs, pages } = library([{ title: 'Rental agreement' }, { title: 'Tax return 2025' }]);
    const hits = searchDocuments('rental', docs, pages);
    expect(hits).toHaveLength(1);
    expect(hits[0].docId).toBe('d1');
    expect(hits[0].field).toBe('title');
    // The list already shows the title, so a title-only match needs no excerpt.
    expect(hits[0].snippet).toBeNull();
  });

  it('matches on a tag and reports the tag as the excerpt', () => {
    const { docs, pages } = library([{ title: 'Scan 2026-01-02', tags: ['Receipts', 'Travel'] }]);
    const hits = searchDocuments('travel', docs, pages);
    expect(hits).toHaveLength(1);
    expect(hits[0].field).toBe('tag');
    expect(hits[0].snippet?.text).toBe('Travel');
    expect(marked(hits[0].snippet?.text ?? '', hits[0].snippet?.ranges ?? [])).toEqual(['Travel']);
  });

  it('matches recognised page text and points at the page it came from', () => {
    const { docs, pages } = library([
      { title: 'Scan 2026-01-02', texts: ['Nothing of interest here', 'Total due: 148.20 EUR'] },
    ]);
    const hits = searchDocuments('148.20', docs, pages);
    expect(hits).toHaveLength(1);
    expect(hits[0].field).toBe('text');
    const pageId = hits[0].pageId;
    expect(pageId).not.toBeNull();
    expect(pages[pageId ?? ''].ocr?.text).toContain('148.20');
    expect(hits[0].snippet?.text).toContain('148.20');
  });

  it('ignores pages that have not been recognised yet', () => {
    const { docs, pages } = library([{ title: 'Scan', texts: [null] }]);
    expect(searchDocuments('anything', docs, pages)).toEqual([]);
  });

  it('ranks a title match above a tag match above a body match', () => {
    const { docs, pages } = library([
      { title: 'Notes', texts: ['the invoice was paid in full, invoice invoice'] },
      { title: 'Meeting', tags: ['invoice'] },
      { title: 'Invoice 2026-02', texts: ['unrelated body text'] },
    ]);
    const hits = searchDocuments('invoice', docs, pages);
    expect(hits.map((hit) => hit.docId)).toEqual(['d3', 'd2', 'd1']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[1].score).toBeGreaterThan(hits[2].score);
  });

  it('prefers a match at the start of a word over one mid-word', () => {
    const { docs, pages } = library([{ title: 'Superinvoice' }, { title: 'Invoice draft' }]);
    expect(searchDocuments('invoice', docs, pages).map((hit) => hit.docId)).toEqual(['d2', 'd1']);
  });

  it('requires every term to match somewhere in the document', () => {
    const { docs, pages } = library([
      { title: 'Invoice', texts: ['issued to Acme Ltd'] },
      { title: 'Invoice', texts: ['issued to Globex'] },
    ]);
    expect(searchDocuments('invoice acme', docs, pages).map((hit) => hit.docId)).toEqual(['d1']);
  });

  it('breaks score ties with the most recently updated document', () => {
    const { docs, pages } = library([
      { title: 'Report', updatedAt: 100 },
      { title: 'Report', updatedAt: 900 },
    ]);
    expect(searchDocuments('report', docs, pages).map((hit) => hit.docId)).toEqual(['d2', 'd1']);
  });

  it('is case and diacritic insensitive across every field', () => {
    const { docs, pages } = library([
      { title: 'Café Résumé' },
      { title: 'Scan', tags: ['Ärzte'] },
      { title: 'Scan', texts: ['Signé à Genève'] },
    ]);
    expect(searchDocuments('RESUME', docs, pages).map((hit) => hit.docId)).toEqual(['d1']);
    expect(searchDocuments('arzte', docs, pages).map((hit) => hit.docId)).toEqual(['d2']);
    expect(searchDocuments('geneve', docs, pages).map((hit) => hit.docId)).toEqual(['d3']);
  });

  it('returns nothing for a blank query', () => {
    const { docs, pages } = library([{ title: 'Anything' }]);
    expect(searchDocuments('   ', docs, pages)).toEqual([]);
  });
});

describe('makeSnippet', () => {
  const text =
    'INVOICE 2026-014\nBilled to Acme Ltd, 14 Harbour Road, Dublin.\n' +
    'Consulting services rendered in January. Total due 1,480.00 EUR on receipt of this invoice.';

  it('returns null when nothing matches', () => {
    expect(makeSnippet(text, ['nowhere'])).toBeNull();
  });

  it('centres the window on the first match and marks every occurrence', () => {
    const snippet = makeSnippet(text, ['invoice']);
    expect(snippet).not.toBeNull();
    expect(snippet?.text.startsWith('INVOICE')).toBe(true);
    expect(marked(snippet?.text ?? '', snippet?.ranges ?? [])).toEqual(['INVOICE', 'invoice']);
  });

  it('adds ellipses and keeps the highlight aligned when the match is deep in the text', () => {
    const snippet = makeSnippet(text, ['1,480.00']);
    expect(snippet?.text.startsWith('…')).toBe(true);
    expect(marked(snippet?.text ?? '', snippet?.ranges ?? [])).toEqual(['1,480.00']);
  });

  it('flattens newlines without shifting the highlight', () => {
    const snippet = makeSnippet(text, ['billed']);
    expect(snippet?.text).not.toContain('\n');
    expect(marked(snippet?.text ?? '', snippet?.ranges ?? [])).toEqual(['Billed']);
  });

  it('highlights accented source text from an unaccented query', () => {
    const snippet = makeSnippet('Reçu pour Genève, payé', ['geneve', 'paye']);
    expect(marked(snippet?.text ?? '', snippet?.ranges ?? [])).toEqual(['Genève', 'payé']);
  });

  it('merges overlapping term ranges', () => {
    const snippet = makeSnippet('abcdef', ['abc', 'bcd']);
    expect(snippet?.ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it('does not cut a word in half at either edge', () => {
    const long = `${'padding word '.repeat(20)}TARGET${' trailing word'.repeat(20)}`;
    const snippet = makeSnippet(long, ['target'], 60);
    expect(snippet?.text.replace(/…/g, '').trim().split(/\s+/).every((word) => long.includes(word))).toBe(true);
  });
});

describe('collectTags', () => {
  it('counts tags and orders them by use', () => {
    const { docs } = library([
      { title: 'a', tags: ['work', 'tax'] },
      { title: 'b', tags: ['work'] },
      { title: 'c', tags: ['archive', 'work'] },
    ]);
    expect(collectTags(docs)).toEqual([
      { tag: 'work', count: 3 },
      { tag: 'archive', count: 1 },
      { tag: 'tax', count: 1 },
    ]);
  });

  it('is empty when nothing is tagged', () => {
    const { docs } = library([{ title: 'a' }]);
    expect(collectTags(docs)).toEqual([]);
  });
});
