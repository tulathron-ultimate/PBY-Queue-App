import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addSample,
  averageMinutes,
  estimateWaitMinutes,
  formatWait,
  waitForSms,
} from '../src/estimate.js';
import {
  annotateDuplicates,
  hasErrors,
  matchHeaders,
  parseImportTable,
  TEMPLATE_EXAMPLE_ROWS,
  TEMPLATE_HEADERS,
} from '../src/importRows.js';
import { isValidPin } from '../src/limits.js';
import { formatPhone, maskPhone, maskPhonesInText, normalizePhone } from '../src/phone.js';
import { publicName } from '../src/privacy.js';
import {
  isGsm7,
  renderSms,
  STOP_FOOTER,
  TEMPLATES,
  smsEventName,
  toSmsSafe,
} from '../src/templates.js';
import { parseVCards } from '../src/vcard.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('phone normalization (§2.9)', () => {
  it.each([
    ['(555) 234-5678', '+15552345678'],
    ['555.234.5678', '+15552345678'],
    ['1-555-234-5678', '+15552345678'],
    ['+1 555 234 5678', '+15552345678'],
    [' 555 234 5678 ', '+15552345678'],
  ])('%s → %s', (input, e164) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164, international: false });
  });

  it('keeps international + numbers with 8–15 digits', () => {
    expect(normalizePhone('+44 20 7946 0958')).toEqual({
      ok: true,
      e164: '+442079460958',
      international: true,
    });
    expect(normalizePhone('+123456')).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([
    '555-12',
    '055-234-5678',
    '555-023-4567',
    '155-234-5678',
    '555-123-4567',
    '2-555-234-5678',
    'abc',
    '+0123456789', // no E.164 country code starts with 0
    '+00 44 20 7946 0958',
  ])('rejects %s', (input) => {
    expect(normalizePhone(input).ok).toBe(false);
  });

  it('flags empty input separately', () => {
    expect(normalizePhone('  ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('formats and masks', () => {
    expect(formatPhone('+15551234567')).toBe('(555) 123-4567');
    expect(maskPhone('+15551234567')).toBe('+1******4567');
    expect(maskPhonesInText('sent to +15551234567 and (555) 222-3333 ok')).toBe(
      'sent to +1******4567 and +1******3333 ok',
    );
  });
});

describe('wait estimate (§2.3)', () => {
  it('uses 3 min per party before any data', () => {
    expect(averageMinutes([])).toBe(3);
    expect(estimateWaitMinutes(4, averageMinutes([]))).toBe(12);
  });

  it('averages the last 5 valid samples and ignores misfires and breaks', () => {
    let s: number[] = [];
    for (const ms of [5_000, 60_000, 120_000, 30 * 60_000, 180_000, 60_000, 60_000, 60_000]) {
      s = addSample(s, ms);
    }
    expect(s).toEqual([120_000, 180_000, 60_000, 60_000, 60_000]);
    expect(averageMinutes(s)).toBeCloseTo(1.6);
    expect(estimateWaitMinutes(3, 1.6)).toBe(5);
  });

  it('clamps to 1–15 minutes and formats', () => {
    expect(averageMinutes([16_000])).toBe(1);
    expect(averageMinutes([], 40)).toBe(15);
    expect(formatWait(0)).toBe('Any minute now');
    expect(formatWait(12)).toBe('~12 min');
    expect(formatWait(91)).toBe('90+ min');
    expect(waitForSms(120)).toBe('90+');
  });
});

describe('templates (§2.4)', () => {
  const link = 'https://pby.example.com/s/AbCdEfGhIjKl';

  it('ships GSM-7 defaults that fit within their documented max lengths', () => {
    const max = { event: 'X'.repeat(20), name: 'Y'.repeat(12), pos: 999, wait: '90+', link };
    for (const key of Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]) {
      expect(isGsm7(renderSms(key, max))).toBe(true);
    }
    expect(renderSms('join', max).length).toBeLessThanOrEqual(125);
    expect(renderSms('join', max, { stopFooter: true }).length).toBeLessThanOrEqual(148);
    expect(renderSms('up_next', max).length).toBeLessThanOrEqual(140);
    expect(renderSms('your_turn', max).length).toBeLessThanOrEqual(82);
    expect(renderSms('skipped', max).length).toBeLessThanOrEqual(146);
  });

  it('renders placeholders with the first name and a transliterated event', () => {
    const text = renderSms('up_next', { event: 'Café Portraits', name: 'Émile Zola Family', link });
    expect(text).toBe(
      `Cafe Portraits: Emile, you're up next! Please head to the photo area now. Status: ${link}`,
    );
    expect(isGsm7(text)).toBe(true);
  });

  it('appends the STOP footer when asked', () => {
    const text = renderSms('your_turn', { event: 'Santa', name: 'Leo' }, { stopFooter: true });
    expect(text.endsWith(STOP_FOOTER)).toBe(true);
  });

  it('overflow drops the name first, then truncates the event, never the link', () => {
    const longLink = 'https://x.example/s/' + 'a'.repeat(60);
    const text = renderSms('skipped', {
      event: 'Pumpkin Patch Portraits',
      name: 'Alexandra',
      link: longLink,
    });
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).not.toContain('Alexandra');
    expect(text.endsWith(longLink)).toBe(true);
  });

  it('makes names SMS safe', () => {
    expect(toSmsSafe('Zoë “Z” O’Neil 📸 – ß')).toBe('Zoe "Z" O\'Neil - ss');
    expect(smsEventName('A very long event name that goes on', null)).toBe('A very long event na');
    expect(smsEventName('Long name', 'Short')).toBe('Short');
  });
});

