import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';
import { AppShell } from '@/AppShell';
import globalCss from '@/styles/global.css?url';

/**
 * The document shell.
 *
 * Start renders this on the server (at build time, in SPA mode) and hydrates
 * it on the client, so it holds everything that must exist before React does:
 * viewport and theme colours, the manifest, and the icon links.
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover',
      },
      { title: 'OpenScan — Document Scanner' },
      {
        name: 'description',
        content: 'Scan documents, clean them up and export searchable PDFs, entirely on your device.',
      },
      { name: 'theme-color', content: '#0f1115', media: '(prefers-color-scheme: dark)' },
      { name: 'theme-color', content: '#f6f7f9', media: '(prefers-color-scheme: light)' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      { name: 'apple-mobile-web-app-title', content: 'OpenScan' },
    ],
    links: [
      { rel: 'stylesheet', href: globalCss },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'icon', href: '/icons/icon.svg', type: 'image/svg+xml' },
      { rel: 'apple-touch-icon', href: '/icons/icon-180.png' },
    ],
  }),
  shellComponent: RootDocument,
  component: RouteComponent,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RouteComponent() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
