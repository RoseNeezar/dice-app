import type { BarcodeResult, Point } from '@/types';
import { decodeToBitmap } from '@/lib/image/io';

/**
 * A thin, typed wrapper around the Barcode Detection API.
 *
 * The API is not in TypeScript's DOM library and ships only on Chromium and
 * recent Safari, so everything here is written to degrade to a clear message
 * rather than a thrown `ReferenceError`.
 */

interface DetectedBarcode {
  rawValue: string;
  format: string;
  cornerPoints?: readonly Point[];
}

interface BarcodeDetectorInstance {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
}

/** Shown wherever the platform cannot scan codes. */
export const BARCODE_UNSUPPORTED_MESSAGE =
  'This browser cannot scan codes. Chrome on Android or Safari 17+ can, or import a photo of the code.';

function constructor(): BarcodeDetectorConstructor | null {
  const scope = globalThis as { BarcodeDetector?: BarcodeDetectorConstructor };
  return typeof scope.BarcodeDetector === 'function' ? scope.BarcodeDetector : null;
}

/** True when {@link scanBarcodes} can actually do something. */
export function isBarcodeScanningSupported(): boolean {
  return constructor() !== null;
}

// One detector for the whole session: construction is comparatively expensive
// and we call detect() several times a second while the QR mode is open.
let detector: BarcodeDetectorInstance | null = null;

function getDetector(): BarcodeDetectorInstance {
  const Ctor = constructor();
  if (!Ctor) throw new Error(BARCODE_UNSUPPORTED_MESSAGE);
  // No `formats` option: the default is "every format this device supports",
  // and naming a format the device lacks makes the constructor throw.
  detector ??= new Ctor();
  return detector;
}

/**
 * Read every code visible in a video frame, bitmap or image blob.
 *
 * Throws with {@link BARCODE_UNSUPPORTED_MESSAGE} where the API is missing —
 * check {@link isBarcodeScanningSupported} first to keep that out of the UI.
 */
export async function scanBarcodes(source: HTMLVideoElement | ImageBitmap | Blob): Promise<BarcodeResult[]> {
  const instance = getDetector();
  // `ImageBitmapSource` does not include Blob in the spec, so decode first.
  const bitmap = source instanceof Blob ? await decodeToBitmap(source) : null;
  try {
    const found = await instance.detect(bitmap ?? (source as ImageBitmapSource));
    return found
      .filter((code) => code.rawValue.length > 0)
      .map((code) => ({
        text: code.rawValue,
        format: code.format,
        corners: code.cornerPoints ? code.cornerPoints.map((p) => ({ x: p.x, y: p.y })) : null,
      }));
  } finally {
    bitmap?.close();
  }
}

/**
 * Normalize scanned text into an `https:`/`http:` URL the app may open, or null
 * when the payload is plain text. Anything with another scheme (`javascript:`,
 * `data:`, custom app schemes) is deliberately rejected.
 */
export function toOpenableUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const candidate = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return parsed.href;
}

/** Human label for the scan sheet — a link reads differently from a payload. */
export function describeBarcode(result: BarcodeResult): string {
  const format = result.format.replace(/_/g, ' ');
  return toOpenableUrl(result.text) ? `Link · ${format}` : format;
}
