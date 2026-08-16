import { describe, expect, it } from 'vitest';
import { PASSCODE_LENGTH, hashPasscode, isValidPasscode, verifyPasscode } from '@/lib/crypto/passcode';

/** Decoded byte length of a base64 string, without pulling in a decoder. */
function byteLength(base64: string): number {
  return Buffer.from(base64, 'base64').length;
}

describe('hashPasscode', () => {
  it('returns a 32-byte hash and a fresh 16-byte salt as base64', async () => {
    const { hash, salt } = await hashPasscode('123456');
    expect(byteLength(hash)).toBe(32);
    expect(byteLength(salt)).toBe(16);
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('salts every call differently, so identical codes hash differently', async () => {
    const a = await hashPasscode('123456');
    const b = await hashPasscode('123456');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('is deterministic when the salt is reused', async () => {
    const first = await hashPasscode('123456');
    const second = await hashPasscode('123456', first.salt);
    expect(second.hash).toBe(first.hash);
    expect(second.salt).toBe(first.salt);
  });

  it('rejects a salt that is not base64', async () => {
    await expect(hashPasscode('123456', 'not base64 !!')).rejects.toThrow(/base64/i);
  });

  it('distinguishes codes that differ only in order', async () => {
    const { hash, salt } = await hashPasscode('123456');
    const other = await hashPasscode('654321', salt);
    expect(other.hash).not.toBe(hash);
  });
});

describe('verifyPasscode', () => {
  it('accepts the code it was derived from', async () => {
    const { hash, salt } = await hashPasscode('402913');
    await expect(verifyPasscode('402913', hash, salt)).resolves.toBe(true);
  });

  it('rejects a wrong code, including a prefix of the right one', async () => {
    const { hash, salt } = await hashPasscode('402913');
    await expect(verifyPasscode('402914', hash, salt)).resolves.toBe(false);
    await expect(verifyPasscode('40291', hash, salt)).resolves.toBe(false);
    await expect(verifyPasscode('', hash, salt)).resolves.toBe(false);
  });

  it('rejects the right code against the wrong salt', async () => {
    const { hash } = await hashPasscode('402913');
    const { salt } = await hashPasscode('402913');
    await expect(verifyPasscode('402913', hash, salt)).resolves.toBe(false);
  });

  it('returns false rather than throwing on a corrupt record', async () => {
    await expect(verifyPasscode('402913', 'not base64 !!', 'also bad !!')).resolves.toBe(false);
    await expect(verifyPasscode('402913', '', '')).resolves.toBe(false);
  });

  it('handles non-ASCII passcodes byte-for-byte', async () => {
    const { hash, salt } = await hashPasscode('påsscøde✓');
    await expect(verifyPasscode('påsscøde✓', hash, salt)).resolves.toBe(true);
    await expect(verifyPasscode('passcode', hash, salt)).resolves.toBe(false);
  });
});

describe('isValidPasscode', () => {
  it('accepts exactly PASSCODE_LENGTH digits', () => {
    expect(isValidPasscode('0'.repeat(PASSCODE_LENGTH))).toBe(true);
  });

  it('rejects the wrong length, letters and whitespace', () => {
    expect(isValidPasscode('0'.repeat(PASSCODE_LENGTH - 1))).toBe(false);
    expect(isValidPasscode('0'.repeat(PASSCODE_LENGTH + 1))).toBe(false);
    expect(isValidPasscode('12345a')).toBe(false);
    expect(isValidPasscode('12 345')).toBe(false);
    expect(isValidPasscode('')).toBe(false);
  });
});
