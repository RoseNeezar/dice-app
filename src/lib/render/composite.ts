import type { Annotation, ID, Page } from '@/types';
import { getBlob } from '@/lib/db/repository';
import { canvasToBlob, decodeToBitmap, makeCanvas } from '@/lib/image/io';

/**
 * Bake a page's annotations into a flat image.
 *
 * Export paths (PDF, JPEG, share) all go through here so what the viewer shows
 * and what leaves the device are the same pixels. Annotation geometry is
 * normalized to the page, so this works at any output resolution.
 */

const FONT_STACKS: Record<string, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

export async function compositeAnnotations(
  source: Blob,
  annotations: Annotation[],
  resolveBlob: (id: ID) => Promise<Blob | null> = getBlob,
): Promise<Blob> {
  if (annotations.length === 0) return source;
  const bitmap = await decodeToBitmap(source);
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx) {
    bitmap.close();
    return source;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  for (const annotation of annotations) {
    ctx.save();
    ctx.globalAlpha = annotation.opacity;
    const x = annotation.x * width;
    const y = annotation.y * height;
    const w = annotation.width * width;
    const h = annotation.height * height;
    if (annotation.rotation) {
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((annotation.rotation * Math.PI) / 180);
      ctx.translate(-(x + w / 2), -(y + h / 2));
    }

    switch (annotation.kind) {
      case 'text': {
        const fontSize = Math.max(8, annotation.fontScale * height);
        const weight = annotation.bold ? '700' : '400';
        const style = annotation.italic ? 'italic' : 'normal';
        ctx.font = `${style} ${weight} ${fontSize}px ${FONT_STACKS[annotation.fontFamily] ?? FONT_STACKS.sans}`;
        ctx.fillStyle = annotation.color;
        ctx.textBaseline = 'top';
        ctx.textAlign = annotation.align;
        const anchorX = annotation.align === 'center' ? x + w / 2 : annotation.align === 'right' ? x + w : x;
        const lines = wrapText(ctx, annotation.text, w || width);
        lines.forEach((line, i) => {
          ctx.fillText(line, anchorX, y + i * fontSize * 1.25);
        });
        break;
      }
      case 'highlight': {
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = annotation.color;
        ctx.fillRect(x, y, w, h);
        break;
      }
      case 'redact': {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#000000';
        ctx.fillRect(x, y, w, h);
        break;
      }
      case 'draw': {
        ctx.strokeStyle = annotation.color;
        ctx.lineWidth = Math.max(1, annotation.widthScale * width);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const stroke of annotation.strokes) {
          if (stroke.length === 0) continue;
          ctx.beginPath();
          ctx.moveTo(stroke[0].x * width, stroke[0].y * height);
          for (let i = 1; i < stroke.length; i++) {
            ctx.lineTo(stroke[i].x * width, stroke[i].y * height);
          }
          if (stroke.length === 1) ctx.lineTo(stroke[0].x * width + 0.1, stroke[0].y * height);
          ctx.stroke();
        }
        break;
      }
      case 'signature':
      case 'image': {
        const blob = await resolveBlob(annotation.blobId);
        if (blob) {
          const stamp = await decodeToBitmap(blob);
          ctx.drawImage(stamp, x, y, w, h);
          stamp.close();
        }
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }

  return canvasToBlob(canvas, 'image/jpeg', 0.9);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

export interface ExportImage {
  blob: Blob;
  width: number;
  height: number;
}

/** The pixels a page should contribute to any export. */
export async function pageExportImage(page: Page): Promise<ExportImage | null> {
  const processed = await getBlob(page.processedBlobId);
  const source = processed ?? (await getBlob(page.originalBlobId));
  if (!source) return null;
  const blob = await compositeAnnotations(source, page.annotations);
  const size = page.processed ?? page.source;
  if (blob === source) return { blob, width: size.width, height: size.height };
  // Compositing re-encodes at the source resolution, so the size is unchanged.
  return { blob, width: size.width, height: size.height };
}
