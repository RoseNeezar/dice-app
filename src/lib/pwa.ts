import { useStore } from '@/state/store';

/**
 * Progressive-web-app plumbing: the service worker registration, the install
 * prompt, and telling the user when a newer build is waiting.
 *
 * Everything here is optional at runtime — the app is fully functional in a
 * browser with no service worker, no install prompt and no manifest support —
 * so every entry point degrades to a no-op rather than throwing.
 */

/**
 * Shown in Settings and used to label the cache generation. Kept in step with
 * the `version` field of package.json by hand; there is no build-time define,
 * and inventing one would put a Vite config change in another agent's file.
 */
export const APP_VERSION = '1.0.0';

/**
 * `beforeinstallprompt` is Chromium-only and absent from lib.dom, so the shape
 * we rely on is declared here rather than cast away at each use.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let updateReady = false;
/** Set only by `applyUpdate`, so a controller change we did not ask for never reloads the page. */
let reloadOnControllerChange = false;

const installListeners = new Set<(available: boolean) => void>();
const updateListeners = new Set<() => void>();

function emitInstall(): void {
  for (const listener of installListeners) listener(deferredPrompt !== null);
}

/* ------------------------------------------------------------------ */
/* Install prompt                                                      */
/* ------------------------------------------------------------------ */

// Chromium fires `beforeinstallprompt` during the first navigation, often
// before React has mounted, and the event is only usable if its default was
// prevented at that moment — so the capture has to happen on module load.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emitInstall();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emitInstall();
  });
}

/** Whether the browser is currently offering to install the app. */
export function canInstall(): boolean {
  return deferredPrompt !== null;
}

/**
 * Subscribe to install availability. The callback fires immediately with the
 * current state, then again whenever it changes.
 *
 * @returns An unsubscribe function — call it on unmount.
 */
export function onInstallAvailable(listener: (available: boolean) => void): () => void {
  installListeners.add(listener);
  listener(deferredPrompt !== null);
  return () => {
    installListeners.delete(listener);
  };
}

/**
 * Show the browser's install prompt.
 *
 * The captured event is single-use, so it is dropped whether or not the user
 * accepts; the browser will offer a fresh one later if the app is still
 * installable.
 */
export async function promptInstall(): Promise<InstallOutcome> {
  const event = deferredPrompt;
  if (!event) return 'unavailable';
  deferredPrompt = null;
  emitInstall();
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome;
  } catch {
    return 'unavailable';
  }
}

/** Whether the app is running as an installed app rather than in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  // iOS Safari never implemented display-mode and uses this instead.
  return 'standalone' in navigator && navigator.standalone === true;
}

/* ------------------------------------------------------------------ */
/* Updates                                                             */
/* ------------------------------------------------------------------ */

/** Whether a newer build has been downloaded and is waiting to take over. */
export function isUpdateReady(): boolean {
  return updateReady;
}

/**
 * Subscribe to "a new version is ready". Fires immediately if one already is.
 *
 * @returns An unsubscribe function — call it on unmount.
 */
export function onUpdateReady(listener: () => void): () => void {
  updateListeners.add(listener);
  if (updateReady) listener();
  return () => {
    updateListeners.delete(listener);
  };
}

function markUpdateReady(): void {
  if (updateReady) return;
  updateReady = true;
  for (const listener of updateListeners) listener();
}

/**
 * Activate the waiting build and reload.
 *
 * Reloading is what actually swaps the running code: the new worker takes
 * control on `skipWaiting`, but the page keeps the JavaScript it already
 * parsed until it is loaded again.
 */
export function applyUpdate(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  reloadOnControllerChange = true;
  void navigator.serviceWorker.getRegistration().then((registration) => {
    const waiting = registration?.waiting;
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
    // Nothing waiting after all — a plain reload still picks up whatever the
    // cache has, and leaves the user with a working app rather than a dead button.
    reloadOnControllerChange = false;
    window.location.reload();
  });
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

async function register(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

    // A build downloaded during a previous visit that never got activated.
    if (registration.waiting && navigator.serviceWorker.controller) markUpdateReady();

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // With no controller this is the very first install, not an update.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          markUpdateReady();
        }
      });
    });
  } catch {
    // An unregistrable worker only costs offline support, so it is not worth a
    // message: the app itself keeps working exactly as it did.
  }
}

/**
 * Register the service worker and wire up update notifications.
 *
 * Production only: in dev the worker would serve stale modules over Vite's own
 * transforms, which is confusing enough to be worse than having no offline
 * support while developing.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadOnControllerChange) return;
    reloadOnControllerChange = false;
    window.location.reload();
  });

  onUpdateReady(() => {
    useStore.getState().notify('A new version of OpenScan is ready', 'info', {
      label: 'Reload',
      run: applyUpdate,
    });
  });

  // Registering competes with the first paint for bandwidth, so it waits for
  // the page to finish loading — unless it already has.
  if (document.readyState === 'complete') {
    void register();
  } else {
    window.addEventListener('load', () => void register(), { once: true });
  }
}
