import type { Gif } from './catalog';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export type MediaFormat = 'mp4' | 'gif';

export async function fetchMedia(
  gif: Gif,
  format: MediaFormat,
  signal?: AbortSignal,
): Promise<File> {
  const abort = AbortSignal.timeout(20_000);
  const response = await fetch(gif[format], {
    signal: signal ? AbortSignal.any([signal, abort]) : abort,
  });
  const mime = format === 'mp4' ? 'video/mp4' : 'image/gif';
  if (
    !response.ok || response.headers.get('content-type')?.split(';')[0] !== mime || !response.body
  ) {
    throw new Error('Soubor se nepodařilo načíst z Giphy. Zkuste to znovu nebo otevřete originál.');
  }
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new Error('Soubor přesahuje limit 25 MiB. Otevřete originál na Giphy.');
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  const file = new File(chunks, `ct-${gif.id}.${format}`, { type: mime });
  const header = new TextDecoder().decode(await file.slice(0, 12).arrayBuffer());
  if (format === 'mp4' ? header.slice(4, 8) !== 'ftyp' : !/^GIF8[79]a/.test(header)) {
    throw new Error('Giphy vrátilo neplatný soubor. Zkuste otevřít originál.');
  }
  return file;
}

export function canShareFile(file: File): boolean {
  try {
    return !!navigator.share && !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

export async function shareMediaFile(file: File): Promise<boolean> {
  try {
    await navigator.share({ files: [file] });
    return true;
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return false;
    throw cause;
  }
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  // Keep the object alive while browsers hand the download to the OS.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
