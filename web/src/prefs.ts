/** Per-device display preferences (localStorage, wrapped so private mode still works). */
export type Theme = 'light' | 'dark' | 'auto';
export type TextSize = 1 | 1.15 | 1.3;

export interface Prefs {
  theme: Theme;
  maxContrast: boolean;
  textSize: TextSize;
  keepAwake: boolean;
  askToText: boolean;
}

const DEFAULT_PREFS: Prefs = {
  theme: 'light',
  maxContrast: false,
  textSize: 1,
  keepAwake: true,
  askToText: true,
};

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('pby.prefs') ?? '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem('pby.prefs', JSON.stringify(p));
  } catch {
    // storage unavailable
  }
}

/** Host pages use the saved theme (default Light); guest pages follow the phone (Auto). */
export function applyTheme(p: Prefs | null): void {
  const root = document.documentElement;
  const theme = p ? p.theme : 'auto';
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  if (p?.maxContrast) root.setAttribute('data-contrast', 'max');
  else root.removeAttribute('data-contrast');
  root.style.setProperty('--text-scale', String(p?.textSize ?? 1));
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}
