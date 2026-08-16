import { describe, expect, it } from 'vitest';
import type { OcrLine, OcrWord } from '@/types';
import { buildCsvBlob, linesToTable, tableToCsv } from '@/lib/export/tables';

const WORD_HEIGHT = 0.02;
/** Roughly the advance of one glyph at receipt scale, in page widths. */
const GLYPH = 0.012;

function word(text: string, x: number, y: number): OcrWord {
  return { text, x, y, width: text.length * GLYPH, height: WORD_HEIGHT, confidence: 0.95 };
}

/** A line built from `[text, x]` pairs laid out at row `y`. */
function row(y: number, cells: [string, number][]): OcrLine {
  const words: OcrWord[] = [];
  for (const [phrase, startX] of cells) {
    let x = startX;
    for (const token of phrase.split(' ')) {
      words.push(word(token, x, y));
      x += token.length * GLYPH + GLYPH;
    }
  }
  const last = words[words.length - 1];
  return {
    text: words.map((w) => w.text).join(' '),
    x: words[0].x,
    y,
    width: last.x + last.width - words[0].x,
    height: WORD_HEIGHT,
    words,
  };
}

describe('linesToTable', () => {
  it('recovers a clean three-column receipt', () => {
    const lines = [
      row(0.10, [['Flat white', 0.05], ['2', 0.55], ['7.00', 0.75]]),
      row(0.16, [['Banana bread', 0.05], ['1', 0.55], ['5.50', 0.75]]),
      row(0.22, [['Sparkling water', 0.05], ['3', 0.55], ['9.00', 0.75]]),
    ];
    const table = linesToTable(lines);
    expect(table.rows).toEqual([
      ['Flat white', '2', '7.00'],
      ['Banana bread', '1', '5.50'],
      ['Sparkling water', '3', '9.00'],
    ]);
    expect(table.confidence).toBeGreaterThan(0.8);
  });

  it('merges words that OCR split across two lines at the same height', () => {
    const left = row(0.30, [['Subtotal', 0.05]]);
    const right = row(0.302, [['42.50', 0.75]]);
    const table = linesToTable([
      row(0.10, [['Item', 0.05], ['Price', 0.75]]),
      row(0.20, [['Tea', 0.05], ['3.00', 0.75]]),
      left,
      right,
    ]);
    expect(table.rows).toEqual([
      ['Item', 'Price'],
      ['Tea', '3.00'],
      ['Subtotal', '42.50'],
    ]);
  });

  it('keeps the columns when one row spills across a gutter, but trusts it less', () => {
    const clean = linesToTable([
      row(0.10, [['Coffee', 0.05], ['2', 0.55], ['7.00', 0.75]]),
      row(0.16, [['Toast', 0.05], ['1', 0.55], ['5.50', 0.75]]),
      row(0.22, [['Juice', 0.05], ['3', 0.55], ['9.00', 0.75]]),
      row(0.28, [['Water', 0.05], ['1', 0.55], ['2.00', 0.75]]),
    ]);
    // The long description runs straight through the first gutter, and the
    // quantity column drifts — exactly what a crooked phone photo produces.
    const ragged = linesToTable([
      row(0.10, [['Coffee beans single origin Ethiopia', 0.05], ['2', 0.55], ['7.00', 0.75]]),
      row(0.16, [['Toast', 0.05], ['1', 0.60], ['5.50', 0.75]]),
      row(0.22, [['Juice', 0.05], ['3', 0.52], ['9.00', 0.76]]),
      row(0.28, [['Water', 0.05], ['1', 0.58], ['2.00', 0.74]]),
    ]);

    expect(ragged.rows).toHaveLength(4);
    for (const line of ragged.rows) expect(line).toHaveLength(3);
    expect(ragged.rows[0][2]).toBe('7.00');
    expect(ragged.rows[1]).toEqual(['Toast', '1', '5.50']);
    expect(ragged.confidence).toBeLessThan(clean.confidence);
    expect(ragged.confidence).toBeGreaterThan(0);
  });

  it('pads short rows so the grid stays rectangular', () => {
    const table = linesToTable([
      row(0.10, [['Name', 0.05], ['Qty', 0.55], ['Cost', 0.75]]),
      row(0.16, [['Pen', 0.05], ['4', 0.55], ['1.20', 0.75]]),
      row(0.22, [['Notebook', 0.05], ['9.99', 0.75]]),
    ]);
    expect(table.rows[2]).toEqual(['Notebook', '', '9.99']);
  });

  it('reports no confidence when there is only one column of prose', () => {
    const table = linesToTable([
      row(0.10, [['The quick brown fox', 0.05]]),
      row(0.16, [['jumps over the dog', 0.05]]),
    ]);
    expect(table.rows).toEqual([['The quick brown fox'], ['jumps over the dog']]);
    expect(table.confidence).toBe(0);
  });

  it('handles an empty page and lines that only carry line-level text', () => {
    expect(linesToTable([])).toEqual({ rows: [], confidence: 0 });
    const lineOnly: OcrLine = { text: 'Total 12.00', x: 0.05, y: 0.1, width: 0.4, height: WORD_HEIGHT, words: [] };
    expect(linesToTable([lineOnly]).rows).toEqual([['Total 12.00']]);
  });
});

describe('tableToCsv', () => {
  it('quotes only the fields RFC 4180 requires, and doubles inner quotes', () => {
    const csv = tableToCsv({
      rows: [
        ['plain', 'has, comma', 'has "quote"'],
        ['line\nbreak', 'carriage\rreturn', ''],
      ],
      confidence: 1,
    });
    expect(csv).toBe(
      'plain,"has, comma","has ""quote"""\r\n"line\nbreak","carriage\rreturn",',
    );
  });

  it('is empty for an empty table', () => {
    expect(tableToCsv({ rows: [], confidence: 0 })).toBe('');
  });
});

describe('buildCsvBlob', () => {
  it('prefixes a UTF-8 BOM so Excel reads accents correctly', async () => {
    const blob = buildCsvBlob('café,1');
    expect(blob.type).toBe('text/csv;charset=utf-8');
    // `Blob.text()` strips the BOM on decode, so assert on the raw bytes.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('café,1');
  });
});
