import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppSettings, CaptureMode, FilterId, ThemeSetting } from '@/types';
import { useStore } from '@/state/store';
import * as repo from '@/lib/db/repository';
import type { StorageUsage } from '@/lib/db/repository';
import { OCR_LANGUAGES } from '@/lib/ocr/languages';
import { formatBytes } from '@/features/docs/DocCard';
import { OptionSelect, PdfOptionsEditor } from '@/features/export/ExportSheet';
import { loadLockOnExit, setLockOnExit } from '@/features/lock/LockScreen';
import { PASSCODE_LENGTH, hashPasscode, isValidPasscode, verifyPasscode } from '@/lib/crypto/passcode';
import {
  APP_VERSION,
  applyUpdate,
  canInstall,
  isStandalone,
  onInstallAvailable,
  onUpdateReady,
  promptInstall,
} from '@/lib/pwa';
import { Icon, type IconName } from '@/ui/Icon';
import { Button, ProgressBar, Segmented, Slider, Spinner, Toggle, TopBar } from '@/ui/primitives';
import { Dialog } from '@/ui/Sheet';
import './SettingsScreen.css';

/**
 * Every preference in one screen.
 *
 * Each control writes straight through `updateSettings`, which persists as it
 * goes: there is no save button, and nothing here can be left half-applied.
 */

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const FILTERS: { value: FilterId; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'magic', label: 'Magic colour' },
  { value: 'enhance', label: 'Enhance' },
  { value: 'gray', label: 'Greyscale' },
  { value: 'bw', label: 'Black & white' },
  { value: 'ink', label: 'Ink' },
];

const CAPTURE_MODES: { value: CaptureMode; label: string }[] = [
  { value: 'single', label: 'Single page' },
  { value: 'batch', label: 'Batch' },
  { value: 'idcard', label: 'ID card' },
  { value: 'book', label: 'Book' },
  { value: 'qr', label: 'QR & barcodes' },
  { value: 'ocr', label: 'Text' },
];

const RESOLUTIONS: { value: string; label: string }[] = [
  { value: '1600', label: 'Compact — 1600 px' },
  { value: '2000', label: 'Balanced — 2000 px' },
  { value: '2400', label: 'Sharp — 2400 px' },
  { value: '3200', label: 'Maximum — 3200 px' },
];

/**
 * The preset closest to a stored resolution.
 *
 * A value saved by an older build (or by the PDF defaults of a shared profile)
 * need not be one of the four offered, and a `<select>` with no matching option
 * renders blank — so the nearest one is shown instead.
 */
function nearestResolution(edge: number): string {
  return RESOLUTIONS.reduce((best, option) =>
    Math.abs(Number(option.value) - edge) < Math.abs(Number(best.value) - edge) ? option : best,
  ).value;
}

/** Typed into the reset dialog to confirm it. Compared case-insensitively. */
const RESET_WORD = 'ERASE';

type DialogName = 'setPasscode' | 'changePasscode' | 'removePasscode' | 'emptyTrash' | 'reset' | null;

/* ------------------------------------------------------------------ */
/* Layout helpers                                                      */
/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set__section">
      <h2 className="set__heading">{title}</h2>
      <div className="set__card">{children}</div>
    </section>
  );
}

