/**
 * Passcode hashing for the app lock.
 *
 * The passcode never leaves this device and is never stored: only a PBKDF2
 * derivation of it is kept, next to the random salt it was derived with. Both
 * are base64 so they survive IndexedDB, JSON and structured cloning unchanged.
 *
 * WebCrypto only — no dependency, and the derivation runs in native code rather
 * than on the JavaScript thread.
 */

/**
 * PBKDF2 work factor. A numeric passcode has so little entropy that no factor
 * makes it brute-force proof; this is chosen to stay around a fifth of a second
 * on a mid-range phone, which is unnoticeable on the unlock screen but makes an
 * offline attack on a stolen hash cost real time per guess.
 */
const ITERATIONS = 210_000;

/** Derived key length in bits — one full SHA-256 block. */
const KEY_BITS = 256;

/** Salt length in bytes; 16 is the usual floor for PBKDF2. */
const SALT_BYTES = 16;

/**
 * Digits in a passcode. Both the lock screen and the settings editor read this,
 * so the two can never disagree about what a valid code looks like.
 */
export const PASSCODE_LENGTH = 6;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Decode base64, or `null` when the text is not valid base64.
 *
 * The `ArrayBuffer` type argument is not decoration: WebCrypto refuses a view
 * that might be backed by shared memory, which the bare `Uint8Array` type
 * admits.
 */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function subtle(): SubtleCrypto {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('This browser cannot set a passcode — it has no WebCrypto support.');
  }
  return crypto.subtle;
}

async function derive(passcode: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Compare two byte strings without leaking where they first differ.
 *
 * Lengths are compared up front: the length of a hash is not a secret, and a
 * mismatch there means the stored value is corrupt rather than wrong.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/**
 * Derive the stored form of a passcode.
 *
 * @param passcode The code the user typed. Any string is accepted; length
 * policy belongs to the UI, not to the hash.
 * @param salt Base64 salt to reuse. Omit it — the only caller that passes one
 * is a re-derivation against an existing record.
 * @returns The base64 hash and the base64 salt it belongs to. Store both.
 * @throws If `salt` is given but is not valid base64, or WebCrypto is missing.
 */
export async function hashPasscode(
  passcode: string,
  salt?: string,
): Promise<{ hash: string; salt: string }> {
  let saltBytes: Uint8Array<ArrayBuffer>;
  if (salt === undefined) {
    saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  } else {
    const decoded = fromBase64(salt);
    if (!decoded || decoded.length === 0) throw new Error('That passcode salt is not valid base64.');
    saltBytes = decoded;
  }
  const hash = await derive(passcode, saltBytes);
  return { hash: toBase64(hash), salt: toBase64(saltBytes) };
}

/**
 * Check a passcode against a stored hash and salt.
 *
 * Never throws for bad input: a corrupt or truncated record simply fails to
 * verify, which keeps the lock screen closed instead of crashing it open.
 */
export async function verifyPasscode(
  passcode: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  const expected = fromBase64(hash);
  const saltBytes = fromBase64(salt);
  if (!expected || !saltBytes || expected.length === 0 || saltBytes.length === 0) return false;
  try {
    return timingSafeEqual(await derive(passcode, saltBytes), expected);
  } catch {
    return false;
  }
}

/** Whether `value` is a passcode the app will accept: digits only, exact length. */
export function isValidPasscode(value: string): boolean {
  return value.length === PASSCODE_LENGTH && /^[0-9]+$/.test(value);
}
