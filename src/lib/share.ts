/**
 * Getting a finished file off the device.
 *
 * Two routes exist and neither works everywhere: the Web Share API hands the
 * file to another app (Mail, Drive, WhatsApp) but only on mobile and only over
 * HTTPS from a user gesture, while a download link works everywhere but on iOS
 * dumps the file into Files with no further choice. So we prefer sharing and
 * fall back to downloading — and every path revokes its object URL.
 */

/**
 * How long a download's object URL is kept alive after the click.
 *
 * Revoking in the same tick cancels the download in Safari, which starts the
 * transfer asynchronously. Ten seconds is far longer than any browser needs to
 * pick the bytes up, and still bounds how long a large export is pinned in
 * memory.
 */
const REVOKE_DELAY = 10_000;

/**
 * Save a blob to the user's downloads under `filename`.
 *
 * The anchor has to be in the document for Firefox to honour the click, and is
 * removed again immediately afterwards.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY);
}

/** Whether this browser can hand these particular files to another app. */
export function canShareFiles(files: File[]): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files });
  } catch {
    // Some engines throw instead of returning false for an unsupported payload.
    return false;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Hand `files` to another app, or save them if that is not possible.
 *
 * @returns `'shared'` when the share sheet accepted them, `'cancelled'` when
 * the user dismissed it, and `'downloaded'` when the files were saved instead —
 * either because sharing is unsupported here or because the share attempt
 * failed for a reason other than the user backing out.
 * @throws If `files` is empty, which is always a caller bug.
 */
export async function shareFiles(files: File[], title: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (files.length === 0) throw new Error('There is nothing to share.');

  if (canShareFiles(files)) {
    try {
      await navigator.share({ files, title });
      return 'shared';
    } catch (error) {
      if (isAbort(error)) return 'cancelled';
      // A blocked or unimplemented share must still get the user their file.
    }
  }

  for (const file of files) downloadBlob(file, file.name);
  return 'downloaded';
}
