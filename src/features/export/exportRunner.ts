import type { ExportQuality, ID, OcrResult, Page, PageEdits, PdfExportOptions } from '@/types';
import { DEFAULT_ADJUSTMENTS } from '@/types';
import type { IconName } from '@/ui/Icon';
import { cv } from '@/lib/cv/client';
import { pageExportImage } from '@/lib/render/composite';
import type { PdfPageInput } from '@/lib/pdf/export';
import { suggestPdfName } from '@/lib/pdf/naming';
import { recognizeImage } from '@/lib/ocr/ocr';
import { buildDocxBlob, buildTxtBlob, documentToText, type TextExportPage } from '@/lib/export/text';
import { buildCsvBlob, linesToTable, tableToCsv } from '@/lib/export/tables';
import { createZip, type ZipEntry } from '@/lib/export/zip';
import { getBlob } from '@/lib/db/repository';

/**
 * Everything that turns a document into files the user can keep.
 *
 * The sheet above this module owns the choices; this module owns the work:
 * recognising text that the chosen format needs, baking annotations into the
 * page images, re-encoding them at the requested quality and assembling the
 * result. It reports progress continuously and checks the abort signal between
 * every page, so "Cancel" stops within one page rather than at the end.
 */

export type ExportFormat = 'pdf' | 'jpeg' | 'txt' | 'docx' | 'csv' | 'zip';

export interface ExportFormatInfo {
  id: ExportFormat;
  label: string;
  /** One line under the label in the picker. */
  hint: string;
  icon: IconName;
  /** Built from the OCR layer rather than from the pixels. */
  textBased: boolean;
}

/** The formats offered, in the order they appear in the picker. */
export const EXPORT_FORMATS: ExportFormatInfo[] = [
  { id: 'pdf', label: 'PDF', hint: 'One document', icon: 'pdf', textBased: false },
  { id: 'jpeg', label: 'Images', hint: 'One JPEG per page', icon: 'image', textBased: false },
  { id: 'txt', label: 'Text', hint: 'Recognised text', icon: 'fileText', textBased: true },
  { id: 'docx', label: 'Word', hint: '.docx document', icon: 'file', textBased: true },
  { id: 'csv', label: 'Spreadsheet', hint: 'Tables as .csv', icon: 'table', textBased: true },
  { id: 'zip', label: 'ZIP', hint: 'All images, zipped', icon: 'layers', textBased: false },
];

/** One page to export, with its position in the parent document (zero-based). */
export interface ExportPage {
  page: Page;
  index: number;
}

/** A snapshot of the job for the progress bar. */
export interface ExportProgress {
  /** 0..1 across the whole job. */
  value: number;
  /** What is happening right now; safe to render as-is. */
  message: string;
}

export interface ExportJob {
  format: ExportFormat;
  /** Document title — becomes the file name and the PDF metadata title. */
  title: string;
  pages: ExportPage[];
  options: PdfExportOptions;
  /** Tesseract language code used for any recognition this export has to do. */
  ocrLanguage: string;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
  /** Persist an OCR layer this export produced, so it is never recomputed. */
  saveOcr: (pageId: ID, ocr: OcrResult) => Promise<void>;
}

export interface ExportOutcome {
  files: File[];
  /** A non-fatal caveat worth showing once the files are ready. */
  warning: string | null;
}

/** Thrown when the abort signal fires; the UI treats it as "no error happened". */
export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelled';
  }
}

export function isCancellation(error: unknown): boolean {
  return error instanceof ExportCancelled;
}

/* ------------------------------------------------------------------ */
/* Quality                                                             */
/* ------------------------------------------------------------------ */

/**
 * Longest edge, in pixels, each quality preset allows. `original` keeps the
 * page render untouched.
 */
const MAX_EDGE: Record<ExportQuality, number | null> = {
  original: null,
  high: 2400,
  medium: 1700,
  low: 1100,
};

const JPEG_QUALITY: Record<ExportQuality, number> = {
  original: 0.9,
  high: 0.88,
  medium: 0.78,
  low: 0.62,
};

/**
 * Re-encoding a page that is already within budget would only add a generation
 * of JPEG loss, so the resize step is skipped unless it actually shrinks
 * something.
 */
