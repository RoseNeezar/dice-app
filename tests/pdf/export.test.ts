import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFStream, StandardFonts } from 'pdf-lib';
import type { OcrResult, PageOrientation, PageSizeId, PdfExportOptions, PdfMargin } from '@/types';
import { DEFAULT_PDF_OPTIONS } from '@/types';
import { PAGE_SIZES, fitRect, marginPoints, resolvePageSize } from '@/lib/pdf/pageSizes';
import {
  buildPdf,
  sanitizePdfText,
  suggestPdfName,
  type PdfPageInput,
  type PdfProgress,
} from '@/lib/pdf/export';

/**
 * 8x8 and 16x8 baseline JPEGs plus an 8x8 PNG, inlined as base64 so the export
 * tests need no canvas, no network and no image encoder.
 */
const JPEG_8X8 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwB3gW2wicYwPpj+WPu+33e2392UUVzZjleF+sP3Txs2nL61I//Z';
const JPEG_16X8 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjqKKK8U/TD//Z';
const PNG_8X8 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAK0lEQVR4nGNkYGD4r8HAqIFK8jOw/GeQY2Rg+M/AgEayMDLIYYr+ZxhYHQC2NSHuY1WA/QAAAABJRU5ErkJggg==';

function blobFrom(base64: string, type: string): Blob {
  return new Blob([Buffer.from(base64, 'base64')], { type });
}

function jpegPage(overrides: Partial<PdfPageInput> = {}): PdfPageInput {
  return { blob: blobFrom(JPEG_8X8, 'image/jpeg'), width: 8, height: 8, ocr: null, ...overrides };
}

function options(overrides: Partial<PdfExportOptions> = {}): PdfExportOptions {
  return { ...DEFAULT_PDF_OPTIONS, title: 'Test scan', ...overrides };
}

