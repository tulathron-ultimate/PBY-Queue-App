import type { LobbySnapshot } from '@pby/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { LivePill } from '../../components/ui';
import { Icon } from '../../icons';
import { useLive } from '../../live';
import { useWakeLock } from '../../platform/wakeLock';

/**
 * L1 / G5 lobby display: a read-only 16:9 board for a TV or tablet at the venue. Live over
 * WebSocket (reconnecting on its own, with polling as a fallback), keeps the screen awake, and
 * shows only what a guest status page shows: tickets and privacy-filtered names.
 */
export function Lobby({ token }: { token: string }) {
  const [snap, setSnap] = useState<LobbySnapshot | null>(null);
  const [gone, setGone] = useState(false);
  const [flash, setFlash] = useState(false);
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);
  const lastTicket = useRef<number | null>(null);
  useWakeLock(true);

  const poll = useCallback(async () => {
    try {
      const s = await api<LobbySnapshot>(`/api/lobby/${token}`);
      setSnap(s);
      return s;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setGone(true);
      return null;
    }
  }, [token]);

  useEffect(() => {
    void poll();
  }, [poll]);

  const live = useLive<LobbySnapshot>({
    wsPath: gone ? null : `/ws/lobby/${token}`,
    poll,
    pick: (m) => (m.type === 'lobby' ? m.data : null),
    onData: setSnap,
    onClose: (code) => {
      if (code === 4404) {
        setGone(true);
        return false;
      }
    },
  });

  const ticket = snap?.nowServing?.ticket ?? null;
  useEffect(() => {
    const prev = lastTicket.current;
    lastTicket.current = ticket;
    if (ticket !== null && prev !== null && ticket !== prev) {
      setFlash(true);
      const t = window.setTimeout(() => setFlash(false), 1000);
      return () => window.clearTimeout(t);
    }
  }, [ticket]);

  useEffect(() => {
    document.title = snap ? `${snap.eventName} · Now serving` : 'PBY Queue';
  }, [snap]);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  if (gone) {
    return (
      <main className="lobby lobby-msg" data-testid="lobby-gone">
        <h1 className="display">This display link was turned off.</h1>
        <p>Open the new link from the photographer's Share screen.</p>
      </main>
    );
  }
  if (!snap) {
    return <main className="lobby lobby-msg" aria-busy="true" />;
  }
  if (snap.eventEnded) {
    return (
      <main className="lobby lobby-msg" data-testid="lobby-ended">
        <h1 className="display">{snap.eventName}</h1>
        <p>This photo line has ended. Thanks for coming!</p>
      </main>
    );
  }

  const now = snap.nowServing;
  const shortJoin = snap.joinUrl?.replace(/^https?:\/\//, '') ?? null;
  const canFullscreen = document.fullscreenEnabled && !fullscreen;
  return (
    <main className={`lobby${snap.paused ? ' is-paused' : ''}`} data-testid="lobby">
      <header className="lb-head">
        <h1 className="display">{snap.eventName}</h1>
        <LivePill state={live.state} lastUpdate={live.lastUpdate} />
      </header>
      {snap.paused && (
        <div className="lb-paused" role="status" data-testid="lobby-paused">
          <Icon name="pause" />
          <span>
            <b>Paused for a short break.</b> Everyone keeps their place.
            {snap.pauseMessage && <span className="msg">{snap.pauseMessage}</span>}
          </span>
        </div>
      )}
      <section
        className={`lb-now${flash ? ' flash' : ''}`}
        aria-live="polite"
        data-testid="lobby-now"
      >
        <div className="lbl eyebrow">● Now serving</div>
        {now ? (
          <>
            <div className="n">#{now.ticket}</div>
            {now.name && <div className="nm">{now.name}</div>}
          </>
        ) : (
          <div className="nm idle">Starting soon</div>
        )}
      </section>
      <section className="lb-next" aria-label="Up next" data-testid="lobby-next">
        <div className="lbl eyebrow">Up next</div>
        {snap.comingUp.length ? (
          snap.comingUp.map((c, i) => (
            <div key={c.ticket} className={`it${i === 0 ? ' first' : ''}`}>
              <span className="tk">#{c.ticket}</span>
              <span className="nm">{c.name ?? ''}</span>
            </div>
          ))
        ) : (
          <p className="empty">Nobody waiting</p>
        )}
      </section>
      <footer className="lb-foot">
        {snap.joinQrUrl && shortJoin ? (
          <>
            <img className="q" src={snap.joinQrUrl} alt="" />
            <div>
              <b>Scan to join the photo line</b>
              <small>{shortJoin}</small>
            </div>
          </>
        ) : (
          <div>
            <b>Watch for your ticket number</b>
          </div>
        )}
        {canFullscreen && (
          <button
            type="button"
            className="lb-full"
            onClick={() => void document.documentElement.requestFullscreen?.().catch(() => {})}
          >
            Full screen
          </button>
        )}
      </footer>
    </main>
  );
}
