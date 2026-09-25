/**
 * Minimal vCard parser (A3) for the iPhone "share contacts" path.
 * Handles vCard 2.1/3.0/4.0, folded lines, grouped properties (item1.TEL + X-ABLabel),
 * quoted-printable values and multiple TELs (prefer CELL, then the first one).
 */
export interface VCardPhone {
  value: string;
  types: string[];
}

export interface VCardContact {
  name: string;
  phones: VCardPhone[];
  /** The preferred number (raw, not normalized), or null. */
  phone: string | null;
}

interface Prop {
  group: string | null;
  name: string;
  params: Map<string, string[]>;
  value: string;
}

/** Splits on `sep` outside double quotes. */
function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function unfold(text: string): string[] {
  const raw = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const lines: string[] = [];
  for (const line of raw) {
    const prev = lines.length ? lines[lines.length - 1] : null;
    if (prev !== null && (line.startsWith(' ') || line.startsWith('\t'))) {
      lines[lines.length - 1] = prev + line.slice(1);
    } else if (
      prev !== null &&
      /QUOTED-PRINTABLE/i.test(prev.split(':')[0]) &&
      prev.endsWith('=')
    ) {
      // vCard 2.1 quoted-printable soft line break
      lines[lines.length - 1] = prev.slice(0, -1) + line;
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function decodeQuotedPrintable(value: string): string {
  // Turn =XX into %XX and let decodeURIComponent do the UTF-8 decoding.
  let uri = '';
  for (let i = 0; i < value.length; i++) {
    const hex = value.slice(i + 1, i + 3);
    if (value[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      uri += `%${hex}`;
      i += 2;
    } else {
      uri += encodeURIComponent(value[i]);
    }
  }
  try {
    return decodeURIComponent(uri);
  } catch {
    return value;
  }
}

function unescapeValue(value: string): string {
  return value.replace(/\\([nN,;:\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseLine(line: string): Prop | null {
  const parts = splitOutsideQuotes(line, ':');
  if (parts.length < 2) return null;
  const left = parts[0];
  const value = parts.slice(1).join(':');
  const [nameWithGroup, ...paramParts] = splitOutsideQuotes(left, ';');
  const dot = nameWithGroup.lastIndexOf('.');
  const group = dot >= 0 ? nameWithGroup.slice(0, dot).toLowerCase() : null;
  const name = (dot >= 0 ? nameWithGroup.slice(dot + 1) : nameWithGroup).trim().toUpperCase();
  const params = new Map<string, string[]>();
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    // vCard 2.1 allows bare types such as `TEL;CELL:`
    const key = (eq >= 0 ? p.slice(0, eq) : 'TYPE').trim().toUpperCase();
    const raw = eq >= 0 ? p.slice(eq + 1) : p;
    const values = raw
      .replace(/"/g, '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    params.set(key, [...(params.get(key) ?? []), ...values]);
  }
  let decoded = value;
  if ((params.get('ENCODING') ?? []).includes('quoted-printable')) {
    decoded = decodeQuotedPrintable(value);
  }
  return { group, name, params, value: decoded };
}

function isMobile(types: readonly string[]): boolean {
  return types.some((t) => t === 'cell' || t === 'mobile' || t === 'iphone');
}

function buildContact(props: Prop[]): VCardContact {
  const labels = new Map<string, string>();
  for (const p of props) {
    if (p.name === 'X-ABLABEL' && p.group) labels.set(p.group, p.value.toLowerCase());
  }
  const get = (name: string) => props.find((p) => p.name === name);
  let name = unescapeValue(get('FN')?.value ?? '').trim();
  if (!name) {
    const n = get('N');
    if (n) {
      const [family = '', given = '', additional = '', prefix = '', suffix = ''] =
        splitOutsideQuotes(n.value, ';').map((s) => unescapeValue(s).trim());
      name = [prefix, given, additional, family, suffix].filter(Boolean).join(' ');
    }
  }
  if (!name) name = unescapeValue(get('ORG')?.value.split(';')[0] ?? '').trim();

  const phones: VCardPhone[] = props
    .filter((p) => p.name === 'TEL')
    .map((p) => {
      const types = [...(p.params.get('TYPE') ?? [])];
      if (p.params.has('PREF')) types.push('pref');
      const label = p.group ? labels.get(p.group) : undefined;
      if (label && /mobile|cell|iphone/.test(label)) types.push('cell');
      const value = unescapeValue(p.value).replace(/^tel:/i, '').trim();
      return { value, types };
    })
    .filter((p) => p.value);
  const preferred = phones.find((p) => isMobile(p.types)) ?? phones[0];
  return { name, phones, phone: preferred?.value ?? null };
}

export function parseVCards(text: string): VCardContact[] {
  const contacts: VCardContact[] = [];
  let current: Prop[] | null = null;
  for (const line of unfold(text)) {
    if (!line.trim()) continue;
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') {
      current = [];
      continue;
    }
    if (upper === 'END:VCARD') {
      if (current) {
        const contact = buildContact(current);
        if (contact.name || contact.phone) contacts.push(contact);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const prop = parseLine(line);
    if (prop) current.push(prop);
  }
  return contacts;
}
