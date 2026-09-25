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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