describe('privacy (G2)', () => {
  it('shows first name plus last initial, or nothing when names are off', () => {
    expect(publicName('Emma Rivera', true)).toBe('Emma R.');
    expect(publicName('  Emma  van der berg ', true)).toBe('Emma B.');
    expect(publicName('Okafor', true)).toBe('Okafor');
    expect(publicName('Emma Rivera', false)).toBeNull();
  });
});

describe('PIN rules (§2.10)', () => {
  it('needs 6–12 digits or letters', () => {
    expect(isValidPin('123456')).toBe(true);
    expect(isValidPin('abc123XYZ')).toBe(true);
    expect(isValidPin('12345')).toBe(false);
    expect(isValidPin('1234567890123')).toBe(false);
    expect(isValidPin('12 3456')).toBe(false);
  });
});

describe('vCard parser (A3)', () => {
  it('parses an iPhone multi-contact export with folding, groups and photos', () => {
    const contacts = parseVCards(fixture('iphone-multi.vcf'));
    expect(contacts.map((c) => c.name)).toEqual([
      'Emma Rivera',
      'Linh Nguyen',
      'José García Family',
      'Hawks Soccer Club',
      'Chidi Okafor',
    ]);
    // prefers CELL over the first (pref) number
    expect(contacts[0].phone).toBe('+1 (555) 309-4417');
    expect(contacts[0].phones).toHaveLength(3);
    // item1.X-ABLabel:mobile marks the grouped TEL as cell
    expect(contacts[1].phone).toBe('555.882.0019');
    expect(contacts[2].phone).toBe('555 610 7788');
    // no CELL: first number
    expect(contacts[3].phone).toBe('5556107700');
    expect(contacts[4].phone).toBeNull();
  });

  it('handles vCard 4.0 tel: URIs and 2.1 quoted-printable names', () => {
    const contacts = parseVCards(fixture('mixed-versions.vcf'));
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({ name: 'Priya Shah', phone: '+1-555-444-2000' });
    expect(contacts[1]).toMatchObject({ name: 'Jürgen Müller', phone: '555-321-0987' });
  });

  it('returns nothing for non-vCard text', () => {
    expect(parseVCards('hello')).toEqual([]);
  });
});

describe('Excel/CSV import (§2.8)', () => {
  it('matches headers case-insensitively with aliases', () => {
    expect(
      matchHeaders(['FULL NAME', 'Mobile', 'size', 'Member Names', 'Team', 'Notes', 'X']),
    ).toEqual({ name: 0, phone: 1, size: 2, members: 3, group: 4, notes: 5 });
  });

  it('skips example and blank rows, validates the rest', () => {
    const table = [
      TEMPLATE_HEADERS,
      ...TEMPLATE_EXAMPLE_ROWS,
      ['Harris Family', '555-12', '3', '', '', ''],
      ['Chen', '', '', '', '', ''],
      ['', '555-111-2222', '', '', '', ''],
      ['Alvarez Family', '(555) 740-1122', '', 'Ana; Luis, Sofia', 'U10 Hawks', 'Front row'],
      ['Big Group', '5557401122', '25', '', '', ''],
    ];
    const parsed = parseImportTable(table);
    expect(parsed.skippedExamples).toBe(2);
    expect(parsed.rows.map((r) => r.name)).toEqual([
      'Harris Family',
      'Chen',
      'Alvarez Family',
      'Big Group',
    ]);
    const [harris, chen, alvarez, big] = parsed.rows;
    expect(harris.issues.map((i) => i.code)).toEqual(['invalid_phone']);
    expect(harris.phoneInvalidInput).toBe('555-12');
    expect(hasErrors(harris)).toBe(false);
    expect(chen.issues.map((i) => i.code)).toEqual(['no_phone']);
    expect(alvarez).toMatchObject({
      phone: '+15557401122',
      size: 3,
      members: ['Ana', 'Luis', 'Sofia'],
      group: 'U10 Hawks',
      notes: 'Front row',
      issues: [],
    });
    expect(hasErrors(big)).toBe(true);

    const dup = annotateDuplicates(parsed.rows, new Map([['+15557401122', 12]]));
    expect(dup[2].issues[0].message).toContain('#12');
    expect(annotateDuplicates(parsed.rows, new Map())[3].issues.map((i) => i.code)).toContain(
      'duplicate',
    );
  });

  it('keeps at most 40 characters of an invalid phone entry', () => {
    const [row] = parseImportTable([
      ['Name', 'Phone'],
      ['Garbage', 'x'.repeat(5000)],
    ]).rows;
    expect(row.phoneInvalidInput).toHaveLength(40);
    expect(row.issues[0].message.length).toBeLessThan(120);
  });

  it('reports a missing Name column', () => {
    expect(parseImportTable([['Phone'], ['555']]).missingNameColumn).toBe(true);
  });

  it('caps an import at 500 rows', () => {
    const rows = Array.from({ length: 510 }, (_, i) => [`P ${i}`]);
    const parsed = parseImportTable([['Name'], ...rows]);
    expect(parsed.rows).toHaveLength(500);
    expect(parsed.truncated).toBe(true);
  });
});
