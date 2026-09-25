/**
 * Phone normalization (FEATURES §2.9). US-first, E.164 output.
 *
 * Implemented by hand rather than with libphonenumber-js because the spec's rules are
 * short and exact, and this keeps the shared bundle tiny. See docs/IMPLEMENTATION_NOTES.md.
 */
export type PhoneResult =
  { ok: true; e164: string; international: boolean } | { ok: false; reason: 'empty' | 'invalid' };

function validNanp(tenDigits: string): boolean {
  if (tenDigits.length !== 10) return false;
  const area = tenDigits[0];
  const exchange = tenDigits[3];
  return !'01'.includes(area) && !'01'.includes(exchange);
}

export function normalizePhone(input: string | null | undefined): PhoneResult {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return { ok: false, reason: 'invalid' };

  if (hasPlus) {
    if (digits.startsWith('1')) {
      // +1 is the North American Numbering Plan, so apply the US rules.
      const national = digits.slice(1);
      return validNanp(national)
        ? { ok: true, e164: `+1${national}`, international: false }
        : { ok: false, reason: 'invalid' };
    }
    // E.164 country codes never start with 0 (`+0…`, `+00…` are typos or dial prefixes).
    if (digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')) {
      return { ok: true, e164: `+${digits}`, international: true };
    }
    return { ok: false, reason: 'invalid' };
  }

  let national: string | null = null;
  if (digits.length === 10) national = digits;
  else if (digits.length === 11 && digits.startsWith('1')) national = digits.slice(1);
  if (national && validNanp(national)) {
    return { ok: true, e164: `+1${national}`, international: false };
  }
  return { ok: false, reason: 'invalid' };
}

/** `+15551234567` → `(555) 123-4567`. International numbers are returned as-is. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function phoneLast4(e164: string | null | undefined): string {
  if (!e164) return '';
  return e164.replace(/\D/g, '').slice(-4);
}

/** Log hygiene (P3): `+15551234567` → `+1******4567`. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 5) return '*'.repeat(digits.length);
  const isNanp = digits.length === 11 && digits.startsWith('1');
  const prefix = isNanp ? '+1' : '+';
  const middle = digits.length - (isNanp ? 1 : 0) - 4;
  return `${prefix}${'*'.repeat(middle)}${digits.slice(-4)}`;
}

/** Masks every phone-looking run (7+ digits, optional separators) in free text. */
export function maskPhonesInText(text: string): string {
  return text.replace(/\+?\(?\d[\d\s().-]{6,}\d/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 7) return match;
    return maskPhone(`+${digits.length === 10 ? `1${digits}` : digits}`);
  });
}
