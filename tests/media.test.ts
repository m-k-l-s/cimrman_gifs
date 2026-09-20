import { afterEach, describe, expect, test } from 'bun:test';
import type { Gif } from '../src/catalog';
import { canShareFile, fetchMedia, MAX_FILE_BYTES } from '../src/media';

const originalFetch = globalThis.fetch;
const shareDescriptors = ['share', 'canShare'].map(name =>
  [name, Object.getOwnPropertyDescriptor(navigator, name)] as const
);
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of shareDescriptors) {
    if (descriptor) Object.defineProperty(navigator, name, descriptor);
    else Reflect.deleteProperty(navigator, name);
  }
});

describe('file sharing capabilities', () => {
  const file = new File(['GIF89a'], 'reaction.gif', { type: 'image/gif' });

  function capabilities(canShare?: (data: ShareData) => boolean): void {
    Object.defineProperties(navigator, {
      share: { configurable: true, value: async () => {} },
      canShare: { configurable: true, value: canShare },
    });
  }

  test('checks the prepared file without adding URL or text', () => {
    let received: ShareData | undefined;
    capabilities(data => {
      received = data;
      return true;
    });
    expect(canShareFile(file)).toBe(true);
    expect(received).toEqual({ files: [file] });
  });

  test('link sharing alone does not qualify as file sharing', () => {
    capabilities(data => !!data.url && !data.files);
    expect(canShareFile(file)).toBe(false);
  });

  test('missing or rejecting capability checks fall back to download', () => {
    capabilities();
    expect(canShareFile(file)).toBe(false);
    capabilities(() => {
      throw new DOMException('Blocked', 'NotAllowedError');
    });
    expect(canShareFile(file)).toBe(false);
    capabilities(() => true);
    Reflect.deleteProperty(navigator, 'share');
    expect(canShareFile(file)).toBe(false);
  });
});
const gif: Gif = {
  id: 'abc',
  url: 'https://giphy.com/gifs/abc',
  keywords: [],
  title: '',
  categoryIds: [],
  webp: 'https://media.giphy.com/media/abc/200w.webp',
  gif: 'https://media.giphy.com/media/abc/giphy.gif',
  mp4: 'https://media.giphy.com/media/abc/giphy.mp4',
};
function respond(body: BodyInit, type: string, status = 200): void {
  globalThis.fetch = Object.assign(
    async () => new Response(body, { status, headers: { 'content-type': type } }),
    { preconnect: originalFetch.preconnect },
  );
}

describe('actual media files', () => {
  test('creates a named MP4 attachment from original bytes', async () => {
    const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);
    respond(bytes, 'video/mp4');
    const file = await fetchMedia(gif, 'mp4');
    expect(file.name).toBe('ct-abc.mp4');
    expect(file.type).toBe('video/mp4');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });
  test('retains GIF bytes; never converts to a still PNG', async () => {
    respond('GIF89a-test', 'image/gif');
    const file = await fetchMedia(gif, 'gif');
    expect(file.type).toBe('image/gif');
    expect(await file.text()).toBe('GIF89a-test');
  });
  test('rejects HTTP, MIME and file-signature failures', async () => {
    for (
      const [body, mime, status] of [['failure', 'video/mp4', 503], ['<html>', 'text/html', 200], [
        'not an MP4',
        'video/mp4',
        200,
      ]] as const
    ) {
      respond(body, mime, status);
      await expect(fetchMedia(gif, 'mp4')).rejects.toThrow();
    }
  });
  test('bounds downloaded bytes with an explicit size error', async () => {
    respond(new Uint8Array(MAX_FILE_BYTES + 1), 'video/mp4');
    await expect(fetchMedia(gif, 'mp4')).rejects.toThrow('25 MiB');
  });
});
