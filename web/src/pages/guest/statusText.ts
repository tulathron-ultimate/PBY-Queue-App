/**
 * Plain-language lines for the guest status page (G2). Positions only: the owner decided
 * against wait-time estimates, because the pace of a photo line varies too much.
 */

/** "3 ahead of you" from a 1-based position among the parties that will be called. */
export function aheadText(position: number | null): string | null {
  if (position === null || position < 1) return null;
  const ahead = position - 1;
  return ahead === 0 ? 'Nobody ahead of you' : `${ahead} ahead of you`;
}
