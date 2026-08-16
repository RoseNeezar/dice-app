import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Size } from '@/types';
import { canvasToBlob, decodeToBitmap } from '@/lib/image/io';

/**
 * Owns the `MediaStream`: permissions, torch, zoom, front/back switching and
 * full-resolution stills. Every failure resolves to a {@link CameraFailure}
 * with something the user can actually do about it.
 */

export type Facing = 'environment' | 'user';

export type CameraStatus =
  /** Waiting for `getUserMedia` (this is when the permission prompt shows). */
  | 'starting'
  /** Frames are flowing. */
  | 'live'
  /** Permission refused, or blocked by policy. */
  | 'denied'
  /** No camera hardware, or the browser has no camera API at all. */
  | 'missing'
  /** Hardware exists but would not start — usually another app holds it. */
  | 'error';

export interface CameraFailure {
  status: Exclude<CameraStatus, 'starting' | 'live'>;
  title: string;
  /** How to fix it, in plain language. */
  hint: string;
}

export interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

export interface CameraControls {
  torch: boolean;
  zoom: ZoomRange | null;
}

export interface UseCamera {
  status: CameraStatus;
  failure: CameraFailure | null;
  facing: Facing;
  /** Intrinsic frame size, needed to map detections onto the cover-cropped preview. */
  videoSize: Size | null;
  controls: CameraControls;
  torchOn: boolean;
  zoom: number;
  canSwitch: boolean;
  setTorch: (on: boolean) => void;
  setZoom: (value: number) => void;
  switchFacing: () => void;
  retry: () => void;
  /** Full-resolution JPEG still. Rejects with a user-facing message. */
  capture: (quality: number) => Promise<Blob>;
}

/**
 * `torch` and `zoom` are real MediaStream Image Capture members that
 * TypeScript's DOM library does not declare.
 */
interface CameraTrackCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  zoom?: { min: number; max: number; step?: number };
}

interface CameraConstraint {
  torch?: boolean;
  zoom?: number;
}

function advanced(constraint: CameraConstraint): MediaTrackConstraints {
  // Same reason as CameraTrackCapabilities: the members are undeclared, and an
  // `advanced` set is ignored rather than fatal where a device lacks them.
  return { advanced: [constraint] } as unknown as MediaTrackConstraints;
}

function describeFailure(error: unknown): CameraFailure {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      status: 'denied',
      title: 'Camera access is blocked',
      hint: 'Tap the padlock or camera icon in the address bar, allow the camera, then try again.',
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return {
      status: 'missing',
      title: 'No camera found',
      hint: 'This device has no usable camera. You can still import photos from your gallery.',
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      status: 'error',
      title: 'The camera would not start',
      hint: 'Another app may be using it. Close that app, then try again.',
    };
  }
  return {
    status: 'error',
    title: 'The camera would not start',
    hint: error instanceof Error && error.message ? error.message : 'Try again, or import photos instead.',
  };
}

/** Encode any drawable frame as a JPEG at its intrinsic size. */
async function encodeFrame(
  source: CanvasImageSource,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  if (width < 1 || height < 1) throw new Error('The camera has not produced a frame yet');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire a 2D canvas context');
  ctx.drawImage(source, 0, 0, width, height);
  return canvasToBlob(canvas, 'image/jpeg', quality);
}

/**
 * @param videoRef the preview element the stream is attached to; owned by the
 *   caller so React's lint rules can tell the stream state apart from the ref.
 */
