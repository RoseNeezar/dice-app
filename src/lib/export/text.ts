import type { OcrResult } from '@/types';
import { createZip } from './zip';

/**
 * Plain-text and Word exports of a document's OCR layer.
 *
 * The `.docx` here is written by hand rather than with a library: a Word file
 * is an OPC package (a ZIP of XML parts), and the four parts below are the
 * complete minimum that Word, LibreOffice and Google Docs all accept. Styling
 * is direct formatting so no `styles.xml` is needed.
 */

/** A page as the text exporters see it: its position and its OCR layer. */
export interface TextExportPage {
  /** Zero-based position in the document; rendered as `Page index + 1`. */
  index: number;
  ocr: OcrResult | null;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FALLBACK_TITLE = 'Untitled document';
const NO_TEXT_NOTE = 'No text was recognised in this document.';

/** Split an OCR layer into display lines, preferring the line boxes over the raw dump. */
function pageLines(ocr: OcrResult | null): string[] {
  if (!ocr) return [];
  const fromLines = ocr.lines.map((line) => line.text.replace(/\s+$/, '')).filter((line) => line !== '');
  if (fromLines.length > 0) return fromLines;
  return ocr.text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '');
}

/**
 * A readable transcript of every page that has been recognised.
 *
 * Pages without an OCR layer are skipped rather than emitted empty, so the
 * separators always mark real content, and the page numbers stay those of the
 * document rather than of the transcript.
 */
export function documentToText(pages: TextExportPage[], title: string): string {
  const heading = title.trim() || FALLBACK_TITLE;
  const sections: string[] = [];
  for (const page of pages) {
    const lines = pageLines(page.ocr);
    if (lines.length === 0) continue;
    sections.push(`--- Page ${page.index + 1} ---\n${lines.join('\n')}`);
  }
  if (sections.length === 0) return `${heading}\n\n${NO_TEXT_NOTE}\n`;
  return `${heading}\n\n${sections.join('\n\n')}\n`;
}

/** Wrap a transcript as a downloadable `.txt`. */
export function buildTxtBlob(text: string): Blob {
  return new Blob([text], { type: 'text/plain;charset=utf-8' });
}

/**
 * Drop everything XML 1.0 cannot carry. One stray control byte from OCR is
 * enough to make Word refuse to open the whole file, so this runs on every
 * string that reaches the document. Iterating by code point means a lone
 * surrogate arrives on its own and can be dropped, while real astral
 * characters (emoji, CJK extensions) pass through intact.
 */
function stripInvalidXml(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += ' ';
      continue;
    }
    if (code < 0x20) continue;
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (code === 0xfffe || code === 0xffff) continue;
    out += char;
  }
  return out;
}

function escapeXml(value: string): string {
  return stripInvalidXml(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface ParagraphStyle {
  bold?: boolean;
  /** Font size in half-points, as WordprocessingML measures it. */
  size?: number;
  pageBreakBefore?: boolean;
  /** Space before/after in twentieths of a point. */
  spaceBefore?: number;
  spaceAfter?: number;
}

const BODY_SIZE = 22;
const HEADING_SIZE = 26;
const TITLE_SIZE = 36;

/**
 * One `<w:p>`. Child order matters — WordprocessingML validates `pPr` and `rPr`
 * against a sequence, not a set.
 */
function paragraph(text: string, style: ParagraphStyle = {}): string {
  const size = style.size ?? BODY_SIZE;
  const props: string[] = [];
  if (style.pageBreakBefore) props.push('<w:pageBreakBefore/>');
  if (style.spaceBefore !== undefined || style.spaceAfter !== undefined) {
    const before = style.spaceBefore === undefined ? '' : ` w:before="${style.spaceBefore}"`;
    const after = style.spaceAfter === undefined ? '' : ` w:after="${style.spaceAfter}"`;
    props.push(`<w:spacing${before}${after}/>`);
  }
  const pPr = props.length > 0 ? `<w:pPr>${props.join('')}</w:pPr>` : '';
  const rPr =
    '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
    (style.bold ? '<w:b/><w:bCs/>' : '') +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const CONTENT_TYPES_XML =
  `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const PACKAGE_RELS_XML =
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
  'Target="word/document.xml"/>' +
  '</Relationships>';

/** The main part has no images or styles to reference, but the part must exist. */
const DOCUMENT_RELS_XML =
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

/** A4 portrait with 2 cm margins, in twentieths of a point. */
const SECTION_XML =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" ' +
  'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';

function documentXml(title: string, pages: TextExportPage[]): string {
  const body: string[] = [paragraph(title, { bold: true, size: TITLE_SIZE, spaceAfter: 240 })];
  let recognised = 0;
  for (const page of pages) {
    const lines = pageLines(page.ocr);
    if (lines.length === 0) continue;
    body.push(
      paragraph(`Page ${page.index + 1}`, {
        bold: true,
        size: HEADING_SIZE,
        // Each recognised page starts on its own sheet, mirroring the scan.
        pageBreakBefore: recognised > 0,
        spaceBefore: 240,
        spaceAfter: 120,
      }),
    );
    for (const line of lines) body.push(paragraph(line));
    recognised += 1;
  }
  if (recognised === 0) body.push(paragraph(NO_TEXT_NOTE));
  return (
    `${XML_DECLARATION}<w:document ` +
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body.join('')}${SECTION_XML}</w:body></w:document>`
  );
}

/**
 * Build a Word document from the recognised text of `pages`.
 *
 * `[Content_Types].xml` is written first because some OPC readers expect the
 * content-type part at the head of the archive.
 */
export async function buildDocxBlob(title: string, pages: TextExportPage[]): Promise<Blob> {
  const heading = title.trim() || FALLBACK_TITLE;
  const encoder = new TextEncoder();
  const zip = await createZip([
    { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: encoder.encode(PACKAGE_RELS_XML) },
    { name: 'word/document.xml', data: encoder.encode(documentXml(heading, pages)) },
    { name: 'word/_rels/document.xml.rels', data: encoder.encode(DOCUMENT_RELS_XML) },
  ]);
  return new Blob([zip], { type: DOCX_MIME });
}
