import type { CSSProperties } from 'react';
import type { Point, Size } from '@/types';
import type { Rect } from './CropCanvas';

/** Diameter of the loupe in CSS pixels. */
const SIZE = 116;
/** How far above the finger the loupe floats, so the hand never covers it. */
const GAP = 40;
/** Keep-out margin from the container edges. */
const MARGIN = 8;

/**
 * Where the loupe should sit so it stays on screen and out from under the
 * finger: above the touch point by default, below it when there is no room.
 * Returns the top-left corner in container coordinates.
 */
export function loupePlacement(anchor: Point, container: Size, size = SIZE, gap = GAP): Point {
  const above = anchor.y - gap - size;
  const below = anchor.y + gap;
  const maxY = Math.max(MARGIN, container.height - size - MARGIN);
  const maxX = Math.max(MARGIN, container.width - size - MARGIN);
  const y = above < MARGIN ? Math.min(below, maxY) : above;
  return {
    x: Math.min(maxX, Math.max(MARGIN, anchor.x - size / 2)),
    y: Math.min(maxY, Math.max(MARGIN, y)),
  };
}

export interface MagnifierProps {
  /** Object URL of the image being inspected. */
  src: string;
  /** Where that image is drawn inside the container, in CSS pixels. */
  imageRect: Rect;
  /** Point to centre in the loupe — the handle, not the finger. */
  focus: Point;
  /** The finger, used only to place the loupe. */
  anchor: Point;
  /** Size of the container the loupe is positioned within. */
  container: Size;
  /** Magnification relative to the on-screen image. */
  zoom?: number;
  /** Diameter in CSS pixels. */
  size?: number;
}

/**
 * A circular loupe that magnifies the pixels under a crop handle.
 *
 * The magnification is a scaled `background-image` rather than a canvas copy:
 * the browser samples the full-resolution source directly, so the view stays
 * sharp on high-density screens and costs nothing per frame.
 *
 * Styles live in CropCanvas.css — this component is only ever rendered there.
 */
export function Magnifier({ src, imageRect, focus, anchor, container, zoom = 2.5, size = SIZE }: MagnifierProps) {
  const position = loupePlacement(anchor, container, size);
  const style: CSSProperties = {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${size}px`,
    height: `${size}px`,
  };
  const glass: CSSProperties = {
    backgroundImage: `url("${src}")`,
    backgroundSize: `${imageRect.width * zoom}px ${imageRect.height * zoom}px`,
    backgroundPosition: `${size / 2 - (focus.x - imageRect.x) * zoom}px ${
      size / 2 - (focus.y - imageRect.y) * zoom
    }px`,
  };

  return (
    <div className="magnifier" style={style} aria-hidden="true">
      <div className="magnifier__glass" style={glass} />
      <svg className="magnifier__cross" viewBox="0 0 100 100" focusable="false">
        <path d="M50 34V46M50 54V66M34 50H46M54 50H66" />
        <circle cx="50" cy="50" r="9" />
      </svg>
    </div>
  );
}
