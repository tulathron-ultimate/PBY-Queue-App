import { useEffect } from 'react';
import { CreateEvent } from './pages/host/CreateEvent';
import { EventsList } from './pages/host/EventsList';
import { HostEvent } from './pages/host/HostEvent';
import { Join } from './pages/guest/Join';
import { Status } from './pages/guest/Status';
import { applyTheme, loadPrefs } from './prefs';
import { navigate, useLocation } from './router';

export function App() {
  const path = useLocation().split('?')[0].replace(/\/+$/, '') || '/';
  const isHost = path === '/' || path.startsWith('/host');

  useEffect(() => {
    applyTheme(isHost ? loadPrefs() : null);
  }, [isHost]);

  useEffect(() => {
    if (path === '/') navigate('/host', { replace: true });
  }, [path]);

  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/j\/([A-Za-z0-9]+)$/))) return <Join code={m[1].toUpperCase()} />;
  if ((m = path.match(/^\/s\/([A-Za-z0-9]+)$/))) return <Status token={m[1]} />;
  if (path === '/host/new') return <CreateEvent />;
  if ((m = path.match(/^\/host\/e\/([A-Za-z0-9]+)(?:\/(share|settings))?$/))) {
    return <HostEvent key={m[1]} id={m[1]} view={(m[2] as 'share' | 'settings') ?? 'dashboard'} />;
  }
  if (path === '/host' || path === '/') return <EventsList />;
  return (
    <main className="screen guest">
      <div className="content" style={{ paddingTop: 48 }}>
        <h1 className="display">Page not found</h1>
        <p>Check the link, or ask the photographer.</p>
      </div>
    </main>
  );
}
