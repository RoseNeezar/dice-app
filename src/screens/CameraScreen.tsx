import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { BarcodeResult, CaptureMode, FilterId, ID, Quad } from '@/types';
import { DEFAULT_EDITS } from '@/types';
import { useStore } from '@/state/store';
import { cv } from '@/lib/cv/client';
import { composeIdCard, splitSpread } from '@/lib/cv/pipeline';
import { blobToRaster, rasterToBlob } from '@/lib/image/io';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { Icon } from '@/ui/Icon';
import { Button, IconButton } from '@/ui/primitives';
import { Dialog, Sheet } from '@/ui/Sheet';
import { useCamera } from '@/features/camera/useCamera';
import { useLiveDetection } from '@/features/camera/useLiveDetection';
import { DetectionOverlay } from '@/features/camera/DetectionOverlay';
import { ShutterButton } from '@/features/camera/ShutterButton';
import { ModeStrip, modeInfo } from '@/features/camera/ModeStrip';
import {
  BARCODE_UNSUPPORTED_MESSAGE,
  describeBarcode,
  isBarcodeScanningSupported,
  scanBarcodes,
  toOpenableUrl,
} from '@/features/camera/barcode';
import './CameraScreen.css';

/**
 * The viewfinder.
 *
 * Detection runs on a small copy of the preview, but the quad that is actually
 * stored comes from a fresh detection on the captured still: the still is a
 * different frame (and often a different aspect ratio) from the preview, so
 * reusing the preview quad would crop the wrong rectangle.
 */

/** Longest edge the captured still is decoded to before detection. */
const DETECT_EDGE = 1440;
/** Longest edge of each side of an ID card before the two are composed. */
const ID_CARD_EDGE = 1400;
/** How many capture thumbnails are stacked in the corner. */
const THUMB_STACK = 3;

const FAILURE_ICON = { denied: 'lock', missing: 'camera', error: 'info' } as const;

/** Store actions are read through `getState` so callbacks never go stale. */
const store = () => useStore.getState();

