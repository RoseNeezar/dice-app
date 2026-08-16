/**
 * Library search: title, tags and recognised page text.
 *
 * Everything here is pure and DOM-free so it can run on every keystroke and be
 * unit tested. Matching is case- and diacritic-insensitive, and the folding is
 * deliberately one UTF-16 unit in, one unit out, so an offset found in a folded
 * string indexes the original string too — that is what lets snippets be sliced
 * out of the untouched text and still highlight the right characters.
 */

import type { ID, Page, ScanDocument } from '@/types';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Half-open `[start, end)` character range inside a snippet. */
export interface SearchRange {
  start: number;
  end: number;
}

/** An excerpt to render under a result, with the matched runs marked. */
export interface SearchSnippet {
  text: string;
  ranges: SearchRange[];
}

/** Which part of a document a match came from. */
export type SearchField = 'title' | 'tag' | 'text';

export interface SearchHit {
  docId: ID;
  /** Higher is a better match; only meaningful relative to the same query. */
  score: number;
  /** The strongest field that matched. */
  field: SearchField;
  /**
   * Best excerpt to show beneath the title, or `null` when the title alone
   * matched and the list already shows it.
   */
  snippet: SearchSnippet | null;
  /** Page the snippet was taken from, when it came from recognised text. */
  pageId: ID | null;
}

export interface SearchOptions {
  /** Approximate length of the excerpt, before ellipses. */
  snippetLength?: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

/* ------------------------------------------------------------------ */
/* Folding                                                             */
/* ------------------------------------------------------------------ */

const COMBINING = /[\u0300-\u036f]/g;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/;

/**
 * Lowercase `text` and strip diacritics without changing its length, so an
 * index into the result is also a valid index into `text`.
 */
export function fold(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // The overwhelmingly common case: plain ASCII needs no Unicode machinery.
    if (code < 128) {
      out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i];
      continue;
    }
    const unit = text[i];
    const lower = unit.toLowerCase();
    const stripped = lower.normalize('NFD').replace(COMBINING, '');
    if (stripped.length === 1) out += stripped;
    else if (lower.length === 1) out += lower;
    else out += unit;
  }
  return out;
}

/** Split a raw query into folded terms. Repeats and blanks are dropped. */
export function parseQuery(query: string): string[] {
  const terms = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const term = fold(raw);
    if (term) terms.add(term);
    // A query longer than this is a paste accident, not a search.
    if (terms.size >= 8) break;
  }
  return [...terms];
}

function isWordStart(folded: string, index: number): boolean {
  if (index === 0) return true;
  return !ALPHANUMERIC.test(folded[index - 1]);
}

