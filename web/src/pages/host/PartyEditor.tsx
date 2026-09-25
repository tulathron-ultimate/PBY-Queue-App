import {
  formatPhone,
  hasErrors,
  isActive,
  LIMITS,
  normalizePhone,
  validateDraft,
  type HostParty,
} from '@pby/shared';
import { useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../../api';
import { Sheet, Stepper } from '../../components/ui';
import { copyText } from '../../platform/share';
import type { HostContext } from './HostEvent';

/** H7: add or edit one party. */
export function PartyEditor({
  ctx,
  party,
  onClose,
}: {
  ctx: HostContext;
  party?: HostParty;
  onClose: () => void;
}) {
  const { snap, act, toast } = ctx;
  const editing = !!party;
  const [name, setName] = useState(party?.name ?? '');
  const [size, setSize] = useState(party?.size ?? 1);
  const [withNames, setWithNames] = useState((party?.members.length ?? 0) > 0);
  const [members, setMembers] = useState<string[]>(party?.members ?? []);
  const [phone, setPhone] = useState(
    party?.phone ? formatPhone(party.phone) : (party?.phoneInvalidInput ?? ''),
  );
  const [notes, setNotes] = useState(party?.notes ?? '');
  const [noTexts, setNoTexts] = useState(party?.noTexts ?? false);
  const [consent, setConsent] = useState(snap.event.hostConsent);
  const [arrived, setArrived] = useState(true);
  const [position, setPosition] = useState<'end' | 'next'>('end');
  const [sendJoin, setSendJoin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const memberList = withNames
    ? members
        .slice(0, size)
        .map((m) => m.trim())
        .filter(Boolean)
    : [];
  const draft = validateDraft(
    {
      name,
      phone,
      size: String(size),
      members: memberList.join('; '),
      group: party?.group ?? '',
      notes,
    },
    1,
  );
  const phoneResult = normalizePhone(phone);
  const phoneBad = phone.trim() !== '' && !phoneResult.ok;
  const duplicate =
    phoneResult.ok &&
    snap.parties.find(
      (p) =>
        p.id !== party?.id &&
        p.phone === phoneResult.e164 &&
        (isActive(p) || p.state === 'now_serving'),
    );
  const valid = !hasErrors(draft) && name.trim().length > 0;

  const reset = () => {
    setName('');
    setSize(1);
    setMembers([]);
    setWithNames(false);
    setPhone('');
    setNotes('');
    setError(null);
    nameRef.current?.focus();
  };

  const save = async (again: boolean) => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const body = {
      name: draft.name,
      phone: draft.phone ?? draft.phoneInvalidInput ?? '',
      size,
      members: memberList,
      notes: draft.notes ?? '',
    };
    try {
      if (editing) {
        await act(`/parties/${party.id}`, { ...body, noTexts }, 'PATCH');
        toast({ text: `Saved ${draft.name}` });
        onClose();
      } else {
        await act('/parties', {
          ...body,
          arrived,
          position,
          sendJoinText: sendJoin,
          consentConfirmed: consent,
        });
        toast({ text: `Added ${draft.name}` });
        if (again) reset();
        else onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(false);
  };

  const link = party ? `${location.origin}/s/${party.token}` : '';

  return (
    <Sheet label={editing ? `Edit #${party.ticket}` : 'Add a party'} onClose={onClose} full>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <header className="topbar">
          <button type="button" className="textbtn" onClick={onClose}>
            Cancel
          </button>
          <h2 className="title" style={{ textAlign: 'center', margin: 0 }}>
            {editing ? `Edit #${party.ticket}` : 'Add a party'}
          </h2>
          <button className="textbtn" disabled={!valid || busy} style={{ fontWeight: 900 }}>
            Save
          </button>
        </header>
        <div className="sheet-body">
          <div className="field">
            <label htmlFor="pe-name">Party name</label>
            <input
              id="pe-name"
              ref={nameRef}
              className="input"
              placeholder="e.g., Smith Family"
              autoFocus={!editing}
              maxLength={LIMITS.partyNameMax}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <span className="flabel">How many people?</span>
            <Stepper
              value={size}
              min={LIMITS.partySizeMin}
              max={LIMITS.partySizeMax}
              onChange={setSize}
              label="Party size"
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={withNames}
              onChange={(e) => setWithNames(e.target.checked)}
            />
            <span>Add names (optional)</span>
          </label>
          {withNames && (
            <div className="stack field">
              {Array.from({ length: size }, (_, i) => (
                <input
                  key={i}
                  className="input"
                  aria-label={`Person ${i + 1}`}
                  placeholder={`Person ${i + 1}`}
                  maxLength={LIMITS.memberNameMax}
                  value={members[i] ?? ''}
                  onChange={(e) =>
                    setMembers((m) => {
                      const next = [...m];
                      next[i] = e.target.value;
                      return next;
                    })
                  }
                />
              ))}
            </div>
          )}
          <div className="field">
            <label htmlFor="pe-phone">Mobile number</label>
            <input
              id="pe-phone"
              className="input"
              type="tel"
              autoComplete="off"
              placeholder="(555) 555-5555"
              value={phone}
              aria-invalid={phoneBad}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => phoneResult.ok && setPhone(formatPhone(phoneResult.e164))}
            />
            {phoneBad ? (
              <div className="field-error">
                ⚠ Not a valid number. They can still be added, but won't get texts.
              </div>
            ) : (
              <div className="help">Gets the "Up next" and "Your turn" texts.</div>
            )}
            {duplicate && (
              <div className="banner" style={{ marginTop: 8 }} role="status">
                ◆ Same phone as #{duplicate.ticket} {duplicate.name}. You can still add them
                (siblings often share a parent's phone).
              </div>
            )}
          </div>
          {!snap.event.hostConsent && (
            <label className="check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>They agreed to get texts about this photo session.</span>
            </label>
          )}
          {editing && (
            <label className="check">
              <input
                type="checkbox"
                checked={noTexts}
                onChange={(e) => setNoTexts(e.target.checked)}
              />
              <span>No texts for this party</span>
            </label>
          )}
          <div className="field">
            <label htmlFor="pe-notes">Notes (only you see these)</label>
            <textarea
              id="pe-notes"
              className="input"
              maxLength={LIMITS.notesMax}
              placeholder="e.g., needs wheelchair spot"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {!editing && (
            <>
              <div className="field">
                <span className="flabel">Put them</span>
                <div className="seg">
                  <button
                    type="button"
                    aria-pressed={position === 'end'}
                    onClick={() => setPosition('end')}
                  >
                    <b>End of line</b>
                  </button>
                  <button
                    type="button"
                    aria-pressed={position === 'next'}
                    onClick={() => setPosition('next')}
                  >
                    <b>Next</b>
                  </button>
                </div>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={arrived}
                  onChange={(e) => setArrived(e.target.checked)}
                  data-testid="arrived"
                />
                <span>They're here now (checked in)</span>
              </label>
              {phoneResult.ok && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={sendJoin}
                    onChange={(e) => setSendJoin(e.target.checked)}
                  />
                  <span>Text them their status link</span>
                </label>
              )}
            </>
          )}
          {editing && (
            <div className="field">
              <span className="flabel">Status link</span>
              <div
                className="mono"
                style={{ textAlign: 'left', fontSize: 'var(--fs-sm)', margin: '0 0 8px' }}
              >
                {link}
              </div>
              <button
                type="button"
                className="btn secondary"
                onClick={async () => setCopied(await copyText(link))}
              >
                {copied ? 'Copied ✓' : 'Copy link'}
              </button>
            </div>
          )}
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="sheet-foot">
          {editing ? (
            <button className="btn primary" disabled={!valid || busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          ) : (
            <div className="btn-pair">
              <button
                type="button"
                className="btn secondary"
                disabled={!valid || busy}
                onClick={() => void save(true)}
              >
                Save &amp; add another
              </button>
              <button className="btn primary" disabled={!valid || busy} data-testid="party-save">
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>
      </form>
    </Sheet>
  );
}
