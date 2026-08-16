import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

/**
 * The router entry TanStack Start looks for.
 *
 * OpenScan holds every document in IndexedDB on the device, so there is no
 * server data to load: routes exist to give each screen a real URL, a real
 * back button and a shareable deep link, not to fetch anything. Preloading is
 * therefore pointless and turned off.
 */
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: false,
    scrollRestoration: true,
    defaultStaleTime: Infinity,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
