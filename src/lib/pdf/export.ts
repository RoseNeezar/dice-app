import {
  PDFDocument,
  StandardFonts,
  TextRenderingMode,
  beginText,
  degrees,
  endText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
} from 'pdf-lib';
import type { PDFFont, PDFHexString, PDFImage, PDFName, PDFOperator, PDFPage, RGB } from 'pdf-lib';
import type { OcrLine, OcrResult, PdfExportOptions, Size, WatermarkOptions } from '@/types';
import { fitRect, marginPoints, resolvePageSize, type PageDimensions } from './pageSizes';
import { encryptPdf } from './encrypt';

/**
 * PDF assembly.
 *
 * Takes already-rendered page images (the render pipeline has applied the
 * filter, the annotations and the export quality by the time they get here) and
 * lays them out into a PDF: page boxes and margins from `pageSizes`, an
 * invisible OCR text layer so the file is searchable, an optional watermark,
 * document metadata, and optional RC4 encryption.
 */

/** One page's worth of input: a rendered image plus the OCR that goes with it. */
export interface PdfPageInput {
  blob: Blob;
  width: number;
  height: number;
  ocr: OcrResult | null;
}

/** Progress for the export UI. `page` is 1-based. */
export interface PdfProgress {
  page: number;
  total: number;
  stage: 'embedding' | 'text' | 'encrypting' | 'saving';
}

/** Yield to the event loop after this many pages so the UI can repaint. */
const YIELD_EVERY = 4;

/** Pages are pushed as operator batches; a spread this size is safe everywhere. */
const OPERATOR_CHUNK = 1024;

/** Font size bounds for the invisible OCR layer, in points. */
const MIN_TEXT_SIZE = 0.25;
/** An OCR line never needs a font taller than this multiple of its own box. */
const MAX_TEXT_SIZE_RATIO = 2.5;
/** Horizontal glyph scaling (Tz) bounds, in percent. */
const MIN_SQUEEZE = 10;
const MAX_SQUEEZE = 1000;

/** Upper bound on tiled watermark repetitions, so a tiny font cannot explode the file. */
const MAX_WATERMARK_TILES = 200;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ */
/* Text sanitising                                                     */
/* ------------------------------------------------------------------ */

/**
 * The code points WinAnsiEncoding adds on top of Latin-1, in 0x80–0x9F: the
 * curly quotes, dashes and symbols OCR output is full of.
 */
const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

function isWinAnsi(codePoint: number): boolean {
  return (
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa0 && codePoint <= 0xff) ||
    WIN_ANSI_EXTRAS.has(codePoint)
  );
}

/**
 * Reduce text to what the standard Helvetica font can actually encode.
 *
 * The 14 standard fonts are WinAnsi-only, so a Greek or CJK code point would
 * throw during encoding and take the whole export down with it. Characters that
 * merely carry a diacritic outside WinAnsi (ā, ş, ż) are folded to their base
 * letter, which keeps the text layer searchable; anything with no Latin
 * equivalent is dropped rather than replaced, so search never matches on a
 * substitute character that was not in the document.
 *
 * @param input Raw OCR or watermark text.
 * @returns A single-line, WinAnsi-safe string; empty when nothing survives.
 */
