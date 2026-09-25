import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import { Icon } from '../../icons';
import { linkHandler, navigate } from '../../router';

interface EventSummary {
  id: string;
  name: string;
  date: string;
  status: 'open' | 'closed';
  waiting: number;
  done: number;
}

/** H0: events this device is signed in to, plus "Join as a helper". */
export function EventsList() {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError(null);
    api<{ events: EventSummary[] }>('/api/host/events')
      .then((r) => setEvents(r.events))
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, []);

  const join = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setJoinError(null);
    try {
      const r = await api<{ id: string }>('/api/host/login', { body: { code, pin } });
      navigate(`/host/e/${r.id}`);
    } catch (err) {
      setJoinError(
        err instanceof ApiError && err.code === 'wrong_pin'
          ? 'Wrong event code or PIN.'
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="screen">
      <header className="topbar">
        <h1 className="title display" style={{ margin: 0 }}>
          Your events
        </h1>
      </header>
      <div className="content with-bar">
        {error && (
          <div className="banner danger" role="alert">
            {error}{' '}
            <button type="button" className="linkbtn" onClick={load}>
              Retry
            </button>
          </div>
        )}
        {events === null && !error && (
          <div className="stack" aria-label="Loading">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 72 }} />
            ))}
          </div>
        )}
        {events?.length === 0 && (
          <p style={{ fontWeight: 600 }}>
            No events yet. Create one before the shoot; it takes 30 seconds.
          </p>
        )}
        {events?.map((e) => (
          <a
            key={e.id}
            href={`/host/e/${e.id}`}
            onClick={linkHandler(`/host/e/${e.id}`)}
            className={`event-card${e.status === 'closed' ? ' closed' : ''}`}
            style={{ textDecoration: 'none' }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t">{e.name}</div>
              <div className="help" style={{ marginTop: 0 }}>
                {e.date} ·{' '}
                {e.status === 'closed' ? 'Ended' : `${e.waiting} waiting · ${e.done} done`}
              </div>
            </div>
            <Icon name="next" />
          </a>
        ))}

        <h2 className="group-label eyebrow">Helping out?</h2>
        <form onSubmit={join} className="stack">
          <p className="help" style={{ marginTop: 0 }}>
            Enter the event code (the 6 letters at the end of the join link) and the host PIN.
          </p>
          <div className="btn-pair">
            <label>
              <span className="sr-only">Event code</span>
              <input
                className="input"
                placeholder="Event code"
                autoCapitalize="characters"
                autoComplete="off"
                value={code}
                maxLength={6}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </label>
            <label>
              <span className="sr-only">PIN</span>
              <input
                className="input"
                placeholder="PIN"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                maxLength={12}
                onChange={(e) => setPin(e.target.value)}
              />
            </label>
          </div>
          {joinError && <div className="field-error">{joinError}</div>}
          <button className="btn secondary" disabled={busy || code.length < 6 || pin.length < 6}>
            Open event
          </button>
        </form>
      </div>
      <div className="bottombar">
        <div className="inner">
          <a href="/host/new" onClick={linkHandler('/host/new')} className="btn primary xl">
            <Icon name="plus" /> New event
          </a>
        </div>
      </div>
    </main>
  );
}
