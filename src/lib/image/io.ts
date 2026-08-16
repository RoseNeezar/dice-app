import type { RasterImage, Size } from '@/types';

/**
 * Image encode/decode helpers that work identically on the main thread and in
 * a worker: `OffscreenCanvas` where available, a DOM canvas otherwise.
 */

export type CanvasLike = OffscreenCanvas | HTMLCanvasElement;

export function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

export function makeCanvas(width: number, height: number): CanvasLike {
  if (hasOffscreenCanvas()) return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') {
    throw new Error('No canvas implementation available in this context');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: CanvasLike): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d', { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('Could not acquire a 2D canvas context');
  return ctx;
}

export async function decodeToBitmap(source: Blob | ImageBitmapSource): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'undefined') {
    throw new Error('createImageBitmap is not supported in this browser');
  }
  return createImageBitmap(source as ImageBitmapSource);
}

/** Decode any image blob into raw RGBA pixels. */
export async function blobToRaster(blob: Blob, maxEdge?: number): Promise<RasterImage> {
  const bitmap = await decodeToBitmap(blob);
  try {
    let { width, height } = bitmap;
    if (maxEdge) {
      const longest = Math.max(width, height);
      if (longest > maxEdge) {
        const k = maxEdge / longest;
        width = Math.max(1, Math.round(width * k));
        height = Math.max(1, Math.round(height * k));
      }
    }
    const canvas = makeCanvas(width, height);
    const ctx = context2d(canvas);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height);
    return { width: data.width, height: data.height, data: data.data };
  } finally {
    bitmap.close();
  }
}

export function bitmapToRaster(bitmap: ImageBitmap | HTMLVideoElement, size?: Size): RasterImage {
  const width = size?.width ?? ('videoWidth' in bitmap ? bitmap.videoWidth : bitmap.width);
  const height = size?.height ?? ('videoHeight' in bitmap ? bitmap.videoHeight : bitmap.height);
  const canvas = makeCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  return { width: data.width, height: data.height, data: data.data };
}

export function rasterToImageData(raster: RasterImage): ImageData {
  if (typeof ImageData !== 'undefined') {
    return new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height);
  }
  throw new Error('ImageData is not available in this context');
}

export function rasterToCanvas(raster: RasterImage): CanvasLike {
  const canvas = makeCanvas(raster.width, raster.height);
  const ctx = context2d(canvas);
  ctx.putImageData(rasterToImageData(raster), 0, 0);
  return canvas;
}

export async function canvasToBlob(canvas: CanvasLike, type = 'image/jpeg', quality = 0.86): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas encoding failed'))),
      type,
      quality,
    );
  });
}

export async function rasterToBlob(raster: RasterImage, type = 'image/jpeg', quality = 0.86): Promise<Blob> {
  return canvasToBlob(rasterToCanvas(raster), type, quality);
}

/** JPEG for photos, PNG when the source needs transparency (signatures). */
export async function rasterToJpeg(raster: RasterImage, quality: number): Promise<Blob> {
  return rasterToBlob(raster, 'image/jpeg', quality);
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader === 'undefined') {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    return `data:${blob.type};base64,${btoa(binary)}`;
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read blob'));
    reader.readAsDataURL(blob);
  });
}

export async function blobSize(blob: Blob): Promise<Size> {
  const bitmap = await decodeToBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}
