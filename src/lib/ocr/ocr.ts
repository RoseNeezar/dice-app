import type { OcrLine, OcrResult, OcrWord } from '@/types';
import type {
  Bbox,
  Line as TesseractLine,
  LoggerMessage,
  Word as TesseractWord,
  Worker as TesseractWorker,
} from 'tesseract.js';
import { blobSize } from '@/lib/image/io';
import { languageLabel } from './languages';

/**
 * Text recognition on top of tesseract.js.
 *
 * The engine is expensive to start (a WebAssembly core plus a multi-megabyte
 * language model), so workers are created lazily, cached per language and
 * reused for every page — starting one per page turns a two-second scan into a
 * fifteen-second one. Recognition itself runs inside tesseract's own web
 * worker, so the main thread stays free.
 */

/** Progress for a single recognition pass; `progress` is 0..1. */
export interface OcrProgress {
  /** Human-readable stage, safe to render directly. */
  status: string;
  progress: number;
}

/**
 * Each live engine holds tens of megabytes of WebAssembly heap, which is what
 * pushes low-end phones into a tab reload. Two covers "switch language, switch
 * back" without hoarding.
 */
const MAX_CACHED_WORKERS = 2;

/** Marks the errors we have already turned into a user-facing message. */
class OcrError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OcrError';
  }
}

interface ProgressSink {
  current: ((message: LoggerMessage) => void) | null;
}

interface WorkerEntry {
  language: string;
  worker: Promise<TesseractWorker>;
  /** Serialises jobs so progress events from two pages cannot interleave. */
  queue: Promise<unknown>;
  /** Number of jobs queued or running; a busy engine is never evicted. */
  busy: number;
  lastUsed: number;
  sink: ProgressSink;
}

const workers = new Map<string, WorkerEntry>();

/** tesseract's stage names are internal jargon; these are what the user sees. */
const STATUS_LABELS: Record<string, string> = {
  'loading tesseract core': 'Starting the OCR engine',
  'initializing tesseract': 'Starting the OCR engine',
  'loading language traineddata': 'Downloading language data',
  'loading language traineddata (from cache)': 'Loading language data',
  'initializing api': 'Preparing to read',
  'recognizing text': 'Reading text',
};

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Whether OCR can run right now, and why not when it cannot.
 *
 * Being offline only blocks the *first* recognition: once a language is loaded
 * its engine stays cached in memory, so a warm session keeps working with no
 * connection.
 */
export function ocrAvailability(): { available: boolean; reason?: string } {
  if (typeof WebAssembly === 'undefined') {
    return {
      available: false,
      reason: 'This browser cannot read text from images — it has no WebAssembly support.',
    };
  }
  if (typeof Worker === 'undefined') {
    return {
      available: false,
      reason: 'This browser cannot read text from images — it has no Web Worker support.',
    };
  }
  if (isOffline() && workers.size === 0) {
    return {
      available: false,
      reason: 'Reading text needs to download language data the first time. Connect to the internet and try again.',
    };
  }
  return { available: true };
}

function engineError(language: string, cause: unknown): OcrError {
  const label = languageLabel(language);
  return new OcrError(
    isOffline()
      ? `Could not download the ${label} language data because you are offline. Reconnect and try again.`
      : `Could not load the ${label} language data. Check your connection, then try again.`,
    { cause },
  );
}

function createEntry(language: string): WorkerEntry {
  const sink: ProgressSink = { current: null };
  const worker = (async () => {
    // Imported on demand so the ~1 MB tesseract bundle never lands in the main
    // chunk — most sessions never run OCR at all.
    const { createWorker } = await import('tesseract.js');
    const instance = await createWorker(language, undefined, {
      logger: (message) => sink.current?.(message),
      // Without a handler tesseract.js rethrows inside its own message pump,
      // which surfaces as an unhandled error instead of a rejected promise.
      errorHandler: () => undefined,
    });
    // Keeps runs of spaces in `data.text`, which is what lets the spreadsheet
    // export see columns.
    await instance.setParameters({ preserve_interword_spaces: '1' });
    return instance;
  })();
  return { language, worker, queue: Promise.resolve(), busy: 0, lastUsed: Date.now(), sink };
}

/** Never rejects: a worker that failed to load has nothing to tear down. */
async function disposeEntry(entry: WorkerEntry): Promise<void> {
  try {
    const worker = await entry.worker;
    await worker.terminate();
  } catch {
    /* already gone */
  }
}

