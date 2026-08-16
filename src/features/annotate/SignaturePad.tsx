import { useCallback, useEffect, useRef, useState } from 'react';
import type { ID } from '@/types';
import { useStore } from '@/state/store';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { Button, EmptyState, IconButton, Spinner } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import {
  type InkPoint,
  type InkStroke,
  buildStroke,
  deleteSignature,
  drawInk,
  listSignatures,
  saveSignature,
  signaturePng,
} from './signatures';
import './SignaturePad.css';

/**
 * Ink colours are content, not chrome: a signature is blue or black whichever
 * theme the app is in, and it has to survive being stamped on a white page.
 */
const INK_COLORS: { value: string; label: string }[] = [
  { value: '#101418', label: 'Black ink' },
  { value: '#14389c', label: 'Blue ink' },
  { value: '#9c1414', label: 'Red ink' },
];

/* ------------------------------------------------------------------ */
/* Pad                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A canvas you sign on with a finger or a stylus.
 *
 * Strokes are captured with timestamps and rendered through the shared ink
 * model, so the line thins as the pen accelerates instead of reading like a
 * marker. Painting happens inside `requestAnimationFrame`, never per pointer
 * event, so a fast signature does not stall the main thread.
 */
export function SignaturePad({ onSaved, onCancel }: { onSaved: (blobId: ID) => void; onCancel: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<InkStroke[]>([]);
  const liveRef = useRef<InkPoint[]>([]);
  const pointerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const dprRef = useRef(1);

  const [color, setColor] = useState(INK_COLORS[0].value);
  const [strokeCount, setStrokeCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = dprRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    drawInk(ctx, strokesRef.current, color);
    if (liveRef.current.length > 0) drawInk(ctx, [buildStroke(liveRef.current)], color);
  }, [color]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      paint();
    });
  }, [paint]);

  /* Keep the backing store in device pixels so the ink is not soft on retina. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      dprRef.current = dpr;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      paint();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    return () => observer.disconnect();
  }, [paint]);

  useEffect(() => {
    schedule();
  }, [color, schedule]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const sample = useCallback((event: React.PointerEvent<HTMLCanvasElement>, point: { clientX: number; clientY: number }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    liveRef.current.push({
      x: point.clientX - bounds.left,
      y: point.clientY - bounds.top,
      t: performance.now(),
    });
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (pointerRef.current !== null) return;
      pointerRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      liveRef.current = [];
      sample(event, event);
      schedule();
    },
    [sample, schedule],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (pointerRef.current !== event.pointerId) return;
      // Coalesced events recover the samples the browser batched into this
      // frame, which is the difference between a smooth curve and a polygon.
      const native = event.nativeEvent;
      const points = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      if (points.length > 0) for (const point of points) sample(event, point);
      else sample(event, event);
      schedule();
    },
    [sample, schedule],
  );

  const endStroke = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (pointerRef.current !== event.pointerId) return;
      pointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (liveRef.current.length > 0) {
        strokesRef.current = [...strokesRef.current, buildStroke(liveRef.current)];
        liveRef.current = [];
        setStrokeCount(strokesRef.current.length);
      }
      schedule();
    },
    [schedule],
  );

  const undo = useCallback(() => {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    schedule();
  }, [schedule]);

  const clear = useCallback(() => {
    strokesRef.current = [];
    liveRef.current = [];
    setStrokeCount(0);
    schedule();
  }, [schedule]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const png = await signaturePng(strokesRef.current, { color });
      if (!png) {
        useStore.getState().notify('Draw your signature before saving it', 'error');
        return;
      }
      onSaved(await saveSignature(png));
    } catch (error) {
      useStore
        .getState()
        .notify(error instanceof Error ? error.message : 'Could not save that signature', 'error');
    } finally {
      setBusy(false);
    }
  }, [color, onSaved]);

  return (
    <div className="sigpad">
      <div className="sigpad__inks" role="radiogroup" aria-label="Ink colour">
        {INK_COLORS.map((ink) => (
          <button
            key={ink.value}
            type="button"
            role="radio"
            aria-checked={ink.value === color}
            aria-label={ink.label}
            title={ink.label}
            className={`sigpad__ink ${ink.value === color ? 'is-active' : ''}`}
            onClick={() => setColor(ink.value)}
          >
            <span style={{ background: ink.value }} />
          </button>
        ))}
      </div>

      <div className="sigpad__sheet">
        <canvas
          ref={canvasRef}
          className="sigpad__canvas"
          aria-label="Signature pad. Draw your signature with a finger or a stylus."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
        />
        {strokeCount === 0 && (
          <p className="sigpad__hint" aria-hidden="true">
            Sign here
          </p>
        )}
        <span className="sigpad__rule" aria-hidden="true" />
      </div>

      <div className="sigpad__actions">
        <Button icon="undo" onClick={undo} disabled={strokeCount === 0 || busy}>
          Undo
        </Button>
        <Button icon="close" onClick={clear} disabled={strokeCount === 0 || busy}>
          Clear
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={strokeCount === 0 || busy}>
          {busy ? <Spinner size={16} label="Saving the signature" /> : 'Save'}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

function SignatureCard({
  id,
  onPick,
  onDelete,
}: {
  id: ID;
  onPick: (id: ID) => void;
  onDelete: (id: ID) => void;
}) {
  const url = useBlobUrl(id);
  return (
    <li className="siglib__card">
      <button type="button" className="siglib__pick" onClick={() => onPick(id)} aria-label="Use this signature">
        {url ? <img src={url} alt="" /> : <Spinner size={18} label="Loading the signature" />}
      </button>
      <IconButton
        icon="trash"
        label="Delete this signature"
        tone="danger"
        className="siglib__delete"
        onClick={() => onDelete(id)}
      />
    </li>
  );
}

/**
 * The saved-signature picker: reuse one you already drew, or draw a new one.
 *
 * Signatures live in the blob store and are listed in the `signatures` kv key,
 * which is what keeps garbage collection from reclaiming a signature that no
 * page happens to be using right now.
 */