export function sanitizePdfText(input: string): string {
  let out = '';
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
      out += ' ';
      continue;
    }
    if (isWinAnsi(codePoint)) {
      out += char;
      continue;
    }
    for (const folded of char.normalize('NFKD').replace(/\p{M}/gu, '')) {
      const foldedPoint = folded.codePointAt(0);
      if (foldedPoint !== undefined && isWinAnsi(foldedPoint)) out += folded;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Width of `text`, or 0 if the font rejects it. Never throws. */
function safeWidth(font: PDFFont, text: string, size: number): number {
  try {
    const width = font.widthOfTextAtSize(text, size);
    return Number.isFinite(width) ? width : 0;
  } catch {
    return 0;
  }
}

/**
 * Encoded glyph codes for `text`, or null if the font rejects it.
 *
 * `sanitizePdfText` should already have removed anything unencodable; this is
 * the backstop that keeps one surprising glyph from failing a 200-page export.
 */
function safeEncode(font: PDFFont, text: string): PDFHexString | null {
  try {
    return font.encodeText(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/**
 * Embed one page image, choosing the embedder from the file's magic bytes.
 *
 * The MIME type on a Blob is whatever produced it claimed, and a mismatch here
 * corrupts the whole document, so the bytes decide.
 */
async function embedImage(doc: PDFDocument, blob: Blob, pageNumber: number): Promise<PDFImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const isJpeg = startsWith(bytes, JPEG_MAGIC);
  if (!isJpeg && !startsWith(bytes, PNG_MAGIC)) {
    throw new Error(`Page ${pageNumber} is not a JPEG or PNG image, so it cannot be saved as PDF.`);
  }
  try {
    return isJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  } catch (cause) {
    throw new Error(`Page ${pageNumber} could not be added to the PDF — its image data is damaged.`, {
      cause,
    });
  }
}

/**
 * Wrap serialised bytes in a PDF blob.
 *
 * pdf-lib types its output as `Uint8Array<ArrayBufferLike>`, which TypeScript
 * refuses as a `BlobPart` because the backing store could in principle be
 * shared memory. Copying into a plain `ArrayBuffer` keeps that honest without
 * an assertion.
 */
function toPdfBlob(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: 'application/pdf' });
}

function pushOperators(page: PDFPage, operators: PDFOperator[]): void {
  for (let i = 0; i < operators.length; i += OPERATOR_CHUNK) {
    page.pushOperators(...operators.slice(i, i + OPERATOR_CHUNK));
  }
}

/* ------------------------------------------------------------------ */
/* Searchable text layer                                               */
/* ------------------------------------------------------------------ */

/**
 * Operators that place one OCR line as invisible text over the drawn image.
 *
 * The font size is derived from the line's own box width so a selection drag
 * lands on the words the user can see; when a degenerate box would demand an
 * absurd size, the size is clamped and the horizontal glyph scale (Tz) takes up
 * the slack, keeping the line the right width either way.
 */
function ocrLineOperators(
  font: PDFFont,
  fontKey: PDFName,
  line: OcrLine,
  image: Rect,
): PDFOperator[] | null {
  const text = sanitizePdfText(line.text);
  if (text.length === 0) return null;

  const boxWidth = line.width * image.width;
  const boxHeight = line.height * image.height;
  if (!(boxWidth > 0) || !(boxHeight > 0)) return null;

  const unitWidth = safeWidth(font, text, 1);
  if (unitWidth <= 0) return null;

  const size = clamp(boxWidth / unitWidth, MIN_TEXT_SIZE, boxHeight * MAX_TEXT_SIZE_RATIO);
  const drawnWidth = safeWidth(font, text, size);
  const squeeze =
    drawnWidth > 0 ? clamp((boxWidth / drawnWidth) * 100, MIN_SQUEEZE, MAX_SQUEEZE) : 100;

  // OCR boxes are top-down and normalized; PDF user space is bottom-up.
  const left = image.x + line.x * image.width;
  const bottom = image.y + image.height - (line.y + line.height) * image.height;
  // OCR line boxes include descenders, so lift the baseline off the box floor
  // by the font's own descent rather than guessing.
  const descent = Math.max(
    0,
    font.heightAtSize(size) - font.heightAtSize(size, { descender: false }),
  );
  const baseline = bottom + Math.min(descent, boxHeight / 2);

  const encoded = safeEncode(font, text);
  if (!encoded) return null;

  return [
    beginText(),
    setTextRenderingMode(TextRenderingMode.Invisible),
    setFontAndSize(fontKey, size),
    setCharacterSqueeze(squeeze),
    setTextMatrix(1, 0, 0, 1, left, baseline),
    showText(encoded),
    endText(),
  ];
}

function drawOcrLayer(
  page: PDFPage,
  font: PDFFont,
  fontKey: PDFName,
  ocr: OcrResult,
  image: Rect,
): void {
  const lines: PDFOperator[] = [];
  for (const line of ocr.lines) {
    const operators = ocrLineOperators(font, fontKey, line, image);
    if (operators) lines.push(...operators);
  }
  if (lines.length === 0) return;
  // q/Q brackets the layer so the invisible rendering mode and glyph scaling
  // cannot leak into anything drawn afterwards, such as the watermark.
  pushOperators(page, [pushGraphicsState(), ...lines, popGraphicsState()]);
}

/* ------------------------------------------------------------------ */
/* Watermark                                                           */
/* ------------------------------------------------------------------ */

/** Parse a CSS hex or rgb() colour into a PDF colour; falls back to mid grey. */
function parseColor(css: string): RGB {
  const value = css.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex) {
    const digits = hex[1];
    const six =
      digits.length === 3 || digits.length === 4
        ? [...digits.slice(0, 3)].map((digit) => digit + digit).join('')
        : digits.slice(0, 6);
    // A 5- or 7-digit hex is not a colour; fall through to the grey default.
    if (six.length === 6) {
      const packed = Number.parseInt(six, 16);
      return rgb(((packed >> 16) & 0xff) / 255, ((packed >> 8) & 0xff) / 255, (packed & 0xff) / 255);
    }
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (fn) {
    const parts = fn[1]
      .split(/[\s,/]+/)
      .filter((part) => part.length > 0)
      .slice(0, 3)
      .map((part) =>
        part.endsWith('%') ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part),
      );
    if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
      return rgb(
        clamp(parts[0] / 255, 0, 1),
        clamp(parts[1] / 255, 0, 1),
        clamp(parts[2] / 255, 0, 1),
      );
    }
  }
  return rgb(0.5, 0.5, 0.5);
}

