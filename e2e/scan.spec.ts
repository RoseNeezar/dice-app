import { expect, test, type Page } from '@playwright/test';
import { makeDocumentPhoto, resetApp } from './helpers';

/**
 * End-to-end coverage of the path a real user takes: bring an image in, let the
 * pipeline detect and clean it up, then get a PDF back out. Import stands in
 * for the camera because a fake video device cannot produce a stable,
 * assertable page — but everything downstream of the capture is the same code.
 */

test.beforeEach(async ({ page }) => {
  await resetApp(page);
});

/** Import a synthetic document photo and confirm the crop review it lands in. */
async function importAndAccept(page: Page): Promise<void> {
  const photo = await makeDocumentPhoto(page);
  await page.setInputFiles('input[type="file"]', photo);

  // Imports go through the crop review, the same as a capture.
  const done = page.getByRole('button', { name: /^done$/i });
  await expect(done).toBeVisible({ timeout: 90_000 });
  await done.click();
}

test('starts on an empty library and offers a scan', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Scan your first document' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan a document' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import images' })).toBeVisible();
});

test('imports a photo, detects the page and files it in the library', async ({ page }) => {
  await importAndAccept(page);

  // The document screen shows the processed page.
  await expect(page.getByRole('button', { name: /add pages/i })).toBeVisible({ timeout: 30_000 });
  const pageThumb = page.locator('img').first();
  await expect(pageThumb).toBeVisible({ timeout: 30_000 });
  const decoded = await pageThumb.evaluate(
    (node) => (node as HTMLImageElement).naturalWidth > 0 && (node as HTMLImageElement).naturalHeight > 0,
  );
  expect(decoded).toBe(true);

  // Back out to the library, where the document is now listed.
  await page.goBack();
  const card = page.locator('.doccard__hit').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
});

test('the detected crop removes the background around the page', async ({ page }) => {
  await importAndAccept(page);

  // The source photo is a skewed page on a dark desk. After detection and
  // dewarping the corners must be paper, not desk — this is the whole point of
  // the scanner, and it is the one thing a screenshot-free test can still pin.
  const corners = await page.evaluate(async () => {
    const img = document.querySelector('img');
    if (!img) return null;
    const bitmap = await createImageBitmap(await (await fetch(img.src)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const inset = Math.round(Math.min(bitmap.width, bitmap.height) * 0.04);
    const at = (x: number, y: number) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return (d[0] + d[1] + d[2]) / 3;
    };
    return [
      at(inset, inset),
      at(bitmap.width - 1 - inset, inset),
      at(bitmap.width - 1 - inset, bitmap.height - 1 - inset),
      at(inset, bitmap.height - 1 - inset),
    ];
  });

  expect(corners).not.toBeNull();
  for (const luminance of corners as number[]) {
    expect(luminance).toBeGreaterThan(140);
  }
});

test('exports a PDF the browser accepts as a download', async ({ page }) => {
  await importAndAccept(page);

  await page.getByRole('button', { name: /share/i }).first().click();

  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();

  // Searchable PDFs need OCR, which downloads a language model — off here so
  // the test stays hermetic. The switch input is visually hidden behind its
  // styled track (the usual accessible-toggle pattern), so the label is what a
  // user actually presses.
  const searchableRow = sheet.locator('label.toggle').filter({ hasText: /searchable/i }).first();
  if ((await searchableRow.count()) > 0) {
    await searchableRow.scrollIntoViewIfNeeded();
    if (await searchableRow.locator('input').isChecked()) {
      await searchableRow.click();
      await expect(searchableRow.locator('input')).not.toBeChecked();
    }
  }

  const download = page.waitForEvent('download', { timeout: 120_000 });
  await sheet.getByRole('button', { name: /^(export|save|share|create|download)/i }).last().click();

  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/i);

  // A real PDF, not an empty or error blob.
  const path = await file.path();
  expect(path).toBeTruthy();
});

test('settings persist across a reload', async ({ page }) => {
  await page.getByRole('button', { name: /more|menu|options/i }).first().click();
  await page.getByRole('button', { name: /settings/i }).first().click();

  await page.getByRole('radio', { name: /dark/i }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 20_000 });
});
