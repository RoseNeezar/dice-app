/**
 * OpenScan domain model.
 *
 * This module is the contract every other module builds against. Geometry is
 * stored in *normalized source coordinates* (0..1 relative to the original
 * captured image) so that edits survive re-rendering at any resolution.
 */

export type ID = string;

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

export interface Point {
  x: number;
  y: number;
}

/** Document corners, always ordered [top-left, top-right, bottom-right, bottom-left]. */
export type Quad = [Point, Point, Point, Point];

export interface Size {
  width: number;
  height: number;
}

/**
 * A raster image. Structurally compatible with the DOM `ImageData` so the same
 * pure functions run in a worker, on the main thread and under Node in tests.
 */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Rotation = 0 | 90 | 180 | 270;

/* ------------------------------------------------------------------ */
/* Image processing                                                    */
/* ------------------------------------------------------------------ */

export type FilterId =
  /** No tonal change; perspective crop only. */
  | 'original'
  /** Colour document: white balance + shadow removal, keeps colour. */
  | 'magic'
  /** Lighten + sharpen, good for faint pencil or receipts. */
  | 'enhance'
  /** Neutral greyscale with a mild S-curve. */
  | 'gray'
  /** Adaptive (Sauvola) binarisation — smallest files, crispest text. */
  | 'bw'
  /** High-contrast ink extraction that keeps stamps and signatures readable. */
  | 'ink';

export interface Adjustments {
  /** -100..100 */
  brightness: number;
  /** -100..100 */
  contrast: number;
  /** -100..100, ignored by the greyscale/B&W filters. */
  saturation: number;
  /** 0..100 unsharp-mask amount. */
  detail: number;
}

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  detail: 0,
};

export interface PageEdits {
  /** Crop corners in normalized source coordinates, or `null` for the full frame. */
  quad: Quad | null;
  rotation: Rotation;
  filter: FilterId;
  adjust: Adjustments;
  /** Extra clockwise fine rotation in degrees, -15..15, applied after `rotation`. */
  deskew: number;
}

export const DEFAULT_EDITS: PageEdits = {
  quad: null,
  rotation: 0,
  filter: 'magic',
  adjust: DEFAULT_ADJUSTMENTS,
  deskew: 0,
};

/* ------------------------------------------------------------------ */
/* Annotations                                                         */
/* ------------------------------------------------------------------ */

export type AnnotationKind = 'text' | 'signature' | 'image' | 'draw' | 'highlight' | 'redact';

interface AnnotationBase {
  id: ID;
  kind: AnnotationKind;
  /** Normalized centre-independent bounding box, 0..1 of the *processed* page. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Clockwise degrees. */
  rotation: number;
  opacity: number;
}

export interface TextAnnotation extends AnnotationBase {
  kind: 'text';
  text: string;
  color: string;
  /** Font size as a fraction of page height so it scales with export DPI. */
  fontScale: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
}

export interface SignatureAnnotation extends AnnotationBase {
  kind: 'signature';
  /** Blob id of a transparent PNG. */
  blobId: ID;
}

export interface ImageAnnotation extends AnnotationBase {
  kind: 'image';
  blobId: ID;
}

export interface DrawAnnotation extends AnnotationBase {
  kind: 'draw';
  /** Strokes in normalized page coordinates. */
  strokes: Point[][];
  color: string;
  /** Stroke width as a fraction of page width. */
  widthScale: number;
}

export interface HighlightAnnotation extends AnnotationBase {
  kind: 'highlight';
  color: string;
}

export interface RedactAnnotation extends AnnotationBase {
  kind: 'redact';
}

export type Annotation =
  | TextAnnotation
  | SignatureAnnotation
  | ImageAnnotation
  | DrawAnnotation
  | HighlightAnnotation
  | RedactAnnotation;

/* ------------------------------------------------------------------ */
/* OCR                                                                 */
/* ------------------------------------------------------------------ */

export interface OcrWord {
  text: string;
  /** Normalized box on the processed page. */
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  words: OcrWord[];
}

