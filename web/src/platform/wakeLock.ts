import { useEffect } from 'react';

/** Screen wake lock adapter (Q9) with a graceful fallback when the API is missing. */
interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    const wl = (
      navigator as Navigator & {
        wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
      }
    ).wakeLock;
    if (!enabled || !wl) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const s = await wl.request('screen');
        if (cancelled) void s.release();
        else sentinel = s;
      } catch {
        // Not allowed (battery saver, iframe): the screen may sleep. Nothing else to do.
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', acquire);
      void sentinel?.release();
    };
  }, [enabled]);
}
