import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
  PDFWriter,
} from 'pdf-lib';
import type { PDFContext, PDFObject, PDFRef } from 'pdf-lib';

/**
 * PDF standard security handler, revision 3 (RC4, 128-bit).
 *
 * pdf-lib can read encrypted documents but cannot write them, so this module
 * implements the handler from ISO 32000-1 §7.6.3 on top of pdf-lib's object
 * model: it computes the /O and /U entries, derives a per-object key, rewrites
 * every string and stream in the finished document and patches the trailer.
 *
 * Working on the parsed object graph rather than on raw bytes is what makes
 * this safe — object numbers, stream lengths and the cross-reference table are
 * all recomputed by pdf-lib's writer after we have swapped the payloads, so no
 * byte offset can drift.
 *
 * MD5 and RC4 are broken as security primitives; they are here because the PDF
 * format mandates them for this handler, and because a password-protected scan
 * that every reader can open beats one that only we can.
 */

/* ------------------------------------------------------------------ */
/* MD5                                                                 */
/* ------------------------------------------------------------------ */

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(2^32 * |sin(i + 1)|), the constants from RFC 1321. */
const MD5_SINE = new Uint32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

/**
 * MD5 digest of `input`, 16 bytes.
 *
 * Exported because the security handler is only trustworthy if its primitives
 * are checked against the RFC 1321 test vectors.
 */
export function md5(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  // Message + 0x80 + 8-byte length, rounded up to a whole number of 64B blocks.
  const paddedLength = (((input.length + 8) >> 6) << 6) + 64;
  const block = new Uint8Array(paddedLength);
  block.set(input);
  block[input.length] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (f + a + MD5_SINE[i] + words[g]) >>> 0;
      const shift = MD5_SHIFTS[i];
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  return digest;
}

/* ------------------------------------------------------------------ */
/* RC4                                                                 */
/* ------------------------------------------------------------------ */

/**
 * RC4 keystream applied to `data`. Symmetric, so the same call decrypts.
 *
 * Exported so the implementation can be pinned against published test vectors.
 */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length === 0) throw new Error('RC4 requires a non-empty key');
  const state = new Uint8Array(256);
  for (let i = 0; i < 256; i++) state[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    const swap = state[i];
    state[i] = state[j];
    state[j] = swap;
  }
  const out = new Uint8Array(data.length);
  let x = 0;
  let y = 0;
  for (let n = 0; n < data.length; n++) {
    x = (x + 1) & 0xff;
    y = (y + state[x]) & 0xff;
    const swap = state[x];
    state[x] = state[y];
    state[y] = swap;
    out[n] = data[n] ^ state[(state[x] + state[y]) & 0xff];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Standard security handler                                           */
/* ------------------------------------------------------------------ */

/** The 32-byte padding string from ISO 32000-1, Algorithm 2. */
const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** Revision 3 uses a 128-bit key and 50 extra hardening rounds. */
const KEY_BYTES = 16;
const KEY_BITS = KEY_BYTES * 8;
const HARDENING_ROUNDS = 50;
const RC4_KEY_ROUNDS = 19;

/**
 * /P flags. Bits 1–2 are reserved and shall be zero; every other bit is set, so
 * printing, copying, editing, annotating and assembly are all allowed. The
 * password guards *opening* the document, which is what a scanner app promises.
 */
const ALL_PERMISSIONS = -4;

/** How many objects the writer serialises before yielding to the event loop. */
const OBJECTS_PER_TICK = 50;

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function int32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value | 0, true);
  return out;
}

/**
 * Passwords are byte strings, not text. Revision 3 readers treat them as
 * Latin-1, so a code point that fits in a byte becomes that byte (matching
 * Acrobat); anything beyond Latin-1 falls back to its UTF-8 bytes so the
 * password is at least represented deterministically instead of being mangled.
 */
function passwordBytes(password: string): Uint8Array {
  const bytes: number[] = [];
  const utf8 = new TextEncoder();
  for (const char of password) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0xff) bytes.push(codePoint);
    else for (const byte of utf8.encode(char)) bytes.push(byte);
  }
  return new Uint8Array(bytes);
}

/** Truncate to 32 bytes, then top up from the padding string (Algorithm 2, step a). */
function padPassword(password: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const used = Math.min(password.length, 32);
  out.set(password.subarray(0, used));
  out.set(PAD.subarray(0, 32 - used), used);
  return out;
}