export interface OcrResult {
  language: string;
  text: string;
  lines: OcrLine[];
  confidence: number;
  /** Epoch ms. */
  completedAt: number;
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export interface Page {
  id: ID;
  docId: ID;
  /** Blob id of the untouched capture — every edit is re-derived from this. */
  originalBlobId: ID;
  /** Cached render of `edits` applied to the original. */
  processedBlobId: ID | null;
  thumbBlobId: ID | null;
  /** Size of the original capture. */
  source: Size;
  /** Size of the processed render, once one exists. */
  processed: Size | null;
  edits: PageEdits;
  annotations: Annotation[];
  ocr: OcrResult | null;
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type DocumentColor =
  | 'none'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple';

export interface ScanDocument {
  id: ID;
  title: string;
  folderId: ID | null;
  /** Ordered page ids. */
  pageIds: ID[];
  tags: string[];
  color: DocumentColor;
  /** Set when the document lives in the trash; epoch ms of deletion. */
  deletedAt: number | null;
  /** Requires the app passcode to open when true. */
  locked: boolean;
  starred: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Folder {
  id: ID;
  name: string;
  parentId: ID | null;
  color: DocumentColor;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

export type CaptureMode =
  /** One shot, straight into the editor. */
  | 'single'
  /** Keep shooting; pages queue up into one document. */
  | 'batch'
  /** Front and back of an ID composed onto one page. */
  | 'idcard'
  /** Split a two-page book spread into two pages. */
  | 'book'
  /** Read QR codes and barcodes. */
  | 'qr'
  /** Capture straight to a text transcription. */
  | 'ocr';

export interface CaptureSettings {
  mode: CaptureMode;
  /** Fire the shutter automatically once a stable document is framed. */
  autoCapture: boolean;
  grid: boolean;
  torch: boolean;
  /** Beep/haptic on capture. */
  sound: boolean;
  facing: 'environment' | 'user';
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export type PageSizeId = 'fit' | 'a4' | 'a5' | 'a3' | 'letter' | 'legal' | 'b5' | 'businesscard';
export type PageOrientation = 'auto' | 'portrait' | 'landscape';
export type PdfMargin = 'none' | 'small' | 'medium' | 'large';
export type ExportQuality = 'low' | 'medium' | 'high' | 'original';

export interface PdfExportOptions {
  pageSize: PageSizeId;
  orientation: PageOrientation;
  margin: PdfMargin;
  quality: ExportQuality;
  /** Embed an invisible OCR layer so the PDF is searchable and selectable. */
  searchable: boolean;
  /** Owner/user password; when set the PDF is encrypted (RC4-128). */
  password: string | null;
  /** Rendered into a corner of every page. */
  watermark: WatermarkOptions | null;
  title: string;
  author: string;
}

export interface WatermarkOptions {
  text: string;
  opacity: number;
  /** Degrees, counter-clockwise. */
  angle: number;
  fontScale: number;
  color: string;
  tile: boolean;
}

export const DEFAULT_PDF_OPTIONS: PdfExportOptions = {
  pageSize: 'fit',
  orientation: 'auto',
  margin: 'none',
  quality: 'high',
  searchable: true,
  password: null,
  watermark: null,
  title: '',
  author: 'OpenScan',
};

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export type ThemeSetting = 'system' | 'light' | 'dark';
export type ViewMode = 'grid' | 'list';
export type SortKey = 'updated' | 'created' | 'name' | 'size';

export interface AppSettings {
  theme: ThemeSetting;
  defaultFilter: FilterId;
  defaultCaptureMode: CaptureMode;
  autoCapture: boolean;
  showGrid: boolean;
  shutterSound: boolean;
  /** Run OCR automatically after a page is processed. */
  autoOcr: boolean;
  ocrLanguage: string;
  defaultPdf: PdfExportOptions;
  viewMode: ViewMode;
  sortKey: SortKey;
  sortAsc: boolean;
  /** Argon-ish salted hash of the passcode; null when the lock is off. */
  passcodeHash: string | null;
  passcodeSalt: string | null;
  /** Keep the raw capture so filters stay non-destructive. Always true today. */
  keepOriginals: boolean;
  jpegQuality: number;
  /** Longest edge, in pixels, of a processed page. */
  maxProcessedEdge: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  defaultFilter: 'magic',
  defaultCaptureMode: 'batch',
  autoCapture: false,
  showGrid: true,
  shutterSound: true,
  autoOcr: false,
  ocrLanguage: 'eng',
  defaultPdf: DEFAULT_PDF_OPTIONS,
  viewMode: 'grid',
  sortKey: 'updated',
  sortAsc: false,
  passcodeHash: null,
  passcodeSalt: null,
  keepOriginals: true,
  jpegQuality: 0.86,
  maxProcessedEdge: 2400,
};

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export interface BarcodeResult {
  text: string;
  format: string;
  corners: Point[] | null;
}

export interface DetectionResult {
  quad: Quad | null;
  /** 0..1 confidence that a document was actually found. */
  score: number;
}
