import type { PartyState } from '@pby/shared';
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../icons';
import type { LiveState } from '../live';

export const STATE_LABEL: Record<PartyState, string> = {
  waiting: 'Waiting',
  up_next: 'Up next',
  now_serving: 'Now serving',
  done: 'Done',
  skipped: 'Skipped',
  no_show: 'No-show',
  removed: 'Removed',
};

const STATE_GLYPH: Record<PartyState, string> = {
  waiting: '○',
  up_next: '◆',
  now_serving: '●',
  done: '✓',
  skipped: '↷',
  no_show: '✕',
  removed: '–',
};

/** Status = color + label + icon (never color alone). */
export function StatusBadge({ state, big }: { state: PartyState; big?: boolean }) {
  return (
    <span className={`badge b-${state}${big ? ' b-big' : ''}`}>
      <span aria-hidden="true">{STATE_GLYPH[state]}</span> {STATE_LABEL[state]}
    </span>
  );
}

export function LivePill({ state, lastUpdate }: { state: LiveState; lastUpdate: number | null }) {
  if (state === 'live') return <span className="live">Live</span>;
  if (state === 'offline') {
    const mins = lastUpdate ? Math.max(1, Math.round((Date.now() - lastUpdate) / 60_000)) : null;
    return <span className="live offline">Offline{mins ? ` · updated ${mins} min ago` : ''}</span>;
  }
  return (
    <span className="live reconnecting">
      {state === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
    </span>
  );
}

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  small,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  small?: boolean;
}) {
  return (
    <div className={`stepper${small ? ' small' : ''}`} role="group" aria-label={label}>
      <button
        type="button"
        aria-label={`Fewer: ${label}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <output aria-live="polite">{value}</output>
      <button
        type="button"
        aria-label={`More: ${label}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  sub,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  sub?: ReactNode;
  testId?: string;
}) {
  return (
    <label className="setrow">
      <span>
        {label}
        {sub && <span className="sub">{sub}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="toggle"
        checked={checked}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** Bottom sheet with scrim; closes on Escape and scrim tap, keeps focus inside. */
export function Sheet({
  onClose,
  children,
  full,
  label,
}: {
  onClose: () => void;
  children: ReactNode;
  full?: boolean;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && el) {
        const focusable = el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select, textarea',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div
        className={`sheet${full ? ' full' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={ref}
        tabIndex={-1}
      >
        {!full && <button type="button" className="grab" aria-label="Close" onClick={onClose} />}
        {children}
      </div>
    </>
  );
}

export interface ToastData {
  id: number;
  text: string;
  undo?: boolean;
  danger?: boolean;
}

export function Toast({
  toast,
  onUndo,
  onDone,
  noBar,
}: {
  toast: ToastData | null;
  onUndo: () => void;
  onDone: () => void;
  noBar?: boolean;
}) {
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(onDone, toast.undo ? 10_000 : 6000);
    return () => window.clearTimeout(t);
  }, [toast, onDone]);
  if (!toast) return null;
  return (
    <div
      className={`toast${toast.danger ? ' danger' : ''}${noBar ? ' no-bar' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span>{toast.text}</span>
      {toast.undo && (
        <button type="button" className="undo" onClick={onUndo}>
          UNDO
        </button>
      )}
    </div>
  );
}

export function TopBar({
  title,
  onBack,
  children,
  display,
}: {
  title: ReactNode;
  onBack?: () => void;
  children?: ReactNode;
  display?: boolean;
}) {
  return (
    <header className="topbar">
      {onBack && (
        <button type="button" className="iconbtn" aria-label="Back" onClick={onBack}>
          <Icon name="back" />
        </button>
      )}
      <h1 className={`title${display ? ' display' : ''}`} style={{ margin: 0 }}>
        {title}
      </h1>
      {children}
    </header>
  );
}