/** key XOR i, byte-wise — the 19 extra RC4 passes of revision 3. */
function xorKey(key: Uint8Array, value: number): Uint8Array {
  const out = new Uint8Array(key.length);
  for (let i = 0; i < key.length; i++) out[i] = key[i] ^ value;
  return out;
}

/** Algorithm 3: the /O entry, which hides the user password behind the owner password. */
function computeOwnerEntry(ownerPassword: Uint8Array, userPassword: Uint8Array): Uint8Array {
  let hash = md5(padPassword(ownerPassword));
  for (let i = 0; i < HARDENING_ROUNDS; i++) hash = md5(hash);
  const key = hash.subarray(0, KEY_BYTES);
  let out = rc4(key, padPassword(userPassword));
  for (let i = 1; i <= RC4_KEY_ROUNDS; i++) out = rc4(xorKey(key, i), out);
  return out;
}

/** Algorithm 2: the file encryption key. */
function computeEncryptionKey(
  userPassword: Uint8Array,
  ownerEntry: Uint8Array,
  permissions: number,
  fileId: Uint8Array,
): Uint8Array {
  const seed = concatBytes(
    padPassword(userPassword),
    ownerEntry,
    int32le(permissions),
    fileId,
  );
  let hash = md5(seed);
  for (let i = 0; i < HARDENING_ROUNDS; i++) hash = md5(hash.subarray(0, KEY_BYTES));
  return hash.slice(0, KEY_BYTES);
}

/** Algorithm 5: the /U entry, which lets a reader verify the user password. */
function computeUserEntry(key: Uint8Array, fileId: Uint8Array): Uint8Array {
  let hash = md5(concatBytes(PAD, fileId));
  hash = rc4(key, hash);
  for (let i = 1; i <= RC4_KEY_ROUNDS; i++) hash = rc4(xorKey(key, i), hash);
  const out = new Uint8Array(32);
  out.set(hash.subarray(0, 16));
  // Bytes 16..31 are "arbitrary padding" per the spec; reusing PAD keeps the
  // output deterministic for a given key, which makes the tests meaningful.
  out.set(PAD.subarray(0, 16), 16);
  return out;
}

/**
 * Algorithm 1: the key for one indirect object — the file key extended with the
 * object and generation numbers, hashed, then truncated to `key + 5` bytes.
 */
function objectKey(key: Uint8Array, objectNumber: number, generationNumber: number): Uint8Array {
  const seed = new Uint8Array(key.length + 5);
  seed.set(key);
  seed[key.length] = objectNumber & 0xff;
  seed[key.length + 1] = (objectNumber >> 8) & 0xff;
  seed[key.length + 2] = (objectNumber >> 16) & 0xff;
  seed[key.length + 3] = generationNumber & 0xff;
  seed[key.length + 4] = (generationNumber >> 8) & 0xff;
  return md5(seed).slice(0, Math.min(key.length + 5, 16));
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const source = globalThis.crypto;
  if (source && typeof source.getRandomValues === 'function') {
    source.getRandomValues(out);
    return out;
  }
  // Hosts without WebCrypto still get a usable file ID: it only has to be
  // unique per document, the password remains the secret that protects it.
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/* ------------------------------------------------------------------ */
/* Document rewriting                                                  */
/* ------------------------------------------------------------------ */

function encryptString(value: PDFString | PDFHexString, key: Uint8Array): PDFHexString {
  // Always emit hex: encrypted bytes are arbitrary binary, and a hex string
  // needs no escaping rules to survive them intact.
  return PDFHexString.of(toHex(rc4(key, value.asBytes())));
}

/**
 * Encrypt every string reachable from a direct container.
 *
 * `seen` guards against a container that is reachable twice, which would
 * otherwise be encrypted twice and decrypt to garbage.
 */
function encryptContainer(
  container: PDFDict | PDFArray,
  key: Uint8Array,
  seen: Set<PDFObject>,
): void {
  if (seen.has(container)) return;
  seen.add(container);
  if (container instanceof PDFDict) {
    for (const [name, value] of container.entries()) {
      const replacement = encryptValue(value, key, seen);
      if (replacement) container.set(name, replacement);
    }
    return;
  }
  for (let i = 0; i < container.size(); i++) {
    const replacement = encryptValue(container.get(i), key, seen);
    if (replacement) container.set(i, replacement);
  }
}

/** Returns a replacement object when `value` is a string, otherwise recurses and returns null. */
function encryptValue(value: PDFObject, key: Uint8Array, seen: Set<PDFObject>): PDFObject | null {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return encryptString(value, key);
  }
  if (value instanceof PDFDict || value instanceof PDFArray) {
    encryptContainer(value, key, seen);
  }
  return null;
}

