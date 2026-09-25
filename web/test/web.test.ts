import { TEMPLATE_EXAMPLE_ROWS, TEMPLATE_HEADERS } from '@pby/shared';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import {
  parseSpreadsheetFile,
  parseVcfFile,
  parseVcfText,
  tableFromWorkbook,
} from '../src/import/spreadsheet';
import { parseImportTable } from '@pby/shared';
import { aheadText } from '../src/pages/guest/statusText';
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
