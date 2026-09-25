/**
 * G2 name privacy: "Emma Rivera" → "Emma R.". A single word is shown as-is.
 * Returns null when the host has turned names off (show ticket numbers only).
 */
export function publicName(name: string, showNames: boolean): string | null {
  if (!showNames) return null;
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words.length === 1) return words[0];
  const last = words[words.length - 1];
  return `${words[0]} ${last.charAt(0).toUpperCase()}.`;
}