/**
 * Grid of centre points for a tiled watermark, spaced by the rotated bounding
 * box of the text so neighbouring marks do not collide.
 */
function tileCentres(
  page: PageDimensions,
  width: number,
  height: number,
  cos: number,
  sin: number,
): { x: number; y: number }[] {
  const spanX = Math.abs(width * cos) + Math.abs(height * sin);
  const spanY = Math.abs(width * sin) + Math.abs(height * cos);
  let stepX = Math.max(8, spanX * 1.6);
  let stepY = Math.max(8, spanY * 2.2);
  let columns = Math.ceil(page.width / stepX) + 1;
  let rows = Math.ceil(page.height / stepY) + 1;
  if (columns * rows > MAX_WATERMARK_TILES) {
    const relax = Math.sqrt((columns * rows) / MAX_WATERMARK_TILES);
    stepX *= relax;
    stepY *= relax;
    columns = Math.ceil(page.width / stepX) + 1;
    rows = Math.ceil(page.height / stepY) + 1;
  }
  const originX = page.width / 2 - ((columns - 1) * stepX) / 2;
  const originY = page.height / 2 - ((rows - 1) * stepY) / 2;
  const centres: { x: number; y: number }[] = [];
  for (let row = 0; row < rows && centres.length < MAX_WATERMARK_TILES; row++) {
    for (let column = 0; column < columns && centres.length < MAX_WATERMARK_TILES; column++) {
      centres.push({ x: originX + column * stepX, y: originY + row * stepY });
    }
  }
  return centres;
}

