import type { WsMessage } from '@pby/shared';
import { useEffect, useRef, useState } from 'react';

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/**
 * Live updates over WebSocket with reconnect back-off and a polling fallback while the
 * socket is down (15 s by default). After 30 s without a socket the state becomes offline.
 */
export function useLive<T>(opts: {
  wsPath: string | null;
  poll: (() => Promise<T | null>) | null;
  pick: (msg: WsMessage) => T | null;
  onData: (data: T) => void;
  onClose?: (code: number) => boolean | void;
  pollMs?: number;
}): { state: LiveState; lastUpdate: number | null } {
  const [state, setState] = useState<LiveState>('connecting');
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    if (!opts.wsPath) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let downSince: number | null = Date.now();
    let retryTimer: number | undefined;
    const got = (data: T) => {
      setLastUpdate(Date.now());
      ref.current.onData(data);
    };
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}${opts.wsPath}`);
      ws.onopen = () => {
        attempt = 0;
        downSince = null;
        setState('live');
      };
      ws.onmessage = (e) => {
        try {
          const data = ref.current.pick(JSON.parse(String(e.data)) as WsMessage);
          if (data) got(data);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = (e) => {
        if (stopped) return;
        if (ref.current.onClose?.(e.code) === false) {
          stopped = true;
          return;
        }
        downSince ??= Date.now();
        setState(Date.now() - downSince > 30_000 ? 'offline' : 'reconnecting');
        const delay = [1000, 2000, 5000, 10_000][Math.min(attempt++, 3)];
        retryTimer = window.setTimeout(connect, delay);
      };
    };
    connect();
    const pollTimer = window.setInterval(async () => {
      if (ws?.readyState === WebSocket.OPEN) return;
      if (downSince && Date.now() - downSince > 30_000) setState('offline');
      try {
        const data = await ref.current.poll?.();
        if (data) got(data);
      } catch {
        // still offline
      }
    }, opts.pollMs ?? 15_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && ws?.readyState !== WebSocket.OPEN) {
        void ref.current
          .poll?.()
          .then((d) => d && got(d))
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisible);
      ws?.close();
    };
  }, [opts.wsPath, opts.pollMs]);

  return { state, lastUpdate };
}
