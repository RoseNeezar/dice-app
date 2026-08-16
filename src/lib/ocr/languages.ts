/**
 * The OCR languages OpenScan offers.
 *
 * Codes are Tesseract `traineddata` names, which are ISO 639-2/T rather than
 * the two-letter codes the web usually uses — they are passed verbatim to
 * tesseract.js, which downloads `<code>.traineddata.gz` on first use.
 */

export interface OcrLanguage {
  /** Tesseract language code, e.g. `eng` or `chi_sim`. */
  code: string;
  /** English display name. */
  label: string;
}

/**
 * Supported languages, English first (the default) and the rest alphabetical by
 * label. Deliberately a curated subset of Tesseract's ~100 models: every extra
 * entry is a several-megabyte download the user has to choose between.
 */
export const OCR_LANGUAGES: OcrLanguage[] = [
  { code: 'eng', label: 'English' },
  { code: 'ara', label: 'Arabic' },
  { code: 'ces', label: 'Czech' },
  { code: 'chi_sim', label: 'Chinese (Simplified)' },
  { code: 'chi_tra', label: 'Chinese (Traditional)' },
  { code: 'dan', label: 'Danish' },
  { code: 'nld', label: 'Dutch' },
  { code: 'fin', label: 'Finnish' },
  { code: 'fra', label: 'French' },
  { code: 'deu', label: 'German' },
  { code: 'ell', label: 'Greek' },
  { code: 'heb', label: 'Hebrew' },
  { code: 'hin', label: 'Hindi' },
  { code: 'hun', label: 'Hungarian' },
  { code: 'ind', label: 'Indonesian' },
  { code: 'ita', label: 'Italian' },
  { code: 'jpn', label: 'Japanese' },
  { code: 'kor', label: 'Korean' },
  { code: 'nor', label: 'Norwegian' },
  { code: 'pol', label: 'Polish' },
  { code: 'por', label: 'Portuguese' },
  { code: 'ron', label: 'Romanian' },
  { code: 'rus', label: 'Russian' },
  { code: 'spa', label: 'Spanish' },
  { code: 'swe', label: 'Swedish' },
  { code: 'tha', label: 'Thai' },
  { code: 'tur', label: 'Turkish' },
  { code: 'ukr', label: 'Ukrainian' },
  { code: 'vie', label: 'Vietnamese' },
];

const BY_CODE = new Map(OCR_LANGUAGES.map((language) => [language.code, language.label]));

/**
 * Display name for a language code. Tesseract accepts `+`-joined codes for
 * multilingual pages (`eng+deu`), so those are labelled as `English + German`.
 * Unknown codes fall back to the code itself rather than throwing — a stored
 * setting must never be able to break a screen.
 */
export function languageLabel(code: string): string {
  return code
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => BY_CODE.get(part) ?? part)
    .join(' + ');
}
