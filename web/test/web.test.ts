import {
  TEMPLATE_EXAMPLE_ROWS,
  TEMPLATE_HEADERS,
  type HostParty,
  type HostSnapshot,
  type PendingText,
} from '@pby/shared';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import {
  parseSpreadsheetFile,
  parseVcfFile,
  parseVcfText,
  tableFromWorkbook,
} from '../src/import/spreadsheet';
import { parseImportTable } from '@pby/shared';
import { aheadText, guestNote } from '../src/pages/guest/statusText';
import { callNextEmptyLabel } from '../src/pages/host/callNextLabel';
import { trayBody } from '../src/pages/host/trayText';
import { isIos, smsUri } from '../src/platform/sms';

describe('sms adapter (S2)', () => {
  it('uses & on iOS and ? on Android, one recipient per link', () => {
    const body = "Pumpkin: Emma, it's your turn! Please come to the camera now.";
    expect(smsUri('+15552018830', body, true)).toBe(
      `sms:+15552018830&body=${encodeURIComponent(body)}`,
    );
    expect(smsUri('+15552018830', body, false)).toMatch(/^sms:\+15552018830\?body=Pumpkin/);
  });

  it('detects iOS by user agent', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isIos('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 5)).toBe(false);
  });
});

describe('spreadsheet import (A2)', () => {
  it('round-trips the downloadable xlsx template and skips example rows', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      TEMPLATE_HEADERS,
      ...TEMPLATE_EXAMPLE_ROWS,
      ['Rivera Family', 5552018830, 3, 'Maria; Leo; Ana', 'U10 Hawks', ''],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Other');
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['Name'], ['Wrong sheet']]),
      'Queue2',
    );
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const parsed = parseImportTable(tableFromWorkbook(XLSX, buf, false));
    expect(parsed.skippedExamples).toBe(2);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      name: 'Rivera Family',
      phone: '+15552018830',
      size: 3,
      group: 'U10 Hawks',
    });
  });

  it('tolerates a UTF-8 BOM and alias headers in CSV', () => {
    const csv = '﻿party name,Cell,Count\nJosé García,555-610-7788,2\n';
    const parsed = parseImportTable(tableFromWorkbook(XLSX, csv, true));
    expect(parsed.rows[0]).toMatchObject({ name: 'José García', phone: '+15556107788', size: 2 });
  });

  it('turns vCards into size-1 parties', () => {
    const vcf =
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Emma Rivera\r\nTEL;type=CELL:555-201-8830\r\nEND:VCARD\r\n';
    const parsed = parseVcfText(vcf);
    expect(parsed.rows[0]).toMatchObject({ name: 'Emma Rivera', size: 1, phone: '+15552018830' });
  });

  it('reads only as many rows and columns as an import can use (hostile files)', () => {
    const csv = ['Name', ...Array.from({ length: 5000 }, (_, i) => `P ${i}`)].join('\n');
    const table = tableFromWorkbook(XLSX, csv, true);
    expect(table.length).toBeLessThanOrEqual(600);
    expect(parseImportTable(table).truncated).toBe(true);

    const ws = XLSX.utils.aoa_to_sheet([['Name'], ['Wide']]);
    ws['XFD2'] = { t: 's', v: 'far away' };
    ws['!ref'] = 'A1:XFD2';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Queue');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const wide = tableFromWorkbook(XLSX, buf, false);
    expect(Math.max(...wide.map((r) => r.length))).toBeLessThanOrEqual(50);
    expect(parseImportTable(wide).rows[0].name).toBe('Wide');
  });

  it('refuses oversized files before parsing them', async () => {
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'huge.xlsx');
    await expect(parseSpreadsheetFile(big)).rejects.toThrow(/too big/);
    const vcf = new File([new Uint8Array(31 * 1024 * 1024)], 'huge.vcf');
    await expect(parseVcfFile(vcf)).rejects.toThrow(/too big/);
  });
});

describe('guest status lines (G2)', () => {
  it('shows how many are ahead, never a wait time', () => {
    expect(aheadText(4)).toBe('3 ahead of you');
    expect(aheadText(2)).toBe('1 ahead of you');
    expect(aheadText(1)).toBe('Nobody ahead of you');
    expect(aheadText(0)).toBeNull();
    expect(aheadText(null)).toBeNull();
    for (const p of [1, 5, 90, 300]) expect(aheadText(p)).not.toMatch(/min|wait|~/i);
  });
});

describe('tap-to-send tray (QA #17)', () => {
  it('renders the text on the device from the snapshot', () => {
    const party = (id: string, ticket: number, state: HostParty['state'], name: string) =>
      ({
        id,
        ticket,
        state,
        sortKey: ticket,
        arrived: true,
        skipCount: 0,
        upNextSent: false,
        calledAt: null,
        doneAt: null,
        name,
        token: `tok${ticket}xxxxxxxx`,
      }) as HostParty;
    const snap = {
      event: { name: 'Pumpkin Patch Portraits', smsName: null, publicUrl: 'https://q.example.com' },
      parties: [
        party('a', 1, 'now_serving', 'Garcia Family'),
        party('b', 2, 'up_next', 'Nguyen Family'),
        party('c', 3, 'waiting', 'Émile Smith'),
      ],
    } as unknown as HostSnapshot;
    const text = (partyId: string, template: PendingText['template']) =>
      trayBody(snap, { id: 1, partyId, template, to: '+15552018830', createdAt: 0 });
    expect(text('c', 'join')).toBe(
      "Pumpkin Patch Portra: Emile, you're #2 in line. Track live: https://q.example.com/s/tok3xxxxxxxx",
    );
    expect(text('a', 'your_turn')).toBe(
      "Pumpkin Patch Portra: Garcia, it's your turn! Please come to the camera now.",
    );
    expect(text('gone', 'join')).toBe('');
  });
});

describe('QA nits', () => {
  it('drops the "2 away" promise once the guest is already Up next', () => {
    const me = (state: string, hasPhone = true) => ({ state, hasPhone });
    expect(guestNote(me('waiting'), 2)).toBe(
      "Stay nearby. We'll text you when you're 2 away and again when it's your turn.",
    );
    expect(guestNote(me('up_next'), 2)).toBe("Stay nearby. We'll text you when it's your turn.");
    expect(guestNote(me('up_next'), 2)).not.toMatch(/away/);
    expect(guestNote(me('waiting'), 0)).toMatch(/when you're almost up/);
    expect(guestNote(me('up_next', false), 2)).toBe('Keep this page open. It updates by itself.');
    expect(guestNote(me('done'), 2)).toBeNull();
    expect(guestNote(null, 2)).toBeNull();
  });

  it('says the line is paused on Call next while paused (E6)', () => {
    expect(callNextEmptyLabel(5, true, true)).toBe('Line paused');
    expect(callNextEmptyLabel(0, false, true)).toBe('Line paused');
    expect(callNextEmptyLabel(5, true, false)).toBeNull();
  });

  it('labels an uncallable Call next as §2.5 now specifies', () => {
    expect(callNextEmptyLabel(0, false)).toBe('Line is empty');
    expect(callNextEmptyLabel(3, false)).toBe('Nobody checked in');
    expect(callNextEmptyLabel(3, true)).toBeNull();
  });
});

describe('service worker (E8)', () => {
  it('never caches API responses such as the results CSV', () => {
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(config).not.toMatch(/runtimeCaching\s*:/);
    expect(config).toContain('navigateFallbackDenylist: [/^\\/api\\//');
  });
});
