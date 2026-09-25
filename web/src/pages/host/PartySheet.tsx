import { formatPhone, isActive, orderActive, type HostParty, type HostSnapshot } from '@pby/shared';
import { useState } from 'react';
import { Sheet, StatusBadge } from '../../components/ui';
import { Icon } from '../../icons';
import { copyText } from '../../platform/share';
import type { HostContext } from './HostEvent';

/** H4: party actions. Buttons instead of swipes; Move up/down instead of dragging. */
export function PartySheet({
  ctx,
  party: p,
  pending,
  onClose,
  onEdit,
  onText,
  run,
}: {
  ctx: HostContext;
  party: HostParty;
  pending: boolean;
  onClose: () => void;
  onEdit: () => void;
  onText: () => void;
  run: (label: string, fn: () => Promise<HostSnapshot>) => void;
}) {
  const { act, snap } = ctx;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);
  const closed = snap.event.status === 'closed';
  const active = isActive(p);
  const order = orderActive(snap.parties);
  const index = order.findIndex((x) => x.id === p.id);
  const link = `${location.origin}/s/${p.token}`;
  const missed = p.state === 'skipped' || p.state === 'no_show';
  const textLabel =
    p.state === 'now_serving'
      ? 'Text "It\'s your turn"'
      : p.state === 'up_next'
        ? 'Text "You\'re up next"'
        : missed
          ? 'Text "We missed you"'
          : 'Text status link';
  const post = (path: string) => () => act(`/parties/${p.id}/${path}`);

  if (confirmRemove) {
    return (
      <Sheet label="Remove party" onClose={onClose}>
        <h2>Remove {p.name}?</h2>
        <p>They'll see "You're no longer in line."</p>
        <div className="stack">
          <button
            type="button"
            className="btn danger"
            onClick={() => run(`Removed ${p.name}`, post('remove'))}
          >
            Remove from line
          </button>
          <button type="button" className="btn secondary" onClick={() => setConfirmRemove(false)}>
            Cancel
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet label={`Ticket ${p.ticket}, ${p.name}`} onClose={onClose}>
      <div className="sheet-head">
        <span className="tk">#{p.ticket}</span>
        <h2>{p.name}</h2>
        <StatusBadge state={p.state} />
      </div>
      <div className="help" style={{ fontSize: 'var(--fs-sm)', margin: '6px 0 14px' }}>
        {p.size} {p.size === 1 ? 'person' : 'people'}
        {p.members.length ? ` · ${p.members.join(', ')}` : ''}
        {p.group ? ` · ${p.group}` : ''}
        <br />
        {p.phone ? (
          <>
            {formatPhone(p.phone)} · <a href={`tel:${p.phone}`}>Call</a>
          </>
        ) : p.phoneInvalidInput ? (
          <span style={{ color: 'var(--danger)', fontWeight: 700 }}>
            ⚠ Phone "{p.phoneInvalidInput}" isn't valid
          </span>
        ) : (
          'No phone — tell them in person'
        )}
        {p.optedOut && (
          <>
            <br />
            <span style={{ color: 'var(--danger)', fontWeight: 700 }}>
              ⚠ Opted out of texts (STOP)
            </span>
          </>
        )}
        {!p.arrived && active && (
          <>
            <br />
            <b>Not checked in yet.</b> Call next skips them until they arrive.
          </>
        )}
        {p.notes && (
          <>
            <br />
            Note: {p.notes}
          </>
        )}
      </div>
      {!closed && (
        <div className="stack">
          {p.canText && p.state !== 'done' && p.state !== 'removed' && (
            <button type="button" className="btn primary" onClick={onText}>
              <Icon name="msg" /> {pending ? 'Send the waiting text' : textLabel}
            </button>
          )}
          {active && !p.arrived && (
            <button
              type="button"
              className="btn serving"
              onClick={() => run(`${p.name} checked in`, post('arrive'))}
            >
              <Icon name="check" /> Check in (they're here)
            </button>
          )}
          {p.state === 'now_serving' && (
            <div className="btn-pair">
              <button
                type="button"
                className="btn secondary"
                onClick={() => run(`${p.name} done`, () => act('/complete'))}
              >
                <Icon name="check" /> Done
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => run(`${p.name} missed · now serving {serving}`, () => act('/skip'))}
              >
                <Icon name="skip" /> Not here
              </button>
            </div>
          )}
          {missed && (
            <button
              type="button"
              className="btn primary"
              onClick={() => run(`${p.name} is back in line`, post('reinsert'))}
            >
              <Icon name="undo" /> Put back in line
            </button>
          )}
          {(active || missed) && (
            <button
              type="button"
              className="btn secondary left"
              onClick={() => run('Now serving {serving}', post('serve'))}
            >
              <Icon name="camera" /> Serve now
            </button>
          )}
          {active && (
            <>
              <button
                type="button"
                className="btn secondary left"
                disabled={index === 0}
                onClick={() => run(`${p.name} is next`, post('move-next'))}
              >
                <Icon name="next" /> Move to next
              </button>
              <div className="btn-pair">
                <button
                  type="button"
                  className="btn secondary"
                  disabled={index <= 0}
                  onClick={() => run(`Moved ${p.name} up`, post('move-up'))}
                >
                  <Icon name="up" /> Move up
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={index === order.length - 1}
                  onClick={() => run(`Moved ${p.name} down`, post('move-down'))}
                >
                  <Icon name="down" /> Move down
                </button>
              </div>
              {p.arrived && (
                <button
                  type="button"
                  className="btn secondary left"
                  onClick={() => run(`${p.name} marked not here`, post('unarrive'))}
                >
                  <Icon name="noshow" /> Mark as not here yet
                </button>
              )}
            </>
          )}
          <button type="button" className="btn secondary left" onClick={onEdit}>
            <Icon name="edit" /> Edit details
          </button>
          <div className="btn-pair">
            <a
              className="btn secondary"
              href={link}
              target="_blank"
              rel="noreferrer"
              data-testid="status-link"
            >
              <Icon name="link" /> Status page
            </a>
            <button
              type="button"
              className="btn secondary"
              onClick={async () => setCopied(await copyText(link))}
            >
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
          </div>
          {p.state !== 'removed' && p.state !== 'done' && (
            <button
              type="button"
              className="btn danger-text"
              onClick={() => setConfirmRemove(true)}
            >
              Remove from line
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}
