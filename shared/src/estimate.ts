import { DEFAULTS } from './limits.js';

/** Wait-time estimate (FEATURES §2.3). */
export const SAMPLE_MIN_MS = 15_000;
export const SAMPLE_MAX_MS = 20 * 60_000;
export const SAMPLE_WINDOW = 5;
export const AVG_MIN_MINUTES = 1;
export const AVG_MAX_MINUTES = 15;

export function isValidSample(ms: number): boolean {
  return Number.isFinite(ms) && ms >= SAMPLE_MIN_MS && ms <= SAMPLE_MAX_MS;
}

/** Appends a service-time sample, keeping only the most recent valid ones. */
export function addSample(samples: readonly number[], ms: number): number[] {
  if (!isValidSample(ms)) return [...samples];
  return [...samples, ms].slice(-SAMPLE_WINDOW);
}

/** Mean of the last 5 valid samples in minutes, clamped to 1–15. Default 3 before any data. */
export function averageMinutes(
  samples: readonly number[],
  fallbackMinutes: number = DEFAULTS.minutesPerParty,
): number {
  const valid = samples.filter(isValidSample).slice(-SAMPLE_WINDOW);
  const avg = valid.length
    ? valid.reduce((a, b) => a + b, 0) / valid.length / 60_000
    : fallbackMinutes;
  return Math.min(AVG_MAX_MINUTES, Math.max(AVG_MIN_MINUTES, avg));
}

/** `wait = parties_ahead × avg`, rounded up to the nearest minute. */
export function estimateWaitMinutes(partiesAhead: number, avgMinutes: number): number {
  if (partiesAhead <= 0) return 0;
  return Math.ceil(partiesAhead * avgMinutes - 1e-9);
}

/** Display: `~X min`, `90+ min`, and "Any minute now" instead of 0 (DESIGN §1.7). */
export function formatWait(minutes: number): string {
  if (minutes <= 0) return 'Any minute now';
  if (minutes > 90) return '90+ min';
  return `~${minutes} min`;
}

/** The `{wait}` SMS placeholder (≤3 chars). */
export function waitForSms(minutes: number): string {
  return minutes > 90 ? '90+' : String(Math.max(0, minutes));
}
