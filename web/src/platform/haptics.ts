/** Haptics adapter (Q9). Native haptics can replace this under Capacitor. */
function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // unsupported
  }
}

export const haptics = {
  pulse: () => vibrate(30),
  doublePulse: () => vibrate([120, 80, 120]),
};
