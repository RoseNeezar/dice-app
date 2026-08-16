import { useEffect, useState } from 'react';
import type { ID } from '@/types';
import { acquireBlobUrl, releaseBlobUrl } from '@/lib/image/blobUrls';

interface Resolved {
  id: ID;
  url: string | null;
}

/**
 * Resolve a stored blob id to an object URL for the lifetime of the component.
 * Returns null while loading, and when the blob no longer exists.
 *
 * The resolved id is kept alongside the URL so that switching to a different
 * blob reads as "not loaded yet" from the render itself, rather than needing an
 * effect to clear the previous URL — which would cost an extra render pass and
 * could flash the old page's thumbnail on the new page.
 */
export function useBlobUrl(id: ID | null | undefined): string | null {
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void acquireBlobUrl(id).then((url) => {
      if (alive) setResolved({ id, url });
      else releaseBlobUrl(id);
    });
    return () => {
      alive = false;
      releaseBlobUrl(id);
    };
  }, [id]);

  return resolved && id && resolved.id === id ? resolved.url : null;
}
