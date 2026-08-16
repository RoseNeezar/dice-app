import { useEffect } from 'react';
import { useStore } from '@/state/store';
import { HomeScreen } from '@/screens/HomeScreen';
import { CameraScreen } from '@/screens/CameraScreen';
import { ReviewScreen } from '@/screens/ReviewScreen';
import { DocumentScreen } from '@/screens/DocumentScreen';
import { EditScreen } from '@/screens/EditScreen';
import { ViewerScreen } from '@/screens/ViewerScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { LockScreen } from '@/features/lock/LockScreen';
import { Toaster } from '@/ui/Toaster';
import { Spinner } from '@/ui/primitives';
import '@/styles/global.css';

export default function App() {
  const ready = useStore((s) => s.ready);
  const route = useStore((s) => s.route);
  const theme = useStore((s) => s.settings.theme);
  const unlocked = useStore((s) => s.unlocked);
  const hasPasscode = useStore((s) => s.settings.passcodeHash !== null);
  const init = useStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  // The browser back gesture should walk the in-app stack, not leave the app.
  useEffect(() => {
    const onPop = () => {
      const state = useStore.getState();
      if (state.stack.length > 0) {
        state.back();
        history.pushState(null, '');
      }
    };
    history.pushState(null, '');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (!ready) {
    return (
      <div className="boot">
        <Spinner size={28} label="Loading your documents" />
      </div>
    );
  }

  if (hasPasscode && !unlocked) {
    return <LockScreen />;
  }

  return (
    <>
      {renderRoute(route)}
      <Toaster />
    </>
  );
}

function renderRoute(route: ReturnType<typeof useStore.getState>['route']) {
  switch (route.name) {
    case 'home':
    case 'folder':
    case 'trash':
    case 'search':
      return <HomeScreen route={route} />;
    case 'camera':
      return <CameraScreen docId={route.docId} />;
    case 'review':
      return <ReviewScreen docId={route.docId} />;
    case 'doc':
      return <DocumentScreen docId={route.docId} />;
    case 'edit':
      return <EditScreen docId={route.docId} pageId={route.pageId} />;
    case 'viewer':
      return <ViewerScreen docId={route.docId} pageId={route.pageId} />;
    case 'settings':
      return <SettingsScreen />;
    default:
      return <HomeScreen route={{ name: 'home' }} />;
  }
}
