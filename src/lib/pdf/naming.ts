/**
 * Filename helpers, kept apart from `export.ts` so that callers who only need
 * to label a download do not pull the PDF writer (and pdf-lib with it) into
 * their bundle. The export sheet needs the name before the user commits to the
 * export, so this really does get used on its own.
 */

/** Windows reserved device names — a file called `nul.pdf` cannot be saved. */
const RESERVED_FILENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Longest filename stem we suggest, leaving room for the extension and a de-duplicating suffix. */
const MAX_FILENAME_STEM = 80;

/** Replace C0 and DEL control characters with spaces, without a control-character regex. */
export function stripControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    out += code !== undefined && (code < 0x20 || code === 0x7f) ? ' ' : char;
  }
  return out;
}

/** Turn a document title into a filename that every platform will accept. */
export function suggestPdfName(title: string): string {
  let stem = stripControlCharacters(title)
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILENAME_STEM)
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (stem.length === 0 || RESERVED_FILENAMES.test(stem)) stem = 'Scan';
  return `${stem}.pdf`;
}
