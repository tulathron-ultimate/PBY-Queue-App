import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import { TopBar } from '../../components/ui';
import { navigate } from '../../router';

/** H2: unlock an event with its PIN (helper devices and re-login). */
export function PinUnlock({ id, onUnlocked }: { id: string; onUnlocked: () => void }) {
  const [name, setName] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ name: string }>(`/api/events/${id}/public`)
      .then((r) => setName(r.name))
      .catch(() => setName(''));
  }, [id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/host/login`, { body: { eventId: id, pin } });
      onUnlocked();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'wrong_pin') {
        const left = Number(err.data.triesLeft ?? 0);
        setError(
          left > 0
            ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`
            : 'Wrong PIN. Try again in 1 minute.',
        );
      } else {
        setError(errorMessage(err));
      }
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="screen" onSubmit={submit}>
      <TopBar title="Unlock event" onBack={() => navigate('/host')} />
      <div className="content" style={{ paddingTop: 16 }}>
        <p
          className="display"
          style={{ fontSize: 'var(--fs-xl)', margin: '0 0 16px', lineHeight: 1.15 }}
        >
          {name ?? '…'}
        </p>
        <div className="field">
          <label htmlFor="pin">Host PIN</label>
          <input
            id="pin"
            className="input pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={pin}
            maxLength={12}
            aria-invalid={!!error}
            onChange={(e) => setPin(e.target.value.replace(/[^A-Za-z0-9]/g, ''))}
          />
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <button className="btn primary xl" disabled={busy || pin.length < 6}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </div>
    </form>
  );
}
