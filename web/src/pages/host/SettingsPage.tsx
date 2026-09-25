import { LIMITS, type EventSettings } from '@pby/shared';
import { useState } from 'react';
import { api, errorMessage } from '../../api';
import { Sheet, Stepper, Toggle, TopBar } from '../../components/ui';
import { applyTheme, savePrefs, type Prefs, type TextSize, type Theme } from '../../prefs';
import { navigate } from '../../router';
import type { HostContext } from './HostEvent';

/** H9 / E4: event settings plus per-device display preferences. */
export function SettingsPage({ ctx }: { ctx: HostContext }) {
  const { snap, act, toast, prefs, setPrefs, id } = ctx;
  const e = snap.event;
  const closed = e.status === 'closed';
  const [confirm, setConfirm] = useState<'end' | 'delete' | null>(null);
  const [smsName, setSmsName] = useState(e.smsName ?? '');

  const save = async (patch: Partial<EventSettings>) => {
    try {
      await act('/settings', patch, 'PATCH');
    } catch (err) {
      toast({ text: errorMessage(err), danger: true });
    }
  };
  const setPref = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
    applyTheme(next);
  };
  const post = async (path: string, done: string) => {
    try {
      await api(`/api/host/events/${id}${path}`, { body: {} });
      navigate(done, { replace: true });
    } catch (err) {
      toast({ text: errorMessage(err), danger: true });
    }
  };

  return (
    <main className="screen">
      <TopBar title="Settings" onBack={() => navigate(`/host/e/${id}`)} />
      <div className="content">
        {!closed && (
          <>
            <h2 className="group-label eyebrow">Queue</h2>
            <div className="setrow">
              <span>
                Text when this close<span className="sub">"Up next" text; 0 turns it off</span>
              </span>
              <Stepper
                small
                value={e.upNextN}
                min={LIMITS.upNextMin}
                max={LIMITS.upNextMax}
                onChange={(v) => void save({ upNextN: v })}
                label="Up next spots"
              />
            </div>
            <div className="setrow">
              <span>
                Minutes per party<span className="sub">Until we learn your pace</span>
              </span>
              <Stepper
                small
                value={e.minutesPerParty}
                min={LIMITS.minutesPerPartyMin}
                max={LIMITS.minutesPerPartyMax}
                onChange={(v) => void save({ minutesPerParty: v })}
                label="Minutes per party"
              />
            </div>
            <Toggle
              label="Guests can join by QR code"
              checked={e.selfJoin}
              onChange={(v) => void save({ selfJoin: v })}
            />
            <Toggle
              label="Show names to guests"
              sub={'"Emma R." on public screens; off shows ticket numbers only'}
              checked={e.showNames}
              onChange={(v) => void save({ showNames: v })}
            />

            <h2 className="group-label eyebrow">Texting</h2>
            {snap.twilioAvailable && (
              <div className="seg" style={{ margin: '8px 0' }}>
                <button
                  type="button"
                  aria-pressed={e.smsMode === 'tap'}
                  onClick={() => void save({ smsMode: 'tap' })}
                >
                  <b>Tap to send</b>Messages opens with the text ready
                </button>
                <button
                  type="button"
                  aria-pressed={e.smsMode === 'twilio'}
                  onClick={() => void save({ smsMode: 'twilio' })}
                >
                  <b>Automatic</b>Twilio sends by itself
                </button>
              </div>
            )}
            {!snap.twilioAvailable && (
              <div className="setrow">
                Mode<span style={{ color: 'var(--text-muted)' }}>Tap to send</span>
              </div>
            )}
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="sms-name">Event name in texts</label>
              <input
                id="sms-name"
                className="input"
                maxLength={LIMITS.smsEventNameMax}
                placeholder={e.name.slice(0, LIMITS.smsEventNameMax)}
                value={smsName}
                onChange={(ev) => setSmsName(ev.target.value)}
                onBlur={() => smsName !== (e.smsName ?? '') && void save({ smsName })}
              />
              <div className="help">Up to {LIMITS.smsEventNameMax} characters.</div>
            </div>
            <Toggle
              label="Ask to text after Call next"
              checked={prefs.askToText}
              onChange={(v) => setPref({ askToText: v })}
            />
          </>
        )}

        <h2 className="group-label eyebrow">Display (this device)</h2>
        <span className="flabel">Theme</span>
        <div className="seg three">
          {(['light', 'dark', 'auto'] as Theme[]).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={prefs.theme === t}
              onClick={() => setPref({ theme: t })}
            >
              <b>{t === 'auto' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}</b>
            </button>
          ))}
        </div>
        <Toggle
          label="Max contrast (bright sun)"
          checked={prefs.maxContrast}
          onChange={(v) => setPref({ maxContrast: v })}
        />
        <span className="flabel" style={{ marginTop: 12 }}>
          Text size
        </span>
        <div className="seg three">
          {([1, 1.15, 1.3] as TextSize[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={prefs.textSize === s}
              onClick={() => setPref({ textSize: s })}
            >
              <b>{s === 1 ? 'Normal' : s === 1.15 ? 'Large' : 'X-Large'}</b>
            </button>
          ))}
        </div>
        <Toggle
          label="Keep screen awake"
          checked={prefs.keepAwake}
          onChange={(v) => setPref({ keepAwake: v })}
        />

        <h2 className="group-label eyebrow">Helpers</h2>
        <div className="stack">
          <p className="help" style={{ margin: 0 }}>
            Helpers open this app, tap "Helping out?", and enter code <b>{e.code}</b> and the PIN.
            Up to {LIMITS.helperSessionsMax} devices.
          </p>
          <button
            type="button"
            className="btn secondary"
            onClick={async () => {
              try {
                const r = await api<{ removed: number }>(`/api/host/events/${id}/signout-others`, {
                  body: {},
                });
                toast({
                  text: `Signed out ${r.removed} other ${r.removed === 1 ? 'device' : 'devices'}`,
                });
              } catch (err) {
                toast({ text: errorMessage(err), danger: true });
              }
            }}
          >
            Sign out other devices
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => void post('/logout', '/host')}
          >
            Sign out this device
          </button>
        </div>

        <h2 className="group-label eyebrow">Event</h2>
        <div className="stack">
          {!closed && (
            <button type="button" className="btn danger-text" onClick={() => setConfirm('end')}>
              End event
            </button>
          )}
          <button type="button" className="btn danger-text" onClick={() => setConfirm('delete')}>
            Delete guest data now
          </button>
          <p className="help" style={{ margin: 0 }}>
            Guest names and numbers are deleted automatically 7 days after the event ends.
          </p>
        </div>
      </div>
      {confirm && (
        <Sheet label="Confirm" onClose={() => setConfirm(null)}>
          <h2>{confirm === 'end' ? 'End this event?' : 'Delete all guest data now?'}</h2>
          <p>
            {confirm === 'end'
              ? 'Guests can no longer join or see updates, and every device is signed out. You can still delete the data later with the PIN.'
              : 'Names, phone numbers and status links are removed for good. Totals are kept.'}
          </p>
          <div className="stack">
            <button
              type="button"
              className="btn danger"
              onClick={() => void post(confirm === 'end' ? '/close' : '/delete', '/host')}
            >
              {confirm === 'end' ? 'End event' : 'Delete now'}
            </button>
            <button type="button" className="btn secondary" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}
    </main>
  );
}
