# OpenScan

A document scanner and PDF toolkit that runs entirely in your browser. Point a
phone at a page, and OpenScan finds the paper, straightens the perspective,
cleans up the lighting and gives you a searchable PDF — without a single byte
leaving the device.

Install it to the home screen and it works offline.

## What it does

**Capture**

- Live edge detection on the camera preview, with the page outline tracked in
  real time.
- Auto-shutter that fires once the phone is steady and the page is framed.
- Capture modes: single, batch, ID card (both sides on one page), book (splits
  a spread into two pages), QR/barcode, and capture-straight-to-text.
- Torch, grid, zoom, front/back camera, and import from the photo library.

**Clean up**

- Four-point perspective correction with the true page aspect ratio recovered
  from the vanishing points, so an A4 sheet shot at an angle comes back as A4.
- Manual corner adjustment with a magnifier loupe for precise placement.
- Scan looks: Magic Colour, Enhance, Greyscale, B&W and Save Ink — all built on
  illumination flattening, so a shadow across the page disappears instead of
  being crushed to black.
- Brightness, contrast, saturation and detail sliders, rotation and deskew.
- Every edit is non-destructive: renders are always re-derived from the
  untouched capture, so nothing degrades as you change your mind.

**Organise**

- Documents, folders, tags, colour flags, stars and full-text search across
  recognised text.
- Drag to reorder pages, split, merge, duplicate and move.
- Trash with restore, and orphaned-blob collection so deleted scans free space.

**Share**

- PDF with page size, orientation, margins, quality, watermarks and an
  invisible OCR text layer that makes the file searchable and selectable.
- Password-protected PDFs.
- JPEG, plain text, Word (.docx), spreadsheet (.csv) and ZIP export.
- Native share sheet where the browser supports it, download everywhere else.

**Text recognition**

- On-device OCR in 20+ languages, word-level boxes, and text you can copy,
  export or search.

**Private by design**

- Everything is processed on-device and stored in IndexedDB. There is no
  account, no server and no telemetry.
- Optional passcode lock (PBKDF2-SHA256) for the whole app.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

The camera needs a secure context. `localhost` counts; to try it on a phone,
build and serve over HTTPS (or use a tunnel).

```bash
npm run build      # typecheck + production bundle
npm run preview    # serve the build on :4173
```

## Checks

```bash
npm run lint       # eslint
npm test           # vitest unit suite
npm run test:e2e   # Playwright end-to-end
npm run verify     # all of the above
```

## How it works

The interesting part is `src/lib/cv`, which is a small computer-vision stack
written from scratch — no OpenCV, no WASM blob, about 40 KB of TypeScript that
runs in a worker.

| Module | What it does |
| --- | --- |
| `edges.ts` | Separable Gaussian blur, Sobel gradients, Canny with histogram-derived thresholds, Otsu |
| `detect.ts` | Hough line transform, then a search over line pairs scored by how much real edge evidence sits under each candidate quadrilateral |
| `homography.ts` | Four-point DLT solved as an 8×8 system, perspective warp with adaptive pre-filtering, and aspect-ratio recovery from the two vanishing points |
| `enhance.ts` | Illumination estimation by grey dilation, Sauvola adaptive thresholding, percentile white balance, unsharp masking |
| `stability.ts` | The auto-shutter state machine: frame difference *and* corner drift must both settle |
| `pipeline.ts` | dewarp → deskew → rotate → tone, plus ID-card composition and book-spread splitting |

Detection runs on a 384 px working frame in roughly 60 ms, which is what makes
the live preview overlay possible.

Data lives in IndexedDB behind `src/lib/db/repository.ts`: documents and pages
are small JSON rows, and every image is a separate blob so a 200-page document
never has to be loaded whole.

## Layout

```
src/
  types/       domain model — the contract everything else builds on
  state/       zustand store: navigation, capture sessions, all mutations
  lib/
    cv/        computer vision + the worker that runs it
    db/        IndexedDB wrapper and repository
    pdf/       PDF assembly, page geometry, encryption
    ocr/       Tesseract wrapper and language list
    export/    text, docx, csv, zip writers
    render/    annotation compositing for export
    image/     encode/decode helpers shared by window and worker
  ui/          design tokens, icon set, primitives, sheets
  screens/     one file per route
  features/    camera, crop, edit, docs, annotate, export, lock
```

## Browser support

Chrome, Edge and Android WebView have the full feature set. Safari 16.4+ and
Firefox work, minus the capabilities they do not implement (torch, and
`BarcodeDetector` for QR — the app checks and degrades rather than breaking).
Everything falls back gracefully: no worker means processing on the main
thread, no `navigator.share` means a download.
