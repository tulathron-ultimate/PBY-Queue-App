import { LIMITS, normalizePhone, type JoinInfo } from '@pby/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import { Stepper } from '../../components/ui';
import { storageGet, storageSet } from '../../prefs';
import { linkHandler, navigate } from '../../router';

/** G1: join the line from the QR code or link (A5). */
export function Join({ code }: { code: string }) {
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState('');
  const [size, setSize] = useState(1);
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const saved = storageGet(`pby.join.${code}`);
  const [existing, setExisting] = useState<{ token: string; name: string } | null>(() => {
    try {
      return saved ? (JSON.parse(saved) as { token: string; name: string }) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    api<JoinInfo>(`/api/join/${code}`)
      .then((i) => {
        setInfo(i);
        document.title = `Join · ${i.eventName}`;
      })
      .catch(() => setNotFound(true));
  }, [code]);

  const phoneResult = normalizePhone(phone);
  const phoneBad = phone.trim() !== '' && !phoneResult.ok;
  const needsConsent = phone.trim() !== '' && !consent;
  const valid = name.trim().length > 0 && !phoneBad && !needsConsent;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; existing: boolean }>(`/api/join/${code}`, {
        body: { name, size, phone, consent, website },
      });
      storageSet(`pby.join.${code}`, JSON.stringify({ token: r.token, name: name.trim() }));
      navigate(`/s/${r.token}?joined=${r.existing ? 'again' : '1'}`, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'closed'
          ? "The line isn't taking new people right now. Please talk to the photographer."
          : errorMessage(err),
      );
      setBusy(false);
    }
  };

  if (notFound) {
    return (
      <main className="screen guest">
        <div className="content" style={{ paddingTop: 48 }}>
          <h1 className="display">We can't find this line</h1>
          <p>Check the link or QR code, or ask the photographer.</p>
        </div>
      </main>
    );
  }
  if (!info) {
    return (
      <main className="screen guest" aria-busy="true">
        <div className="content" style={{ paddingTop: 32 }}>
          <div className="skeleton" style={{ height: 36, width: '60%', marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 56, marginBottom: 16 }} />
          <div className="skeleton" style={{ height: 56 }} />
        </div>
      </main>
    );
  }
  const closed = !info.open || !info.selfJoin;

  return (
    <form className="screen guest" onSubmit={submit} noValidate>
      <div className="content with-bar" style={{ paddingTop: 16 }}>
        <div className="display" style={{ fontSize: 'var(--fs-lg)', color: 'var(--text-muted)' }}>
          {info.eventName}
        </div>
        <h1
          className="display"
          style={{ fontSize: '2.3rem', lineHeight: 1.1, margin: '2px 0 10px' }}
        >
          Join the photo line
        </h1>
        {!closed && (
          <div
            className="badge b-waiting b-big"
            style={{ marginBottom: 16, textTransform: 'none', letterSpacing: 0 }}
          >
            {info.lineLength
              ? `${info.lineLength} ${info.lineLength === 1 ? 'group' : 'groups'} ahead of you`
              : 'Nobody waiting right now'}
          </div>
        )}
        {closed ? (
          <div className="banner" role="status">
            {info.open
              ? "The line isn't taking new people right now. Please talk to the photographer."
              : 'This photo line has ended. Thanks for coming!'}
          </div>
        ) : existing ? (
          <div className="banner ok" role="status">
            You're already in line as {existing.name}.{' '}
            <a href={`/s/${existing.token}`} onClick={linkHandler(`/s/${existing.token}`)}>
              See my place
            </a>
            <div>
              <button type="button" className="linkbtn" onClick={() => setExisting(null)}>
                Add someone else
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="j-name">Your name or family name</label>
              <input
                id="j-name"
                className="input"
                autoComplete="name"
                placeholder="e.g., Smith Family"
                maxLength={LIMITS.partyNameMax}
                value={name}
                aria-invalid={touched && !name.trim()}
                onChange={(e) => setName(e.target.value)}
              />
              {touched && !name.trim() && <div className="field-error">Please enter a name.</div>}
            </div>
            <div className="field">
              <span className="flabel">How many people in the photo?</span>
              <Stepper
                value={size}
                min={1}
                max={LIMITS.partySizeMax}
                onChange={setSize}
                label="People in the photo"
              />
            </div>
            <div className="field">
              <label htmlFor="j-phone">Mobile number</label>
              <input
                id="j-phone"
                className="input"
                type="tel"
                autoComplete="tel"
                inputMode="tel"
                placeholder="(555) 555-5555"
                value={phone}
                aria-invalid={phoneBad}
                onChange={(e) => setPhone(e.target.value)}
              />
              {phoneBad ? (
                <div className="field-error">Please check this number.</div>
              ) : (
                <div className="help">We'll text you when you're almost up. Optional.</div>
              )}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                Text me updates about my place in line. Msg &amp; data rates may apply. Reply STOP
                to opt out.
              </span>
            </label>
            {touched && needsConsent && (
              <div className="field-error">
                Tick the box so we can text you, or leave the number blank.
              </div>
            )}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-5000px' }}>
              <label>
                Website
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </label>
            </div>
            {error && (
              <div className="field-error" role="alert">
                {error}
              </div>
            )}
          </>
        )}
      </div>
      {!closed && !existing && (
        <div className="bottombar guest">
          <div className="inner">
            <button className="btn primary xl" disabled={busy}>
              {busy ? 'Joining…' : 'Join the line'}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
