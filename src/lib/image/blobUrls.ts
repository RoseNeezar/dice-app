import type { ID } from '@/types';
import { getBlob } from '@/lib/db/repository';

/**
 * Object-URL cache keyed by blob id.
 *
 * Every thumbnail in a 200-page document would otherwise mint a new URL on
 * each render and leak it. Entries are reference counted so a URL survives
 * while any component still shows it, and are revoked when the underlying blob
 * is replaced or deleted.
 */

interface Entry {
  url: string;
  refs: number;
  promise: Promise<string | null>;
}

const cache = new Map<ID, Entry>();

export async function acquireBlobUrl(id: ID | null | undefined): Promise<string | null> {
  if (!id) return null;
  const existing = cache.get(id);
  if (existing) {
    existing.refs++;
    return existing.promise;
  }
  const entry: Entry = { url: '', refs: 1, promise: Promise.resolve(null) };
  entry.promise = (async () => {
    const blob = await getBlob(id);
    if (!blob) {
      cache.delete(id);
      return null;
    }
    entry.url = URL.createObjectURL(blob);
    return entry.url;
  })();
  cache.set(id, entry);
  return entry.promise;
}

export function releaseBlobUrl(id: ID | null | undefined): void {
  if (!id) return;
  const entry = cache.get(id);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  cache.delete(id);
  if (entry.url) URL.revokeObjectURL(entry.url);
}

/** Force-drop URLs whose blobs are gone or have been replaced. */
export function releaseBlobUrls(ids: ID[]): void {
  for (const id of ids) {
    const entry = cache.get(id);
    if (!entry) continue;
    cache.delete(id);
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
}

export function clearBlobUrlCache(): void {
  for (const [, entry] of cache) {
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
  cache.clear();
}
