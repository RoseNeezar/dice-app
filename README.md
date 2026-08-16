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

Built with [TanStack Start](https://tanstack.com/start) on Vite, in SPA mode.

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

### Routing

TanStack Start runs in **SPA mode**: the shell is prerendered at build time and
the app takes over on the client. There is deliberately no server rendering and
no server function — every document lives in IndexedDB on the device, and every
screen needs a camera, a canvas or a worker, so there is nothing a server could
usefully render. It is also what lets the whole app be installed and run
offline.

What the router buys is real URLs. Each screen is a file under `src/routes/`,
so `/doc/:docId/review` can be reloaded or shared, and the phone's back gesture
walks the history instead of leaving the app.

| URL | Screen |
| --- | --- |
| `/` | Library |
| `/folder/$folderId` | Folder contents |
| `/search`, `/trash` | Search, trash |
| `/doc/$docId` | A document's pages |
| `/doc/$docId/camera` | Capture |
| `/doc/$docId/review` | Crop review |
| `/doc/$docId/page/$pageId` | Viewer |
| `/doc/$docId/page/$pageId/edit` | Filters and adjustments |
| `/settings` | Settings |

Screens never build URLs themselves. They call `navigate({ name: 'doc', docId })`
on the store, and `src/state/navigation.ts` is the single place that maps a
destination onto a path — so the routes can be reshaped without touching a
screen.

## Layout

```
src/
  routes/      one file per URL (TanStack Start file-based routing)
  router.tsx   the router entry Start looks for
  AppShell.tsx boot, theme and the passcode gate, wrapping every route
  types/       domain model — the contract everything else builds on
  state/       zustand store: capture sessions, all mutations; navigation.ts maps routes to URLs
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
