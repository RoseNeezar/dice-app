import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OcrLine, OcrResult } from '@/types';
import { buildDocxBlob, buildTxtBlob, documentToText } from '@/lib/export/text';

function line(text: string): OcrLine {
  return { text, x: 0.1, y: 0.1, width: 0.8, height: 0.03, words: [] };
}

function ocr(...texts: string[]): OcrResult {
  return {
    language: 'eng',
    text: texts.join('\n'),
    lines: texts.map(line),
    confidence: 0.9,
    completedAt: 1_700_000_000_000,
  };
}

/** Read a part out of a generated .docx using python's zipfile. */
function readDocxPart(bytes: Uint8Array, part: string): { names: string[]; content: string } {
  const dir = mkdtempSync(join(tmpdir(), 'openscan-docx-'));
  const file = join(dir, `${randomUUID()}.docx`);
  try {
    writeFileSync(file, bytes);
    const script = [
      'import json,sys,zipfile',
      'z=zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      'print(json.dumps({"names":z.namelist(),"content":z.read(sys.argv[2]).decode("utf-8")}))',
    ].join('\n');
    const stdout = execFileSync('python3', ['-c', script, file, part], { encoding: 'utf8' });
    return JSON.parse(stdout) as { names: string[]; content: string };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function docxPart(title: string, pages: { index: number; ocr: OcrResult | null }[], part: string) {
  const blob = await buildDocxBlob(title, pages);
  return readDocxPart(new Uint8Array(await blob.arrayBuffer()), part);
}

describe('documentToText', () => {
  it('writes a title header and one section per recognised page', () => {
    const text = documentToText(
      [
        { index: 0, ocr: ocr('Invoice 42', 'Total 19.99') },
        { index: 1, ocr: null },
        { index: 2, ocr: ocr('Thank you') },
      ],
      'Receipts',
    );
    expect(text).toBe('Receipts\n\n--- Page 1 ---\nInvoice 42\nTotal 19.99\n\n--- Page 3 ---\nThank you\n');
  });

  it('falls back to the raw OCR dump when there are no line boxes', () => {
    const raw: OcrResult = { ...ocr('ignored'), lines: [], text: 'alpha\r\nbeta   \n\n' };
    expect(documentToText([{ index: 0, ocr: raw }], 'Notes')).toBe('Notes\n\n--- Page 1 ---\nalpha\nbeta\n');
  });

  it('says so instead of returning a blank file when nothing was recognised', () => {
    expect(documentToText([{ index: 0, ocr: null }], '  ')).toBe(
      'Untitled document\n\nNo text was recognised in this document.\n',
    );
  });
});

describe('buildTxtBlob', () => {
  it('is UTF-8 plain text that round-trips', async () => {
    const blob = buildTxtBlob('café — 90%\n');
    expect(blob.type).toBe('text/plain;charset=utf-8');
    expect(await blob.text()).toBe('café — 90%\n');
  });
});

describe('buildDocxBlob', () => {
  it('is a valid OPC package with the expected parts', async () => {
    const { names, content } = await docxPart(
      'Quarterly report',
      [{ index: 0, ocr: ocr('First line', 'Second line') }],
      'word/document.xml',
    );
    expect(names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/_rels/document.xml.rels',
    ]);
    expect(content).toContain('<w:t xml:space="preserve">Quarterly report</w:t>');
    expect(content).toContain('<w:t xml:space="preserve">Page 1</w:t>');
    expect(content).toContain('<w:t xml:space="preserve">First line</w:t>');
    expect(content).toContain('<w:t xml:space="preserve">Second line</w:t>');
    expect(content).toContain('<w:sectPr>');
  });

  it('declares the Word content type and the officeDocument relationship', async () => {
    const pages = [{ index: 0, ocr: ocr('x') }];
    const types = await docxPart('T', pages, '[Content_Types].xml');
    expect(types.content).toContain('wordprocessingml.document.main+xml');
    const rels = await docxPart('T', pages, '_rels/.rels');
    expect(rels.content).toContain('Target="word/document.xml"');
    expect(rels.content).toContain('relationships/officeDocument');
  });

  it('escapes XML and drops characters Word would choke on', async () => {
    // A bell character and a lone high surrogate: either one on its own makes
    // the package unopenable if it reaches the XML.
    const dirty = 'Tom & \'Jerry\' <b>\u0007\tend\uD800';
    const { content } = await docxPart('A & "B"', [{ index: 0, ocr: ocr(dirty) }], 'word/document.xml');
    expect(content).toContain('<w:t xml:space="preserve">Tom &amp; &apos;Jerry&apos; &lt;b&gt; end</w:t>');
    expect(content).toContain('<w:t xml:space="preserve">A &amp; &quot;B&quot;</w:t>');
    expect(content).not.toContain('\u0007');
    expect(content).not.toContain('\uD800');
  });

  it('breaks each recognised page onto its own sheet, but never the first', async () => {
    const { content } = await docxPart(
      'Two pages',
      [
        { index: 0, ocr: ocr('one') },
        { index: 1, ocr: null },
        { index: 2, ocr: ocr('three') },
      ],
      'word/document.xml',
    );
    expect(content.match(/<w:pageBreakBefore\/>/g)).toHaveLength(1);
    expect(content).toContain('<w:t xml:space="preserve">Page 3</w:t>');
    expect(content).not.toContain('<w:t xml:space="preserve">Page 2</w:t>');
  });

  it('still opens when no page has any text', async () => {
    const { content } = await docxPart('Empty', [{ index: 0, ocr: null }], 'word/document.xml');
    expect(content).toContain('No text was recognised in this document.');
  });

  it('is served with the Word MIME type', async () => {
    const blob = await buildDocxBlob('T', []);
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
});