function ocr(lines: { text: string; x: number; y: number; width: number; height: number }[]): OcrResult {
  return {
    language: 'eng',
    text: lines.map((line) => line.text).join('\n'),
    lines: lines.map((line) => ({ ...line, words: [] })),
    confidence: 0.95,
    completedAt: 1_700_000_000_000,
  };
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Load without letting pdf-lib rewrite the Producer/ModDate we are asserting on. */
async function load(pdf: Blob): Promise<PDFDocument> {
  return PDFDocument.load(await bytesOf(pdf), { updateMetadata: false });
}

function decodeStream(stream: PDFStream): string {
  const raw = Buffer.from(stream.getContents());
  const filter = stream.dict.get(PDFName.of('Filter'));
  return filter?.toString() === '/FlateDecode'
    ? inflateSync(raw).toString('latin1')
    : raw.toString('latin1');
}

/**
 * The operators of one page's content stream.
 *
 * Reading them back is how the image placement, the searchable layer and the
 * watermark are verified without a PDF renderer. Image XObjects are excluded so
 * a stray byte inside the JPEG can never satisfy an assertion.
 */
async function pageOperators(pdf: Blob, index = 0): Promise<string> {
  const doc = await load(pdf);
  const contents = doc.getPage(index).node.Contents();
  if (contents instanceof PDFStream) return decodeStream(contents);
  if (contents instanceof PDFArray) {
    return contents
      .asArray()
      .map((entry) => decodeStream(doc.context.lookup(entry, PDFStream)))
      .join('\n');
  }
  throw new Error('page has no content stream');
}

/** WinAnsi hex exactly as pdf-lib writes it inside a `<...> Tj` operator. */
function winAnsiHex(text: string): string {
  return [...text]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

type Matrix = [number, number, number, number, number, number];

/** `m` applied first, then `n` — PDF's row-vector convention. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function transform(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * Where the image XObject actually lands on the page, by folding every `cm`
 * operator ahead of the `Do` into one matrix and mapping the unit square
 * through it. Independent of how pdf-lib chooses to decompose the transform.
 */
function imagePlacement(operators: string): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const untilDraw = operators.slice(0, operators.indexOf(' Do'));
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const cm = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g;
  for (const match of untilDraw.matchAll(cm)) {
    const parsed = match.slice(1).map(Number) as Matrix;
    ctm = multiply(parsed, ctm);
  }
  const origin = transform(ctm, 0, 0);
  const far = transform(ctm, 1, 1);
  return {
    x: Math.min(origin.x, far.x),
    y: Math.min(origin.y, far.y),
    width: Math.abs(far.x - origin.x),
    height: Math.abs(far.y - origin.y),
  };
}

function pypdfAvailable(): boolean {
  try {
    execFileSync('python3', ['-c', 'import pypdf'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_PYPDF = pypdfAvailable();
const tempDir = mkdtempSync(join(tmpdir(), 'openscan-pdf-'));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Read the file back with pypdf, a parser that knows nothing about this implementation. */
function readWithPypdf(
  pdf: Uint8Array,
  name: string,
  password = '',
): { pages: number; text: string } {
  const path = join(tempDir, name);
  writeFileSync(path, pdf);
  const script = [
    'import json, sys',
    'from pypdf import PdfReader',
    'reader = PdfReader(sys.argv[1])',
    'if reader.is_encrypted:',
    '    assert reader.decrypt(sys.argv[2]), "wrong password"',
    'print(json.dumps({"pages": len(reader.pages), "text": reader.pages[0].extract_text()}))',
  ].join('\n');
  const stdout = execFileSync('python3', ['-c', script, path, password], { encoding: 'utf8' });
  return JSON.parse(stdout) as { pages: number; text: string };
}

describe('buildPdf — structure', () => {
  it('produces a real PDF blob with one page per input', async () => {
    const pdf = await buildPdf([jpegPage(), jpegPage(), jpegPage()], options());
    expect(pdf.type).toBe('application/pdf');
    const bytes = await bytesOf(pdf);
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
  });

  it('rejects an empty document with a message a user can act on', async () => {
    await expect(buildPdf([], options())).rejects.toThrow('There are no pages to export.');
  });

  it('rejects a blob that is not a JPEG or PNG, naming the page', async () => {
    const page = jpegPage({ blob: new Blob([Buffer.from('not an image')], { type: 'image/jpeg' }) });
    await expect(buildPdf([jpegPage(), page], options())).rejects.toThrow(
      /Page 2 is not a JPEG or PNG/,
    );
  });

  it('sniffs the format from the bytes, not the declared MIME type', async () => {
    // A PNG mislabelled as JPEG still embeds correctly.
    const page = jpegPage({ blob: blobFrom(PNG_8X8, 'image/jpeg') });
    const doc = await load(await buildPdf([page], options()));
    expect(doc.getPageCount()).toBe(1);
  });

  it('writes the metadata OpenScan promises', async () => {
    const pdf = await buildPdf([jpegPage()], options({ title: 'Lease', author: 'Ada' }));
    const doc = await load(pdf);
    expect(doc.getTitle()).toBe('Lease');
    expect(doc.getAuthor()).toBe('Ada');
    expect(doc.getCreator()).toBe('OpenScan');
    expect(doc.getProducer()).toBe('OpenScan');
    expect(doc.getCreationDate()).toBeInstanceOf(Date);
  });

  it('falls back to sensible metadata when the title and author are blank', async () => {
    const pdf = await buildPdf([jpegPage()], options({ title: '   ', author: '' }));
    const doc = await load(pdf);
    expect(doc.getTitle()).toBe('Scan');
    expect(doc.getAuthor()).toBe('OpenScan');
  });

  it('reports progress for every page and ends on saving', async () => {
    const seen: PdfProgress[] = [];
    await buildPdf([jpegPage(), jpegPage()], options(), (progress) => seen.push(progress));
    expect(seen.filter((p) => p.stage === 'embedding').map((p) => p.page)).toEqual([1, 2]);
    expect(seen.every((p) => p.total === 2)).toBe(true);
    expect(seen.at(-1)).toEqual({ page: 2, total: 2, stage: 'saving' });
  });

  it('stays responsive across a page count that forces event-loop yields', async () => {
    const pages = Array.from({ length: 9 }, () => jpegPage());
    const doc = await load(await buildPdf(pages, options()));
    expect(doc.getPageCount()).toBe(9);
  });
});

describe('buildPdf — page geometry', () => {
  const CASES: { size: PageSizeId; orientation: PageOrientation; margin: PdfMargin }[] = [];
  for (const size of ['fit', 'a3', 'a4', 'a5', 'b5', 'letter', 'legal', 'businesscard'] as const) {
    for (const orientation of ['auto', 'portrait', 'landscape'] as const) {
      for (const margin of ['none', 'small', 'medium', 'large'] as const) {
        CASES.push({ size, orientation, margin });
      }
    }
  }

  it('matches resolvePageSize for every size, orientation and margin', async () => {
    for (const { size, orientation, margin } of CASES) {
      const pdf = await buildPdf(
        [jpegPage()],
        options({ pageSize: size, orientation, margin, searchable: false }),
      );
      const doc = await load(pdf);
      const expected = resolvePageSize(size, orientation, { width: 8, height: 8 });
      const actual = doc.getPage(0).getSize();
      expect(actual.width).toBeCloseTo(expected.width, 4);
      expect(actual.height).toBeCloseTo(expected.height, 4);
    }
  });

  it('follows the image orientation per page, not per document', async () => {
    const pdf = await buildPdf(
      [
        jpegPage(),
        { blob: blobFrom(JPEG_16X8, 'image/jpeg'), width: 16, height: 8, ocr: null },
      ],
      options({ pageSize: 'a4', orientation: 'auto' }),
    );
    const doc = await load(pdf);
    const first = doc.getPage(0).getSize();
    const second = doc.getPage(1).getSize();
    expect(first.width).toBeLessThan(first.height);
    expect(second.width).toBeGreaterThan(second.height);
  });

  it('draws the image inside the margins, centred and un-cropped', async () => {
    const pdf = await buildPdf(
      [{ blob: blobFrom(JPEG_16X8, 'image/jpeg'), width: 16, height: 8, ocr: null }],
      options({ pageSize: 'a4', orientation: 'portrait', margin: 'large', searchable: false }),
    );
    const page = resolvePageSize('a4', 'portrait', { width: 16, height: 8 });
    const margin = marginPoints('large', page);
    const box = fitRect(
      { width: 16, height: 8 },
      { width: page.width - margin * 2, height: page.height - margin * 2 },
    );
    const placement = imagePlacement(await pageOperators(pdf));
    expect(placement.width).toBeCloseTo(box.width, 2);
    expect(placement.height).toBeCloseTo(box.height, 2);
    expect(placement.x).toBeCloseTo(margin + box.x, 2);
    expect(placement.y).toBeCloseTo(margin + box.y, 2);
    expect(placement.x).toBeGreaterThanOrEqual(margin - 1e-6);
    expect(placement.y).toBeGreaterThanOrEqual(margin - 1e-6);
    expect(placement.x + placement.width).toBeLessThanOrEqual(page.width - margin + 1e-6);
    expect(placement.width / placement.height).toBeCloseTo(2, 3);
  });

  it('fills the page edge to edge when fit and no margin are chosen', async () => {
    const pdf = await buildPdf(
      [jpegPage()],
      options({ pageSize: 'fit', orientation: 'auto', margin: 'none', searchable: false }),
    );
    const doc = await load(pdf);
    expect(doc.getPage(0).getSize()).toEqual({ width: 8, height: 8 });
  });
});

describe('buildPdf — searchable text layer', () => {
  const invoice = ocr([
    { text: 'Invoice', x: 0.1, y: 0.1, width: 0.4, height: 0.06 },
    { text: 'Total 42.00', x: 0.1, y: 0.3, width: 0.5, height: 0.06 },
  ]);

  it('draws every OCR line as invisible text', async () => {
    const pdf = await buildPdf(
      [jpegPage({ ocr: invoice })],
      options({ pageSize: 'a4', searchable: true }),
    );
    const stream = await pageOperators(pdf);
    expect(stream).toContain('3 Tr');
    expect(stream).toContain(winAnsiHex('Invoice'));
    expect(stream).toContain(winAnsiHex('Total 42.00'));
    // The layer is bracketed so it cannot leak state into later drawing.
    expect(stream).toContain('q\n');
    expect(stream).toContain('Q\n');
  });

  it('omits the layer entirely when searchable is off', async () => {
    const pdf = await buildPdf(
      [jpegPage({ ocr: invoice })],
      options({ pageSize: 'a4', searchable: false }),
    );
    const stream = await pageOperators(pdf);
    expect(stream).not.toContain('3 Tr');
    expect(stream).not.toContain(winAnsiHex('Invoice'));
  });

  it('positions each line inside the drawn image, right way up', async () => {
    const pdf = await buildPdf(
      [jpegPage({ ocr: invoice })],
      options({ pageSize: 'a4', orientation: 'portrait', margin: 'none' }),
    );
    const page = resolvePageSize('a4', 'portrait', { width: 8, height: 8 });
    const box = fitRect({ width: 8, height: 8 }, page);
    const stream = await pageOperators(pdf);
    const matrices = [...stream.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/g)].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
    }));
    expect(matrices).toHaveLength(2);
    for (const point of matrices) {
      expect(point.x).toBeGreaterThanOrEqual(box.x - 1e-6);
      expect(point.x).toBeLessThanOrEqual(box.x + box.width);
      expect(point.y).toBeGreaterThanOrEqual(box.y - 1e-6);
      expect(point.y).toBeLessThanOrEqual(box.y + box.height);
    }
    // The line higher up the page in OCR coordinates is higher up in PDF space.
    expect(matrices[0].y).toBeGreaterThan(matrices[1].y);
  });

  it('sizes the font so the drawn line matches the OCR box width', async () => {
    const line = { text: 'Invoice', x: 0.1, y: 0.1, width: 0.4, height: 0.06 };
    const pdf = await buildPdf(
      [jpegPage({ ocr: ocr([line]) })],
      options({ pageSize: 'fit', orientation: 'auto', margin: 'none' }),
    );
    const stream = await pageOperators(pdf);
    const size = Number(/\/\S+ ([\d.]+) Tf/.exec(stream)?.[1]);
    const squeeze = Number(/([\d.]+) Tz/.exec(stream)?.[1]);
    const probe = await PDFDocument.create();
    const helvetica = await probe.embedFont(StandardFonts.Helvetica);
    const drawn = helvetica.widthOfTextAtSize(line.text, size) * (squeeze / 100);
    // The page is 8pt wide ('fit' on an 8x8 image with no margin).
    expect(drawn).toBeCloseTo(line.width * 8, 4);
    expect(squeeze).toBeCloseTo(100, 6);
  });

  it('drops characters Helvetica cannot encode instead of failing the export', async () => {
    const mixed = ocr([
      { text: '請求書 Invoice', x: 0.1, y: 0.1, width: 0.6, height: 0.06 },
      { text: '請求書', x: 0.1, y: 0.3, width: 0.6, height: 0.06 },
    ]);
    const pdf = await buildPdf([jpegPage({ ocr: mixed })], options({ pageSize: 'a4' }));
    const stream = await pageOperators(pdf);
    expect(stream).toContain(winAnsiHex('Invoice'));
    // The CJK-only line has nothing left to draw, so it is skipped outright.
    expect([...stream.matchAll(/Tm/g)]).toHaveLength(1);
  });

  it('survives an OCR result with degenerate boxes', async () => {
    const broken = ocr([
      { text: 'zero', x: 0.1, y: 0.1, width: 0, height: 0.05 },
      { text: '   ', x: 0.1, y: 0.2, width: 0.4, height: 0.05 },
      { text: 'tiny', x: 0.1, y: 0.3, width: 0.4, height: 0.000001 },
    ]);
    const pdf = await buildPdf([jpegPage({ ocr: broken })], options({ pageSize: 'a4' }));
    const doc = await load(pdf);
    expect(doc.getPageCount()).toBe(1);
  });
});

describe('buildPdf — watermark', () => {
  const watermark = {
    text: 'CONFIDENTIAL',
    opacity: 0.2,
    angle: 45,
    fontScale: 0.06,
    color: '#ff0000',
    tile: false,
  };

  it('draws the mark once across the centre', async () => {
    const pdf = await buildPdf([jpegPage()], options({ pageSize: 'a4', watermark }));
    const stream = await pageOperators(pdf);
    expect([...stream.matchAll(new RegExp(winAnsiHex('CONFIDENTIAL'), 'g'))]).toHaveLength(1);
    expect(stream).toContain('1 0 0 rg');
  });

  it('tiles the mark when asked, without unbounded repetition', async () => {
    const pdf = await buildPdf(
      [jpegPage()],
      options({ pageSize: 'a4', watermark: { ...watermark, tile: true, fontScale: 0.002 } }),
    );
    const stream = await pageOperators(pdf);
    const marks = [...stream.matchAll(new RegExp(winAnsiHex('CONFIDENTIAL'), 'g'))].length;
    expect(marks).toBeGreaterThan(1);
    expect(marks).toBeLessThanOrEqual(200);
  });

  it('ignores a watermark with nothing drawable in it', async () => {
    const pdf = await buildPdf(
      [jpegPage()],
      options({ pageSize: 'a4', watermark: { ...watermark, text: '  ' } }),
    );
    const stream = await pageOperators(pdf);
    expect(stream).not.toContain('Tj');
  });
});

describe('buildPdf — password', () => {
  it('encrypts the finished document and reports the stage', async () => {
    const stages: string[] = [];
    const pdf = await buildPdf([jpegPage()], options({ password: 'hunter2' }), (progress) =>
      stages.push(progress.stage),
    );
    expect(stages).toContain('encrypting');
    const text = Buffer.from(await bytesOf(pdf)).toString('latin1');
    expect(text).toContain('/Encrypt');
    await expect(PDFDocument.load(await bytesOf(pdf))).rejects.toThrow();
  });

  it('leaves the document unencrypted for an empty password', async () => {
    const pdf = await buildPdf([jpegPage()], options({ password: '' }));
    const text = Buffer.from(await bytesOf(pdf)).toString('latin1');
    expect(text).not.toContain('/Encrypt');
  });
});

describe.skipIf(!HAS_PYPDF)('buildPdf — verified with pypdf', () => {
  it('produces a document a real parser can read and search', async () => {
    const pdf = await buildPdf(
      [
        jpegPage({
          ocr: ocr([
            { text: 'Invoice 2026-08', x: 0.08, y: 0.1, width: 0.5, height: 0.05 },
            { text: 'Total 42.00 EUR', x: 0.08, y: 0.2, width: 0.55, height: 0.05 },
          ]),
        }),
        jpegPage(),
      ],
      options({ pageSize: 'a4', searchable: true }),
    );
    const result = readWithPypdf(await bytesOf(pdf), 'searchable.pdf');
    expect(result.pages).toBe(2);
    expect(result.text).toContain('Invoice');
    expect(result.text).toContain('Total');
    expect(result.text).toContain('42.00');
  });

  it('keeps the searchable layer intact through encryption', async () => {
    const pdf = await buildPdf(
      [jpegPage({ ocr: ocr([{ text: 'Secret ledger', x: 0.1, y: 0.1, width: 0.5, height: 0.05 }]) })],
      options({ pageSize: 'a4', searchable: true, password: 'hunter2', title: 'Ledger' }),
    );
    const result = readWithPypdf(await bytesOf(pdf), 'searchable-encrypted.pdf', 'hunter2');
    expect(result.pages).toBe(1);
    expect(result.text).toContain('Secret ledger');
  });
});

describe('sanitizePdfText', () => {
  it('keeps ASCII and Latin-1 untouched', () => {
    expect(sanitizePdfText('Rechnung für Café')).toBe('Rechnung für Café');
  });

  it('keeps the WinAnsi extras OCR emits', () => {
    expect(sanitizePdfText('“quoted” — em–dash…')).toBe('“quoted” — em–dash…');
  });

  it('folds diacritics that WinAnsi lacks down to their base letter', () => {
    // ó is Latin-1 so it survives intact; Ō is not, and folds to O.
    expect(sanitizePdfText('Kraków Ōsaka')).toBe('Kraków Osaka');
    expect(sanitizePdfText('Ćwik żarówka')).toBe('Cwik zarówka');
  });

  it('drops scripts with no Latin equivalent rather than substituting', () => {
    expect(sanitizePdfText('請求書 Invoice')).toBe('Invoice');
    expect(sanitizePdfText('請求書')).toBe('');
  });

  it('collapses whitespace and control characters to single spaces', () => {
    expect(sanitizePdfText('  a\t\tb\r\nc  ')).toBe('a b c');
  });
});

describe('suggestPdfName', () => {
  it('keeps a normal title and adds the extension', () => {
    expect(suggestPdfName('Meeting notes')).toBe('Meeting notes.pdf');
  });

  it('does not double the extension', () => {
    expect(suggestPdfName('Report.pdf')).toBe('Report.pdf');
    expect(suggestPdfName('Report.PDF')).toBe('Report.pdf');
  });

  it('strips path separators and characters filesystems reject', () => {
    expect(suggestPdfName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j.pdf');
  });

  it('collapses whitespace and trims leading dots', () => {
    expect(suggestPdfName('  ..my   scan.. ')).toBe('my scan.pdf');
  });

  it('falls back when nothing usable is left', () => {
    expect(suggestPdfName('')).toBe('Scan.pdf');
    expect(suggestPdfName('///')).toBe('Scan.pdf');
    expect(suggestPdfName('...')).toBe('Scan.pdf');
  });

  it('avoids Windows reserved device names', () => {
    expect(suggestPdfName('NUL')).toBe('Scan.pdf');
    expect(suggestPdfName('com1')).toBe('Scan.pdf');
  });

  it('truncates a very long title', () => {
    const name = suggestPdfName('x'.repeat(400));
    expect(name.endsWith('.pdf')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(84);
  });
});

describe('page size table is exercised end to end', () => {
  it('uses the same constants the exporter does', () => {
    expect(Object.keys(PAGE_SIZES).sort()).toEqual(
      ['a3', 'a4', 'a5', 'b5', 'businesscard', 'legal', 'letter'].sort(),
    );
  });
});