export function SignatureSheet({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the blob id of the signature to stamp. */
  onPick: (blobId: ID) => void;
}) {
  const [ids, setIds] = useState<ID[]>([]);
  const [loading, setLoading] = useState(open);
  const [failed, setFailed] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  // Opening the sheet always shows a fresh read of the library.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setLoading(true);
      setFailed(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listSignatures().then(
      (list) => {
        if (!alive) return;
        setIds(list);
        setDrawing(list.length === 0);
        setLoading(false);
      },
      () => {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [open]);

  const remove = useCallback((id: ID) => {
    // A signature already stamped on a page must keep its pixels; only the
    // library entry goes away.
    const inUse = Object.values(useStore.getState().pages).some((page) =>
      page.annotations.some((annotation) => 'blobId' in annotation && annotation.blobId === id),
    );
    void deleteSignature(id, inUse).then(
      (next) => setIds(next),
      () => useStore.getState().notify('Could not delete that signature', 'error'),
    );
  }, []);

  const saved = useCallback(
    (id: ID) => {
      setDrawing(false);
      onPick(id);
    },
    [onPick],
  );

  return (
    <Sheet open={open} title="Signature" onClose={onClose}>
      {drawing ? (
        <SignaturePad onSaved={saved} onCancel={() => (ids.length > 0 ? setDrawing(false) : onClose())} />
      ) : (
        <div className="siglib">
          {loading && (
            <div className="siglib__busy">
              <Spinner size={22} label="Loading your signatures" />
            </div>
          )}
          {failed && !loading && (
            <EmptyState
              icon="info"
              title="Could not open your signatures"
              body="The signature library could not be read from this device's storage."
            />
          )}
          {!loading && !failed && (
            <ul className="siglib__grid">
              {ids.map((id) => (
                <SignatureCard key={id} id={id} onPick={onPick} onDelete={remove} />
              ))}
            </ul>
          )}
          <Button variant="primary" icon="signature" block onClick={() => setDrawing(true)}>
            Draw a new signature
          </Button>
        </div>
      )}
    </Sheet>
  );
}
