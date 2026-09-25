import type { HostSnapshot } from '@pby/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import { Toast, TopBar, type ToastData } from '../../components/ui';
import { useLive } from '../../live';
import { loadPrefs, type Prefs } from '../../prefs';
import { navigate } from '../../router';
import { Dashboard } from './Dashboard';
import { PinUnlock } from './PinUnlock';
import { SettingsPage } from './SettingsPage';
import { SharePage } from './SharePage';

export type Act = (
  path: string,
  body?: unknown,
  method?: 'POST' | 'PATCH',
) => Promise<HostSnapshot>;

export interface HostContext {
  id: string;
  snap: HostSnapshot;
  act: Act;
  /** Server clock minus the local clock, for timers. */
  clockOffset: number;
  live: ReturnType<typeof useLive>;
  toast: (t: Omit<ToastData, 'id'>) => void;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
  undo: () => Promise<void>;
}

let toastSeq = 0;

/** Loads one event for an authenticated host device and keeps it live. */
export function HostEvent({ id, view }: { id: string; view: 'dashboard' | 'share' | 'settings' }) {
  const [snap, setSnapState] = useState<HostSnapshot | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [auth, setAuth] = useState<'loading' | 'ok' | 'pin' | 'gone' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toastData, setToastData] = useState<ToastData | null>(null);
  const [prefs, setPrefs] = useState(loadPrefs);

  const setSnap = useCallback((s: HostSnapshot) => {
    setSnapState(s);
    setClockOffset(s.serverTime - Date.now());
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await api<HostSnapshot>(`/api/host/events/${id}`);
      setSnap(s);
      setAuth('ok');
      return s;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuth('pin');
      else if (err instanceof ApiError && err.status === 404) setAuth('gone');
      else {
        setLoadError(errorMessage(err));
        setAuth((a) => (a === 'ok' ? a : 'error'));
      }
      return null;
    }
  }, [id, setSnap]);

  useEffect(() => {
    void load();
  }, [load]);

  const live = useLive<HostSnapshot>({
    wsPath: auth === 'ok' ? `/ws/host/${id}` : null,
    poll: load,
    pick: (m) => (m.type === 'host' ? m.data : null),
    onData: setSnap,
    onClose: (code) => {
      if (code === 4401) {
        setAuth('pin');
        return false;
      }
      if (code === 4404) {
        setAuth('gone');
        return false;
      }
    },
  });

  const toast = useCallback(
    (t: Omit<ToastData, 'id'>) => setToastData({ ...t, id: ++toastSeq }),
    [],
  );

  const act: Act = useCallback(
    async (path, body, method = 'POST') => {
      try {
        const r = await api<HostSnapshot | { snapshot: HostSnapshot }>(
          `/api/host/events/${id}${path}`,
          {
            method,
            body: body ?? {},
          },
        );
        const s = 'snapshot' in r ? r.snapshot : r;
        setSnap(s);
        return s;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) setAuth('pin');
        throw err;
      }
    },
    [id, setSnap],
  );

  const undo = useCallback(async () => {
    setToastData(null);
    try {
      const s = (await act('/undo')) as HostSnapshot & { undone?: string };
      toast({ text: `Undid: ${s.undone ?? 'last action'}` });
    } catch (err) {
      toast({ text: errorMessage(err), danger: true });
    }
  }, [act, toast]);

  if (auth === 'pin') return <PinUnlock id={id} onUnlocked={() => void load()} />;
  if (auth === 'gone') {
    return (
      <main className="screen">
        <TopBar title="Event not found" onBack={() => navigate('/host')} />
        <div className="content">
          <p>This event was deleted, or the link is wrong.</p>
        </div>
      </main>
    );
  }
  if (auth === 'error' && !snap) {
    return (
      <main className="screen">
        <TopBar title="Can't load event" onBack={() => navigate('/host')} />
        <div className="content">
          <div className="banner danger" role="alert">
            {loadError}
          </div>
          <button className="btn secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (!snap) {
    return (
      <main className="screen" aria-busy="true">
        <div className="content" style={{ paddingTop: 72 }}>
          <div className="skeleton" style={{ height: 150, marginBottom: 16 }} />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton" style={{ height: 64, marginBottom: 8 }} />
          ))}
        </div>
      </main>
    );
  }

  const ctx: HostContext = {
    id,
    snap,
    act,
    clockOffset,
    live,
    toast,
    prefs,
    setPrefs,
    undo,
  };
  return (
    <>
      {view === 'share' ? (
        <SharePage ctx={ctx} />
      ) : view === 'settings' ? (
        <SettingsPage ctx={ctx} />
      ) : (
        <Dashboard ctx={ctx} />
      )}
      <Toast
        toast={toastData}
        onUndo={() => void undo()}
        onDone={() => setToastData(null)}
        noBar={view !== 'dashboard'}
      />
    </>
  );
}
