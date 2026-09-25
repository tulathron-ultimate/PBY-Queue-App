/** Field limits and defaults (FEATURES §2.2, §2.3, §2.6, §2.7, §2.10, §2.12). */
export const LIMITS = {
  eventNameMax: 40,
  smsEventNameMax: 20,
  partyNameMax: 40,
  partySizeMin: 1,
  partySizeMax: 20,
  membersMax: 20,
  memberNameMax: 40,
  notesMax: 200,
  groupMax: 40,
  activePartiesMax: 500,
  importRowsMax: 500,
  helperSessionsMax: 5,
  pinMinLength: 6,
  pinMaxLength: 12,
  upNextMin: 0,
  upNextMax: 5,
  minutesPerPartyMin: 1,
  minutesPerPartyMax: 15,
} as const;

export const DEFAULTS = {
  upNextN: 2,
  minutesPerParty: 3,
  maxSkips: 2,
  reinsertSpotsBack: 3,
  retentionDays: 7,
  autoCloseHours: 12,
  undoToastMs: 10_000,
  callNextDebounceMs: 1_000,
  guestPollMs: 15_000,
  sessionHours: 12,
} as const;

/** PIN: 6–12 chars, digits or letters (§2.10). */
export const PIN_PATTERN = /^[A-Za-z0-9]{6,12}$/;

export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
