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

/**
 * The small print under the guest card. Once the guest is already Up next, the "we'll text you
 * when you're N away" promise is past, so only the Your turn text is mentioned.
 */
export function guestNote(
  me: { state: string; hasPhone: boolean } | null,
  upNextN: number,
): string | null {
  if (!me || (me.state !== 'waiting' && me.state !== 'up_next')) return null;
  if (!me.hasPhone) return 'Keep this page open. It updates by itself.';
  if (me.state === 'up_next') return "Stay nearby. We'll text you when it's your turn.";
  return `Stay nearby. We'll text you when you're ${upNextN > 0 ? `${upNextN} away` : 'almost up'} and again when it's your turn.`;
}
