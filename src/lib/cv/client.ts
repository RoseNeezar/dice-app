import type { DetectionResult, PageEdits, RasterImage, Size } from '@/types';
import type { WorkerRequest, WorkerResponse } from './worker';
import { detectDocument } from './detect';
import { renderPage, renderThumbnail } from './pipeline';
import { blobToRaster, rasterToBlob } from '@/lib/image/io';

export interface RenderResult {
  full: Blob;
  thumb: Blob;
  size: Size;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
}

/** `Omit` does not distribute over unions; this does. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type WorkerRequestBody = DistributiveOmit<WorkerRequest, 'id'>;

/**
 * Runs the CV pipeline off the main thread so the camera preview keeps its
 * frame rate. Falls back to synchronous in-thread execution wherever workers
 * are unavailable (older WebViews, some test runners) — same code either way.
 */
class CvClient {
  private worker: Worker | null = null;
  private workerBroken = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private ensureWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') {
      this.workerBroken = true;
      return null;
    }
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (!message.ok) entry.reject(new Error(message.error));
        else if (message.type === 'detect') entry.resolve(message.result as never);
        else entry.resolve({ full: message.full, thumb: message.thumb, size: message.size } as never);
      });
      this.worker.addEventListener('error', () => {
        // Reject everything in flight and permanently fall back in-thread.
        this.workerBroken = true;
        for (const [, entry] of this.pending) entry.reject(new Error('CV worker failed'));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      });
      return this.worker;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  private send<T>(request: WorkerRequestBody, transfer: Transferable[] = []): Promise<T> | null {
    const worker = this.ensureWorker();
    if (!worker) return null;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: never) => void, reject });
      try {
        worker.postMessage({ ...request, id } as WorkerRequest, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Detect the page in a preview frame. */
  async detect(raster: RasterImage): Promise<DetectionResult> {
    const copy: RasterImage = {
      width: raster.width,
      height: raster.height,
      data: new Uint8ClampedArray(raster.data),
    };
    const promise = this.send<DetectionResult>({ type: 'detect', raster: copy }, [copy.data.buffer]);
    if (promise) {
      try {
        return await promise;
      } catch {
        return detectDocument(raster);
      }
    }
    return detectDocument(raster);
  }

  /** Apply edits to a stored capture and return encoded full + thumbnail. */
  async render(
    source: Blob | RasterImage,
    edits: PageEdits,
    options: { maxEdge?: number; thumbEdge?: number; quality?: number } = {},
  ): Promise<RenderResult> {
    const maxEdge = options.maxEdge ?? 2400;
    const thumbEdge = options.thumbEdge ?? 360;
    const quality = options.quality ?? 0.86;
    const isBlob = source instanceof Blob;
    const promise = this.send<RenderResult>(
      {
        type: 'render',
        source: isBlob ? { kind: 'blob', blob: source } : { kind: 'raster', raster: source },
        edits,
        maxEdge,
        thumbEdge,
        quality,
      },
      [],
    );
    if (promise) {
      try {
        return await promise;
      } catch {
        // fall through to the in-thread path
      }
    }
    return renderInThread(source, edits, maxEdge, thumbEdge, quality);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

export async function renderInThread(
  source: Blob | RasterImage,
  edits: PageEdits,
  maxEdge: number,
  thumbEdge: number,
  quality: number,
): Promise<RenderResult> {
  const raster = source instanceof Blob ? await blobToRaster(source) : source;
  const processed = renderPage(raster, edits, { maxEdge });
  const thumb = renderThumbnail(processed, thumbEdge);
  const isBinary = edits.filter === 'bw';
  const [full, thumbBlob] = await Promise.all([
    rasterToBlob(processed, 'image/jpeg', isBinary ? Math.min(0.95, quality + 0.08) : quality),
    rasterToBlob(thumb, 'image/jpeg', 0.75),
  ]);
  return { full, thumb: thumbBlob, size: { width: processed.width, height: processed.height } };
}

export const cv = new CvClient();
