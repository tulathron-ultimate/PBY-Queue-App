import type { GuestSnapshot } from '@pby/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import { LivePill, StatusBadge } from '../../components/ui';
import { Icon } from '../../icons';
import { useLive } from '../../live';
import { haptics } from '../../platform/haptics';
import { linkHandler } from '../../router';

/** G2 My status, G3 It's your turn, G4 terminal states. Live over WebSocket, 15 s polling fallback. */
export function Status({ token }: { token: string }) {
  const [snap, setSnap] = useState<GuestSnapshot | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joined = new URLSearchParams(location.search).get('joined');
  const lastState = useRef<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const s = await api<GuestSnapshot>(`/api/status/${token}`);
      setSnap(s);
      return s;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setInvalid(true);
      return null;
    }
  }, [token]);

  useEffect(() => {
    void poll();
  }, [poll]);

  const live = useLive<GuestSnapshot>({
    wsPath: invalid ? null : `/ws/status/${token}`,
    poll,
    pick: (m) => (m.type === 'guest' ? m.data : null),
    onData: setSnap,
    onClose: (code) => {
      if (code === 4404) {
        setInvalid(true);
        return false;
      }
    },
  });

  const state = snap?.eventEnded ? 'ended' : (snap?.me?.state ?? null);
  useEffect(() => {
    if (!state) return;
    const prev = lastState.current;
    lastState.current = state;
    const name = snap?.eventName ?? 'PBY';
    if (state === 'now_serving') {
      document.title = '📸 Your turn!';
      if (prev && prev !== 'now_serving') haptics.doublePulse();
    } else if (state === 'up_next') {
      document.title = `⚡ You're up next — ${name}`;
      if (prev && prev !== 'up_next' && document.visibilityState === 'visible') haptics.pulse();
    } else {
      document.title = name;
    }
  }, [state, snap?.eventName]);

  const arrive = async () => {
    setBusy(true);
    setError(null);
    try {
      setSnap(await api<GuestSnapshot>(`/api/status/${token}/arrive`, { body: {} }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (invalid) {
    return (
      <main className="screen guest">
        <div className="content" style={{ paddingTop: 48 }}>
          <div className="hero ended">
            <p className="headline">We can't find this spot in line.</p>
            <p className="who">Check the link in your text, or ask the photographer.</p>
          </div>
        </div>
      </main>
    );
  }
  if (!snap) {
    return (
      <main className="screen guest" aria-busy="true">
        <div className="content" style={{ paddingTop: 48 }}>
          <div className="skeleton" style={{ height: 240 }} />
        </div>
      </main>
    );
  }

  const me = snap.me;
  if (me?.state === 'now_serving' && !snap.eventEnded) {
    return (
      <main className="turn" role="alert" data-testid="your-turn">
        <Icon name="camera" />
        <h1>It's your turn!</h1>
        <p>Come to the photographer now</p>
        <p style={{ fontSize: 'var(--fs-base)', opacity: 0.95 }}>
          Ticket #{me.ticket} · {me.name}
        </p>
      </main>
    );
  }

  const header = (
    <div className="g-head">
      <span className="ev">{snap.eventName}</span>
      {!snap.eventEnded && <LivePill state={live.state} lastUpdate={live.lastUpdate} />}
    </div>
  );
  const rejoin = snap.selfJoin ? (
    <a
      className="btn secondary"
      href={`/j/${snap.joinCode}`}
      onClick={linkHandler(`/j/${snap.joinCode}`)}
    >
      Rejoin the line
    </a>
  ) : null;

  let hero: React.ReactNode;
  if (snap.eventEnded || !me) {
    hero = (
      <div className="hero ended">
        <p className="headline">This photo line has ended.</p>
        <p className="who">Thanks for coming!</p>
      </div>
    );
  } else if (me.state === 'done') {
    hero = (
      <div className="hero done">
        <StatusBadge state="done" big />
        <p className="headline">Thanks, {me.name.split(' ')[0]}! Your photos are done.</p>
      </div>
    );
  } else if (me.state === 'skipped' || me.state === 'no_show') {
    hero = (
      <div className={`hero ${me.state}`}>
        <StatusBadge state={me.state} big />
        <div className="pos word" style={{ fontSize: '3rem' }}>
          On hold
        </div>
        <p className="headline" style={{ fontSize: 'var(--fs-lg)' }}>
          {me.state === 'no_show' ? 'You were marked as not here.' : 'We missed you!'}
        </p>
        <p className="who">Find the photographer and they'll fit you back in.</p>
      </div>
    );
  } else if (me.state === 'removed') {
    hero = (
      <div className="hero removed">
        <p className="headline">You're no longer in line.</p>
        {rejoin}
      </div>
    );
  } else {
    const upNext = me.state === 'up_next';
    const showNext = upNext && me.position === 1;
    hero = (
      <div className={`hero ${me.state}`} data-testid="my-card" aria-live="polite">
        {upNext && <p className="headline">◆ You're up next!</p>}
        <div className="lbl">{upNext ? 'Head to the photo area now' : 'Your place in line'}</div>
        <div className={`pos${showNext ? ' word' : ''}`} data-testid="position">
          {showNext ? 'Next' : me.position}
        </div>
        {!showNext && <div className="lbl">in line</div>}
        <div className="who">
          Ticket #{me.ticket} · {me.name} · {me.size} {me.size === 1 ? 'person' : 'people'}
        </div>
        {me.arrived && me.waitText && (
          <div className="eta">
            {me.waitMinutes === 0 ? (
              me.waitText
            ) : (
              <>
                Estimated wait <b>{me.waitText}</b>
              </>
            )}
          </div>
        )}
        <StatusBadge state={me.state} />
        {!me.arrived && (
          <div style={{ marginTop: 14 }}>
            <p className="who" style={{ marginBottom: 8 }}>
              You're not checked in yet. We'll call the next person who is here.
            </p>
            <button
              type="button"
              className="btn primary xl"
              disabled={busy}
              onClick={() => void arrive()}
              data-testid="im-here"
            >
              <Icon name="pin" /> I'm here
            </button>
            {error && <div className="field-error">{error}</div>}
          </div>
        )}
      </div>
    );
  }

  const n = snap.nowServing;
  return (
    <main className="screen guest">
      {header}
      <div className="content">
        {joined === '1' && me && (
          <div className="banner ok" role="status">
            You're in! Bookmark this page{me.hasPhone ? ' or watch for our text' : ''}.
          </div>
        )}
        {joined === 'again' && me && (
          <div className="banner" role="status">
            You were already in line with this number, so here is your spot.
          </div>
        )}
        {live.state !== 'live' && live.state !== 'connecting' && !snap.eventEnded && (
          <div className="banner" role="status">
            ⟳ Reconnecting…
            {live.lastUpdate
              ? ` last updated ${Math.max(1, Math.round((Date.now() - live.lastUpdate) / 60_000))} min ago`
              : ''}
          </div>
        )}
        {hero}
        {!snap.eventEnded && (
          <div className="nowcard" aria-live="polite" data-testid="now-serving">
            <span className="n">{n ? `#${n.ticket}` : '—'}</span>
            <div>
              <div className="lbl eyebrow">Now taking photos</div>
              <div className="nm">{n ? (n.name ?? `Ticket #${n.ticket}`) : 'Starting soon'}</div>
            </div>
          </div>
        )}
        {!snap.eventEnded && snap.comingUp.length > 0 && (
          <div className="mini" aria-label="Coming up">
            {snap.comingUp.map((c) => (
              <div key={c.ticket} className={`it${c.isMe ? ' me' : ''}`}>
                <span className="tk">#{c.ticket}</span>
                {c.name ?? ''}
                {c.isMe && <span className="you">YOU</span>}
              </div>
            ))}
          </div>
        )}
        {me && (me.state === 'waiting' || me.state === 'up_next') && (
          <p className="note">
            {me.hasPhone
              ? `Stay nearby. We'll text you when you're ${snap.upNextN > 0 ? `${snap.upNextN} away` : 'almost up'} and again when it's your turn.`
              : 'Keep this page open. It updates by itself.'}
          </p>
        )}
      </div>
    </main>
  );
}
