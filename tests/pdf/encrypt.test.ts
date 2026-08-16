import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { encryptPdf, md5, rc4 } from '@/lib/pdf/encrypt';

/** 8x8 PNG, inlined so the fixture needs no canvas — it exercises image stream encryption. */
const PNG_8X8 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAK0lEQVR4nGNkYGD4r8HAqIFK8jOw/GeQY2Rg+M/AgEayMDLIYYr+ZxhYHQC2NSHuY1WA/QAAAABJRU5ErkJggg==';

const SAMPLE_TEXT = 'Confidential quarterly report';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function ascii(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

function fromHex(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

/** A small but realistic PDF: metadata strings, a flate content stream and an image XObject. */
async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Quarterly report');
  doc.setAuthor('OpenScan');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(Buffer.from(PNG_8X8, 'base64'));
  const page = doc.addPage([300, 400]);
  page.drawImage(image, { x: 20, y: 260, width: 120, height: 120 });
  page.drawText(SAMPLE_TEXT, { x: 20, y: 200, size: 14, font, color: rgb(0, 0, 0) });
  return doc.save({ useObjectStreams: false });
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
const tempDir = mkdtempSync(join(tmpdir(), 'openscan-encrypt-'));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface PypdfReport {
  encrypted: boolean;
  decrypt: number;
  pages?: number;
  text?: string;
  title?: string | null;
  permissions?: number;
}

/** Open the file with pypdf, a parser that knows nothing about this implementation. */
function inspectWithPypdf(bytes: Uint8Array, name: string, password: string): PypdfReport {
  const path = join(tempDir, name);
  writeFileSync(path, bytes);
  const script = [
    'import json, sys',
    'from pypdf import PdfReader',
    'reader = PdfReader(sys.argv[1])',
    'result = {"encrypted": bool(reader.is_encrypted), "decrypt": 0}',
    'if reader.is_encrypted:',
    '    result["decrypt"] = int(reader.decrypt(sys.argv[2]))',
    'if result["decrypt"]:',
    '    result["pages"] = len(reader.pages)',
    '    result["text"] = reader.pages[0].extract_text()',
    '    result["title"] = reader.metadata.title if reader.metadata else None',
    '    result["permissions"] = int(reader.user_access_permissions)',
    'print(json.dumps(result))',
  ].join('\n');
  const stdout = execFileSync('python3', ['-c', script, path, password], { encoding: 'utf8' });
  return JSON.parse(stdout) as PypdfReport;
}

describe('md5', () => {
  it('matches the RFC 1321 test vectors', () => {
    expect(hex(md5(ascii('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(md5(ascii('a')))).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(hex(md5(ascii('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(hex(md5(ascii('message digest')))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(hex(md5(ascii('abcdefghijklmnopqrstuvwxyz')))).toBe('c3fcd3d76192e4007dfb496cca67e13b');
    expect(
      hex(md5(ascii('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'))),
    ).toBe('d174ab98d277d9f5a5611c2c9f419d9f');
    expect(
      hex(md5(ascii('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))),
    ).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  it('handles the block-boundary lengths padding gets wrong', () => {
    expect(hex(md5(ascii('a'.repeat(55))))).toBe('ef1772b6dff9a122358552954ad0df65');
    expect(hex(md5(ascii('a'.repeat(56))))).toBe('3b0c8ac703f828b04c6c197006d17218');
    expect(hex(md5(ascii('a'.repeat(64))))).toBe('014842d480b571495a4a0363793f7367');
    expect(hex(md5(ascii('a'.repeat(119))))).toBe('8a7bd0732ed6a28ce75f6dabc90e1613');
    expect(hex(md5(ascii('a'.repeat(120))))).toBe('5f61c0ccad4cac44c75ff505e1f1e537');
  });

  it('is not confused by a subarray view', () => {
    const backing = ascii('xxabcxx');
    expect(hex(md5(backing.subarray(2, 5)))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});

describe('rc4', () => {
  it('matches the classic published vectors', () => {
    expect(hex(rc4(ascii('Key'), ascii('Plaintext')))).toBe('bbf316e8d940af0ad3');
    expect(hex(rc4(ascii('Wiki'), ascii('pedia')))).toBe('1021bf0420');
    expect(hex(rc4(ascii('Secret'), ascii('Attack at dawn')))).toBe(
      '45a01f645fc35b383552544b9bf5',
    );
  });

  it('is its own inverse', () => {
    const key = ascii('a long enough key');
    const data = new Uint8Array(1000).map((_, i) => (i * 37) & 0xff);
    expect(hex(rc4(key, rc4(key, data)))).toBe(hex(data));
  });

  it('refuses an empty key rather than producing a plaintext copy', () => {
    expect(() => rc4(new Uint8Array(0), ascii('x'))).toThrow(/non-empty key/);
  });
});

describe('encryptPdf — structure', () => {
  it('writes a complete RC4 128-bit standard security handler', async () => {
    const encrypted = await encryptPdf(await samplePdf(), 'hunter2');
    const text = Buffer.from(encrypted).toString('latin1');

    expect(text).toMatch(/\/Encrypt \d+ \d+ R/);
    expect(text).toContain('/Filter /Standard');
    expect(text).toContain('/V 2');
    expect(text).toContain('/R 3');
    expect(text).toContain('/Length 128');
    // All permissions granted; only opening the file is gated.
    expect(text).toContain('/P -4');

    const owner = /\/O <([0-9A-Fa-f]+)>/.exec(text);
    const user = /\/U <([0-9A-Fa-f]+)>/.exec(text);
    expect(owner?.[1]).toHaveLength(64);
    expect(user?.[1]).toHaveLength(64);

    const id = /\/ID \[ <([0-9A-Fa-f]+)> <([0-9A-Fa-f]+)> \]/.exec(text);
    expect(id?.[1]).toHaveLength(32);
    expect(id?.[2]).toBe(id?.[1]);
  });

  it('leaves the file readable as a PDF container but not as content', async () => {
    const encrypted = await encryptPdf(await samplePdf(), 'hunter2');
    expect(Buffer.from(encrypted.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    // Every string and stream is ciphertext now.
    expect(Buffer.from(encrypted).toString('latin1')).not.toContain(SAMPLE_TEXT);
    await expect(PDFDocument.load(encrypted)).rejects.toThrow();
    const reopened = await PDFDocument.load(encrypted, { ignoreEncryption: true });
    expect(reopened.isEncrypted).toBe(true);
  });

  it('derives /U from the file ID, so two exports never share ciphertext', async () => {
    const source = await samplePdf();
    const first = Buffer.from(await encryptPdf(source, 'hunter2')).toString('latin1');
    const second = Buffer.from(await encryptPdf(source, 'hunter2')).toString('latin1');
    const idOf = (text: string) => /\/ID \[ <([0-9A-Fa-f]+)>/.exec(text)?.[1];
    const userOf = (text: string) => /\/U <([0-9A-Fa-f]+)>/.exec(text)?.[1];
    expect(idOf(first)).not.toBe(idOf(second));
    expect(userOf(first)).not.toBe(userOf(second));
  });

  it('changes /O when an owner password is supplied', async () => {
    const source = await samplePdf();
    const withoutOwner = Buffer.from(await encryptPdf(source, 'user-pw')).toString('latin1');
    const withOwner = Buffer.from(await encryptPdf(source, 'user-pw', 'owner-pw')).toString(
      'latin1',
    );
    const ownerOf = (text: string) => /\/O <([0-9A-Fa-f]+)>/.exec(text)?.[1];
    expect(ownerOf(withoutOwner)).not.toBe(ownerOf(withOwner));
  });

  it('refuses an empty password instead of shipping an unprotected file', async () => {
    await expect(encryptPdf(await samplePdf(), '')).rejects.toThrow(
      'A password is required to encrypt the PDF.',
    );
  });

  it('refuses to double-encrypt', async () => {
    const once = await encryptPdf(await samplePdf(), 'hunter2');
    await expect(encryptPdf(once, 'hunter2')).rejects.toThrow(/already password protected/);
  });

  it('reports unreadable input rather than producing a broken file', async () => {
    await expect(encryptPdf(fromHex('00010203'), 'hunter2')).rejects.toThrow(
      'The PDF could not be read back for encryption.',
    );
  });
});

describe.skipIf(!HAS_PYPDF)('encryptPdf — verified with pypdf', () => {
  it('is encrypted, opens with the password and still parses', async () => {
    const encrypted = await encryptPdf(await samplePdf(), 'hunter2');
    const report = inspectWithPypdf(encrypted, 'protected.pdf', 'hunter2');
    expect(report.encrypted).toBe(true);
    // 1 = user password, 2 = owner password; either means the file opened.
    expect(report.decrypt).toBeGreaterThan(0);
    expect(report.pages).toBe(1);
    expect(report.text).toContain('Confidential quarterly report');
    expect(report.title).toBe('Quarterly report');
  });

  it('rejects the wrong password', async () => {
    const encrypted = await encryptPdf(await samplePdf(), 'hunter2');
    const report = inspectWithPypdf(encrypted, 'wrong-password.pdf', 'not-the-password');
    expect(report.encrypted).toBe(true);
    expect(report.decrypt).toBe(0);
  });

  it('accepts the user password and the owner password separately', async () => {
    const encrypted = await encryptPdf(await samplePdf(), 'user-pw', 'owner-pw');
    const asUser = inspectWithPypdf(encrypted, 'as-user.pdf', 'user-pw');
    const asOwner = inspectWithPypdf(encrypted, 'as-owner.pdf', 'owner-pw');
    expect(asUser.decrypt).toBe(1);
    expect(asOwner.decrypt).toBe(2);
    expect(asOwner.pages).toBe(1);
  });

  it('grants every permission once the file is open', async () => {
    const encrypted = await encryptPdf(await samplePdf(), 'hunter2');
    const report = inspectWithPypdf(encrypted, 'permissions.pdf', 'hunter2');
    // -4 as an unsigned 32-bit value: every flag except the two reserved bits.
    expect(report.permissions).toBe(0xfffffffc);
  });

  it('handles a non-ASCII password the way a Latin-1 reader does', async () => {
    const encrypted = await encryptPdf(await samplePdf(), 'pässwörd');
    const report = inspectWithPypdf(encrypted, 'latin1-password.pdf', 'pässwörd');
    expect(report.decrypt).toBeGreaterThan(0);
    expect(report.pages).toBe(1);
  });

  it('survives a document large enough to span many objects', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle('Long document');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 25; i++) {
      const page = doc.addPage([200, 200]);
      page.drawText(`Page ${i + 1} marker`, { x: 10, y: 100, size: 10, font });
    }
    const encrypted = await encryptPdf(await doc.save({ useObjectStreams: false }), 'hunter2');
    const report = inspectWithPypdf(encrypted, 'many-pages.pdf', 'hunter2');
    expect(report.pages).toBe(25);
    expect(report.text).toContain('Page 1 marker');
  });

  it('encrypts a document that was saved with object streams', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle('Compressed objects');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([200, 200]).drawText('Object stream marker', { x: 10, y: 100, size: 10, font });
    const encrypted = await encryptPdf(await doc.save({ useObjectStreams: true }), 'hunter2');
    const report = inspectWithPypdf(encrypted, 'objstm.pdf', 'hunter2');
    expect(report.decrypt).toBeGreaterThan(0);
    expect(report.text).toContain('Object stream marker');
  });
});