/**
 * Encrypt every indirect object except the encryption dictionary itself, whose
 * /O and /U entries are stored in the clear by definition.
 */
function encryptIndirectObjects(context: PDFContext, key: Uint8Array, skip: PDFRef): void {
  const seen = new Set<PDFObject>();
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (ref.objectNumber === skip.objectNumber && ref.generationNumber === skip.generationNumber) {
      continue;
    }
    const key0 = objectKey(key, ref.objectNumber, ref.generationNumber);
    if (object instanceof PDFStream) {
      encryptContainer(object.dict, key0, seen);
      // getContents() yields the bytes as they would hit the file (already
      // Flate-encoded where applicable), which is exactly what gets encrypted.
      // Re-wrapping as a raw stream stops pdf-lib re-encoding them afterwards.
      context.assign(ref, PDFRawStream.of(object.dict, rc4(key0, object.getContents())));
    } else if (object instanceof PDFDict || object instanceof PDFArray) {
      encryptContainer(object, key0, seen);
    } else if (object instanceof PDFString || object instanceof PDFHexString) {
      context.assign(ref, encryptString(object, key0));
    }
  }
}

/**
 * Encrypt a finished PDF with the standard security handler (RC4 128-bit,
 * V=2 / R=3).
 *
 * The document opens only with `userPassword`. `ownerPassword` defaults to the
 * user password; all permissions are granted, so the password controls access
 * rather than what the reader may do once it is open.
 *
 * @param bytes A serialised, unencrypted PDF.
 * @param userPassword The password required to open the document. Required.
 * @param ownerPassword Optional owner password for permission changes.
 * @returns The encrypted PDF bytes.
 */
export async function encryptPdf(
  bytes: Uint8Array,
  userPassword: string,
  ownerPassword?: string,
): Promise<Uint8Array> {
  if (userPassword.length === 0) {
    throw new Error('A password is required to encrypt the PDF.');
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (cause) {
    throw new Error('The PDF could not be read back for encryption.', { cause });
  }
  if (doc.isEncrypted) {
    throw new Error('This PDF is already password protected.');
  }
  const context = doc.context;

  // The file ID is part of the key derivation, so it must be written into the
  // trailer before the key is computed — and it is never itself encrypted.
  const fileId = randomBytes(16);
  const idHex = PDFHexString.of(toHex(fileId));
  const idArray = PDFArray.withContext(context);
  idArray.push(idHex);
  idArray.push(idHex);
  context.trailerInfo.ID = idArray;

  const user = passwordBytes(userPassword);
  const owner = passwordBytes(
    ownerPassword !== undefined && ownerPassword.length > 0 ? ownerPassword : userPassword,
  );
  const ownerEntry = computeOwnerEntry(owner, user);
  const key = computeEncryptionKey(user, ownerEntry, ALL_PERMISSIONS, fileId);
  const userEntry = computeUserEntry(key, fileId);

  const encryptDict = PDFDict.withContext(context);
  encryptDict.set(PDFName.of('Filter'), PDFName.of('Standard'));
  encryptDict.set(PDFName.of('V'), PDFNumber.of(2));
  encryptDict.set(PDFName.of('R'), PDFNumber.of(3));
  encryptDict.set(PDFName.of('Length'), PDFNumber.of(KEY_BITS));
  encryptDict.set(PDFName.of('P'), PDFNumber.of(ALL_PERMISSIONS));
  encryptDict.set(PDFName.of('O'), PDFHexString.of(toHex(ownerEntry)));
  encryptDict.set(PDFName.of('U'), PDFHexString.of(toHex(userEntry)));
  const encryptRef = context.register(encryptDict);
  context.trailerInfo.Encrypt = encryptRef;

  encryptIndirectObjects(context, key, encryptRef);

  return PDFWriter.forContext(context, OBJECTS_PER_TICK).serializeToBuffer();
}
