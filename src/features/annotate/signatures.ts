import type { ID, Point } from '@/types';
import { deleteBlobs, getKv, putBlob, setKv } from '@/lib/db/repository';
import { canvasToBlob, makeCanvas } from '@/lib/image/io';

/**
 * Ink model and signature library.
 *
 * Everything here is deliberately free of React and of the DOM (bar the two
 * rasterising helpers at the bottom) so the stroke maths can be unit tested and
 * reused by the annotation layer's freehand tool.
 *
 * A signature drawn with a constant line width reads as a marker pen. Real ink
 * thins out as the nib accelerates, so strokes are sampled with timestamps and
 * turned into a per-point width before being smoothed.
 */

/** A sampled pointer position, in the coordinate space it was captured in. */
export interface InkPoint extends Point {
  /** Milliseconds, from any monotonic clock; only differences are used. */
  t: number;
}

/** A pen-down..pen-up stroke: positions with a width for each of them. */
export interface InkStroke {
  points: Point[];
  /** Same length as `points`. */
  widths: number[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Speed-to-width curve. Widths are in the stroke's own coordinate space. */
export interface InkModel {
  minWidth: number;
  maxWidth: number;
  /** Speed, in units per millisecond, at which the pen reaches `minWidth`. */
  speedRef: number;
  /** 0..1 inertia of the width filter; higher is smoother but less responsive. */
  smoothing: number;
}

/**
 * Tuned for a signature pad a few hundred CSS pixels wide: signing across it in
 * roughly a third of a second is "fast", which is where the line goes thin.
 */
export const DEFAULT_INK: InkModel = {
  minWidth: 1.1,
  maxWidth: 4.4,
  speedRef: 1.3,
  smoothing: 0.5,
};

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/* ------------------------------------------------------------------ */
/* Stroke shaping                                                      */
/* ------------------------------------------------------------------ */

/**
 * One round of Chaikin corner cutting: every segment is replaced by its
 * quarter and three-quarter points. Endpoints are kept so a stroke never
 * shrinks away from where the pen actually touched down and lifted.
 */
function chaikinPoints(points: readonly Point[]): Point[] {
  if (points.length < 3) return points.map((p) => ({ x: p.x, y: p.y }));
  const out: Point[] = [{ x: points[0].x, y: points[0].y }];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    out.push({ x: a.x + (b.x - a.x) * 0.25, y: a.y + (b.y - a.y) * 0.25 });
    out.push({ x: a.x + (b.x - a.x) * 0.75, y: a.y + (b.y - a.y) * 0.75 });
  }
  const last = points[points.length - 1];
  out.push({ x: last.x, y: last.y });
  return out;
}

/** The scalar twin of {@link chaikinPoints}, so widths stay aligned to points. */
function chaikinValues(values: readonly number[]): number[] {
  if (values.length < 3) return [...values];
  const out: number[] = [values[0]];
  for (let i = 0; i < values.length - 1; i++) {
    const a = values[i];
    const b = values[i + 1];
    out.push(a + (b - a) * 0.25, a + (b - a) * 0.75);
  }
  out.push(values[values.length - 1]);
  return out;
}

/** Round off the corners a finger leaves behind. Endpoints are preserved. */
export function smoothPath(points: readonly Point[], iterations = 1): Point[] {
  let out = points.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < iterations; i++) out = chaikinPoints(out);
  return out;
}

/**
 * Width for every sample: slow strokes come out at `maxWidth`, strokes at or
 * above `speedRef` at `minWidth`, with an exponential filter so a single jittery
 * sample cannot pinch the line.
 */
export function strokeWidths(points: readonly InkPoint[], model: InkModel = DEFAULT_INK): number[] {
  const n = points.length;
  if (n === 0) return [];
  const blend = 1 - clamp01(model.smoothing);
  const widths: number[] = new Array<number>(n);
  let current = 0;
  for (let i = 0; i < n; i++) {
    // The first sample has no preceding segment, so it borrows the speed of the
    // one that follows: a stroke that starts fast should start thin.
    const a = i === 0 ? points[0] : points[i - 1];
    const b = i === 0 ? points[Math.min(1, n - 1)] : points[i];
    const dt = Math.max(1, b.t - a.t);
    const speed = Math.hypot(b.x - a.x, b.y - a.y) / dt;
    const k = clamp01(speed / model.speedRef);
    const target = model.maxWidth + (model.minWidth - model.maxWidth) * k;
    current = i === 0 ? target : current + (target - current) * blend;
    widths[i] = current;
  }
  return widths;
}

/**
 * Turn raw samples into a drawable stroke: widths from the timing, then the
 * same corner cutting applied to positions and widths together.
 */
export function buildStroke(raw: readonly InkPoint[], model: InkModel = DEFAULT_INK, iterations = 2): InkStroke {
  let points: Point[] = raw.map((p) => ({ x: p.x, y: p.y }));
  let widths = strokeWidths(raw, model);
  for (let i = 0; i < iterations; i++) {
    points = chaikinPoints(points);
    widths = chaikinValues(widths);
  }
  return { points, widths };
}

/* ------------------------------------------------------------------ */
/* Bounds and trimming                                                 */
/* ------------------------------------------------------------------ */

/**
 * The box the ink actually covers, half a stroke width proud of the centre
 * lines so nothing is clipped when it is rendered.
 */
