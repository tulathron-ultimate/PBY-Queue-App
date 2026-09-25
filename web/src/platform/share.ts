/** Clipboard and Web Share adapters. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function canShare(): boolean {
  return typeof navigator.share === 'function';
}

export async function shareLink(title: string, url: string): Promise<void> {
  try {
    await navigator.share({ title, url });
  } catch {
    // dismissed
  }
}