function countOccurrences(haystack: string, needle: string, limit: number): number {
  let count = 0;
  let from = 0;
  while (count < limit) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    count += 1;
    from = index + needle.length;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Snippets                                                            */
/* ------------------------------------------------------------------ */

/** How far back from the first match the excerpt starts. */
const SNIPPET_LEAD = 44;
/** How far the window may slide to avoid cutting a word in half. */
const BOUNDARY_SLACK = 24;
const ELLIPSIS = '…';

/**
 * Cut an excerpt around the first occurrence of any term, marking every term
 * occurrence inside it. Returns `null` when no term appears in `text`.
 */
export function makeSnippet(text: string, terms: string[], maxLength = 160): SearchSnippet | null {
  if (!text || terms.length === 0) return null;
  const folded = fold(text);

  let first = -1;
  for (const term of terms) {
    const index = folded.indexOf(term);
    if (index >= 0 && (first < 0 || index < first)) first = index;
  }
  if (first < 0) return null;

  let start = Math.max(0, first - SNIPPET_LEAD);
  for (let i = 0; i < BOUNDARY_SLACK && start > 0; i++) {
    if (WHITESPACE.test(text[start - 1])) break;
    start -= 1;
  }
  let end = Math.min(text.length, start + maxLength);
  for (let i = 0; i < BOUNDARY_SLACK && end < text.length; i++) {
    if (WHITESPACE.test(text[end])) break;
    end += 1;
  }

  const prefix = start > 0 ? ELLIPSIS : '';
  const suffix = end < text.length ? ELLIPSIS : '';
  // Replacing each whitespace character with a single space keeps the 1:1
  // index mapping that the ranges below depend on.
  const body = text.slice(start, end).replace(/\s/g, ' ');
  const foldedBody = folded.slice(start, end);

  const ranges: SearchRange[] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const index = foldedBody.indexOf(term, from);
      if (index < 0) break;
      ranges.push({ start: index + prefix.length, end: index + term.length + prefix.length });
      from = index + term.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: SearchRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }

  return { text: `${prefix}${body}${suffix}`, ranges: merged };
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

/*
 * A term found at the start of a word in the title is what people mean nine
 * times out of ten, so the fields are an order of magnitude apart rather than
 * gently weighted — a body-text match should never outrank a title match no
 * matter how often it repeats.
 */
const TITLE_WORD = 120;
const TITLE_PART = 80;
const TAG_WORD = 70;
const TAG_PART = 45;
const TEXT_BASE = 24;
const TEXT_REPEAT = 3;
const TEXT_REPEAT_CAP = 5;
/** Awarded once when the whole query appears verbatim in the title. */
const PHRASE_BONUS = 60;

interface TermMatch {
  score: number;
  field: SearchField;
}

function scoreTerm(term: string, foldedTitle: string, foldedTags: string[], pageTexts: string[]): TermMatch {
  let score = 0;
  let field: SearchField = 'text';

  const inTitle = foldedTitle.indexOf(term);
  if (inTitle >= 0) {
    score = isWordStart(foldedTitle, inTitle) ? TITLE_WORD : TITLE_PART;
    field = 'title';
  }

  for (const tag of foldedTags) {
    const inTag = tag.indexOf(term);
    if (inTag < 0) continue;
    const tagScore = isWordStart(tag, inTag) ? TAG_WORD : TAG_PART;
    if (tagScore > score) {
      score = tagScore;
      field = 'tag';
    }
  }

  let occurrences = 0;
  for (const text of pageTexts) {
    occurrences += countOccurrences(text, term, TEXT_REPEAT_CAP - occurrences);
    if (occurrences >= TEXT_REPEAT_CAP) break;
  }
  if (occurrences > 0) {
    const textScore = TEXT_BASE + occurrences * TEXT_REPEAT;
    if (textScore > score) {
      score = textScore;
      field = 'text';
    }
  }

  return { score, field };
}

/**
 * Rank every document that matches *all* of the query's terms.
 *
 * Terms are ANDed across the whole document, not per field: "invoice acme"
 * matches a document titled "Invoice" whose scanned text mentions Acme.
 */
export function searchDocuments(
  query: string,
  docs: ScanDocument[],
  pages: Record<ID, Page>,
  options: SearchOptions = {},
): SearchHit[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  const phrase = fold(query.trim());
  const hits: (SearchHit & { updatedAt: number; title: string })[] = [];

  for (const doc of docs) {
    const foldedTitle = fold(doc.title);
    const foldedTags = doc.tags.map(fold);

    const pageTexts: string[] = [];
    const pageIds: ID[] = [];
    const rawTexts: string[] = [];
    for (const pageId of doc.pageIds) {
      const text = pages[pageId]?.ocr?.text;
      if (!text) continue;
      pageTexts.push(fold(text));
      rawTexts.push(text);
      pageIds.push(pageId);
    }

    let total = 0;
    let bestField: SearchField = 'text';
    let bestScore = -1;
    let matched = true;

    for (const term of terms) {
      const { score, field } = scoreTerm(term, foldedTitle, foldedTags, pageTexts);
      if (score === 0) {
        matched = false;
        break;
      }
      total += score;
      if (score > bestScore) {
        bestScore = score;
        bestField = field;
      }
    }
    if (!matched) continue;

    if (phrase && foldedTitle.includes(phrase)) total += PHRASE_BONUS;

    /* The excerpt shows what the list cannot: recognised text first, then a
       matching tag. A title-only match needs no excerpt. */
    let snippet: SearchSnippet | null = null;
    let snippetPageId: ID | null = null;
    for (let i = 0; i < pageTexts.length && !snippet; i++) {
      const candidate = makeSnippet(rawTexts[i], terms, options.snippetLength);
      if (candidate) {
        snippet = candidate;
        snippetPageId = pageIds[i];
      }
    }
    if (!snippet) {
      for (const tag of doc.tags) {
        const candidate = makeSnippet(tag, terms, options.snippetLength);
        if (candidate) {
          snippet = candidate;
          break;
        }
      }
    }

    hits.push({
      docId: doc.id,
      score: total,
      field: bestField,
      snippet,
      pageId: snippetPageId,
      updatedAt: doc.updatedAt,
      title: doc.title,
    });
  }

  hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  return hits.map(({ docId, score, field, snippet, pageId }) => ({ docId, score, field, snippet, pageId }));
}

/** Every tag in use, most used first, for the filter row. */
export function collectTags(docs: ScanDocument[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    for (const tag of doc.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
