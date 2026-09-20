import { describe, expect, test } from 'bun:test';
import { isSticker } from '../src/catalog';

describe('sticker classification', () => {
  test('uses the canonical sticker pathname', () => {
    expect(isSticker({ url: 'https://giphy.com/stickers/ceska-televize-abc123' })).toBe(true);
    expect(isSticker({ url: 'https://giphy.com/stickers/abc123?source=share#preview' })).toBe(true);
  });

  test('does not infer stickers from GIF slugs or query strings', () => {
    expect(isSticker({ url: 'https://giphy.com/gifs/transparent-sticker-abc123' })).toBe(false);
    expect(isSticker({ url: 'https://giphy.com/gifs/abc123?next=/stickers/abc123' })).toBe(false);
  });

  test('requires the complete stickers path segment', () => {
    for (const path of ['/stickers', '/stickers-extra/abc123', '/gifs/stickers/abc123']) {
      expect(isSticker({ url: `https://giphy.com${path}` })).toBe(false);
    }
  });
});
