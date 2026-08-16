/**
 * A minimal, dependency-free ZIP writer (store method, no compression).
 *
 * OpenScan needs ZIP in two places — "export all pages as images" and the OPC
 * container that a `.docx` really is — and neither is worth a third-party
 * dependency. Deflate is deliberately not implemented: page images are already
 * JPEG/PNG, so compressing them again costs CPU on a phone and saves nothing.
 */

/** One file inside the archive. `name` is the full path, using `/` separators. */
export interface ZipEntry {
  name: string;
  data: Blob | Uint8Array;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;

/** PKZip 2.0 — the floor for the store method plus UTF-8 names. */
const VERSION_NEEDED = 20;
/** High byte 3 = Unix, so the permission bits below are honoured on extract. */
const VERSION_MADE_BY = 0x0314;
/** Bit 11 marks the file name as UTF-8 rather than CP437. */
const FLAG_UTF8_NAMES = 0x0800;
const METHOD_STORE = 0;
/** `-rw-r--r--` in the high 16 bits, where Unix hosts keep the file mode. */
const UNIX_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;

const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  crcTable = table;
  return table;
}

/** Fold one chunk into a running CRC-32. The seed and result are pre-inversion. */
function crc32Update(seed: number, chunk: Uint8Array): number {
  const table = getCrcTable();
  let crc = seed;
  for (let i = 0; i < chunk.length; i++) {
    crc = table[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc;
}

function crc32(chunk: Uint8Array): number {
  return (crc32Update(0xffffffff, chunk) ^ 0xffffffff) >>> 0;
}

/**
 * CRC a blob without ever holding it in memory as a copy: the blob itself is
 * handed to the final archive as a `BlobPart`, so a 20 MB page image is read
 * once in chunks and never duplicated.
 */
async function crc32OfBlob(blob: Blob): Promise<number> {
  if (typeof blob.stream !== 'function') {
    return crc32(new Uint8Array(await blob.arrayBuffer()));
  }
  const reader = blob.stream().getReader();
  let crc = 0xffffffff;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = crc32Update(crc, value);
    }
  } finally {
    reader.releaseLock();
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * `Blob` refuses views backed by a `SharedArrayBuffer`, which the `Uint8Array`
 * type admits, so anything shared is copied into a private buffer first.
 */
function toBlobPart(bytes: Uint8Array): BlobPart {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

/** MS-DOS packed date/time, the only timestamp the base ZIP format carries. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface PreparedEntry {
  nameBytes: Uint8Array;
  size: number;
  crc: number;
  /** Byte offset of this entry's local header, for the central directory. */
  offset: number;
}

/**
 * Build a ZIP archive from `entries`.
 *
 * Entries are stored uncompressed in the order given — put `[Content_Types].xml`
 * first when writing an OPC package, since some readers expect it there.
 *
 * @throws if a name is empty, a name is duplicated, or the archive would exceed
 * the 4 GB / 65535-entry limits of the non-Zip64 format.
 */
export async function createZip(entries: ZipEntry[]): Promise<Blob> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`A ZIP archive cannot hold more than ${MAX_ENTRIES} files`);
  }

  const encoder = new TextEncoder();
  const stamp = dosDateTime(new Date());
  const seen = new Set<string>();
  const prepared: PreparedEntry[] = [];
  const parts: BlobPart[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.name.replace(/^\/+/, '');
    if (!name) throw new Error('Every ZIP entry needs a file name');
    // A `..` segment would let the archive write outside the folder the user
    // extracts it into — never emit one, even from our own call sites.
    if (name.split('/').includes('..')) throw new Error(`Unsafe ZIP entry path: ${entry.name}`);
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    seen.add(name);

    const nameBytes = encoder.encode(name);
    const body = entry.data instanceof Blob ? entry.data : toBlobPart(entry.data);
    const size = entry.data instanceof Blob ? entry.data.size : entry.data.length;
    const crc = entry.data instanceof Blob ? await crc32OfBlob(entry.data) : crc32(entry.data);

    if (offset + LOCAL_HEADER_BYTES + nameBytes.length + size > MAX_UINT32) {
      throw new Error('This archive is too large to export (the ZIP limit is 4 GB)');
    }

    const header = new Uint8Array(LOCAL_HEADER_BYTES + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    view.setUint16(4, VERSION_NEEDED, true);
    view.setUint16(6, FLAG_UTF8_NAMES, true);
    view.setUint16(8, METHOD_STORE, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, LOCAL_HEADER_BYTES);

    parts.push(header);
    parts.push(body);
    prepared.push({ nameBytes, size, crc, offset });
    offset += header.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const entry of prepared) {
    const record = new Uint8Array(CENTRAL_HEADER_BYTES + entry.nameBytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    view.setUint16(4, VERSION_MADE_BY, true);
    view.setUint16(6, VERSION_NEEDED, true);
    view.setUint16(8, FLAG_UTF8_NAMES, true);
    view.setUint16(10, METHOD_STORE, true);
    view.setUint16(12, stamp.time, true);
    view.setUint16(14, stamp.date, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.size, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, UNIX_FILE_ATTRIBUTES >>> 0, true);
    view.setUint32(42, entry.offset, true);
    record.set(entry.nameBytes, CENTRAL_HEADER_BYTES);
    parts.push(record);
    centralSize += record.length;
  }

  if (centralStart + centralSize + EOCD_BYTES > MAX_UINT32) {
    throw new Error('This archive is too large to export (the ZIP limit is 4 GB)');
  }

  const eocd = new Uint8Array(EOCD_BYTES);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIGNATURE, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, prepared.length, true);
  eocdView.setUint16(10, prepared.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralStart, true);
  eocdView.setUint16(20, 0, true);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}
