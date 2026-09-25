import type { ParsedImport } from '@pby/shared';
import type { ChangeEvent } from 'react';
import { Sheet } from '../../components/ui';
import { Icon } from '../../icons';
import {
  downloadTemplate,
  parsedFromContacts,
  parseSpreadsheetFile,
  parseVcfText,
} from '../../import/spreadsheet';
import { contactPickerSupported, pickContacts } from '../../platform/contacts';
import { readTextFile } from '../../platform/files';
import { navigate } from '../../router';
import type { HostContext } from './HostEvent';

export interface ImportPayload {
  rows: ParsedImport['rows'];
  source: 'import' | 'vcard' | 'contacts';
  fileName: string;
  missingName?: boolean;
  truncated?: boolean;
}

/** H6: the ways to add people. Capabilities that are missing are hidden, not disabled. */
export function AddPeopleSheet({
  ctx,
  onClose,
  onManual,
  onImport,
}: {
  ctx: HostContext;
  onClose: () => void;
  onManual: () => void;
  onImport: (p: ImportPayload) => void;
}) {
  const fail = (err: unknown) =>
    ctx.toast({
      text: `We couldn't read this file. ${(err as Error)?.message ?? ''}`.trim(),
      danger: true,
    });

  const onVcf = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = parseVcfText(await readTextFile(file));
      if (!parsed.rows.length) throw new Error('No contacts found in it.');
      onImport({
        rows: parsed.rows,
        source: 'vcard',
        fileName: file.name,
        truncated: parsed.truncated,
      });
    } catch (err) {
      fail(err);
    }
  };

  const onSheet = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = await parseSpreadsheetFile(file);
      onImport({
        rows: parsed.rows,
        source: 'import',
        fileName: file.name,
        missingName: parsed.missingNameColumn,
        truncated: parsed.truncated,
      });
    } catch (err) {
      fail(err);
    }
  };

  const onContacts = async () => {
    try {
      const picked = await pickContacts();
      if (!picked.length) return;
      const parsed = parsedFromContacts(picked);
      onImport({ rows: parsed.rows, source: 'contacts', fileName: 'Your contacts' });
    } catch (err) {
      fail(err);
    }
  };

  return (
    <Sheet label="Add people" onClose={onClose}>
      <h2 style={{ marginBottom: 12 }}>Add people</h2>
      <button type="button" className="menurow" onClick={onManual}>
        <span className="ic">
          <Icon name="edit" />
        </span>
        <span>
          <span className="t" style={{ display: 'block' }}>
            Type it in
          </span>
          <span className="d">Add one party by hand.</span>
        </span>
      </button>
      {contactPickerSupported() && (
        <button type="button" className="menurow" onClick={() => void onContacts()}>
          <span className="ic">
            <Icon name="contact" />
          </span>
          <span>
            <span className="t" style={{ display: 'block' }}>
              From your contacts
            </span>
            <span className="d">Pick people from your phone.</span>
          </span>
        </button>
      )}
      <label className="menurow">
        <span className="ic">
          <Icon name="users" />
        </span>
        <span>
          <span className="t" style={{ display: 'block' }}>
            Contact file (.vcf)
          </span>
          <span className="d">iPhone: Contacts → select → Share → Save to Files.</span>
        </span>
        <input
          type="file"
          accept=".vcf,text/vcard,text/x-vcard"
          aria-label="Contact file (.vcf)"
          onChange={(e) => void onVcf(e)}
        />
      </label>
      <div className="menurow" style={{ flexWrap: 'wrap' }}>
        <span className="ic">
          <Icon name="file" />
        </span>
        <label style={{ flex: 1, position: 'relative', minHeight: 48, cursor: 'pointer' }}>
          <span className="t" style={{ display: 'block' }}>
            Spreadsheet (Excel or CSV)
          </span>
          <span className="d">Columns: Name, Phone, Party Size, Members.</span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv,text/csv"
            aria-label="Spreadsheet (Excel or CSV)"
            data-testid="spreadsheet-input"
            onChange={(e) => void onSheet(e)}
          />
        </label>
        <span className="d" style={{ width: '100%', paddingLeft: 58 }}>
          <button type="button" className="linkbtn" onClick={() => void downloadTemplate('xlsx')}>
            Download template
          </button>{' '}
          ·{' '}
          <button type="button" className="linkbtn" onClick={() => void downloadTemplate('csv')}>
            CSV
          </button>
        </span>
      </div>
      <button type="button" className="menurow" onClick={() => navigate(`/host/e/${ctx.id}/share`)}>
        <span className="ic">
          <Icon name="qr" />
        </span>
        <span>
          <span className="t" style={{ display: 'block' }}>
            Let guests join themselves
          </span>
          <span className="d">Show a QR code or share a link.</span>
        </span>
      </button>
    </Sheet>
  );
}
