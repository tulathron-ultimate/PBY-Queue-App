/** File adapters: reading picked files (vCard, CSV/XLSX) and saving downloads. */
export async function readTextFile(file: File): Promise<string> {
  // TextDecoder strips a UTF-8 BOM.
  return new TextDecoder('utf-8').decode(await file.arrayBuffer());
}

export async function readBinaryFile(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // iOS Safari asks before saving, and the blob URL must still work when the host taps.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Downloads a file from our own API with the session cookie, keeping the server's file name.
 * Fetch + blob works the same on iPhone Safari (iOS 13+, including the installed app) and
 * Android Chrome, and a failed request (signed out, event deleted) becomes an error, not a
 * saved error page.
 */
export async function downloadFromApi(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? "Couldn't download the file.");
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  downloadBlob(name ?? fallbackName, await res.blob());
}
