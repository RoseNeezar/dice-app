import { Icon, type IconName } from '@/ui/Icon';
import './ShutterButton.css';

/**
 * The capture button. The ring around it fills as the auto-capture controller
 * decides the phone has stopped moving, so the automatic shot never feels like
 * it came out of nowhere.
 */

export interface ShutterButtonProps {
  onCapture: () => void;
  /** A capture is in flight; the button locks and reports progress to AT. */
  busy: boolean;
  /** 0..1 auto-capture stability. */
  progress: number;
  label: string;
  /** Optional glyph inside the disc — used by the code-scanning mode. */
  icon?: IconName;
  disabled?: boolean;
}

const RADIUS = 36;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ShutterButton({
  onCapture,
  busy,
  progress,
  label,
  icon,
  disabled = false,
}: ShutterButtonProps) {
  const clamped = Math.min(1, Math.max(0, progress));
  return (
    <button
      type="button"
      className={`shutter ${busy ? 'is-busy' : ''}`}
      onClick={onCapture}
      disabled={disabled || busy}
      aria-label={label}
      aria-busy={busy}
    >
      <svg className="shutter__ring" viewBox="0 0 80 80" aria-hidden="true">
        <circle className="shutter__track" cx="40" cy="40" r={RADIUS} />
        <circle
          className="shutter__progress"
          cx="40"
          cy="40"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - clamped)}
        />
      </svg>
      <span className="shutter__core">{icon && <Icon name={icon} size={26} />}</span>
    </button>
  );
}