const PASSTHROUGH_EDITS: PageEdits = {
  quad: null,
  rotation: 0,
  filter: 'original',
  adjust: DEFAULT_ADJUSTMENTS,
  deskew: 0,
};

/** Thumbnails are a by-product of the render path; ask for the smallest one. */
const THROWAWAY_THUMB_EDGE = 32;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  txt: 'text/plain;charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv;charset=utf-8',
  zip: 'application/zip',
};

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportCancelled();
}

/** Linear interpolation inside one phase of the job. */
function span(from: number, to: number, fraction: number): number {
  const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  return from + (to - from) * clamped;
}

/**
 * A file-name stem for this document.
 *
 * Reuses the PDF exporter's sanitiser — it already strips path separators,
 * reserved device names and the characters Windows and macOS refuse — and then
 * takes the extension back off.
 */
export function fileStem(title: string): string {
  return suggestPdfName(title).replace(/\.pdf$/i, '');
}

function numbered(stem: string, index: number, total: number, extension: string): string {
  if (total === 1) return `${stem}.${extension}`;
  const width = String(total).length;
  return `${stem}-${String(index + 1).padStart(width, '0')}.${extension}`;
}

function toFile(blob: Blob, name: string, format: ExportFormat): File {
  return new File([blob], name, { type: MIME[format] });
}

function pluralPages(count: number): string {
  return count === 1 ? '1 page' : `${count} pages`;
}

/** Whether a format is assembled from the OCR layer rather than from pixels. */
function isTextFormat(format: ExportFormat): boolean {
  return EXPORT_FORMATS.some((entry) => entry.id === format && entry.textBased);
}