function drawWatermark(
  page: PDFPage,
  font: PDFFont,
  watermark: WatermarkOptions,
  dimensions: PageDimensions,
): void {
  const text = sanitizePdfText(watermark.text);
  if (text.length === 0) return;

  const size = clamp(watermark.fontScale * dimensions.height, 4, dimensions.height);
  const width = safeWidth(font, text, size);
  if (width <= 0) return;
  const ascent = font.heightAtSize(size, { descender: false });
  const angle = ((watermark.angle % 360) + 360) % 360;
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const color = parseColor(watermark.color);
  const opacity = clamp(watermark.opacity, 0, 1);

  const centres = watermark.tile
    ? tileCentres(dimensions, width, ascent, cos, sin)
    : [{ x: dimensions.width / 2, y: dimensions.height / 2 }];

  for (const centre of centres) {
    // pdf-lib draws from the text origin (left end of the baseline) and rotates
    // about it, so shift back along the baseline and down the ascent to land
    // the visual centre of the glyphs on `centre`.
    page.drawText(text, {
      x: centre.x - (width / 2) * cos + (ascent / 2) * sin,
      y: centre.y - (width / 2) * sin - (ascent / 2) * cos,
      size,
      font,
      color,
      opacity,
      rotate: degrees(angle),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function applyMetadata(doc: PDFDocument, options: PdfExportOptions): void {
  const now = new Date();
  const title = options.title.trim();
  const author = options.author.trim();
  doc.setTitle(title.length > 0 ? title : 'Scan');
  doc.setAuthor(author.length > 0 ? author : 'OpenScan');
  doc.setCreator('OpenScan');
  doc.setProducer('OpenScan');
  doc.setCreationDate(now);
  doc.setModificationDate(now);
}

/** Prefer the embedder's own dimensions; fall back to what the caller declared. */
function imageSize(image: PDFImage, declared: Size): Size {
  const width = image.width > 0 ? image.width : declared.width;
  const height = image.height > 0 ? image.height : declared.height;
  return { width, height };
}

/**
 * Build a PDF from rendered page images.
 *
 * Runs cooperatively: the loop yields to the event loop every few pages and
 * pdf-lib's writer yields while serialising, so a 200-page export never blocks
 * the main thread.
 *
 * `options.quality` is not read here — it governs how the page images were
 * encoded upstream, and re-encoding them would need a canvas this module
 * deliberately does not depend on.
 *
 * @param pages Rendered pages in document order. Must not be empty.
 * @param options Page size, margins, OCR layer, watermark, metadata, password.
 * @param onProgress Called at least once per page so the UI can show a bar.
 * @returns An `application/pdf` blob.
 * @throws If there are no pages, or a page image is not a decodable JPEG/PNG.
 */
export async function buildPdf(
  pages: PdfPageInput[],
  options: PdfExportOptions,
  onProgress?: (progress: PdfProgress) => void,
): Promise<Blob> {
  const total = pages.length;
  if (total === 0) throw new Error('There are no pages to export.');

  const password = options.password !== null && options.password.length > 0 ? options.password : null;
  const wantsOcrLayer = options.searchable && pages.some((page) => page.ocr !== null);
  const watermark =
    options.watermark && sanitizePdfText(options.watermark.text).length > 0
      ? options.watermark
      : null;

  const doc = await PDFDocument.create();
  applyMetadata(doc, options);
  const font = wantsOcrLayer || watermark ? await doc.embedFont(StandardFonts.Helvetica) : null;

  for (let index = 0; index < total; index++) {
    const input = pages[index];
    const pageNumber = index + 1;
    onProgress?.({ page: pageNumber, total, stage: 'embedding' });

    const image = await embedImage(doc, input.blob, pageNumber);
    const size = imageSize(image, { width: input.width, height: input.height });
    const dimensions = resolvePageSize(options.pageSize, options.orientation, size);
    const margin = marginPoints(options.margin, dimensions);
    const box = fitRect(size, {
      width: dimensions.width - margin * 2,
      height: dimensions.height - margin * 2,
    });
    const rect: Rect = {
      x: margin + box.x,
      y: margin + box.y,
      width: box.width,
      height: box.height,
    };

    const page = doc.addPage([dimensions.width, dimensions.height]);
    page.drawImage(image, rect);

    if (font) {
      const fontKey = page.node.newFontDictionary(font.name, font.ref);
      if (options.searchable && input.ocr) {
        onProgress?.({ page: pageNumber, total, stage: 'text' });
        drawOcrLayer(page, font, fontKey, input.ocr, rect);
      }
      if (watermark) drawWatermark(page, font, watermark, dimensions);
    }

    if (pageNumber % YIELD_EVERY === 0 && pageNumber < total) await yieldToEventLoop();
  }

  onProgress?.({ page: total, total, stage: 'saving' });
  let bytes = await doc.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    // Encryption rewrites every object anyway; plain objects keep that pass
    // simple and avoid a needless decompress/recompress round trip.
    useObjectStreams: password === null,
  });

  if (password !== null) {
    onProgress?.({ page: total, total, stage: 'encrypting' });
    bytes = await encryptPdf(bytes, password);
  }

  return toPdfBlob(bytes);
}


/**
 * Turn a document title into a safe download filename ending in `.pdf`.
 *
 * Lives in `./naming` so callers that only need a filename do not pull the PDF
 * writer into their bundle; re-exported here for the callers that need both.
 */
export { suggestPdfName } from './naming';