export function useCamera(
  videoRef: RefObject<HTMLVideoElement | null>,
  initialFacing: Facing = 'environment',
): UseCamera {
  const trackRef = useRef<MediaStreamTrack | null>(null);

  const [facing, setFacing] = useState<Facing>(initialFacing);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<CameraStatus>('starting');
  const [failure, setFailure] = useState<CameraFailure | null>(null);
  const [videoSize, setVideoSize] = useState<Size | null>(null);
  const [controls, setControls] = useState<CameraControls>({ torch: false, zoom: null });
  const [torchOn, setTorchOn] = useState(false);
  const [zoom, setZoomValue] = useState(1);
  const [canSwitch, setCanSwitch] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let stream: MediaStream | null = null;

    const onMeta = () => {
      if (video.videoWidth > 0) setVideoSize({ width: video.videoWidth, height: video.videoHeight });
    };

    const open = (constraints: MediaStreamConstraints): Promise<MediaStream> =>
      navigator.mediaDevices.getUserMedia(constraints);

    // An arrow rather than a declaration: hoisted functions lose the narrowing
    // that proves `video` is non-null here.
    const start = async (): Promise<void> => {
      setStatus('starting');
      setFailure(null);
      setTorchOn(false);

      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setStatus('missing');
        setFailure({
          status: 'missing',
          title: 'Camera not available',
          hint: 'This browser has no camera API. Open the app over HTTPS, or import photos from your gallery.',
        });
        return;
      }

      try {
        try {
          stream = await open({
            video: {
              facingMode: { ideal: facing },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              // A 4:3 sensor mode spends far fewer wasted pixels on a portrait
              // page than the 16:9 mode most devices default to.
              aspectRatio: { ideal: 4 / 3 },
            },
            audio: false,
          });
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'OverconstrainedError') throw error;
          // Some webcams reject every size hint; ask for nothing but the lens.
          stream = await open({ video: { facingMode: { ideal: facing } }, audio: false });
        }

        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        video.srcObject = stream;
        video.addEventListener('loadedmetadata', onMeta);
        video.addEventListener('resize', onMeta);
        try {
          await video.play();
        } catch {
          // Autoplay can reject when the element is remounted mid-play; the
          // stream is still attached and the first frame arrives regardless.
        }
        if (cancelled) return;
        onMeta();

        const caps: CameraTrackCapabilities =
          track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
        const zoomRange = caps.zoom
          ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step ?? 0.1 }
          : null;
        setControls({ torch: caps.torch === true, zoom: zoomRange && zoomRange.max > zoomRange.min ? zoomRange : null });
        setZoomValue(zoomRange ? zoomRange.min : 1);
        setStatus('live');

        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) setCanSwitch(devices.filter((d) => d.kind === 'videoinput').length > 1);
        } catch {
          // Device labels are permission-gated on some browsers; a failure here
          // only means we cannot promise a second lens exists.
        }
      } catch (error) {
        if (cancelled) return;
        const described = describeFailure(error);
        setStatus(described.status);
        setFailure(described);
      }
    };

    void start();

    return () => {
      cancelled = true;
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('resize', onMeta);
      trackRef.current = null;
      // Stopping the tracks also extinguishes the torch.
      for (const track of stream?.getTracks() ?? []) track.stop();
      video.srcObject = null;
    };
  }, [facing, attempt, videoRef]);

  const setTorch = useCallback((on: boolean) => {
    const track = trackRef.current;
    if (!track) return;
    setTorchOn(on);
    void track.applyConstraints(advanced({ torch: on })).catch(() => setTorchOn(false));
  }, []);

  const setZoom = useCallback((value: number) => {
    const track = trackRef.current;
    if (!track) return;
    setZoomValue(value);
    void track.applyConstraints(advanced({ zoom: value })).catch(() => undefined);
  }, []);

  const switchFacing = useCallback(() => {
    setVideoSize(null);
    setFacing((current) => (current === 'environment' ? 'user' : 'environment'));
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const capture = useCallback(async (quality: number): Promise<Blob> => {
    const video = videoRef.current;
    const track = trackRef.current;
    if (!video || !track) throw new Error('The camera is not running');

    if (typeof ImageCapture !== 'undefined') {
      try {
        const photo = await new ImageCapture(track).takePhoto();
        if (photo.size > 0) {
          // A hardware JPEG beats anything we could re-encode from a preview
          // frame, so only transcode when the device hands back something else.
          if (photo.type === 'image/jpeg') return photo;
          const bitmap = await decodeToBitmap(photo);
          try {
            return await encodeFrame(bitmap, bitmap.width, bitmap.height, quality);
          } finally {
            bitmap.close();
          }
        }
      } catch {
        // takePhoto() is unimplemented on several Android builds and throws
        // rather than resolving; the preview frame below is always available.
      }
    }
    return encodeFrame(video, video.videoWidth, video.videoHeight, quality);
  }, [videoRef]);

  return {
    status,
    failure,
    facing,
    videoSize,
    controls,
    torchOn,
    zoom,
    canSwitch,
    setTorch,
    setZoom,
    switchFacing,
    retry,
    capture,
  };
}
