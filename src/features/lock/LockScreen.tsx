import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/state/store';
import * as repo from '@/lib/db/repository';
import { Icon } from '@/ui/Icon';
import { PASSCODE_LENGTH, verifyPasscode } from '@/lib/crypto/passcode';
import './LockScreen.css';

/**
 * The app lock.
 *
 * `App` renders this instead of the whole application while a passcode is set
 * and the session has not been unlocked, so there is nothing behind it to
 * reach: no route, no toast, no back gesture. The only way through is the code.
 */

/** Wrong codes tolerated before the pad goes quiet for a while. */
const MAX_ATTEMPTS = 5;

/** How long the pad refuses input after `MAX_ATTEMPTS`, in seconds. */
const COOLDOWN_SECONDS = 30;

/** Keypad layout, reading order. `null` is the empty cell left of the zero. */
const KEYS: (string | null)[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, '0', 'back'];

/* ------------------------------------------------------------------ */
/* Lock on exit                                                        */
/* ------------------------------------------------------------------ */

/**
 * Lock-on-exit lives in the key/value store rather than in `AppSettings`,
 * because the settings type is a shared contract this feature cannot extend.
 * It is cached in memory so the common case can be decided synchronously —
 * a backgrounded tab may never get to finish an IndexedDB read.
 */
const LOCK_ON_EXIT_KEY = 'lockOnExit';

let cachedLockOnExit: boolean | null = null;

/** Whether the app re-locks itself when it goes to the background. */
export async function loadLockOnExit(): Promise<boolean> {
  if (cachedLockOnExit !== null) return cachedLockOnExit;
  const stored = await repo.getKv<boolean>(LOCK_ON_EXIT_KEY).catch(() => undefined);
  cachedLockOnExit = stored === true;
  return cachedLockOnExit;
}

/** Turn lock-on-exit on or off, and persist it. */
export async function setLockOnExit(value: boolean): Promise<void> {
  cachedLockOnExit = value;
  await repo.setKv(LOCK_ON_EXIT_KEY, value);
}

/**
 * Drop the unlocked flag. The store has no `lock` action — only `unlock` —
 * so this writes the one field directly rather than inventing an action in a
 * file this feature does not own.
 */
function lockNow(): void {
  const state = useStore.getState();
  if (state.settings.passcodeHash === null || !state.unlocked) return;
  useStore.setState({ unlocked: false });
}

function onHidden(): void {
  if (document.visibilityState !== 'hidden') return;
  const state = useStore.getState();
  if (state.settings.passcodeHash === null || !state.unlocked) return;
  if (cachedLockOnExit !== null) {
    if (cachedLockOnExit) lockNow();
    return;
  }
  void loadLockOnExit().then((on) => {
    if (on) lockNow();
  });
}

// Installed at module scope on purpose: `App` imports this module
// unconditionally, and the screen itself is only mounted once the app is
// *already* locked, so it cannot be the thing that locks it.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onHidden);
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

export function LockScreen() {
  const [entry, setEntry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [shakes, setShakes] = useState(0);
  const [cooldown, setCooldown] = useState(0);

  const failures = useRef(0);
  const mounted = useRef(true);

  const blocked = cooldown > 0 || checking;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Check a complete code. Called from the key handlers, never from an effect. */
  const verify = useCallback(async (code: string) => {
    const { passcodeHash, passcodeSalt } = useStore.getState().settings;
    if (passcodeHash === null || passcodeSalt === null) {
      // The lock was removed in another tab while this screen was open.
      useStore.getState().unlock();
      return;
    }
    setChecking(true);
    try {
      const ok = await verifyPasscode(code, passcodeHash, passcodeSalt);
      if (!mounted.current) return;
      if (ok) {
        useStore.getState().unlock();
        return;
      }
      setEntry('');
      setShakes((count) => count + 1);
      failures.current += 1;
      if (failures.current >= MAX_ATTEMPTS) {
        failures.current = 0;
        setCooldown(COOLDOWN_SECONDS);
        setError(null);
      } else {
        setError('That code is not right.');
      }
    } catch {
      if (!mounted.current) return;
      setEntry('');
      setError('The passcode could not be checked on this device.');
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, []);

  const press = useCallback(
    (digit: string) => {
      if (blocked || entry.length >= PASSCODE_LENGTH) return;
      const next = entry + digit;
      setError(null);
      setEntry(next);
      // A full code verifies itself; there is no confirm key to forget to press.
      if (next.length === PASSCODE_LENGTH) void verify(next);
    },
    [blocked, entry, verify],
  );

  const backspace = useCallback(() => {
    if (blocked) return;
    setError(null);
    setEntry((current) => current.slice(0, -1));
  }, [blocked]);

  /* Hardware keyboards: type the code, backspace to correct, escape to clear. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key >= '0' && event.key <= '9' && event.key.length === 1) {
        event.preventDefault();
        press(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        backspace();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setEntry('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [backspace, press]);

  /* Count the cooldown down one second at a time. */
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const status = cooldown > 0
    ? `Too many attempts. Try again in ${cooldown} second${cooldown === 1 ? '' : 's'}.`
    : checking
      ? 'Checking…'
      : (error ?? 'Your scans are locked on this device.');

  return (
    <div className="lock">
      <div className="lock__inner">
        <span className="lock__badge" aria-hidden="true">
          <Icon name="lock" size={26} />
        </span>
        <h1 className="lock__title">Enter your passcode</h1>
        <p
          className={`lock__status ${error !== null || cooldown > 0 ? 'is-error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {status}
        </p>

        <div
          // Re-keyed on each failure so the shake replays even when two wrong
          // codes land inside one animation.
          key={shakes}
          className={`lock__dots ${shakes > 0 ? 'is-wrong' : ''}`}
          aria-hidden="true"
        >
          {Array.from({ length: PASSCODE_LENGTH }, (_, index) => (
            <span key={index} className={`lock__dot ${index < entry.length ? 'is-filled' : ''}`} />
          ))}
        </div>

        <div className="lock__pad">
          {KEYS.map((key, index) => {
            if (key === null) return <span key={`gap-${index}`} className="lock__gap" />;
            if (key === 'back') {
              return (
                <button
                  key={key}
                  type="button"
                  className="lock__key lock__key--action"
                  aria-label="Delete the last digit"
                  disabled={blocked || entry.length === 0}
                  onClick={backspace}
                >
                  <Icon name="close" size={22} />
                </button>
              );
            }
            return (
              <button
                key={key}
                type="button"
                className="lock__key"
                disabled={blocked}
                onClick={() => press(key)}
              >
                {key}
              </button>
            );
          })}
        </div>

        <p className="lock__foot">
          Forgotten it? Clearing this site&rsquo;s data in your browser removes the lock — and every
          scan with it.
        </p>
      </div>
    </div>
  );
}
