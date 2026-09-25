import { useState } from 'react';
import { errorMessage } from '../../api';
import { Toggle, TopBar } from '../../components/ui';
import { Icon } from '../../icons';
import { canShare, copyText, shareLink } from '../../platform/share';
import { useWakeLock } from '../../platform/wakeLock';
import { navigate } from '../../router';
import type { HostContext } from './HostEvent';

/** H8: QR code and link for self-join. The screen stays awake so guests can scan it. */
export function SharePage({ ctx }: { ctx: HostContext }) {
  const { snap, act, toast } = ctx;
  const [copied, setCopied] = useState(false);
  const [tvCopied, setTvCopied] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  useWakeLock(true);
  const url = snap.event.joinUrl;
  const shortUrl = url.replace(/^https?:\/\//, '');
  const qr = `/api/join/${snap.event.code}/qr.svg`;
  const lobbyUrl = snap.event.lobbyUrl;
  const closed = snap.event.status === 'closed';
  const lobbyAction = async (path: string, text: string) => {
    try {
      await act(path);
      setTvCopied(false);
      setConfirmOff(false);
      toast({ text });
    } catch (err) {
      toast({ text: errorMessage(err), danger: true });
    }
  };

  return (
    <main className="screen">
      <TopBar title="Let guests join" onBack={() => navigate(`/host/e/${ctx.id}`)} />
      <div className="content">
        <div className="print-only" style={{ textAlign: 'center' }}>
          <h1 className="display" style={{ fontSize: '2.4rem', margin: '0 0 8px' }}>
            {snap.event.name}
          </h1>
        </div>
        <p
          style={{
            textAlign: 'center',
            fontWeight: 800,
            fontSize: 'var(--fs-lg)',
            margin: '8px 0 14px',
          }}
        >
          Scan to join the photo line
        </p>
        <img className="qr" src={qr} alt={`QR code for ${shortUrl}`} />
        <div className="mono" data-testid="join-url">
          {shortUrl}
        </div>
        {!snap.event.selfJoin && (
          <div className="banner no-print">
            Joining is turned off. Guests will see "The line is closed".
          </div>
        )}
        <div className="stack no-print">
          <div className="btn-pair">
            <button
              type="button"
              className="btn secondary"
              onClick={async () => setCopied(await copyText(url))}
            >
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
            {canShare() ? (
              <button
                type="button"
                className="btn primary"
                onClick={() => void shareLink(snap.event.name, url)}
              >
                <Icon name="share" /> Share
              </button>
            ) : (
              <a className="btn primary" href={url} target="_blank" rel="noreferrer">
                Open
              </a>
            )}
          </div>
          <button type="button" className="btn secondary left" onClick={() => window.print()}>
            <Icon name="print" /> Print a sign
          </button>
          <p className="help">
            Event code for helper phones: <b>{snap.event.code}</b>
          </p>
        </div>
        <section className="no-print lobby-share" aria-labelledby="tv-title">
          <h2 id="tv-title" className="group-label eyebrow">
            Lobby display (TV)
          </h2>
          <p className="help" style={{ marginTop: 0 }}>
            Shows Now serving and the next few tickets on a TV or tablet, with this QR code. Names
            appear as "Emma R." (or tickets only if names are off). Anyone with the link can watch
            it, so turn it off after the event.
          </p>
          {lobbyUrl ? (
            <div className="stack">
              <div className="mono" data-testid="lobby-url" style={{ margin: '4px 0' }}>
                {lobbyUrl.replace(/^https?:\/\//, '')}
              </div>
              <div className="btn-pair">
                <button
                  type="button"
                  className="btn primary"
                  data-testid="open-on-tv"
                  onClick={async () => setTvCopied(await copyText(lobbyUrl))}
                >
                  <Icon name="tv" /> {tvCopied ? 'Link copied ✓' : 'Open on TV'}
                </button>
                <a
                  className="btn secondary"
                  href={lobbyUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="open-lobby-here"
                >
                  Open here
                </a>
              </div>
              {tvCopied && (
                <p className="help" style={{ margin: 0 }} role="status">
                  Paste it into the TV's or tablet's browser.
                </p>
              )}
              {confirmOff ? (
                <div className="btn-pair">
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => void lobbyAction('/lobby/revoke', 'TV link turned off')}
                  >
                    Turn off
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => setConfirmOff(false)}
                  >
                    Keep it
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn danger-text"
                  data-testid="lobby-off"
                  onClick={() => setConfirmOff(true)}
                >
                  Turn off TV link
                </button>
              )}
            </div>
          ) : (
            !closed && (
              <button
                type="button"
                className="btn secondary left"
                data-testid="lobby-create"
                onClick={() => void lobbyAction('/lobby', 'TV link ready')}
              >
                <Icon name="tv" /> Make a TV link
              </button>
            )
          )}
        </section>
        <div className="no-print" style={{ marginTop: 8 }}>
          <Toggle
            label="Accept new guests"
            checked={snap.event.selfJoin}
            onChange={async (v) => {
              try {
                await act('/settings', { selfJoin: v }, 'PATCH');
              } catch (err) {
                toast({ text: errorMessage(err), danger: true });
              }
            }}
          />
        </div>
      </div>
    </main>
  );
}
