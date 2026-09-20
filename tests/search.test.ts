import { describe, expect, test } from 'bun:test';
import { parseCatalog } from '../src/catalog';
import { readSearchState, search, searchUrl } from '../src/search';

const gifs = [
  { id: 'one', keywords: ['svěrák', 'jak', 'mam'] },
  { id: 'two', keywords: ['smoljak', 'pivo'] },
  { id: 'empty', keywords: [] },
];

describe('regex search', () => {
  test('URL parsing deduplicates equivalent tags and preserves unknown filters', () => {
    const state = readSearchState(
      'http://localhost/?q=%5Ejak%24&tag=SVERAK&tag=sv%C4%9Br%C3%A1k&tag=&tag=unknown',
    );
    expect(state).toEqual({ query: '^jak$', tags: ['svěrák', 'unknown'] });
  });
  test('clicked tags are exact AND filters combined with the regex query', () => {
    expect(search(gifs, '', ['SVERAK', 'jak']).ids).toEqual(['one']);
    expect(search(gifs, '', ['sverak', 'smoljak']).ids).toEqual([]);
    expect(search(gifs, '^mam$', ['svěrák']).ids).toEqual(['one']);
    expect(search(gifs, '^pivo$', ['svěrák']).ids).toEqual([]);
    expect(search(gifs, '', ['jak']).ids).toEqual(['one']);
    expect(search(gifs, '', ['unknown']).ids).toEqual([]);
  });
  test('tag names are literal, including spaces and regex syntax', () => {
    const entries = [{ id: 'literal', keywords: ['a+b', 'ceska televize'] }, {
      id: 'regex',
      keywords: ['aaab'],
    }];
    expect(search(entries, '', ['a+b', 'ceska televize']).ids).toEqual(['literal']);
  });
  test('tags serialize separately from regex and can be cleared independently', () => {
    const href = searchUrl('http://localhost/?q=old&tag=old&x=1#result', '^jak$', [
      'svěrák',
      'pivo',
    ]);
    const url = new URL(href);
    expect(url.searchParams.get('q')).toBe('^jak$');
    expect(url.searchParams.getAll('tag')).toEqual(['svěrák', 'pivo']);
    expect(new URL(searchUrl(href, '', ['svěrák'])).searchParams.getAll('tag')).toEqual(['svěrák']);
    expect(searchUrl(href, '', [])).toBe('http://localhost/?x=1#result');
  });
  test('empty search includes every item, including untagged entries', () => {
    expect(search(gifs, '  ').ids).toEqual(['one', 'two', 'empty']);
  });
  test('AND across terms, regex within individual keywords, case and accents ignored', () => {
    expect(search(gifs, 'SVĚRÁK ^jak$').ids).toEqual(['one']);
    expect(search(gifs, 'sverak smoljak').ids).toEqual([]);
    expect(search(gifs, 'pivo|mam').ids).toEqual(['one', 'two']);
    expect(search(gifs, '^jak$').ids).toEqual(['one']);
    expect(search(gifs, 'jak').ids).toEqual(['one', 'two']);
  });
  test('regex escape case remains meaningful', () => {
    expect(search(gifs, '^\\D+$').ids).toEqual(['one', 'two']);
    expect(search(gifs, '^\\d+$').ids).toEqual([]);
  });
  test('invalid expressions report an error without broadening results', () => {
    expect(search(gifs, '(')).toEqual({ ids: [], error: expect.stringContaining('Neplatný') });
  });
  test('query URLs round-trip regex symbols and preserve unrelated parameters and hash', () => {
    const url = new URL(searchUrl('http://localhost/gallery/?x=1#result', '^jak$ pivo|víno + \\D'));
    expect(url.searchParams.get('q')).toBe('^jak$ pivo|víno + \\D');
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.hash).toBe('#result');
    expect(searchUrl(url.href, '')).toBe('http://localhost/gallery/?x=1#result');
  });
});

describe('catalog boundary', () => {
  const item = {
    id: 'abc',
    url: 'https://giphy.com/gifs/abc',
    keywords: [],
    webp: 'https://media.giphy.com/media/abc/200w.webp',
    gif: 'https://media.giphy.com/media/abc/giphy.gif',
    mp4: 'https://media.giphy.com/media/abc/giphy.mp4',
  };
  test('untagged GIFs remain valid', () => {
    expect(parseCatalog([item])).toEqual([item]);
  });
  test('malformed rows and untrusted URLs are rejected', () => {
    for (
      const value of [[], {}, [null], [{ ...item, keywords: null }], [item, item], [{
        ...item,
        gif: 'javascript:alert(1)',
      }], [{ ...item, mp4: 'https://media.giphy.com.attacker.test/x' }]]
    ) {
      expect(() => parseCatalog(value)).toThrow();
    }
  });
});
