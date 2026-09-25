import { DEFAULTS, isValidPin, LIMITS } from '@pby/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import { Stepper, Toggle, TopBar } from '../../components/ui';
import { back, navigate } from '../../router';

/** H1: create event (E1). Requires the server's ADMIN_PASSWORD. */
export function CreateEvent() {
  const [cfg, setCfg] = useState<{ twilioAvailable: boolean; adminConfigured: boolean } | null>(
    null,
  );
  const [adminPassword, setAdminPassword] = useState('');
  const [name, setName] = useState('');
  const [smsName, setSmsName] = useState('');
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [smsMode, setSmsMode] = useState<'tap' | 'twilio'>('tap');
  const [upNextN, setUpNextN] = useState<number>(DEFAULTS.upNextN);
  const [minutes, setMinutes] = useState<number>(DEFAULTS.minutesPerParty);
  const [selfJoin, setSelfJoin] = useState(true);
  const [showNames, setShowNames] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ twilioAvailable: boolean; adminConfigured: boolean }>('/api/config')
      .then(setCfg)
      .catch(() => setCfg({ twilioAvailable: false, adminConfigured: true }));
  }, []);

  const nameOk = name.trim().length >= 1 && name.trim().length <= LIMITS.eventNameMax;
  const pinOk = isValidPin(pin);
  const valid = nameOk && pinOk && adminPassword.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string }>('/api/events', {
        body: {
          adminPassword,
          name,
          smsName,
          date,
          pin,
          smsMode,
          upNextN,
          minutesPerParty: minutes,
          selfJoin,
          showNames,
        },
      });
      navigate(`/host/e/${r.id}`, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'wrong_admin_password'
          ? 'Wrong admin password.'
          : errorMessage(err),
      );
      setBusy(false);
    }
  };

  return (
    <form className="screen" onSubmit={submit}>
      <TopBar title="New event" onBack={() => back('/host')} />
      <div className="content with-bar">
        {cfg && !cfg.adminConfigured && (
          <div className="banner danger" role="alert">
            Creating events is turned off. Set ADMIN_PASSWORD on the server.
          </div>
        )}
        <div className="field">
          <label htmlFor="ev-name">Event name</label>
          <input
            id="ev-name"
            className="input"
            placeholder="e.g., Santa Photos – Oak Park"
            value={name}
            maxLength={LIMITS.eventNameMax}
            onChange={(e) => setName(e.target.value)}
            required
          />
          {name.trim().length > LIMITS.smsEventNameMax && (
            <div className="help">
              Texts use the first {LIMITS.smsEventNameMax} characters, or a short name below.
            </div>
          )}
        </div>
        {name.trim().length > LIMITS.smsEventNameMax && (
          <div className="field">
            <label htmlFor="ev-sms">Short name for texts (optional)</label>
            <input
              id="ev-sms"
              className="input"
              value={smsName}
              maxLength={LIMITS.smsEventNameMax}
              placeholder={name.trim().slice(0, LIMITS.smsEventNameMax)}
              onChange={(e) => setSmsName(e.target.value)}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="ev-date">Date</label>
          <input
            id="ev-date"
            className="input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ev-pin">Host PIN</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="ev-pin"
              className="input pin"
              type={showPin ? 'text' : 'password'}
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              maxLength={LIMITS.pinMaxLength}
              aria-invalid={pin.length > 0 && !pinOk}
              onChange={(e) => setPin(e.target.value.replace(/[^A-Za-z0-9]/g, ''))}
            />
            <button
              type="button"
              className="btn secondary"
              style={{ width: 96 }}
              onClick={() => setShowPin((s) => !s)}
            >
              {showPin ? 'Hide' : 'Show'}
            </button>
          </div>
          <div className="help">
            At least 6 digits. Helpers enter this to run the line from another phone.
          </div>
        </div>
        {cfg?.twilioAvailable && (
          <div className="field">
            <span className="flabel">Texting</span>
            <div className="seg">
              <button
                type="button"
                aria-pressed={smsMode === 'tap'}
                onClick={() => setSmsMode('tap')}
              >
                <b>Tap to send{smsMode === 'tap' ? ' ✓' : ''}</b>Your phone opens Messages with the
                text ready. No setup.
              </button>
              <button
                type="button"
                aria-pressed={smsMode === 'twilio'}
                onClick={() => setSmsMode('twilio')}
              >
                <b>Automatic{smsMode === 'twilio' ? ' ✓' : ''}</b>Texts send by themselves.
                Configured on server ✓
              </button>
            </div>
          </div>
        )}
        <div className="field">
          <span className="flabel">Text people when they're this close</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Stepper
              value={upNextN}
              min={LIMITS.upNextMin}
              max={LIMITS.upNextMax}
              onChange={setUpNextN}
              label="Up next spots"
            />
            <span style={{ fontWeight: 600 }}>spots away</span>
          </div>
          <div className="help">They get an "Up next" text at this point. 0 turns it off.</div>
        </div>
        <div className="field">
          <span className="flabel">Minutes per party (estimate)</span>
          <Stepper
            value={minutes}
            min={LIMITS.minutesPerPartyMin}
            max={LIMITS.minutesPerPartyMax}
            onChange={setMinutes}
            label="Minutes per party"
          />
          <div className="help">Used until we learn your real pace.</div>
        </div>
        <Toggle label="Guests can join by QR code" checked={selfJoin} onChange={setSelfJoin} />
        <Toggle
          label="Show names to guests"
          sub="Otherwise guests see ticket numbers only"
          checked={showNames}
          onChange={setShowNames}
        />
        <div className="field" style={{ marginTop: 20 }}>
          <label htmlFor="ev-admin">Admin password</label>
          <input
            id="ev-admin"
            className="input"
            type="password"
            autoComplete="current-password"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
          />
          <div className="help">
            The ADMIN_PASSWORD set on the server. Only needed to create events.
          </div>
        </div>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="bottombar">
        <div className="inner">
          <button className="btn primary xl" disabled={!valid || busy}>
            {busy ? 'Creating…' : 'Create event'}
          </button>
        </div>
      </div>
    </form>
  );
}
