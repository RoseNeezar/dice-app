import { useEffect, useState } from 'react';
import type { ID } from '@/types';
import { acquireBlobUrl, releaseBlobUrl } from '@/lib/image/blobUrls';

/**
 * Resolve a stored blob id to an object URL for the lifetime of the component.
 * Returns null while loading or when the blob no longer exists.
 */
export function useBlobUrl(id: ID | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setUrl(null);
      return;
    }
    let alive = true;
    void acquireBlobUrl(id).then((next) => {
      if (alive) setUrl(next);
      else releaseBlobUrl(id);
    });
    return () => {
      alive = false;
      releaseBlobUrl(id);
    };
  }, [id]);

  return url;
}
