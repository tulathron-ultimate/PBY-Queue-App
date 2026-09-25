import {
  annotateDuplicates,
  formatPhone,
  hasErrors,
  isActive,
  LIMITS,
  toPartyInput,
  validateDraft,
  type ImportRow,
} from '@pby/shared';
import { useMemo, useState } from 'react';
import { errorMessage } from '../../api';
import { Sheet } from '../../components/ui';
import { Icon } from '../../icons';
import { downloadTemplate } from '../../import/spreadsheet';
import type { HostContext } from './HostEvent';

/**
 * H6a: preview before anything is added. Problems are listed first; missing phones are
 * allowed; invalid rows can be fixed inline or excluded. Row order becomes queue order.
 */
export function ImportReview({
  ctx,
  initialRows,
  source,
  fileName,
  missingName,
  truncated,
  onClose,
}: {
  ctx: HostContext;
  initialRows: ImportRow[];
  source: 'import' | 'vcard' | 'contacts';
  fileName: string;
  missingName?: boolean;
  truncated?: boolean;
  onClose: () => void;
}) {
  const { snap, act, toast } = ctx;
  const [rows, setRows] = useState(initialRows);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [consent, setConsent] = useState(snap.event.hostConsent);
  const [sendJoin, setSendJoin] = useState(false);
  const [allHere, setAllHere] = useState(false);
  const [busy, setBusy] = useState(false);

  const existing = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of snap.parties) {
      if (p.phone && (isActive(p) || p.state === 'now_serving')) m.set(p.phone, p.ticket);
    }
    return m;
  }, [snap.parties]);
  const annotated = useMemo(() => annotateDuplicates(rows, existing), [rows, existing]);
  const included = annotated.filter((r) => !excluded.has(r.rowNumber));
  const blocked = included.filter(hasErrors);
  const needLook = annotated.filter(
    (r) => r.issues.length > 0 && !excluded.has(r.rowNumber),
  ).length;
  const ready = included.length - needLook;
  const withPhone = included.filter((r) => r.phone).length;
  const display = [...annotated].sort(
    (a, b) =>
      Number(b.issues.length > 0) - Number(a.issues.length > 0) || a.rowNumber - b.rowNumber,
  );
  const activeCount = snap.parties.filter(isActive).length;
  const overCap = activeCount + included.length > LIMITS.activePartiesMax;

  const update = (rowNumber: number, patch: Partial<ImportRow['draft']>) =>
    setRows((rs) =>
      rs.map((r) =>
        r.rowNumber === rowNumber ? validateDraft({ ...r.draft, ...patch }, rowNumber) : r,
      ),
    );

  const submit = async () => {
    setBusy(true);
    try {
      await act('/import', {
        rows: included.map(toPartyInput),
        source,
        sendJoinTexts: sendJoin,
        consentConfirmed: consent,
        arrived: allHere,
      });
      toast({ text: `Added ${included.length} to the line` });
      onClose();
    } catch (err) {
      toast({ text: errorMessage(err), danger: true });
      setBusy(false);
    }
  };

  return (
    <Sheet label="Review import" onClose={onClose} full>
      <header className="topbar">
        <button type="button" className="textbtn" onClick={onClose}>
          Cancel
        </button>
        <h2 className="title" style={{ textAlign: 'center', margin: 0 }}>
          Review {annotated.length} {annotated.length === 1 ? 'person' : 'people'}
        </h2>
        <span style={{ width: 64 }} />
      </header>
      <div className="sheet-body">
        {missingName ? (
          <div className="banner danger" role="alert">
            We couldn't read this file: there is no Name column. Try the template.
            <div>
              <button
                type="button"
                className="linkbtn"
                onClick={() => void downloadTemplate('xlsx')}
              >
                Download template
              </button>
            </div>
          </div>
        ) : annotated.length === 0 ? (
          <div className="banner" role="status">
            No rows to add. Rows with no Name, and example rows, are skipped.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <span className="badge b-now_serving b-big">✓ {ready} ready</span>
              {needLook > 0 && (
                <span className="badge b-up_next b-big">◆ {needLook} need a look</span>
              )}
              {excluded.size > 0 && (
                <span className="badge b-done b-big">{excluded.size} left out</span>
              )}
            </div>
            <div className="flabel">
              From: <span style={{ fontWeight: 600 }}>{fileName}</span>
            </div>
            {truncated && (
              <div className="banner">Only the first {LIMITS.importRowsMax} rows are shown.</div>
            )}
          </>
        )}
        {display.map((r) => {
          const isExcluded = excluded.has(r.rowNumber);
          const error = hasErrors(r);
          const tone = isExcluded
            ? 'done'
            : error || r.issues.some((i) => i.code === 'invalid_phone')
              ? 'no_show'
              : r.issues.length
                ? 'up_next'
                : 'waiting';
          return (
            <div key={r.rowNumber} className={`qrow ${tone}`} style={{ flexWrap: 'wrap' }}>
              <button
                type="button"
                className="main"
                aria-expanded={editing === r.rowNumber}
                onClick={() => setEditing(editing === r.rowNumber ? null : r.rowNumber)}
              >
                <span className="body">
                  <span className="nm">
                    <span>{r.name || '(no name)'}</span>
                    <span className="size">
                      <Icon name="users" />
                      {r.size}
                    </span>
                  </span>
                  <span className="sub" style={{ display: 'block' }}>
                    {r.issues.length
                      ? r.issues.map((i) => (
                          <span
                            key={i.code}
                            style={{
                              display: 'block',
                              color:
                                i.level === 'error' || i.code === 'invalid_phone'
                                  ? 'var(--danger)'
                                  : undefined,
                            }}
                          >
                            {i.level === 'error' || i.code === 'invalid_phone' ? '✕' : '◆'}{' '}
                            {i.message}
                          </span>
                        ))
                      : formatPhone(r.phone)}
                    {isExcluded && ' · left out'}
                  </span>
                </span>
              </button>
              {editing === r.rowNumber && (
                <div style={{ width: '100%', padding: '8px 8px 4px 0' }}>
                  <div className="field">
                    <label htmlFor={`n-${r.rowNumber}`}>Name</label>
                    <input
                      id={`n-${r.rowNumber}`}
                      className="input"
                      value={r.draft.name}
                      onChange={(e) => update(r.rowNumber, { name: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`p-${r.rowNumber}`}>Phone</label>
                    <input
                      id={`p-${r.rowNumber}`}
                      className="input"
                      type="tel"
                      value={r.draft.phone}
                      onChange={(e) => update(r.rowNumber, { phone: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`s-${r.rowNumber}`}>Party size</label>
                    <input
                      id={`s-${r.rowNumber}`}
                      className="input"
                      inputMode="numeric"
                      value={r.draft.size}
                      onChange={(e) => update(r.rowNumber, { size: e.target.value })}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() =>
                      setExcluded((s) => {
                        const n = new Set(s);
                        if (n.has(r.rowNumber)) n.delete(r.rowNumber);
                        else n.add(r.rowNumber);
                        return n;
                      })
                    }
                  >
                    {isExcluded ? 'Include this row' : 'Leave this row out'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {annotated.length > 0 && (
          <>
            {!snap.event.hostConsent && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>These people agreed to receive texts about this photo session.</span>
              </label>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={sendJoin}
                disabled={!consent}
                onChange={(e) => setSendJoin(e.target.checked)}
              />
              <span>
                Send "you're in line" texts now ({withPhone} {withPhone === 1 ? 'text' : 'texts'})
                {snap.event.smsMode === 'tap' && withPhone > 10
                  ? ' — each one is a tap in Messages'
                  : ''}
              </span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={allHere}
                onChange={(e) => setAllHere(e.target.checked)}
              />
              <span>
                Everyone is here already (check them all in). Otherwise Call next skips them until
                they check in.
              </span>
            </label>
          </>
        )}
      </div>
      <div className="sheet-foot">
        {blocked.length > 0 && (
          <div className="field-error" style={{ marginBottom: 8 }}>
            Fix or leave out {blocked.length} {blocked.length === 1 ? 'row' : 'rows'} first.
          </div>
        )}
        {overCap && (
          <div className="field-error" style={{ marginBottom: 8 }}>
            The line holds {LIMITS.activePartiesMax} parties at most.
          </div>
        )}
        <button
          type="button"
          className="btn primary xl"
          disabled={busy || included.length === 0 || blocked.length > 0 || overCap || !!missingName}
          onClick={() => void submit()}
          data-testid="import-submit"
        >
          {busy ? `Adding… ${included.length}` : `Add ${included.length} to the line`}
        </button>
      </div>
    </Sheet>
  );
}
