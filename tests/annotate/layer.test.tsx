import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Annotation } from '@/types';
import { AnnotationLayer } from '@/features/annotate/AnnotationLayer';
import { ViewerScreen } from '@/screens/ViewerScreen';

/**
 * A render smoke test: every annotation kind has to survive being drawn, and
 * the box semantics (percentage geometry, clockwise rotation about the centre)
 * have to match what the exporter bakes in.
 */
const annotations: Annotation[] = [
  {
    id: 'a1',
    kind: 'text',
    x: 0.1,
    y: 0.2,
    width: 0.5,
    height: 0.1,
    rotation: 12,
    opacity: 1,
    text: 'Hello',
    color: '#101418',
    fontScale: 0.04,
    fontFamily: 'serif',
    bold: true,
    italic: true,
    align: 'center',
  },
  { id: 'a2', kind: 'highlight', x: 0.1, y: 0.3, width: 0.5, height: 0.05, rotation: 0, opacity: 1, color: '#ffe14d' },
  { id: 'a3', kind: 'redact', x: 0.1, y: 0.4, width: 0.2, height: 0.05, rotation: 0, opacity: 0.3 },
  {
    id: 'a4',
    kind: 'draw',
    x: 0.1,
    y: 0.5,
    width: 0.2,
    height: 0.1,
    rotation: 30,
    opacity: 1,
    strokes: [
      [
        { x: 0.1, y: 0.5 },
        { x: 0.3, y: 0.6 },
      ],
    ],
    color: '#d62b20',
    widthScale: 0.004,
  },
  { id: 'a5', kind: 'signature', x: 0.2, y: 0.7, width: 0.3, height: 0.1, rotation: 0, opacity: 1, blobId: 'b1' },
  { id: 'a6', kind: 'image', x: 0.2, y: 0.8, width: 0.3, height: 0.1, rotation: 0, opacity: 1, blobId: 'b2' },
];

describe('AnnotationLayer', () => {
  const html = renderToStaticMarkup(<AnnotationLayer annotations={annotations} />);

  it('draws every kind of mark', () => {
    expect(html).toContain('annot__text');
    expect(html).toContain('annot__highlight');
    expect(html).toContain('annot__redact');
    expect(html).toContain('annot__ink');
  });

  it('places marks with percentage geometry', () => {
    expect(html).toContain('left:10%');
    expect(html).toContain('width:50%');
  });

  it('rotates clockwise about the box centre, like the exporter', () => {
    expect(html).toContain('rotate(12deg)');
    expect(html).toContain('rotate(30 ');
  });

  it('keeps redaction opaque whatever the annotation says', () => {
    expect(html).not.toContain('opacity:0.3');
  });

  it('is inert until it is made active', () => {
    expect(html).not.toContain('is-active');
    expect(html).not.toContain('annot__capture');
  });
});

describe('ViewerScreen', () => {
  it('explains itself when the page it was opened on has gone', () => {
    const html = renderToStaticMarkup(<ViewerScreen docId="missing" pageId="missing" />);
    expect(html).toContain('That page is gone');
  });
});
