import type { Page } from '@playwright/test';

/**
 * Build a synthetic "photo of a document" inside the browser and hand it to
 * the app through a file input.
 *
 * Generating the image in-page (rather than shipping a fixture) keeps the
 * repository free of binary test assets and lets each test choose the
 * perspective, so the detection path is genuinely exercised.
 */
export async function makeDocumentPhoto(
  page: Page,
  options: { width?: number; height?: number; skew?: number; name?: string } = {},
): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const { width = 900, height = 1200, skew = 0.08 } = options;
  const dataUrl = await page.evaluate(
    ({ width, height, skew }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');

      // Desk background.
      ctx.fillStyle = '#22252c';
      ctx.fillRect(0, 0, width, height);

      // Page corners, skewed to look hand-held.
      const dx = width * skew;
      const dy = height * skew * 0.4;
      const corners = [
        { x: width * 0.12 + dx * 0.4, y: height * 0.08 },
        { x: width * 0.9, y: height * 0.06 + dy },
        { x: width * 0.86 - dx * 0.3, y: height * 0.93 },
        { x: width * 0.08, y: height * 0.9 - dy * 0.6 },
      ];

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (const c of corners.slice(1)) ctx.lineTo(c.x, c.y);
      ctx.closePath();
      ctx.fillStyle = '#f2f0ec';
      ctx.fill();
      ctx.clip();

      // Text-like bars so the enhancement filters have something to bite on.
      ctx.fillStyle = '#2b2b2f';
      const left = width * 0.18;
      const lineWidth = width * 0.62;
      for (let i = 0; i < 22; i++) {
        const y = height * 0.16 + i * height * 0.033;
        const w = lineWidth * (0.55 + ((i * 37) % 45) / 100);
        ctx.fillRect(left, y, w, height * 0.011);
      }
      ctx.font = `bold ${Math.round(height * 0.045)}px sans-serif`;
      ctx.fillText('INVOICE 2026-014', left, height * 0.13);
      ctx.restore();

      return canvas.toDataURL('image/jpeg', 0.92);
    },
    { width, height, skew },
  );

  const base64 = dataUrl.split(',')[1];
  return {
    name: options.name ?? 'scan-test.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(base64, 'base64'),
  };
}

/** Wipe IndexedDB so each spec starts from a clean library. */
export async function resetApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    const databases = (await indexedDB.databases?.()) ?? [{ name: 'openscan' }];
    await Promise.all(
      databases
        .filter((db) => db.name)
        .map(
          (db) =>
            new Promise<void>((resolve) => {
              const request = indexedDB.deleteDatabase(db.name as string);
              request.onsuccess = () => resolve();
              request.onerror = () => resolve();
              request.onblocked = () => resolve();
            }),
        ),
    );
  });
  await page.reload();
}

/** Wait until no page render is in flight, so screenshots are stable. */
export async function waitForIdleRender(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const busy = document.querySelectorAll('[data-rendering="true"], .spinner').length;
      return busy === 0;
    },
    undefined,
    { timeout },
  );
}
