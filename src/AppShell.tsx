import { useEffect, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useStore } from '@/state/store';
import { registerRouter } from '@/state/navigation';
import { LockScreen } from '@/features/lock/LockScreen';
import { Toaster } from '@/ui/Toaster';
import { Spinner } from '@/ui/primitives';
import { registerServiceWorker } from '@/lib/pwa';

/**
 * Everything that wraps every route: loading the library out of IndexedDB,
 * applying the theme, and holding the passcode gate shut.
 *
 * Rendered inside the root route, so it runs once for the whole session rather
 * than per navigation.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const ready = useStore((s) => s.ready);
  const theme = useStore((s) => s.settings.theme);
  const unlocked = useStore((s) => s.unlocked);
  const hasPasscode = useStore((s) => s.settings.passcodeHash !== null);
  const init = useStore((s) => s.init);
  const router = useRouter();

  // The store navigates from actions, outside React, so it needs the instance
  // handed to it. Done before the first effect that could navigate.
  registerRouter(router);

  useEffect(() => {
    void init();
    registerServiceWorker();
  }, [init]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  if (!ready) {
    return (
      <div className="boot">
        <Spinner size={28} label="Loading your documents" />
      </div>
    );
  }

  if (hasPasscode && !unlocked) return <LockScreen />;

  return (
    <>
      {children}
      <Toaster />
    </>
  );
}
