import type { OcrLine, OcrWord } from '@/types';

/**
 * Turn an OCR layer back into a table, for "export as spreadsheet".
 *
 * OCR gives us words with boxes but no structure, so the table has to be
 * recovered from the layout. Rows come from vertical overlap between lines;
 * columns come from the *gutters* — vertical bands of white space that survive
 * across most rows. Voting per row rather than projecting all words at once is
 * what makes a ragged receipt (where one long item name spills into the next
 * column) still resolve into the right number of columns.
 */

/** A recovered table plus how much it should be trusted, 0..1. */
export interface TableGuess {
  /** Rectangular: every row has the same number of cells. */
  rows: string[][];
  confidence: number;
}

/** Horizontal resolution of the gutter histogram, in bins across the page width. */
const BINS = 400;
/** A band only counts as a gutter if this share of rows is blank there. */
const GUTTER_VOTE_RATIO = 0.8;
/** Narrowest gutter worth splitting on, as a fraction of page width. */
const MIN_GUTTER_WIDTH = 0.02;
/** A gutter must also be this many character advances wide, so it scales with the type size. */
const GUTTER_CHAR_FACTOR = 2.5;
/** Beyond this, a "table" is really just sparse prose. */
const MAX_COLUMNS = 12;
/** Two lines belong to the same row when they overlap by this much vertically. */
const ROW_OVERLAP_RATIO = 0.5;
/** Column edge scatter, as a fraction of page width, at which alignment scores 0. */
const ALIGN_TOLERANCE = 0.03;

interface Cell {
  words: OcrWord[];
}