function ActionRow({
  icon,
  label,
  hint,
  tone = 'default',
  disabled = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`set__action ${tone === 'danger' ? 'is-danger' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={20} />
      <span className="set__action-text">
        <span className="set__action-label">{label}</span>
        {hint && <span className="set__action-hint">{hint}</span>}
      </span>
      <Icon name="chevronRight" size={18} className="set__chevron" />
    </button>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="set__info">
      <span>{label}</span>
      <span className="set__info-value">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Passcode dialog                                                     */
/* ------------------------------------------------------------------ */

type PasscodeMode = 'set' | 'change' | 'remove';

const PASSCODE_COPY: Record<PasscodeMode, { title: string; confirm: string }> = {
  set: { title: 'Set a passcode', confirm: 'Turn on' },
  change: { title: 'Change your passcode', confirm: 'Save' },
  remove: { title: 'Turn the passcode off?', confirm: 'Turn off' },
};

/**
 * Set, change or clear the app passcode.
 *
 * Mounted fresh for each mode (the caller keys it), so no code ever survives in
 * component state from one visit to the next.
 */
function PasscodeDialog({ mode, onClose }: { mode: PasscodeMode; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const needsCurrent = mode !== 'set';
  const needsNew = mode !== 'remove';

  const submit = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const store = useStore.getState();
      const { passcodeHash, passcodeSalt } = store.settings;

      if (needsCurrent) {
        if (passcodeHash === null || passcodeSalt === null) {
          setError('There is no passcode set on this device.');
          return;
        }
        if (!(await verifyPasscode(current, passcodeHash, passcodeSalt))) {
          setError('That is not your current passcode.');
          return;
        }
      }

      if (!needsNew) {
        await store.updateSettings({ passcodeHash: null, passcodeSalt: null });
        store.notify('Passcode turned off');
        onClose();
        return;
      }

      if (!isValidPasscode(next)) {
        setError(`Choose ${PASSCODE_LENGTH} digits.`);
        return;
      }
      if (next !== repeat) {
        setError('The two codes do not match.');
        return;
      }

      const { hash, salt } = await hashPasscode(next);
      await store.updateSettings({ passcodeHash: hash, passcodeSalt: salt });
      store.notify(mode === 'set' ? 'Passcode turned on' : 'Passcode changed', 'success');
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That passcode could not be saved.');
    } finally {
      busy.current = false;
    }
  }, [current, mode, needsCurrent, needsNew, next, onClose, repeat]);

  const digitsOnly = (value: string) => value.replace(/[^0-9]/g, '').slice(0, PASSCODE_LENGTH);

  return (
    <Dialog
      open
      title={PASSCODE_COPY[mode].title}
      body={
        mode === 'remove'
          ? 'Anyone with this device will be able to open your scans.'
          : `Your passcode is ${PASSCODE_LENGTH} digits. It never leaves this device, and it cannot be recovered if you forget it.`
      }
      confirmLabel={PASSCODE_COPY[mode].confirm}
      destructive={mode === 'remove'}
      onClose={onClose}
      onConfirm={() => void submit()}
    >
      <div
        className="set__passcode"
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          void submit();
        }}
      >
        {needsCurrent && (
          <label className="opt-row">
            <span className="opt-row__label">Current passcode</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={current}
              onChange={(event) => {
                setError(null);
                setCurrent(digitsOnly(event.target.value));
              }}
            />
          </label>
        )}
        {needsNew && (
          <>
            <label className="opt-row">
              <span className="opt-row__label">New passcode</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={next}
                onChange={(event) => {
                  setError(null);
                  setNext(digitsOnly(event.target.value));
                }}
              />
            </label>
            <label className="opt-row">
              <span className="opt-row__label">Repeat it</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={repeat}
                onChange={(event) => {
                  setError(null);
                  setRepeat(digitsOnly(event.target.value));
                }}
              />
            </label>
          </>
        )}
        {error && (
          <p className="set__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

export function SettingsScreen() {
  const settings = useStore((s) => s.settings);
  const docs = useStore((s) => s.docs);

  const [dialog, setDialog] = useState<DialogName>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [usageKey, setUsageKey] = useState(0);
  const [lockExit, setLockExit] = useState(false);
  const [installable, setInstallable] = useState(canInstall);
  const [updateReady, setUpdateReady] = useState(false);
  const [resetWord, setResetWord] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);

  const hasPasscode = settings.passcodeHash !== null;
  const trashed = Object.values(docs).filter((doc) => doc.deletedAt !== null).length;

  const update = useCallback((patch: Partial<AppSettings>) => {
    void useStore
      .getState()
      .updateSettings(patch)
      .catch(() => useStore.getState().notify('That setting could not be saved', 'error'));
  }, []);

  useEffect(() => {
    let live = true;
    repo
      .storageUsage()
      .then((next) => {
        if (!live) return;
        setUsage(next);
        setUsageFailed(false);
      })
      .catch(() => {
        if (live) setUsageFailed(true);
      });
    return () => {
      live = false;
    };
  }, [usageKey]);

  useEffect(() => {
    let live = true;
    void loadLockOnExit().then((value) => {
      if (live) setLockExit(value);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => onInstallAvailable(setInstallable), []);
  useEffect(() => onUpdateReady(() => setUpdateReady(true)), []);

  const refreshUsage = useCallback(() => setUsageKey((key) => key + 1), []);

  /**
   * Run a storage task, report it, and re-measure afterwards. A task that
   * resolves to `null` has already told the user itself.
   */
  const runMaintenance = useCallback(
    (task: () => Promise<string | null>, failure: string) => {
      void (async () => {
        try {
          const message = await task();
          if (message !== null) useStore.getState().notify(message, 'success');
        } catch (error) {
          useStore.getState().notify(error instanceof Error ? error.message : failure, 'error');
        } finally {
          refreshUsage();
        }
      })();
    },
    [refreshUsage],
  );

  const closeDialog = useCallback(() => {
    setDialog(null);
    setResetWord('');
    setResetError(null);
  }, []);

  const passcodeMode: PasscodeMode | null =
    dialog === 'setPasscode'
      ? 'set'
      : dialog === 'changePasscode'
        ? 'change'
        : dialog === 'removePasscode'
          ? 'remove'
          : null;

  return (
    <div className="screen set">
      <TopBar title="Settings" onBack={() => useStore.getState().back()} backLabel="Back" />

      <div className="screen__body set__body">
        <Section title="Appearance">
          <div className="set__row">
            <span className="set__row-label">Theme</span>
            <Segmented
              label="Theme"
              value={settings.theme}
              options={THEMES}
              onChange={(theme) => update({ theme })}
            />
          </div>
        </Section>

        <Section title="Scanning">
          <OptionSelect
            label="Filter for new scans"
            value={settings.defaultFilter}
            options={FILTERS}
            onChange={(defaultFilter) => update({ defaultFilter })}
          />
          <OptionSelect
            label="Camera mode"
            value={settings.defaultCaptureMode}
            options={CAPTURE_MODES}
            onChange={(defaultCaptureMode) => update({ defaultCaptureMode })}
          />
          <Toggle
            label="Capture automatically"
            hint="Fires the shutter once a page is framed and steady."
            checked={settings.autoCapture}
            onChange={(autoCapture) => update({ autoCapture })}
          />
          <Toggle
            label="Show the framing grid"
            checked={settings.showGrid}
            onChange={(showGrid) => update({ showGrid })}
          />
          <Toggle
            label="Shutter sound"
            hint="Plays a short click when a page is captured."
            checked={settings.shutterSound}
            onChange={(shutterSound) => update({ shutterSound })}
          />
          <OptionSelect
            label="Scan resolution"
            value={nearestResolution(settings.maxProcessedEdge)}
            options={RESOLUTIONS}
            hint="The longest edge of a processed page. Bigger is sharper and slower."
            onChange={(value) => update({ maxProcessedEdge: Number(value) })}
          />
          <Slider
            label="Image quality"
            min={50}
            max={100}
            step={2}
            value={Math.round(settings.jpegQuality * 100)}
            format={(percent) => `${percent}%`}
            onChange={(percent) => update({ jpegQuality: percent / 100 })}
            onReset={() => update({ jpegQuality: 0.86 })}
          />
        </Section>

        <Section title="Text recognition">
          <Toggle
            label="Read text automatically"
            hint="Runs recognition on every new page, in the background."
            checked={settings.autoOcr}
            onChange={(autoOcr) => update({ autoOcr })}
          />
          <OptionSelect
            label="Language"
            value={settings.ocrLanguage}
            options={OCR_LANGUAGES.map((language) => ({ value: language.code, label: language.label }))}
            hint="Each language downloads once, then works offline."
            onChange={(ocrLanguage) => update({ ocrLanguage })}
          />
        </Section>

        <Section title="PDF defaults">
          <PdfOptionsEditor
            value={settings.defaultPdf}
            showPassword={false}
            onChange={(defaultPdf) => update({ defaultPdf })}
          />
          <p className="set__note">
            Used every time you share a PDF. A password is asked for at export time and is never
            stored.
          </p>
        </Section>

        <Section title="Security">
          <Toggle
            label="Passcode lock"
            hint={hasPasscode ? 'Asked for every time OpenScan opens.' : 'Lock the app with a code.'}
            checked={hasPasscode}
            onChange={(on) => setDialog(on ? 'setPasscode' : 'removePasscode')}
          />
          {hasPasscode && (
            <ActionRow
              icon="lock"
              label="Change passcode"
              onClick={() => setDialog('changePasscode')}
            />
          )}
          <Toggle
            label="Lock when I leave"
            hint="Locks as soon as OpenScan goes to the background."
            checked={lockExit}
            disabled={!hasPasscode}
            onChange={(on) => {
              setLockExit(on);
              void setLockOnExit(on).catch(() => {
                setLockExit(!on);
                useStore.getState().notify('That setting could not be saved', 'error');
              });
            }}
          />
        </Section>

        <Section title="Storage">
          <div className="set__usage">
            {usageFailed ? (
              <p className="set__note">This browser will not report how much space is in use.</p>
            ) : usage === null ? (
              <div className="set__usage-loading">
                <Spinner size={18} label="Measuring storage" />
                <span className="set__note">Measuring…</span>
              </div>
            ) : (
              <>
                <p className="set__usage-line" aria-live="polite">
                  <strong>{formatBytes(usage.usage)}</strong>
                  {usage.quota > 0 && ` of ${formatBytes(usage.quota)} available`}
                </p>
                {usage.quota > 0 && (
                  <ProgressBar value={usage.usage / usage.quota} label="Storage used" />
                )}
                <p className="set__note">
                  {usage.documents} document{usage.documents === 1 ? '' : 's'} · {usage.pages} page
                  {usage.pages === 1 ? '' : 's'}
                </p>
              </>
            )}
          </div>
          <ActionRow
            icon="trash"
            label="Empty the trash"
            hint={trashed === 0 ? 'The trash is empty' : `${trashed} document${trashed === 1 ? '' : 's'} waiting`}
            disabled={trashed === 0}
            onClick={() => setDialog('emptyTrash')}
          />
          <ActionRow
            icon="refresh"
            label="Clean up unused files"
            hint="Reclaims space from renders left behind by interrupted edits."
            onClick={() =>
              runMaintenance(async () => {
                const removed = await repo.collectGarbage();
                return removed === 0 ? 'Nothing left to clean up' : `Removed ${removed} unused file${removed === 1 ? '' : 's'}`;
              }, 'The cleanup could not finish')
            }
          />
          <ActionRow
            icon="eraser"
            label="Erase everything"
            hint="Deletes every document, folder and setting on this device."
            tone="danger"
            onClick={() => setDialog('reset')}
          />
        </Section>

        <Section title="About">
          <InfoRow label="Version" value={APP_VERSION} />
          <InfoRow label="Installed" value={isStandalone() ? 'Yes' : 'Running in the browser'} />
          {installable && (
            <div className="set__cta">
              <Button
                variant="primary"
                icon="download"
                block
                onClick={() =>
                  void promptInstall().then((outcome) => {
                    if (outcome === 'unavailable') {
                      useStore.getState().notify('This browser will not install apps right now', 'error');
                    }
                  })
                }
              >
                Install OpenScan
              </Button>
            </div>
          )}
          {updateReady && (
            <div className="set__cta">
              <Button variant="primary" icon="refresh" block onClick={applyUpdate}>
                Restart to update
              </Button>
            </div>
          )}
          <p className="set__about">
            Scanning, edge detection, filters, text recognition and PDF export all run on this
            device. Nothing you scan is uploaded, and there is no account. Once OpenScan has loaded
            it keeps working with no connection — only a language you have never used before needs
            the network.
          </p>
        </Section>
      </div>

      {passcodeMode !== null && (
        <PasscodeDialog key={passcodeMode} mode={passcodeMode} onClose={closeDialog} />
      )}

      <Dialog
        open={dialog === 'emptyTrash'}
        title="Empty the trash?"
        body={`${trashed} document${trashed === 1 ? '' : 's'} and every page inside will be deleted for good.`}
        confirmLabel="Empty trash"
        destructive
        onClose={closeDialog}
        onConfirm={() => {
          closeDialog();
          runMaintenance(async () => {
            // The store action raises its own toast.
            await useStore.getState().emptyTrash();
            return null;
          }, 'The trash could not be emptied');
        }}
      />

      <Dialog
        open={dialog === 'reset'}
        title="Erase everything?"
        body="Every document, page, folder and preference on this device is deleted. There is no undo and no copy anywhere else."
        confirmLabel="Erase everything"
        destructive
        onClose={closeDialog}
        onConfirm={() => {
          if (resetWord.trim().toUpperCase() !== RESET_WORD) {
            setResetError(`Type ${RESET_WORD} to confirm.`);
            return;
          }
          void (async () => {
            try {
              await repo.wipeAll();
              // A reload is the only honest way back to a first-run app: every
              // screen is holding state that no longer has anything behind it.
              window.location.reload();
            } catch (error) {
              setResetError(error instanceof Error ? error.message : 'Nothing could be erased.');
            }
          })();
        }}
      >
        <label className="opt-row">
          <span className="opt-row__label">Type {RESET_WORD} to confirm</span>
          <input
            type="text"
            value={resetWord}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder={RESET_WORD}
            onChange={(event) => {
              setResetError(null);
              setResetWord(event.target.value);
            }}
          />
        </label>
        {resetError && (
          <p className="set__error" role="alert">
            {resetError}
          </p>
        )}
      </Dialog>
    </div>
  );
}
