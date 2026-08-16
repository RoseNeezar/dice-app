import type { AnyRouter } from '@tanstack/react-router';
import type { ID } from '@/types';

/**
 * A destination inside the app.
 *
 * Screens describe where they want to go in domain terms; this module is the
 * single place that knows the URL for each one. Keeping the union means the
 * dozens of existing `navigate({ name: 'doc', docId })` call sites stay honest
 * and type-checked, while the router owns history, deep links and the back
 * button.
 */
export type Route =
  | { name: 'home' }
  | { name: 'folder'; folderId: ID }
  | { name: 'trash' }
  | { name: 'search' }
  | { name: 'doc'; docId: ID }
  | { name: 'camera'; docId: ID }
  | { name: 'review'; docId: ID }
  | { name: 'edit'; docId: ID; pageId: ID }
  | { name: 'viewer'; docId: ID; pageId: ID }
  | { name: 'settings' };

export interface RouteLocation {
  to: string;
  params?: Record<string, string>;
}

/** Map a domain destination onto its route path and params. */
export function routeToLocation(route: Route): RouteLocation {
  switch (route.name) {
    case 'home':
      return { to: '/' };
    case 'folder':
      return { to: '/folder/$folderId', params: { folderId: route.folderId } };
    case 'trash':
      return { to: '/trash' };
    case 'search':
      return { to: '/search' };
    case 'doc':
      return { to: '/doc/$docId/', params: { docId: route.docId } };
    case 'camera':
      return { to: '/doc/$docId/camera', params: { docId: route.docId } };
    case 'review':
      return { to: '/doc/$docId/review', params: { docId: route.docId } };
    case 'edit':
      return {
        to: '/doc/$docId/page/$pageId/edit',
        params: { docId: route.docId, pageId: route.pageId },
      };
    case 'viewer':
      return {
        to: '/doc/$docId/page/$pageId/',
        params: { docId: route.docId, pageId: route.pageId },
      };
    case 'settings':
      return { to: '/settings' };
  }
}

let router: AnyRouter | null = null;

/**
 * Hand the store a router to drive.
 *
 * The store is a plain module, not a component, so it cannot use the router
 * hooks; the shell registers the instance once on mount instead.
 */
export function registerRouter(instance: AnyRouter): void {
  router = instance;
}

function requireRouter(): AnyRouter | null {
  if (!router && typeof window !== 'undefined' && import.meta.env.DEV) {
    console.warn('Navigation was attempted before the router was registered.');
  }
  return router;
}

export function goTo(route: Route, options: { replace?: boolean } = {}): void {
  const instance = requireRouter();
  if (!instance) return;
  const location = routeToLocation(route);
  void instance.navigate({ ...location, replace: options.replace ?? false });
}

/**
 * Step back through history, falling back to the library.
 *
 * A capture can be entered from a deep link, in which case there is nothing
 * behind it — going "back" has to land somewhere real rather than leaving the
 * app.
 */
export function goBack(): void {
  const instance = requireRouter();
  if (!instance) return;
  if (instance.history.canGoBack()) {
    instance.history.back();
    return;
  }
  void instance.navigate({ to: '/', replace: true });
}