export function inkBounds(strokes: readonly InkStroke[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (let i = 0; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      const half = (stroke.widths[i] ?? 0) / 2;
      if (p.x - half < minX) minX = p.x - half;
      if (p.y - half < minY) minY = p.y - half;
      if (p.x + half > maxX) maxX = p.x + half;
      if (p.y + half > maxY) maxY = p.y + half;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface TrimResult {
  strokes: InkStroke[];
  width: number;
  height: number;
}

/**
 * Move the ink to the origin and scale it, dropping the empty margin around a
 * signature. This is what keeps a stamped signature from carrying a large
 * invisible box that fights with the page underneath it.
 *
 * @param padding extra space on every side, in the *source* coordinate space.
 * @param scale applied to positions and widths alike.
 */
export function trimStrokes(strokes: readonly InkStroke[], padding = 0, scale = 1): TrimResult | null {
  const bounds = inkBounds(strokes);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const originX = bounds.x - padding;
  const originY = bounds.y - padding;
  return {
    strokes: strokes.map((stroke) => ({
      points: stroke.points.map((p) => ({ x: (p.x - originX) * scale, y: (p.y - originY) * scale })),
      widths: stroke.widths.map((w) => w * scale),
    })),
    width: (bounds.width + padding * 2) * scale,
    height: (bounds.height + padding * 2) * scale,
  };
}

/* ------------------------------------------------------------------ */
/* Rasterising                                                         */
/* ------------------------------------------------------------------ */

type InkContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Paint ink onto a context. Each segment is stroked at the average of its two
 * endpoint widths, which is what gives the line its taper — a single path with
 * one `lineWidth` cannot vary.
 */
export function drawInk(ctx: InkContext, strokes: readonly InkStroke[], color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    const { points, widths } = stroke;
    if (points.length === 0) continue;
    if (points.length === 1) {
      // A tap still leaves a dot — a dropped i-dot looks like a bug.
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, Math.max(0.5, (widths[0] ?? 1) / 2), 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    for (let i = 1; i < points.length; i++) {
      ctx.beginPath();
      ctx.lineWidth = Math.max(0.4, ((widths[i - 1] ?? 1) + (widths[i] ?? 1)) / 2);
      ctx.moveTo(points[i - 1].x, points[i - 1].y);
      ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export interface SignaturePngOptions {
  color: string;
  /** Height of the exported PNG in pixels; the width follows the ink. */
  height?: number;
  /** Breathing room around the ink, as a fraction of its height. */
  padding?: number;
}

/**
 * Render strokes to a transparent PNG trimmed to the ink.
 *
 * Transparency is the whole point: a signature stamped onto a page must not
 * bring a white rectangle with it. The canvas is never cleared to a colour, so
 * everything the pen did not touch stays fully transparent.
 *
 * @returns the PNG, or null when there is no ink to export.
 */
export async function signaturePng(
  strokes: readonly InkStroke[],
  { color, height = 320, padding = 0.06 }: SignaturePngOptions,
): Promise<Blob | null> {
  const bounds = inkBounds(strokes);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const pad = bounds.height * padding;
  const scale = height / (bounds.height + pad * 2);
  const trimmed = trimStrokes(strokes, pad, scale);
  if (!trimmed) return null;
  const width = Math.max(1, Math.round(trimmed.width));
  const canvas = makeCanvas(width, Math.max(1, Math.round(trimmed.height)));
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as InkContext | null;
  if (!ctx) throw new Error('Could not prepare a canvas for the signature');
  drawInk(ctx, trimmed.strokes, color);
  return canvasToBlob(canvas, 'image/png');
}

/* ------------------------------------------------------------------ */
/* Saved signature library                                             */
/* ------------------------------------------------------------------ */

/**
 * Key of the blob-id list in the kv store. Garbage collection treats every id
 * in it as live, which is what lets a saved signature outlive the page it was
 * first stamped on.
 */
export const SIGNATURES_KEY = 'signatures';

/** Beyond this the picker stops being a picker; the oldest fall off the end. */
export const MAX_SIGNATURES = 12;

/** Most recent first, de-duplicated, capped. Pure. */
export function appendSignatureId(list: readonly ID[], id: ID, max = MAX_SIGNATURES): ID[] {
  return [id, ...list.filter((other) => other !== id)].slice(0, Math.max(1, max));
}

/** Pure. */
export function removeSignatureId(list: readonly ID[], id: ID): ID[] {
  return list.filter((other) => other !== id);
}

/** Blob ids of the saved signatures, most recent first. */
export async function listSignatures(): Promise<ID[]> {
  const stored = await getKv<unknown>(SIGNATURES_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter((id): id is ID => typeof id === 'string' && id.length > 0);
}

/** Store a signature PNG and remember it for reuse. Returns its blob id. */
export async function saveSignature(png: Blob): Promise<ID> {
  const id = await putBlob(png);
  const list = await listSignatures();
  const next = appendSignatureId(list, id);
  await setKv(SIGNATURES_KEY, next);
  // Anything pushed off the end is unreferenced unless a page stamped it, and
  // collectGarbage() only spares blobs that a page or this list still names.
  return id;
}

/**
 * Forget a saved signature. The blob is deleted only when no page still uses
 * it — pages that were already signed keep their stamp.
 *
 * @returns the remaining ids.
 */
export async function deleteSignature(id: ID, inUse = false): Promise<ID[]> {
  const next = removeSignatureId(await listSignatures(), id);
  await setKv(SIGNATURES_KEY, next);
  if (!inUse) await deleteBlobs([id]);
  return next;
}
