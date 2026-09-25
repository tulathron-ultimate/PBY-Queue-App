/**
 * Import parsing and validation (A2 Excel/CSV, A3 vCard, A4 Contact Picker) per FEATURES §2.8.
 * Files are read client-side (SheetJS / vCard parser) into a 2D table; this module maps headers,
 * validates rows and produces the preview model. The server re-validates on submit.
 */
import { LIMITS } from './limits.js';
import { normalizePhone } from './phone.js';
import { cleanText } from './text.js';

export type ImportField = 'name' | 'phone' | 'size' | 'members' | 'group' | 'notes';

export const IMPORT_COLUMNS: readonly { field: ImportField; header: string; aliases: string[] }[] =
  [
    { field: 'name', header: 'Name', aliases: ['name', 'party name', 'full name'] },
    { field: 'phone', header: 'Phone', aliases: ['phone', 'mobile', 'cell', 'phone number'] },
    { field: 'size', header: 'Party Size', aliases: ['party size', 'size', 'count'] },
    { field: 'members', header: 'Members', aliases: ['members', 'member names'] },
    { field: 'group', header: 'Group', aliases: ['group', 'team', 'class'] },
    { field: 'notes', header: 'Notes', aliases: ['notes'] },
  ];

export const TEMPLATE_SHEET_NAME = 'Queue';
export const TEMPLATE_HEADERS = IMPORT_COLUMNS.map((c) => c.header);
/** Two example rows; the importer ignores rows whose Name starts with "Example". */
export const TEMPLATE_EXAMPLE_ROWS: (string | number)[][] = [
  [
    'Example Rivera Family',
    '(555) 201-8830',
    4,
    'Maria; Leo; Ana; Sam',
    'U10 Hawks',
    'Needs a chair',
  ],
  ['Example Emma Chen', '555-309-4417', '', '', 'Class 3B', ''],
];

export interface ImportDraft {
  name: string;
  phone: string;
  size: string;
  members: string;
  group: string;
  notes: string;
}

export type ImportIssueCode =
  | 'name_missing'
  | 'name_too_long'
  | 'invalid_phone'
  | 'no_phone'
  | 'bad_size'
  | 'too_many_members'
  | 'member_too_long'
  | 'notes_too_long'
  | 'duplicate';

export interface ImportIssue {
  /** Errors must be fixed or the row excluded. Warnings are allowed. */
  level: 'error' | 'warning';
  code: ImportIssueCode;
  message: string;
}

/** A validated row, ready to send to the server as `ImportPartyInput`. */
export interface ImportPartyInput {
  name: string;
  phone: string | null;
  phoneInvalidInput: string | null;
  size: number;
  members: string[];
  group: string | null;
  notes: string | null;
}

export interface ImportRow extends ImportPartyInput {
  rowNumber: number;
  draft: ImportDraft;
  issues: ImportIssue[];
}