interface Row {
  y0: number;
  y1: number;
  words: OcrWord[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Words of one line, left to right. A line whose words were dropped (some
 * engines only return line-level boxes) still contributes its text as a single
 * word spanning the line, so it lands in a cell instead of vanishing.
 */
function lineWords(line: OcrLine): OcrWord[] {
  const words = line.words.filter((word) => word.text.trim() !== '');
  if (words.length > 0) return [...words].sort((a, b) => a.x - b.x);
  const text = line.text.trim();
  if (text === '') return [];
  return [{ text, x: line.x, y: line.y, width: line.width, height: line.height, confidence: 0 }];
}

/** Group lines that sit at the same height into rows. */
function clusterRows(lines: OcrLine[]): Row[] {
  const candidates = lines
    .map((line) => ({ line, words: lineWords(line) }))
    .filter((entry) => entry.words.length > 0)
    .sort((a, b) => a.line.y + a.line.height / 2 - (b.line.y + b.line.height / 2));

  const rows: Row[] = [];
  for (const { line, words } of candidates) {
    const y0 = line.y;
    const y1 = line.y + line.height;
    const current = rows[rows.length - 1];
    const overlap = current ? Math.min(current.y1, y1) - Math.max(current.y0, y0) : 0;
    // Measured against the incoming line's own height so a tall row that has
    // already absorbed several lines does not start swallowing everything.
    if (current && line.height > 0 && overlap / line.height >= ROW_OVERLAP_RATIO) {
      current.y0 = Math.min(current.y0, y0);
      current.y1 = Math.max(current.y1, y1);
      current.words.push(...words);
    } else {
      rows.push({ y0, y1, words: [...words] });
    }
  }
  for (const row of rows) row.words.sort((a, b) => a.x - b.x);
  return rows;
}

function binRange(word: OcrWord): { start: number; end: number } {
  const start = Math.max(0, Math.min(BINS - 1, Math.floor(word.x * BINS)));
  const end = Math.max(start, Math.min(BINS - 1, Math.ceil((word.x + word.width) * BINS) - 1));
  return { start, end };
}

/**
 * Median per-character advance — a stand-in for the width of one space.
 *
 * The obvious measure, the median gap between neighbouring words, is useless
 * here: in a sparse table most gaps *are* the gutters, so the estimate scales
 * with the thing it is meant to detect. Character width does not.
 */
function typicalCharWidth(rows: Row[]): number {
  const widths: number[] = [];
  for (const row of rows) {
    for (const word of row.words) {
      const length = word.text.trim().length;
      if (length > 0 && word.width > 0) widths.push(word.width / length);
    }
  }
  return median(widths);
}

interface Gutter {
  /** Split position, normalised 0..1. */
  at: number;
  /** Share of rows that are blank at the emptiest point of the band. */
  vote: number;
  widthBins: number;
}

/**
 * The widest stretch of a band on which the most rows agree there is space.
 *
 * Splitting at the middle of the whole band would be wrong when one long cell
 * pokes into one end of it — the split belongs where every row is blank, which
 * is where a human would draw the column rule.
 */
function widestPeak(
  freeVotes: Uint32Array,
  start: number,
  endExclusive: number,
): { start: number; end: number; vote: number } {
  let vote = 0;
  for (let b = start; b < endExclusive; b++) vote = Math.max(vote, freeVotes[b]);
  let best = { start, end: endExclusive, width: 0 };
  let runStart = -1;
  for (let b = start; b <= endExclusive; b++) {
    const inPeak = b < endExclusive && freeVotes[b] === vote;
    if (inPeak) {
      if (runStart < 0) runStart = b;
      continue;
    }
    if (runStart >= 0) {
      if (b - runStart > best.width) best = { start: runStart, end: b, width: b - runStart };
      runStart = -1;
    }
  }
  return { start: best.start, end: best.end, vote };
}

/** Find the vertical white-space bands that separate columns. */
function findGutters(rows: Row[]): Gutter[] {
  const freeVotes = new Uint32Array(BINS);
  const anyCovered = new Uint8Array(BINS);
  for (const row of rows) {
    const covered = new Uint8Array(BINS);
    for (const word of row.words) {
      const { start, end } = binRange(word);
      for (let b = start; b <= end; b++) {
        covered[b] = 1;
        anyCovered[b] = 1;
      }
    }
    for (let b = 0; b < BINS; b++) if (!covered[b]) freeVotes[b] += 1;
  }

  let contentStart = -1;
  let contentEnd = -1;
  for (let b = 0; b < BINS; b++) {
    if (!anyCovered[b]) continue;
    if (contentStart < 0) contentStart = b;
    contentEnd = b;
  }
  if (contentStart < 0 || contentEnd <= contentStart) return [];

  const minWidthBins = Math.max(
    1,
    Math.ceil(Math.max(MIN_GUTTER_WIDTH, typicalCharWidth(rows) * GUTTER_CHAR_FACTOR) * BINS),
  );

  const gutters: Gutter[] = [];
  let runStart = -1;
  const flush = (endExclusive: number) => {
    if (runStart < 0) return;
    const width = endExclusive - runStart;
    // Bands touching the page content edges are margins, not separators.
    if (width >= minWidthBins && runStart > contentStart && endExclusive - 1 < contentEnd) {
      const peak = widestPeak(freeVotes, runStart, endExclusive);
      gutters.push({
        at: (peak.start + peak.end) / 2 / BINS,
        vote: peak.vote / rows.length,
        widthBins: width,
      });
    }
    runStart = -1;
  };
  for (let b = contentStart; b <= contentEnd; b++) {
    if (freeVotes[b] / rows.length >= GUTTER_VOTE_RATIO) {
      if (runStart < 0) runStart = b;
    } else {
      flush(b);
    }
  }
  flush(contentEnd + 1);

  if (gutters.length > MAX_COLUMNS - 1) {
    // Keep the most convincing separators: widest first, then back into
    // left-to-right order so the columns stay in reading order.
    return gutters
      .sort((a, b) => b.widthBins - a.widthBins || b.vote - a.vote)
      .slice(0, MAX_COLUMNS - 1)
      .sort((a, b) => a.at - b.at);
  }
  return gutters;
}

function columnOf(word: OcrWord, boundaries: number[]): number {
  const centre = word.x + word.width / 2;
  let column = 0;
  while (column < boundaries.length && centre > boundaries[column]) column += 1;
  return column;
}

/** How tightly each column's cells share a left or right edge, 0..1. */
function alignmentScore(grid: Cell[][], columns: number): number {
  const scores: number[] = [];
  for (let c = 0; c < columns; c++) {
    const lefts: number[] = [];
    const rights: number[] = [];
    for (const row of grid) {
      const words = row[c].words;
      if (words.length === 0) continue;
      const last = words[words.length - 1];
      lefts.push(words[0].x);
      rights.push(last.x + last.width);
    }
    if (lefts.length < 2) continue;
    const spread = Math.min(stdev(lefts), stdev(rights));
    scores.push(1 - Math.min(spread / ALIGN_TOLERANCE, 1));
  }
  if (scores.length === 0) return 0.5;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

/**
 * Recover a rectangular table from the OCR lines of one page.
 *
 * Always returns a rectangular grid (short rows are padded with empty cells),
 * so the result can go straight to CSV. `confidence` is 0 whenever the layout
 * gives no real evidence of a table — a single column, or a single row.
 */
export function linesToTable(lines: OcrLine[]): TableGuess {
  const rows = clusterRows(lines);
  if (rows.length === 0) return { rows: [], confidence: 0 };

  const gutters = findGutters(rows);
  const boundaries = gutters.map((gutter) => gutter.at);
  const columns = boundaries.length + 1;

  const grid: Cell[][] = rows.map((row) => {
    const cells: Cell[] = Array.from({ length: columns }, () => ({ words: [] }));
    for (const word of row.words) cells[columnOf(word, boundaries)].words.push(word);
    return cells;
  });

  const text = grid.map((row) =>
    row.map((cell) =>
      cell.words
        .map((word) => word.text.trim())
        .filter((word) => word !== '')
        .join(' '),
    ),
  );

  const filled = text.reduce(
    (count, row) => count + row.reduce((inner, cell) => inner + (cell === '' ? 0 : 1), 0),
    0,
  );
  const nonEmpty = text.filter((row) => row.some((cell) => cell !== ''));
  if (nonEmpty.length === 0) return { rows: [], confidence: 0 };
  if (columns < 2 || nonEmpty.length < 2) return { rows: nonEmpty, confidence: 0 };

  const gutterScore =
    gutters.reduce((sum, gutter) => sum + clamp01((gutter.vote - 0.6) / 0.4), 0) / gutters.length;
  const fillScore = filled / (text.length * columns);
  const confidence = clamp01(
    0.45 * gutterScore + 0.35 * alignmentScore(grid, columns) + 0.2 * fillScore,
  );
  return { rows: nonEmpty, confidence };
}

/** Quote per RFC 4180: only when the field would otherwise break the parse. */
function escapeCsvField(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

/** Serialise a table as RFC 4180 CSV, CRLF-delimited and with no trailing break. */
export function tableToCsv(table: TableGuess): string {
  return table.rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
}

/**
 * Wrap CSV for download. The UTF-8 BOM is deliberate: without it Excel on
 * Windows reads the file as the local code page and mangles every accent.
 */
export function buildCsvBlob(csv: string): Blob {
  return new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
}