/** Drop the least recently used *idle* engines until the cache fits its budget. */
function evictIdle(): void {
  while (workers.size > MAX_CACHED_WORKERS) {
    let victim: WorkerEntry | null = null;
    for (const entry of workers.values()) {
      if (entry.busy > 0) continue;
      if (!victim || entry.lastUsed < victim.lastUsed) victim = entry;
    }
    if (!victim) return;
    workers.delete(victim.language);
    void disposeEntry(victim);
  }
}

/** Reserve an engine for one job. The caller owns the matching `busy` decrement. */
function acquire(language: string): WorkerEntry {
  let entry = workers.get(language);
  if (!entry) {
    entry = createEntry(language);
    workers.set(language, entry);
  }
  entry.busy += 1;
  entry.lastUsed = Date.now();
  evictIdle();
  return entry;
}

function mapProgress(message: LoggerMessage): OcrProgress {
  const raw = message.status ?? '';
  const status = STATUS_LABELS[raw] ?? (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Working');
  return { status, progress: clamp01(message.progress ?? 0) };
}

function normalizeBox(box: Bbox, width: number, height: number) {
  return {
    x: clamp01(box.x0 / width),
    y: clamp01(box.y0 / height),
    width: clamp01((box.x1 - box.x0) / width),
    height: clamp01((box.y1 - box.y0) / height),
  };
}

function toOcrWord(word: TesseractWord, width: number, height: number): OcrWord {
  return {
    text: word.text,
    ...normalizeBox(word.bbox, width, height),
    // Tesseract reports 0..100; every other score in OpenScan is 0..1.
    confidence: clamp01(word.confidence / 100),
  };
}

function toOcrLine(line: TesseractLine, width: number, height: number): OcrLine {
  return {
    text: line.text.replace(/\s+$/, ''),
    ...normalizeBox(line.bbox, width, height),
    words: line.words
      .filter((word) => word.text.trim() !== '')
      .map((word) => toOcrWord(word, width, height)),
  };
}

/**
 * Recognise the text in an image.
 *
 * Every box in the result is normalised to 0..1 of the image, so results stay
 * valid when the page is re-rendered at another resolution, and confidences are
 * 0..1 rather than tesseract's 0..100.
 *
 * @param blob the processed page image.
 * @param language a Tesseract language code, optionally `+`-joined (`eng+deu`).
 * @param onProgress called as the engine loads and reads.
 * @throws an `Error` whose message can be shown to the user as-is — a missing
 * network or a blocked CDN never surfaces as a raw fetch error.
 */
export async function recognizeImage(
  blob: Blob,
  language: string,
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrResult> {
  const availability = ocrAvailability();
  if (!availability.available) {
    throw new OcrError(availability.reason ?? 'Reading text is not available in this browser.');
  }

  // Tesseract reports boxes in source pixels and never tells us the image size,
  // so we measure it ourselves to normalise them.
  const size = await blobSize(blob).catch(() => null);
  if (!size || size.width < 1 || size.height < 1) {
    throw new OcrError('That image could not be opened for text recognition.');
  }

  const entry = acquire(language);

  const run = async (): Promise<OcrResult> => {
    entry.sink.current = onProgress ? (message) => onProgress(mapProgress(message)) : null;
    try {
      const worker = await entry.worker.catch((cause: unknown) => {
        // A failed load must not poison the cache, or a retry after reconnecting
        // would keep replaying the same failure.
        workers.delete(entry.language);
        throw engineError(entry.language, cause);
      });
      const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });

      const lines: OcrLine[] = [];
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            const mapped = toOcrLine(line, size.width, size.height);
            if (mapped.text.trim() !== '') lines.push(mapped);
          }
        }
      }

      return {
        language,
        text: (data.text ?? '').replace(/\s+$/, ''),
        lines,
        confidence: clamp01(data.confidence / 100),
        completedAt: Date.now(),
      };
    } catch (cause) {
      if (cause instanceof OcrError) throw cause;
      throw new OcrError('Could not read the text on this page. Try again, or choose a different language.', { cause });
    } finally {
      entry.sink.current = null;
      entry.busy -= 1;
      entry.lastUsed = Date.now();
    }
  };

  const result = entry.queue.then(run);
  // The queue has to survive a failed job, otherwise one bad page wedges the
  // engine for the rest of the session.
  entry.queue = result.catch(() => undefined);
  return result;
}

/**
 * Terminate every cached engine and release its WebAssembly heap. Call this
 * when OCR is turned off in settings, or when tearing the app down. Jobs still
 * in flight reject.
 */
export async function terminateOcr(): Promise<void> {
  const entries = [...workers.values()];
  workers.clear();
  await Promise.all(entries.map(disposeEntry));
}
