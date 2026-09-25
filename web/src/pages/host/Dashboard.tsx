import {
  findNextToCall,
  orderActive,
  phoneLast4,
  type HostParty,
  type HostSnapshot,
  type ImportRow,
} from '@pby/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { LivePill, STATE_LABEL, Sheet } from '../../components/ui';
import { Icon } from '../../icons';
import { haptics } from '../../platform/haptics';
import { useWakeLock } from '../../platform/wakeLock';
import { navigate } from '../../router';
import { AddPeopleSheet } from './AddPeopleSheet';
import type { HostContext } from './HostEvent';
import { ImportReview } from './ImportReview';
import { PartyEditor } from './PartyEditor';
import { PartySheet } from './PartySheet';
import { SendTextsSheet } from './SendTextsSheet';

type Panel =
  | { kind: 'party'; partyId: string }
  | { kind: 'texts'; partyId?: string }
  | { kind: 'add' }
  | { kind: 'editor'; partyId?: string }
  | {
      kind: 'import';
      rows: ImportRow[];
      source: 'import' | 'vcard' | 'contacts';
      fileName: string;
      missingName?: boolean;
      truncated?: boolean;
    }
  | { kind: 'menu' }
  | { kind: 'confirm-delete' }
  | null;

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function textInfo(p: HostParty, pending: boolean, now: number): string {
  if (p.optedOut) return 'opted out of texts';
  if (p.phoneInvalidInput && !p.phone) return 'phone not valid';
  if (!p.phone) return 'no phone';
  if (p.noTexts) return 'no texts';
  if (pending) return 'text ready to send';
  if (p.lastText?.status === 'sent') return `texted ${ago(now - p.lastText.at)}`;
  if (p.lastText?.status === 'failed') return 'text failed';
  if (!p.canText) return `••• ${phoneLast4(p.phone)}`;
  return p.state === 'up_next' ? 'not texted' : `••• ${phoneLast4(p.phone)}`;
}

function PartyRow({
  p,
  pending,
  now,
  onOpen,
  right,
}: {
  p: HostParty;
  pending: boolean;
  now: number;
  onOpen: () => void;
  right: React.ReactNode;
}) {
  const info = textInfo(p, pending, now);
  const warn = p.optedOut || (!!p.phoneInvalidInput && !p.phone) || p.lastText?.status === 'failed';
  const status =
    p.arrived || !['waiting', 'up_next'].includes(p.state) ? STATE_LABEL[p.state] : 'Not here yet';
  return (
    <div
      className={`qrow ${p.state}${p.arrived ? '' : ' not-arrived'}`}
      data-testid={`row-${p.ticket}`}
    >
      <button
        type="button"
        className="main"
        onClick={onOpen}
        aria-label={`Ticket ${p.ticket}, ${p.name}, ${p.size} ${p.size === 1 ? 'person' : 'people'}, ${status}, ${info}`}
      >
        <span className="tk">#{p.ticket}</span>
        <span className="body">
          <span className="nm">
            <span>{p.name}</span>
            <span className="size">
              <Icon name="users" />
              {p.size}
            </span>
          </span>
          <span className="sub" style={{ display: 'block' }}>
            {status} ·{' '}
            {warn ? (
              <span className="warn">
                <span aria-hidden="true">⚠</span> {info}
              </span>
            ) : (
              info
            )}
          </span>
        </span>
      </button>
      {right}
    </div>
  );
}