export interface ParsedImport {
  rows: ImportRow[];
  missingNameColumn: boolean;
  truncated: boolean;
  skippedExamples: number;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Maps header cells to fields. Headers are case-insensitive; extra columns are ignored. */
export function matchHeaders(headers: readonly unknown[]): Partial<Record<ImportField, number>> {
  const map: Partial<Record<ImportField, number>> = {};
  headers.forEach((h, i) => {
    const key = cell(h).toLowerCase().replace(/\s+/g, ' ');
    const col = IMPORT_COLUMNS.find((c) => c.aliases.includes(key));
    if (col && map[col.field] === undefined) map[col.field] = i;
  });
  return map;
}

export function splitMembers(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Longest invalid phone entry kept for the host to fix. */
export const PHONE_INPUT_MAX = 40;

export function validateDraft(input: ImportDraft, rowNumber: number): ImportRow {
  // SEC-8: no bidi overrides, invisible or control characters in anything shown on a screen.
  const draft: ImportDraft = {
    name: cleanText(input.name),
    phone: cleanText(input.phone),
    size: input.size,
    members: cleanText(input.members),
    group: cleanText(input.group),
    notes: cleanText(input.notes, { multiline: true }),
  };
  const issues: ImportIssue[] = [];
  const name = draft.name.trim().replace(/\s+/g, ' ');
  if (!name) issues.push({ level: 'error', code: 'name_missing', message: 'Name is missing.' });
  if (name.length > LIMITS.partyNameMax) {
    issues.push({
      level: 'error',
      code: 'name_too_long',
      message: `Name is longer than ${LIMITS.partyNameMax} characters.`,
    });
  }

  let phone: string | null = null;
  let phoneInvalidInput: string | null = null;
  const phoneResult = normalizePhone(draft.phone);
  if (phoneResult.ok) phone = phoneResult.e164;
  else if (phoneResult.reason === 'empty') {
    issues.push({ level: 'warning', code: 'no_phone', message: "No phone. Can't be texted." });
  } else {
    // Kept so the host can fix it, but bounded: a hostile file could put megabytes here.
    phoneInvalidInput = draft.phone.trim().slice(0, PHONE_INPUT_MAX);
    issues.push({
      level: 'warning',
      code: 'invalid_phone',
      message: `Phone "${phoneInvalidInput}" isn't a valid number. Fix it, or they get no texts.`,
    });
  }

  const members = splitMembers(draft.members);
  if (members.length > LIMITS.membersMax) {
    issues.push({
      level: 'error',
      code: 'too_many_members',
      message: `More than ${LIMITS.membersMax} member names.`,
    });
  }
  if (members.some((m) => m.length > LIMITS.memberNameMax)) {
    issues.push({
      level: 'error',
      code: 'member_too_long',
      message: `A member name is longer than ${LIMITS.memberNameMax} characters.`,
    });
  }

  let size = members.length || 1;
  const sizeText = draft.size.trim();
  if (sizeText) {
    const n = Number(sizeText);
    if (Number.isInteger(n) && n >= LIMITS.partySizeMin && n <= LIMITS.partySizeMax) size = n;
    else {
      issues.push({
        level: 'error',
        code: 'bad_size',
        message: `Party size "${sizeText}" must be a whole number from 1 to ${LIMITS.partySizeMax}.`,
      });
    }
  }
  size = Math.min(LIMITS.partySizeMax, Math.max(LIMITS.partySizeMin, size));

  const notes = draft.notes.trim();
  if (notes.length > LIMITS.notesMax) {
    issues.push({
      level: 'error',
      code: 'notes_too_long',
      message: `Notes are longer than ${LIMITS.notesMax} characters.`,
    });
  }
  const group = draft.group.trim().slice(0, LIMITS.groupMax);

  return {
    rowNumber,
    draft,
    name,
    phone,
    phoneInvalidInput,
    size,
    members,
    group: group || null,
    notes: notes || null,
    issues,
  };
}

/**
 * Parses a sheet (first row = headers). Rows with no Name, and rows whose Name starts with
 * "Example", are skipped. At most 500 rows are kept.
 */
export function parseImportTable(table: readonly (readonly unknown[])[]): ParsedImport {
  const headerIndex = table.findIndex((r) => r.some((c) => cell(c)));
  const headers = headerIndex >= 0 ? table[headerIndex] : [];
  const map = matchHeaders(headers);
  if (map.name === undefined) {
    return { rows: [], missingNameColumn: true, truncated: false, skippedExamples: 0 };
  }
  const get = (row: readonly unknown[], field: ImportField) => {
    const i = map[field];
    return i === undefined ? '' : cell(row[i]);
  };
  const rows: ImportRow[] = [];
  let skippedExamples = 0;
  let truncated = false;
  for (let r = headerIndex + 1; r < table.length; r++) {
    const row = table[r];
    const name = get(row, 'name');
    if (!name) continue;
    if (/^example/i.test(name)) {
      skippedExamples++;
      continue;
    }
    if (rows.length >= LIMITS.importRowsMax) {
      truncated = true;
      break;
    }
    rows.push(
      validateDraft(
        {
          name,
          phone: get(row, 'phone'),
          size: get(row, 'size'),
          members: get(row, 'members'),
          group: get(row, 'group'),
          notes: get(row, 'notes'),
        },
        r + 1,
      ),
    );
  }
  return { rows, missingNameColumn: false, truncated, skippedExamples };
}

/**
 * A6 duplicate detection: warns when a phone already has an active party in the event, or
 * appears earlier in the same file. Duplicates are allowed (siblings share a parent's phone).
 */
export function annotateDuplicates(
  rows: readonly ImportRow[],
  existingActive: ReadonlyMap<string, number>,
): ImportRow[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const issues = row.issues.filter((i) => i.code !== 'duplicate');
    if (row.phone) {
      const ticket = existingActive.get(row.phone);
      const earlier = seen.get(row.phone);
      if (ticket !== undefined) {
        issues.push({
          level: 'warning',
          code: 'duplicate',
          message: `Same phone as #${ticket} already in line.`,
        });
      } else if (earlier !== undefined) {
        issues.push({
          level: 'warning',
          code: 'duplicate',
          message: `Same phone as row ${earlier}.`,
        });
      }
      if (!seen.has(row.phone)) seen.set(row.phone, row.rowNumber);
    }
    return { ...row, issues };
  });
}

export function hasErrors(row: Pick<ImportRow, 'issues'>): boolean {
  return row.issues.some((i) => i.level === 'error');
}

export function toPartyInput(row: ImportRow): ImportPartyInput {
  const { name, phone, phoneInvalidInput, size, members, group, notes } = row;
  return { name, phone, phoneInvalidInput, size, members, group, notes };
}
