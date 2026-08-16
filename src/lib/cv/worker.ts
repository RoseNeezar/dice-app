/// <reference lib="webworker" />
import type { DetectionResult, PageEdits, RasterImage, Size } from '@/types';
import { detectDocument } from './detect';
import { renderPage, renderThumbnail } from './pipeline';
import { blobToRaster, rasterToBlob } from '@/lib/image/io';

export type WorkerRequest =
  | { id: number; type: 'detect'; raster: RasterImage }
  | {
      id: number;
      type: 'render';
      source: { kind: 'blob'; blob: Blob } | { kind: 'raster'; raster: RasterImage };
      edits: PageEdits;
      maxEdge: number;
      thumbEdge: number;
      quality: number;
    };

export type WorkerResponse =
  | { id: number; ok: true; type: 'detect'; result: DetectionResult }
  | { id: number; ok: true; type: 'render'; full: Blob; thumb: Blob; size: Size }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data);
});

async function handle(request: WorkerRequest): Promise<void> {
  try {
    if (request.type === 'detect') {
      const result = detectDocument(request.raster);
      post({ id: request.id, ok: true, type: 'detect', result });
      return;
    }

    const source =
      request.source.kind === 'blob' ? await blobToRaster(request.source.blob) : request.source.raster;
    const processed = renderPage(source, request.edits, { maxEdge: request.maxEdge });
    const thumb = renderThumbnail(processed, request.thumbEdge);
    const isBinary = request.edits.filter === 'bw';
    const [full, thumbBlob] = await Promise.all([
      rasterToBlob(processed, 'image/jpeg', isBinary ? Math.min(0.95, request.quality + 0.08) : request.quality),
      rasterToBlob(thumb, 'image/jpeg', 0.75),
    ]);
    post({
      id: request.id,
      ok: true,
      type: 'render',
      full,
      thumb: thumbBlob,
      size: { width: processed.width, height: processed.height },
    });
  } catch (error) {
    post({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function post(message: WorkerResponse): void {
  ctx.postMessage(message);
}