export function Dashboard({ ctx }: { ctx: HostContext }) {
  const { snap, act, toast, live, prefs, clockOffset, undo } = ctx;
  const [panel, setPanel] = useState<Panel>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [showMissed, setShowMissed] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [calling, setCalling] = useState(false);
  const [flash, setFlash] = useState(false);
  const now = useNow();
  const lastServing = useRef<string | null>(null);
  useWakeLock(prefs.keepAwake);

  const closed = snap.event.status === 'closed';
  const parties = snap.parties;
  const serving = parties.find((p) => p.state === 'now_serving');
  const active = useMemo(() => orderActive(parties), [parties]);
  const upNext = active.filter((p) => p.state === 'up_next');
  const waiting = active.filter((p) => p.state === 'waiting');
  const missed = parties
    .filter((p) => p.state === 'skipped' || p.state === 'no_show')
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const doneList = parties
    .filter((p) => p.state === 'done' || p.state === 'removed')
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const next = findNextToCall(parties);
  const pendingBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of snap.pendingTexts) m.set(t.partyId, (m.get(t.partyId) ?? 0) + 1);
    return m;
  }, [snap.pendingTexts]);
  const pendingUpNext = snap.pendingTexts.filter((t) => t.template === 'up_next').length;
  const tapMode = snap.event.smsMode === 'tap' || !snap.twilioAvailable;

  useEffect(() => {
    const prev = lastServing.current;
    lastServing.current = serving?.id ?? null;
    if (serving?.id && prev && serving.id !== prev) {
      setFlash(true);
      const t = window.setTimeout(() => setFlash(false), 700);
      return () => window.clearTimeout(t);
    }
  }, [serving?.id]);

  const run = async (
    label: string,
    fn: () => Promise<HostSnapshot>,
    opts: { undo?: boolean } = {},
  ) => {
    try {
      const s = await fn();
      const nowServing = s.parties.find((p) => p.state === 'now_serving');
      const text = label.replace('{serving}', nowServing?.name ?? '');
      toast({ text, undo: opts.undo });
      return s;
    } catch (err) {
      toast({ text: errorMessage(err), danger: true });
      return null;
    }
  };

  const afterCall = (s: HostSnapshot | null) => {
    if (s && tapMode && prefs.askToText && s.pendingTexts.length > 0) setPanel({ kind: 'texts' });
  };

  const callNext = async () => {
    if (calling || !next) return;
    setCalling(true);
    window.setTimeout(() => setCalling(false), 1000); // Q2: 1 s debounce
    haptics.pulse();
    afterCall(await run('Now serving {serving}', () => act('/call-next'), { undo: true }));
  };

  const textRow = async (p: HostParty) => {
    if (pendingBy.has(p.id)) return setPanel({ kind: 'texts', partyId: p.id });
    try {
      await act(`/parties/${p.id}/text`);
      if (tapMode) setPanel({ kind: 'texts', partyId: p.id });
      else toast({ text: `Texting ${p.name}…` });
    } catch (err) {
      toast({ text: errorMessage(err), danger: true });
    }
  };

  const matches = (p: HostParty) => {
    if (!search) return true;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const digits = q.replace(/\D/g, '');
    return (
      p.name.toLowerCase().includes(q) ||
      String(p.ticket) === q.replace('#', '') ||
      (digits.length >= 3 && (p.phone ?? '').includes(digits))
    );
  };

  const smsButton = (p: HostParty) =>
    p.phone && p.canText ? (
      <button
        type="button"
        className={`iconbtn sms${pendingBy.has(p.id) ? ' pending' : ''}`}
        aria-label={`Text ${p.name}${pendingBy.has(p.id) ? ' (text ready)' : ''}`}
        onClick={() => void textRow(p)}
      >
        <Icon name="msg" />
      </button>
    ) : (
      <span style={{ width: 48 }} />
    );

  const activeRow = (p: HostParty) => (
    <PartyRow
      key={p.id}
      p={p}
      pending={pendingBy.has(p.id)}
      now={now}
      onOpen={() => setPanel({ kind: 'party', partyId: p.id })}
      right={
        p.arrived ? (
          smsButton(p)
        ) : (
          <button
            type="button"
            className="chip primary"
            data-testid={`check-in-${p.ticket}`}
            onClick={() =>
              void run(`${p.name} checked in`, () => act(`/parties/${p.id}/arrive`), { undo: true })
            }
          >
            <Icon name="check" /> Check in
          </button>
        )
      }
    />
  );

  const servingElapsed = serving?.calledAt ? now + clockOffset - serving.calledAt : 0;
  const servingText = serving ? snap.pendingTexts.find((t) => t.partyId === serving.id) : undefined;
  const servingTexted =
    serving?.lastText?.template === 'your_turn' && serving.lastText.status === 'sent';
  const doneCount = parties.filter((p) => p.state === 'done').length;
  const selectedParty =
    panel?.kind === 'party' || panel?.kind === 'editor'
      ? parties.find((p) => p.id === panel.partyId)
      : undefined;

  return (
    <main className="screen">
      <header className="topbar">
        <h1 className="title" style={{ margin: 0 }}>
          {snap.event.name}
        </h1>
        {!closed && <LivePill state={live.state} lastUpdate={live.lastUpdate} />}
        {snap.undo && (
          <button
            type="button"
            className="iconbtn"
            aria-label={`Undo ${snap.undo.label}`}
            title={`Undo ${snap.undo.label}`}
            onClick={() => void undo()}
          >
            <Icon name="undo" />
          </button>
        )}
        <button
          type="button"
          className="iconbtn"
          aria-label="Share and QR code"
          onClick={() => navigate(`/host/e/${ctx.id}/share`)}
        >
          <Icon name="qr" />
        </button>
        <button
          type="button"
          className="iconbtn"
          aria-label="More"
          onClick={() => setPanel({ kind: 'menu' })}
        >
          <Icon name="more" />
        </button>
      </header>

      <div className="content with-bar with-callbar">
        {live.state === 'offline' && (
          <div className="banner danger" role="status">
            Offline. Showing the last update; actions need a connection.
          </div>
        )}
        {closed && (
          <div className="banner" role="status">
            This event has ended. Guests can no longer join or see updates.
          </div>
        )}
        <div className="counts">
          <span>{active.length} waiting ·</span>
          <button type="button" onClick={() => setShowDone((v) => !v)} aria-pressed={showDone}>
            {doneCount} done
          </button>
        </div>

        {serving ? (
          <section
            className={`serving-card${flash ? ' flash' : ''}`}
            aria-live="polite"
            data-testid="now-serving"
          >
            <div className="lbl">
              <span className="eyebrow">● Now serving</span>
              <span aria-label="Time since called">{clock(servingElapsed)}</span>
            </div>
            <button
              type="button"
              className="name"
              style={{
                background: 'none',
                border: 0,
                padding: 0,
                color: 'inherit',
                width: '100%',
                textAlign: 'left',
              }}
              onClick={() => setPanel({ kind: 'party', partyId: serving.id })}
            >
              <span className="tk">#{serving.ticket}</span>
              <span>{serving.name}</span>
            </button>
            <div className="meta">
              {serving.size} {serving.size === 1 ? 'person' : 'people'}
              {serving.members.length ? ` · ${serving.members.join(', ')}` : ''}
            </div>
            {!closed && (
              <div className="card-actions">
                <button
                  type="button"
                  onClick={() =>
                    void run(`${serving.name} done`, () => act('/complete'), { undo: true })
                  }
                >
                  <Icon name="check" /> Done
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void run(`${serving.name} missed · now serving {serving}`, () => act('/skip'), {
                      undo: true,
                    }).then(afterCall)
                  }
                >
                  <Icon name="skip" /> Not here
                </button>
                {serving.canText ? (
                  <button
                    type="button"
                    onClick={() =>
                      servingText
                        ? setPanel({ kind: 'texts', partyId: serving.id })
                        : void textRow(serving)
                    }
                  >
                    <Icon name={servingTexted ? 'check' : 'msg'} />{' '}
                    {servingTexted ? 'Texted' : 'Text'}
                  </button>
                ) : (
                  <button type="button" disabled style={{ opacity: 0.6 }}>
                    No phone
                  </button>
                )}
              </div>
            )}
          </section>
        ) : active.length === 0 && !closed ? (
          <div className="empty-card">
            <p style={{ margin: '0 0 12px' }}>No one in line yet.</p>
            <div className="btn-pair">
              <button
                type="button"
                className="btn primary"
                onClick={() => setPanel({ kind: 'add' })}
              >
                Add people
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => navigate(`/host/e/${ctx.id}/share`)}
              >
                Show QR code
              </button>
            </div>
          </div>
        ) : (
          <div className="empty-card">
            No one is being served. Tap <b>Call next</b> to start.
          </div>
        )}

        {upNext.length > 0 && (
          <>
            <div className="sec">
              <span className="l">
                <span style={{ color: 'var(--upnext)', display: 'inline-flex' }}>
                  <Icon name="diamond" size={18} />
                </span>
                Up next
              </span>
              {pendingUpNext > 0 && (
                <button
                  type="button"
                  className="chip upnext"
                  onClick={() => setPanel({ kind: 'texts' })}
                >
                  <Icon name="msg" /> Text {pendingUpNext}
                </button>
              )}
            </div>
            {upNext.filter(matches).map(activeRow)}
          </>
        )}

        <div className="sec">
          <span className="l">Waiting ({waiting.length})</span>
          <button
            type="button"
            className="iconbtn"
            aria-label="Search"
            aria-pressed={search !== null}
            onClick={() => setSearch((s) => (s === null ? '' : null))}
          >
            <Icon name="search" />
          </button>
        </div>
        {search !== null && (
          <input
            className="input search"
            autoFocus
            placeholder="Name, phone or ticket #"
            aria-label="Search the line"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        {waiting.filter(matches).map(activeRow)}
        {waiting.length === 0 && <p className="help">Nobody else is waiting.</p>}

        {missed.length > 0 && (
          <>
            <div className="sec">
              <button
                type="button"
                className="l"
                aria-expanded={showMissed}
                onClick={() => setShowMissed((v) => !v)}
              >
                Skipped &amp; no-show ({missed.length}) {showMissed ? '▾' : '· tap to show'}
              </button>
            </div>
            {showMissed &&
              missed.filter(matches).map((p) => (
                <PartyRow
                  key={p.id}
                  p={p}
                  pending={pendingBy.has(p.id)}
                  now={now}
                  onOpen={() => setPanel({ kind: 'party', partyId: p.id })}
                  right={
                    !closed && (
                      <button
                        type="button"
                        className="chip"
                        onClick={() =>
                          void run(
                            `${p.name} is back in line`,
                            () => act(`/parties/${p.id}/reinsert`),
                            { undo: true },
                          )
                        }
                      >
                        Re-add
                      </button>
                    )
                  }
                />
              ))}
          </>
        )}

        {showDone && (
          <>
            <div className="sec">
              <span className="l">Done &amp; removed ({doneList.length})</span>
            </div>
            {doneList.map((p) => (
              <PartyRow
                key={p.id}
                p={p}
                pending={false}
                now={now}
                onOpen={() => setPanel({ kind: 'party', partyId: p.id })}
                right={null}
              />
            ))}
          </>
        )}
      </div>

      <div className="bottombar">
        <div className="inner">
          {closed ? (
            <button
              type="button"
              className="btn danger xl"
              onClick={() => setPanel({ kind: 'confirm-delete' })}
            >
              <Icon name="trash" /> Delete guest data now
            </button>
          ) : (
            <>
              <button type="button" className="addbtn" onClick={() => setPanel({ kind: 'add' })}>
                <Icon name="plus" />
                Add
              </button>
              <button
                type="button"
                className="callnext"
                disabled={!next || calling}
                onClick={() => void callNext()}
                data-testid="call-next"
              >
                {next ? (
                  <>
                    <span className="big">
                      Call next <Icon name="next" />
                    </span>
                    <span className="small">
                      {next.name} · #{next.ticket}
                    </span>
                  </>
                ) : (
                  <span className="big" style={{ fontSize: 'var(--fs-lg)' }}>
                    {active.length ? 'Nobody checked in' : 'Line is empty'}
                  </span>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {panel?.kind === 'party' && selectedParty && (
        <PartySheet
          ctx={ctx}
          party={selectedParty}
          pending={pendingBy.has(selectedParty.id)}
          onClose={() => setPanel(null)}
          onEdit={() => setPanel({ kind: 'editor', partyId: selectedParty.id })}
          onText={() => {
            setPanel(null);
            void textRow(selectedParty);
          }}
          run={(label, fn) => {
            setPanel(null);
            void run(label, fn, { undo: true }).then(
              (s) => label.includes('{serving}') && afterCall(s),
            );
          }}
        />
      )}
      {panel?.kind === 'texts' && (
        <SendTextsSheet ctx={ctx} focusPartyId={panel.partyId} onClose={() => setPanel(null)} />
      )}
      {panel?.kind === 'add' && (
        <AddPeopleSheet
          ctx={ctx}
          onClose={() => setPanel(null)}
          onManual={() => setPanel({ kind: 'editor' })}
          onImport={(p) => setPanel({ kind: 'import', ...p })}
        />
      )}
      {panel?.kind === 'editor' && (
        <PartyEditor ctx={ctx} party={selectedParty} onClose={() => setPanel(null)} />
      )}
      {panel?.kind === 'import' && (
        <ImportReview
          ctx={ctx}
          initialRows={panel.rows}
          source={panel.source}
          fileName={panel.fileName}
          missingName={panel.missingName}
          truncated={panel.truncated}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'menu' && (
        <Sheet label="More" onClose={() => setPanel(null)}>
          <div className="stack">
            <button
              type="button"
              className="btn secondary left"
              onClick={() => navigate(`/host/e/${ctx.id}/settings`)}
            >
              <Icon name="gear" /> Settings
            </button>
            <button
              type="button"
              className="btn secondary left"
              onClick={() => navigate(`/host/e/${ctx.id}/share`)}
            >
              <Icon name="qr" /> Let guests join (QR code)
            </button>
            <button
              type="button"
              className="btn secondary left"
              onClick={() => {
                setShowDone((v) => !v);
                setPanel(null);
              }}
            >
              <Icon name="check" /> {showDone ? 'Hide' : 'Show'} done &amp; removed
            </button>
            {tapMode && (
              <button
                type="button"
                className="btn secondary left"
                onClick={() => setPanel({ kind: 'texts' })}
              >
                <Icon name="msg" /> Texts to send ({snap.pendingTexts.length})
              </button>
            )}
            <button type="button" className="btn secondary left" onClick={() => navigate('/host')}>
              <Icon name="back" /> All events
            </button>
          </div>
        </Sheet>
      )}
      {panel?.kind === 'confirm-delete' && (
        <Sheet label="Delete guest data" onClose={() => setPanel(null)}>
          <h2>Delete all guest data now?</h2>
          <p>Names, phone numbers and status links are removed for good. Totals are kept.</p>
          <div className="stack">
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                try {
                  await api(`/api/host/events/${ctx.id}/delete`, { body: {} });
                  navigate('/host', { replace: true });
                } catch (err) {
                  toast({ text: errorMessage(err), danger: true });
                }
              }}
            >
              Delete now
            </button>
            <button type="button" className="btn secondary" onClick={() => setPanel(null)}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}
    </main>
  );
}
