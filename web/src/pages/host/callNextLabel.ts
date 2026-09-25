/**
 * What the disabled Call next button says when nobody can be called (FEATURES §2.5, DESIGN H3):
 * "Line paused" while the host has paused the line (E6), "Line is empty" with nobody waiting, or
 * "Nobody checked in" when everyone waiting is not here yet (A8). Null when there is someone to
 * call.
 */
export function callNextEmptyLabel(
  activeCount: number,
  hasNext: boolean,
  paused = false,
): string | null {
  if (paused) return 'Line paused';
  if (hasNext) return null;
  return activeCount > 0 ? 'Nobody checked in' : 'Line is empty';
}
