/** Excel/CSV via SheetJS (loaded on demand so the host dashboard stays light). */
import {
  LIMITS,
  parseImportTable,
  parseVCards,
  TEMPLATE_EXAMPLE_ROWS,
  TEMPLATE_HEADERS,
  TEMPLATE_SHEET_NAME,
  validateDraft,
  type ParsedImport,
} from '@pby/shared';
import { downloadBlob, readTextFile } from '../platform/files';

type XLSXModule = typeof import('xlsx');

/**
 * Hostile-file limits. A 500-row roster is tens of KB; an iPhone contacts export with photos
 * is roughly 100 KB per contact. Parsing happens on the host's phone, so an oversized or
 * zip-bombed file would freeze the dashboard mid-event.
 */
export const MAX_SPREADSHEET_BYTES = 5 * 1024 * 1024;
export const MAX_VCF_BYTES = 25 * 1024 * 1024;
/** Header + 500 rows + the template's example rows + slack for blank rows. */
const MAX_SHEET_ROWS = LIMITS.importRowsMax + 20;
const MAX_SHEET_COLS = 50;

function checkSize(file: File, max: number): void {
  if (file.size > max) {
    throw new Error(`The file is too big (limit ${Math.round(max / 1024 / 1024)} MB).`);
  }
}

/** Reads the `Queue` sheet (or the first sheet) into a 2D table of strings. */
export function tableFromWorkbook(
  XLSX: XLSXModule,
  data: ArrayBuffer | string,
  isCsv: boolean,
): unknown[][] {
  const wb =
    typeof data === 'string'
      ? XLSX.read(data.replace(/^\uFEFF/, ''), {
          type: 'string',
          raw: false,
          sheetRows: MAX_SHEET_ROWS,
        })
      : XLSX.read(new Uint8Array(data), { type: 'array', raw: isCsv, sheetRows: MAX_SHEET_ROWS });
  const name =
    wb.SheetNames.find((n) => n.toLowerCase() === TEMPLATE_SHEET_NAME.toLowerCase()) ??
    wb.SheetNames[0];
  const sheet = wb.Sheets[name];
  if (!sheet?.['!ref']) return [];
  // A sheet can claim a range up to column XFD; the import only needs the first few columns.
  const range = XLSX.utils.decode_range(sheet['!ref']);
  range.e.c = Math.min(range.e.c, range.s.c + MAX_SHEET_COLS - 1);
  range.e.r = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS - 1);
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
    range,
  });
}

export async function parseSpreadsheetFile(file: File): Promise<ParsedImport> {
  checkSize(file, MAX_SPREADSHEET_BYTES);
  const XLSX = await import('xlsx');
  const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
  const data = isCsv
    ? new TextDecoder('utf-8').decode(await file.arrayBuffer())
    : await file.arrayBuffer();
  return parseImportTable(tableFromWorkbook(XLSX, data, isCsv));
}

/** vCard and Contact Picker results become size-1 parties, editable in the preview. */
export function parsedFromContacts(
  contacts: { name: string; phone: string | null }[],
): ParsedImport {
  const rows = contacts
    .filter((c) => c.name.trim() || c.phone)
    .slice(0, 500)
    .map((c, i) =>
      validateDraft(
        {
          name: c.name.trim() || 'Unnamed',
          phone: c.phone ?? '',
          size: '1',
          members: '',
          group: '',
          notes: '',
        },
        i + 1,
      ),
    );
  return { rows, missingNameColumn: false, truncated: contacts.length > 500, skippedExamples: 0 };
}

export function parseVcfText(text: string): ParsedImport {
  return parsedFromContacts(parseVCards(text));
}

export async function parseVcfFile(file: File): Promise<ParsedImport> {
  checkSize(file, MAX_VCF_BYTES);
  return parseVcfText(await readTextFile(file));
}

export async function downloadTemplate(kind: 'xlsx' | 'csv'): Promise<void> {
  if (kind === 'csv') {
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [TEMPLATE_HEADERS, ...TEMPLATE_EXAMPLE_ROWS]
      .map((r) => r.map(esc).join(','))
      .join('\r\n');
    downloadBlob(
      'pby-queue-template.csv',
      new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }),
    );
    return;
  }
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...TEMPLATE_EXAMPLE_ROWS]);
  ws['!cols'] = [{ wch: 26 }, { wch: 16 }, { wch: 11 }, { wch: 26 }, { wch: 14 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, ws, TEMPLATE_SHEET_NAME);
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  downloadBlob(
    'pby-queue-template.xlsx',
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
}