/** Whether this job has to read text off the pages before it can build anything. */
export function needsRecognition(format: ExportFormat, options: PdfExportOptions): boolean {
  return format === 'pdf' ? options.searchable : isTextFormat(format);
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

/**
 * Recognise the pages that need it, filling `into` as it goes.
 *
 * Results are persisted through `saveOcr` page by page, so an export that is
 * cancelled or that fails halfway still leaves the work it did behind — and
 * the caller's `page` snapshots are stale by then, which is why the fresh
 * layers are collected in a map as well. Filling a caller-owned map rather
 * than returning one is what lets a partial run still be used.
 */
async function recognizeMissing(
  job: ExportJob,
  targets: ExportPage[],
  from: number,
  to: number,
  into: Map<ID, OcrResult>,
): Promise<void> {
  for (let i = 0; i < targets.length; i++) {
    stop(job.signal);
    const { page } = targets[i];
    const blob = await getBlob(page.processedBlobId ?? page.originalBlobId);
    if (!blob) throw new Error('A page is missing its image, so its text could not be read.');
    const result = await recognizeImage(blob, job.ocrLanguage, (progress) => {
      job.onProgress({
        value: span(from, to, (i + progress.progress) / targets.length),
        message: `${progress.status} — page ${i + 1} of ${targets.length}`,
      });
    });
    stop(job.signal);
    into.set(page.id, result);
    await job.saveOcr(page.id, result);
    job.onProgress({
      value: span(from, to, (i + 1) / targets.length),
      message: `Read ${i + 1} of ${pluralPages(targets.length)}`,
    });
  }
}

interface RenderedPage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * The pixels each page contributes: annotations baked in by
 * `pageExportImage`, then downscaled and re-encoded when the quality preset
 * asks for something smaller than the stored render.
 */
async function renderPages(job: ExportJob, from: number, to: number): Promise<RenderedPage[]> {
  const total = job.pages.length;
  const maxEdge = MAX_EDGE[job.options.quality];
  const out: RenderedPage[] = [];

  for (let i = 0; i < total; i++) {
    stop(job.signal);
    job.onProgress({
      value: span(from, to, i / total),
      message: `Preparing page ${i + 1} of ${total}`,
    });

    const image = await pageExportImage(job.pages[i].page);
    if (!image) throw new Error(`Page ${i + 1} is missing its image, so it cannot be exported.`);

    const longest = Math.max(image.width, image.height);
    // A page whose render never completed falls back to the raw capture, which
    // may be in a format PDF cannot embed (WebP, HEIC). Re-encoding it is the
    // difference between a working export and a hard failure.
    const unusableFormat = image.blob.type !== 'image/jpeg' && image.blob.type !== 'image/png';

    if (unusableFormat || (maxEdge !== null && longest > maxEdge)) {
      // Goes through the CV client so the work happens in the worker rather
      // than on the thread that is drawing the progress bar.
      const scaled = await cv.render(image.blob, PASSTHROUGH_EDITS, {
        maxEdge: maxEdge ?? longest,
        thumbEdge: THROWAWAY_THUMB_EDGE,
        quality: JPEG_QUALITY[job.options.quality],
      });
      out.push({ blob: scaled.full, width: scaled.size.width, height: scaled.size.height });
    } else {
      out.push(image);
    }
  }

  job.onProgress({ value: to, message: 'Pages ready' });
  return out;
}

/** The OCR layer to use for a page: the one this run produced, else the stored one. */
function ocrFor(entry: ExportPage, fresh: Map<ID, OcrResult>): OcrResult | null {
  return fresh.get(entry.page.id) ?? entry.page.ocr;
}

function textPages(job: ExportJob, fresh: Map<ID, OcrResult>): TextExportPage[] {
  return job.pages.map((entry) => ({ index: entry.index, ocr: ocrFor(entry, fresh) }));
}

/* ------------------------------------------------------------------ */
/* Formats                                                             */
/* ------------------------------------------------------------------ */

async function buildPdfFiles(
  job: ExportJob,
  fresh: Map<ID, OcrResult>,
  from: number,
): Promise<ExportOutcome> {
  const imagesEnd = span(from, 1, 0.65);
  const images = await renderPages(job, from, imagesEnd);
  stop(job.signal);

  const inputs: PdfPageInput[] = images.map((image, i) => ({
    blob: image.blob,
    width: image.width,
    height: image.height,
    ocr: job.options.searchable ? ocrFor(job.pages[i], fresh) : null,
  }));

  // pdf-lib is ~500 KB, and most sessions never export a PDF, so the writer is
  // pulled in on demand rather than shipped in the initial bundle.
  const { buildPdf } = await import('@/lib/pdf/export');
  const blob = await buildPdf(inputs, job.options, (progress) => {
    const fraction = progress.stage === 'saving' || progress.stage === 'encrypting'
      ? 1
      : progress.page / progress.total;
    job.onProgress({
      value: span(imagesEnd, 1, fraction),
      message:
        progress.stage === 'encrypting'
          ? 'Encrypting the PDF'
          : progress.stage === 'saving'
            ? 'Writing the PDF'
            : `Adding page ${progress.page} of ${progress.total}`,
    });
  });
  stop(job.signal);

  return { files: [toFile(blob, suggestPdfName(job.title), 'pdf')], warning: null };
}

async function buildImageFiles(job: ExportJob, from: number): Promise<ExportOutcome> {
  const images = await renderPages(job, from, 1);
  const stem = fileStem(job.title);
  return {
    files: images.map((image, i) => toFile(image.blob, numbered(stem, i, images.length, 'jpg'), 'jpeg')),
    warning: null,
  };
}

async function buildZipFile(job: ExportJob, from: number): Promise<ExportOutcome> {
  const packingStart = span(from, 1, 0.9);
  const images = await renderPages(job, from, packingStart);
  stop(job.signal);
  job.onProgress({ value: packingStart, message: 'Packing the archive' });

  const stem = fileStem(job.title);
  const width = String(images.length).length;
  const entries: ZipEntry[] = images.map((image, i) => ({
    // Kept inside a folder so extracting does not scatter pages across the
    // user's downloads.
    name: `${stem}/page-${String(i + 1).padStart(width, '0')}.jpg`,
    data: image.blob,
  }));
  const blob = await createZip(entries);
  stop(job.signal);
  return { files: [toFile(blob, `${stem}.zip`, 'zip')], warning: null };
}

function noTextWarning(pages: TextExportPage[]): string | null {
  return pages.every((page) => (page.ocr?.text ?? '').trim() === '')
    ? 'No text could be read from these pages, so the file is nearly empty.'
    : null;
}

async function buildTextFile(
  job: ExportJob,
  fresh: Map<ID, OcrResult>,
  format: 'txt' | 'docx',
): Promise<ExportOutcome> {
  const pages = textPages(job, fresh);
  job.onProgress({ value: 0.95, message: format === 'txt' ? 'Writing the text file' : 'Writing the Word file' });
  const stem = fileStem(job.title);
  const blob =
    format === 'txt'
      ? buildTxtBlob(documentToText(pages, job.title))
      : await buildDocxBlob(job.title, pages);
  return { files: [toFile(blob, `${stem}.${format}`, format)], warning: noTextWarning(pages) };
}

/** Confidence below which the recovered columns are more guess than structure. */
const WEAK_TABLE = 0.35;

async function buildCsvFile(job: ExportJob, fresh: Map<ID, OcrResult>): Promise<ExportOutcome> {
  job.onProgress({ value: 0.95, message: 'Looking for tables' });

  const rows: string[][] = [];
  let best = 0;
  for (const entry of job.pages) {
    const ocr = ocrFor(entry, fresh);
    if (!ocr) continue;
    // One table per page, stacked: a table that runs over a page break is far
    // more common in a scan than two unrelated tables in one document.
    const table = linesToTable(ocr.lines);
    if (table.rows.length === 0) continue;
    best = Math.max(best, table.confidence);
    rows.push(...table.rows);
  }

  if (rows.length === 0) {
    throw new Error('No text was found on these pages, so there is nothing to put in a spreadsheet.');
  }

  const blob = buildCsvBlob(tableToCsv({ rows, confidence: best }));
  return {
    files: [toFile(blob, `${fileStem(job.title)}.csv`, 'csv')],
    warning:
      best < WEAK_TABLE
        ? 'These pages did not look much like a table, so the columns may need tidying up.'
        : null,
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run an export end to end.
 *
 * @returns The finished files, ready to share or download, plus any caveat
 * worth telling the user about.
 * @throws {ExportCancelled} when `job.signal` aborts — check with
 * `isCancellation` before reporting a failure.
 * @throws An `Error` whose message can be shown as-is for anything else.
 */
export async function runExport(job: ExportJob): Promise<ExportOutcome> {
  stop(job.signal);
  if (job.pages.length === 0) throw new Error('There are no pages to export.');

  const wantsText = needsRecognition(job.format, job.options);
  const targets = wantsText ? job.pages.filter((entry) => entry.page.ocr === null) : [];

  // Recognition dominates the wall clock whenever it runs, so it gets most of
  // the bar; without it the whole bar belongs to building the file.
  const ocrEnd = targets.length === 0 ? 0 : isTextFormat(job.format) ? 0.9 : 0.6;

  job.onProgress({ value: 0, message: 'Getting ready' });

  const fresh = new Map<ID, OcrResult>();
  let caveat: string | null = null;
  if (targets.length > 0) {
    try {
      await recognizeMissing(job, targets, 0, ocrEnd, fresh);
    } catch (error) {
      // A text export has nothing left to produce, but a PDF without its
      // searchable layer is still the document the user asked for — losing it
      // to a missing network would be the wrong trade.
      if (isCancellation(error) || isTextFormat(job.format)) throw error;
      const reason = error instanceof Error ? error.message : 'The text could not be read.';
      caveat = `${reason} The PDF was made without a searchable text layer.`;
    }
  }
  stop(job.signal);

  const outcome = await buildOutcome(job, fresh, ocrEnd);
  if (caveat === null) return outcome;
  return { ...outcome, warning: outcome.warning === null ? caveat : `${caveat} ${outcome.warning}` };
}

function buildOutcome(
  job: ExportJob,
  fresh: Map<ID, OcrResult>,
  ocrEnd: number,
): Promise<ExportOutcome> {
  switch (job.format) {
    case 'pdf':
      return buildPdfFiles(job, fresh, ocrEnd);
    case 'jpeg':
      return buildImageFiles(job, ocrEnd);
    case 'zip':
      return buildZipFile(job, ocrEnd);
    case 'txt':
    case 'docx':
      return buildTextFile(job, fresh, job.format);
    case 'csv':
      return buildCsvFile(job, fresh);
  }
}
