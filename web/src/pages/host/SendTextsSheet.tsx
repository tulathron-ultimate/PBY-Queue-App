import { formatPhone, TEMPLATE_LABELS, type PendingText, type TemplateKey } from '@pby/shared';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api';
import { Sheet } from '../../components/ui';
import { Icon } from '../../icons';
import { openSms } from '../../platform/sms';
import type { HostContext } from './HostEvent';

const BADGE: Record<TemplateKey, string> = {
  your_turn: 'b-now_serving',
  up_next: 'b-up_next',
  join: 'b-waiting',
  skipped: 'b-skipped',
};

interface Sent {
  id: number;
  name: string;
  template: TemplateKey;
}

/**
 * H5 (tap-to-send): one text per tap. Each tap opens Messages already filled in; when the
 * page becomes visible again the text is marked sent and the next one comes up.
 */
export function SendTextsSheet({
  ctx,
  focusPartyId,
  onClose,
}: {
  ctx: HostContext;
  focusPartyId?: string;
  onClose: () => void;
}) {
  const { snap, act, toast } = ctx;
  const [sent, setSent] = useState<Sent[]>([]);
  const [awaiting, setAwaiting] = useState<number | null>(null);
  const awaitingRef = useRef<number | null>(null);
  const names = new Map(snap.parties.map((p) => [p.id, p.name]));

  const queue: PendingText[] = [...snap.pendingTexts].sort((a, b) => {
    if (focusPartyId) {
      const fa = a.partyId === focusPartyId ? 0 : 1;
      const fb = b.partyId === focusPartyId ? 0 : 1;
      if (fa !== fb) return fa - fb;
    }
    return a.id - b.id;
  });
  const current = queue[0];
  const total = sent.length + queue.length;

  const mark = async (id: number, status: 'sent' | 'skipped' | 'pending') => {
    try {
      await act(`/texts/${id}`, { status });
    } catch (err) {
      toast({ text: errorMessage(err), danger: true });
    }
  };

  const markSent = async (id: number) => {
    const msg = snap.pendingTexts.find((t) => t.id === id);
    awaitingRef.current = null;
    setAwaiting(null);
    if (msg)
      setSent((s) => [...s, { id, name: names.get(msg.partyId) ?? '', template: msg.template }]);
    await mark(id, 'sent');
  };

  // Coming back from Messages marks the text as sent (optimistic; "Didn't send" reverts).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && awaitingRef.current !== null) {
        void markSent(awaitingRef.current);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  const send = (msg: PendingText) => {
    awaitingRef.current = msg.id;
    setAwaiting(msg.id);
    openSms(msg.to, msg.body);
  };

  const lastSent = sent[sent.length - 1];

  return (
    <Sheet label="Send texts" onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2>
          {queue.length ? `Send ${total} ${total === 1 ? 'text' : 'texts'}` : 'All texts sent'}
        </h2>
        {total > 0 && (
          <span style={{ fontWeight: 800, color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
            {Math.min(sent.length + 1, total)} of {total}
          </span>
        )}
      </div>
      {total > 0 && (
        <div className="progress" aria-hidden="true">
          {Array.from({ length: Math.min(total, 12) }, (_, i) => (
            <span key={i} className={i < sent.length ? 'on' : ''} />
          ))}
        </div>
      )}
      {current ? (
        <>
          <div className="msgcard" data-testid="text-card">
            <div className="to">
              <span>{names.get(current.partyId)}</span>
              <span className={`badge ${BADGE[current.template]}`}>
                {TEMPLATE_LABELS[current.template]}
              </span>
            </div>
            <div className="help" style={{ marginTop: 2 }}>
              {formatPhone(current.to)}
            </div>
            <div className="preview">{current.body}</div>
          </div>
          {awaiting === current.id ? (
            <div className="stack">
              <button
                type="button"
                className="btn primary xl"
                onClick={() => void markSent(current.id)}
              >
                <Icon name="check" /> I sent it
              </button>
              <button type="button" className="btn secondary" onClick={() => send(current)}>
                Open Messages again
              </button>
            </div>
          ) : (
            <button type="button" className="btn primary xl" onClick={() => send(current)}>
              <Icon name="msg" /> Text {names.get(current.partyId)}
            </button>
          )}
          <div className="btn-pair" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                awaitingRef.current = null;
                setAwaiting(null);
                void mark(current.id, 'skipped');
              }}
            >
              Skip this one
            </button>
            <button type="button" className="btn secondary" onClick={onClose}>
              Done for now
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn primary" style={{ marginTop: 12 }} onClick={onClose}>
          Close
        </button>
      )}
      {lastSent && (
        <button
          type="button"
          className="linkbtn"
          onClick={() => {
            setSent((s) => s.slice(0, -1));
            void mark(lastSent.id, 'pending');
          }}
        >
          Didn't send to {lastSent.name}? Put it back
        </button>
      )}
      <div className="sendlist">
        {sent.map((s) => (
          <div key={s.id} className="sent">
            <span className={`badge ${BADGE[s.template]}`}>✓</span> {s.name}:{' '}
            {TEMPLATE_LABELS[s.template]} · sent
          </div>
        ))}
        {queue.map((t) => (
          <div key={t.id}>
            <span className={`badge ${BADGE[t.template]}`}>
              {t.template === 'up_next' ? '◆' : '●'}
            </span>{' '}
            {names.get(t.partyId)}: {TEMPLATE_LABELS[t.template]}
          </div>
        ))}
      </div>
    </Sheet>
  );
}
