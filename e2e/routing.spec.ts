import { expect, test } from '@playwright/test';
import { makeDocumentPhoto, resetApp } from './helpers';

/**
 * The routing contract the app gets from TanStack Start: every screen has a
 * real URL, a reload lands back on it, and the browser's own back button walks
 * the history. None of this was possible while navigation lived in a store.
 */

test.beforeEach(async ({ page }) => {
  await resetApp(page);
});

test('each screen has its own URL', async ({ page }) => {
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole('button', { name: /more|menu|options/i }).first().click();
  await page.getByRole('button', { name: /settings/i }).first().click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Scan a document' })).toBeVisible();
});

test('a document deep link survives a cold reload', async ({ page }) => {
  const photo = await makeDocumentPhoto(page);
  await page.setInputFiles('input[type="file"]', photo);

  const done = page.getByRole('button', { name: /^done$/i });
  await expect(done).toBeVisible({ timeout: 90_000 });

  // The crop review is addressable while we are on it.
  await expect(page).toHaveURL(/\/doc\/[^/]+\/review$/);
  await done.click();

  await expect(page).toHaveURL(/\/doc\/[^/]+$/);
  const url = page.url();

  // Reload straight into the document: the shell is prerendered, the router
  // matches the path, and the document is read back out of IndexedDB.
  await page.goto(url);
  await expect(page.getByRole('button', { name: /add pages/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('img').first()).toBeVisible({ timeout: 30_000 });
});

test('an unknown document id does not break the app', async ({ page }) => {
  await page.goto('/doc/does-not-exist/');
  // Whatever it shows, it must stay usable and reachable rather than crashing
  // to a blank document.
  await expect(page.locator('body')).not.toBeEmpty();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Scan a document' })).toBeVisible({ timeout: 30_000 });
});