export function CameraScreen({ docId }: { docId: ID }) {
  const session = useStore((s) => s.session);
  const settings = useStore((s) => s.settings);
  const mode = session?.mode ?? settings.defaultCaptureMode;
  const capturedIds = session?.pageIds;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camera = useCamera(videoRef);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const busyRef = useRef(false);
  // Serialises the store writes so pages land in the order they were shot,
  // even though the shutter is released before a page finishes rendering.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const [grid, setGrid] = useState(settings.showGrid);
  const [autoCapture, setAutoCapture] = useState(settings.autoCapture);
  const [idFront, setIdFront] = useState<{ blob: Blob; quad: Quad | null } | null>(null);
  const [scan, setScan] = useState<BarcodeResult | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const codesSupported = isBarcodeScanningSupported();
  const capturedCount = capturedIds?.length ?? 0;
  const blocking = confirmExit || scan !== null;
  const live = camera.status === 'live';

  useEffect(() => () => void audioRef.current?.close(), []);

  /* ---------------- feedback ---------------- */

  const playShutterSound = useCallback(() => {
    if (!settings.shutterSound || typeof AudioContext === 'undefined') return;
    try {
      const ctx = (audioRef.current ??= new AudioContext());
      void ctx.resume();
      const at = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      // A short falling chirp reads as a mechanical shutter without a sample.
      osc.frequency.setValueAtTime(1900, at);
      osc.frequency.exponentialRampToValueAtTime(720, at + 0.05);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.1);
    } catch {
      // Audio is a nicety; a blocked AudioContext must never break capture.
    }
  }, [settings.shutterSound]);

  const shutterFeedback = useCallback(() => {
    setFlashKey((key) => key + 1);
    playShutterSound();
    if (settings.shutterSound && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(14);
    }
  }, [playShutterSound, settings.shutterSound]);

  /* ---------------- storing pages ---------------- */

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = queueRef.current.then(task, task);
    // Keep the chain alive after a rejection so one bad page cannot stall the rest.
    queueRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    setPending((count) => count + 1);
    void queueRef.current.then(() => setPending((count) => count - 1));
    return next;
  }, []);

  const addPage = useCallback(
    (blob: Blob, quad: Quad | null, filter?: FilterId) =>
      enqueue(() =>
        useStore.getState().addCapture(blob, filter ? { quad, filter } : { quad }),
      ),
    [enqueue],
  );

  /** Render one crop of an ID card so both sides can be composed as pixels. */
  const renderSide = useCallback(
    async (side: { blob: Blob; quad: Quad | null }) => {
      const result = await cv.render(
        side.blob,
        { ...DEFAULT_EDITS, quad: side.quad, filter: settings.defaultFilter },
        { maxEdge: Math.min(ID_CARD_EDGE, settings.maxProcessedEdge), quality: settings.jpegQuality },
      );
      return blobToRaster(result.full);
    },
    [settings.defaultFilter, settings.jpegQuality, settings.maxProcessedEdge],
  );

  /* ---------------- capture ---------------- */

  const { capture: grabStill, status: cameraStatus } = camera;

  const runCapture = useCallback(async () => {
    if (busyRef.current || cameraStatus !== 'live') return;
    if (mode === 'qr' && !codesSupported) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const blob = await grabStill(settings.jpegQuality);
      shutterFeedback();

      if (mode === 'qr') {
        const codes = await scanBarcodes(blob);
        if (codes.length === 0) setNote('No code found — move closer and try again');
        else setScan(codes[0]);
        return;
      }

      // Decoding at a reduced edge keeps a 12 MP still from being copied
      // pixel-by-pixel into the worker; the detector downsamples anyway.
      const raster = await blobToRaster(blob, DETECT_EDGE);
      const { quad } = await cv.detect(raster);

      if (mode === 'idcard') {
        if (!idFront) {
          setIdFront({ blob, quad });
          return;
        }
        const [front, back] = await Promise.all([renderSide(idFront), renderSide({ blob, quad })]);
        const composed = await rasterToBlob(composeIdCard(front, back), 'image/jpeg', settings.jpegQuality);
        setIdFront(null);
        setNote('Both sides composed onto one page');
        // The sides were already toned by renderSide, so the composed page must
        // not be filtered a second time.
        await addPage(composed, null, 'original');
        return;
      }

      if (mode === 'book') {
        const [left, right] = splitSpread(quad);
        await addPage(blob, left);
        await addPage(blob, right);
        setNote('Spread split into two pages');
        return;
      }

      const pageId = await addPage(blob, quad);
      if (mode === 'single') {
        if (pageId) await store().endCapture();
        return;
      }
      if (mode === 'ocr') {
        setNote('Captured — run text recognition from review');
        store().notify('Text recognition will run on this page in review');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The capture failed';
      setNote(message);
      store().notify(message, 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [
    addPage,
    cameraStatus,
    codesSupported,
    grabStill,
    idFront,
    mode,
    renderSide,
    settings.jpegQuality,
    shutterFeedback,
  ]);

  const detection = useLiveDetection({
    video: videoRef,
    enabled: live && mode !== 'qr' && !blocking,
    autoCapture: autoCapture && !busy && !blocking,
    onAutoCapture: () => void runCapture(),
  });

  /* ---------------- continuous code scanning ---------------- */

  useEffect(() => {
    if (mode !== 'qr' || !live || scan !== null || !codesSupported) return;
    let alive = true;
    let timer = 0;

    const loop = async () => {
      if (!alive) return;
      try {
        const video = videoRef.current;
        if (video && video.readyState >= 2) {
          const codes = await scanBarcodes(video);
          if (alive && codes.length > 0) {
            if ('vibrate' in navigator) navigator.vibrate(20);
            setScan(codes[0]);
            return;
          }
        }
      } catch {
        // A frame the detector dislikes is not worth reporting; try the next.
      }
      if (alive) timer = window.setTimeout(() => void loop(), 350);
    };

    void loop();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [mode, live, scan, codesSupported, videoRef]);

  /* ---------------- chrome actions ---------------- */

  const onPickFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setBusy(true);
    try {
      const imported = await store().importImages(files, { docId });
      if (imported) await store().endCapture();
    } finally {
      setBusy(false);
    }
  };

  const changeMode = (next: CaptureMode) => {
    // A half-finished ID card cannot survive a mode change.
    if (next !== 'idcard') setIdFront(null);
    store().setCaptureMode(next);
  };

  const toggleGrid = () => {
    const next = !grid;
    setGrid(next);
    void store().updateSettings({ showGrid: next });
  };

  const toggleAuto = () => {
    const next = !autoCapture;
    setAutoCapture(next);
    setNote(next ? 'Auto capture on — hold the page steady' : 'Auto capture off');
    void store().updateSettings({ autoCapture: next });
  };

  const finish = () => {
    void store().endCapture();
  };

  const requestExit = () => {
    if (capturedCount > 0) setConfirmExit(true);
    else void store().endCapture({ discard: true });
  };

  const discardAll = async () => {
    setConfirmExit(false);
    const state = store();
    const current = state.session;
    // `endCapture({discard:true})` only purges documents this session created;
    // pages appended to an existing document have to be removed explicitly.
    if (current?.appending && current.pageIds.length > 0) await state.deletePages(current.pageIds);
    await state.endCapture({ discard: true });
  };

  const copyScan = async () => {
    if (!scan) return;
    try {
      await navigator.clipboard.writeText(scan.text);
      store().notify('Copied to clipboard', 'success');
    } catch {
      store().notify('Could not copy — select and copy the text instead', 'error');
    }
  };

  const scanUrl = scan ? toOpenableUrl(scan.text) : null;

  /* ---------------- status line ---------------- */

  let status = modeInfo(mode).hint;
  if (camera.status === 'starting') status = 'Starting the camera…';
  else if (mode === 'qr' && !codesSupported) status = BARCODE_UNSUPPORTED_MESSAGE;
  else if (idFront) status = 'Now capture the back of the card';
  else if (busy) status = 'Capturing…';
  else if (pending > 0) status = pending === 1 ? 'Processing 1 page…' : `Processing ${pending} pages…`;
  else if (note) status = note;
  else if (autoCapture && detection.quad) status = 'Hold steady…';

  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 2600);
    return () => window.clearTimeout(timer);
  }, [note]);

  const shutterLabel =
    mode === 'qr'
      ? 'Scan the code in view'
      : mode === 'idcard' && idFront
        ? 'Capture the back of the card'
        : `Capture ${modeInfo(mode).label.toLowerCase()}`;

  return (
    <div className="camera">
      <div className={`camera__stage ${camera.facing === 'user' ? 'is-mirrored' : ''}`}>
        <video
          ref={videoRef}
          className="camera__video"
          playsInline
          muted
          autoPlay
          disablePictureInPicture
          tabIndex={-1}
        />
        {live && <DetectionOverlay quad={detection.quad} videoSize={camera.videoSize} />}
        {grid && <div className="camera__grid" aria-hidden="true" />}
        {flashKey > 0 && <div key={flashKey} className="camera__flash" aria-hidden="true" />}
      </div>

      {camera.failure && (
        <div className="camera__fallback" role="alert">
          <span className="camera__fallback-icon">
            <Icon name={FAILURE_ICON[camera.failure.status]} size={30} />
          </span>
          <h2>{camera.failure.title}</h2>
          <p>{camera.failure.hint}</p>
          <div className="camera__fallback-actions">
            {camera.failure.status !== 'missing' && (
              <Button variant="primary" icon="refresh" onClick={camera.retry}>
                Try again
              </Button>
            )}
            <Button variant="secondary" icon="image" onClick={() => fileRef.current?.click()}>
              Import from gallery
            </Button>
          </div>
        </div>
      )}

      <header className="camera__top">
        <IconButton icon="close" label="Close the camera" tone="camera" onClick={requestExit} />
        <div className="camera__top-actions">
          {!camera.failure && (
            <>
              <IconButton
                icon="magic"
                label="Automatic capture"
                tone="camera"
                active={autoCapture}
                onClick={toggleAuto}
              />
              <IconButton
                icon="gridOverlay"
                label="Composition grid"
                tone="camera"
                active={grid}
                onClick={toggleGrid}
              />
            </>
          )}
          {camera.controls.torch && (
            <IconButton
              icon={camera.torchOn ? 'torch' : 'torchOff'}
              label={camera.torchOn ? 'Turn the torch off' : 'Turn the torch on'}
              tone="camera"
              active={camera.torchOn}
              onClick={() => camera.setTorch(!camera.torchOn)}
            />
          )}
          {camera.canSwitch && (
            <IconButton
              icon="switchCamera"
              label={camera.facing === 'environment' ? 'Switch to the front camera' : 'Switch to the back camera'}
              tone="camera"
              onClick={camera.switchFacing}
            />
          )}
        </div>
      </header>

      {!camera.failure && (
        <div className="camera__controls">
          {camera.controls.zoom && (
            <label className="camera__zoom">
              <Icon name="zoomIn" size={18} aria-hidden="true" />
              <input
                type="range"
                min={camera.controls.zoom.min}
                max={camera.controls.zoom.max}
                step={camera.controls.zoom.step}
                value={camera.zoom}
                aria-label="Zoom"
                onChange={(event) => camera.setZoom(Number(event.target.value))}
              />
            </label>
          )}

          <p className="camera__status" role="status">
            {status}
          </p>

          <ModeStrip mode={mode} onChange={changeMode} disabled={busy} />

          <div className="camera__bar">
            <div className="camera__bar-side">
              <IconButton
                icon="image"
                label="Import photos from the gallery"
                tone="camera"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
              />
              {capturedIds && capturedIds.length > 0 && (
                <div className="camera__stack" aria-hidden="true">
                  {capturedIds.slice(-THUMB_STACK).map((pageId, index) => (
                    <CaptureThumb key={pageId} pageId={pageId} index={index} />
                  ))}
                </div>
              )}
            </div>

            <ShutterButton
              onCapture={() => void runCapture()}
              busy={busy}
              progress={detection.progress}
              label={shutterLabel}
              icon={mode === 'qr' ? 'qr' : undefined}
              disabled={!live || (mode === 'qr' && !codesSupported)}
            />

            <div className="camera__bar-side camera__bar-side--end">
              <button
                type="button"
                className="camera__done"
                onClick={finish}
                disabled={capturedCount === 0}
                aria-label={`Done, ${capturedCount} ${capturedCount === 1 ? 'page' : 'pages'} captured`}
              >
                <Icon name="check" size={19} />
                <span>{capturedCount}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden rather than sr-only: it is opened by the buttons above and must
          not take a tab stop of its own. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => void onPickFiles(event)}
      />

      <Sheet open={scan !== null} title="Scanned code" onClose={() => setScan(null)}>
        {scan && (
          <div className="camera__scan">
            <span className="camera__scan-format">{describeBarcode(scan)}</span>
            <p className="camera__scan-text">{scan.text}</p>
            <div className="camera__scan-actions">
              <Button variant="secondary" icon="copy" onClick={() => void copyScan()}>
                Copy
              </Button>
              {scanUrl && (
                <Button
                  variant="primary"
                  icon="arrowRight"
                  onClick={() => window.open(scanUrl, '_blank', 'noopener,noreferrer')}
                >
                  Open link
                </Button>
              )}
            </div>
          </div>
        )}
      </Sheet>

      <Dialog
        open={confirmExit}
        title={capturedCount === 1 ? 'Discard this page?' : `Discard ${capturedCount} pages?`}
        body="Everything captured in this session will be deleted."
        confirmLabel="Discard"
        cancelLabel="Keep scanning"
        destructive
        onConfirm={() => void discardAll()}
        onClose={() => setConfirmExit(false)}
      />
    </div>
  );
}

/** One thumbnail in the corner stack of pages captured this session. */
function CaptureThumb({ pageId, index }: { pageId: ID; index: number }) {
  const thumbId = useStore((s) => s.pages[pageId]?.thumbBlobId ?? null);
  const url = useBlobUrl(thumbId);
  return (
    <span className="camera__thumb" style={{ transform: `translateY(${index * -3}px) rotate(${index * 2 - 2}deg)` }}>
      {url && <img src={url} alt="" />}
    </span>
  );
}
