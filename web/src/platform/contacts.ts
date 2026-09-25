/** Contact Picker adapter (A4). Android Chrome only; the UI hides the button otherwise. */
interface ContactInfo {
  name?: string[];
  tel?: string[];
}
interface ContactsManager {
  select(props: string[], opts: { multiple: boolean }): Promise<ContactInfo[]>;
}

function manager(): ContactsManager | null {
  const nav = navigator as Navigator & { contacts?: ContactsManager };
  return typeof nav.contacts?.select === 'function' ? nav.contacts : null;
}

export function contactPickerSupported(): boolean {
  return manager() !== null;
}

export async function pickContacts(): Promise<{ name: string; phone: string }[]> {
  const m = manager();
  if (!m) return [];
  const picked = await m.select(['name', 'tel'], { multiple: true });
  return picked.map((c) => ({ name: c.name?.[0]?.trim() ?? '', phone: c.tel?.[0] ?? '' }));
}
