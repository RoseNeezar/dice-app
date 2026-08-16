import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createZip } from '@/lib/export/zip';

/**
 * The ZIP writer is hand-rolled, so "it parses in our own reader" would prove
 * nothing. Every test round-trips through python's `zipfile`, an independent
 * implementation that validates CRCs and the central directory.
 */

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Run python against a written archive and parse its JSON report. */
function inspectZip(bytes: Uint8Array): { names: string[]; digests: Record<string, string>; bad: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'openscan-zip-'));
  const file = join(dir, `${randomUUID()}.zip`);
  try {
    writeFileSync(file, bytes);
    const script = [
      'import json,zipfile,hashlib,sys',
      'z=zipfile.ZipFile(sys.argv[1])',
      'bad=z.testzip()',
      'names=z.namelist()',
      'digests={n:hashlib.sha256(z.read(n)).hexdigest() for n in names}',
      'print(json.dumps({"names":names,"digests":digests,"bad":bad}))',
    ].join('\n');
    const stdout = execFileSync('python3', ['-c', script, file], { encoding: 'utf8' });
    return JSON.parse(stdout) as { names: string[]; digests: Record<string, string>; bad: string | null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function zipBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('createZip', () => {
  it('produces an archive python can read, byte for byte', async () => {
    const text = new TextEncoder().encode('Hello, OpenScan — página 1\n');
    const binary = new Uint8Array(512);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 37) % 256;

    const blob = await createZip([
      { name: 'notes.txt', data: text },
      { name: 'images/page-001.bin', data: new Blob([binary]) },
      { name: 'empty.dat', data: new Uint8Array(0) },
    ]);
    expect(blob.type).toBe('application/zip');

    const report = inspectZip(await zipBytes(blob));
    expect(report.bad).toBeNull();
    expect(report.names).toEqual(['notes.txt', 'images/page-001.bin', 'empty.dat']);
    expect(report.digests['notes.txt']).toBe(sha256(text));
    expect(report.digests['images/page-001.bin']).toBe(sha256(binary));
    expect(report.digests['empty.dat']).toBe(sha256(new Uint8Array(0)));
  });

  it('round-trips a 1 MB entry, exercising chunked CRC over a blob', async () => {
    const payload = new Uint8Array(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 251 + 7) % 256;

    const report = inspectZip(await zipBytes(await createZip([{ name: 'big.bin', data: new Blob([payload]) }])));
    expect(report.bad).toBeNull();
    expect(report.digests['big.bin']).toBe(sha256(payload));
  });

  it('keeps non-ASCII names intact via the UTF-8 name flag', async () => {
    const data = new TextEncoder().encode('ok');
    const report = inspectZip(await zipBytes(await createZip([{ name: 'Ordner/正式な書類.txt', data }])));
    expect(report.bad).toBeNull();
    expect(report.names).toEqual(['Ordner/正式な書類.txt']);
  });

  it('writes a valid empty archive', async () => {
    const blob = await createZip([]);
    expect(blob.size).toBe(22);
    const report = inspectZip(await zipBytes(blob));
    expect(report.names).toEqual([]);
  });

  it('normalises leading slashes and rejects unusable names', async () => {
    const data = new TextEncoder().encode('x');
    const report = inspectZip(await zipBytes(await createZip([{ name: '/word/document.xml', data }])));
    expect(report.names).toEqual(['word/document.xml']);

    await expect(createZip([{ name: '', data }])).rejects.toThrow(/file name/);
    await expect(createZip([{ name: 'a/../../etc/passwd', data }])).rejects.toThrow(/Unsafe/);
    await expect(
      createZip([
        { name: 'a.txt', data },
        { name: 'a.txt', data },
      ]),
    ).rejects.toThrow(/Duplicate/);
  });
});
