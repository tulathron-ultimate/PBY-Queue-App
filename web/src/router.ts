import { useSyncExternalStore, type MouseEvent } from 'react';

/** A tiny history router: the app has a handful of routes, so no dependency is needed. */
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.scrollTo(0, 0);
  notify();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useLocation(): string {
  return useSyncExternalStore(subscribe, () => location.pathname + location.search);
}

export function linkHandler(to: string) {
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
}

export function back(fallback: string): void {
  if (history.length > 1) history.back();
  else navigate(fallback, { replace: true });
}
