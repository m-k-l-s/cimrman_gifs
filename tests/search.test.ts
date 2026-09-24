import { describe, expect, test } from 'bun:test';
import { description, parseCatalog } from '../src/catalog';
import { readSearchState, search, searchUrl } from '../src/search';

const gifs = [
  { id: 'one', keywords: ['svěrák', 'jak', 'mam'] },
  { id: 'two', keywords: ['smoljak', 'pivo'] },
  { id: 'empty', keywords: [] },
].map(gif => ({ ...gif, title: '' }));

describe('regex search', () => {
  test('URL parsing deduplicates equivalent tags and preserves unknown filters', () => {
    const state = readSearchState(
      'http://localhost/?q=%5Ejak%24&tag=SVERAK&tag=sv%C4%9Br%C3%A1k&tag=&tag=unknown',
    );
    expect(state).toEqual({ query: '^jak$', tags: ['svěrák', 'unknown'], category: '' });
  });
  test('category URLs preserve combined filters and unknown categories', () => {
    const state = { query: '^pivo$', tags: ['smoljak'], category: 'pelisky' };
    const href = searchUrl('https://example.test/?x=1#clips', state);
    expect(readSearchState(href)).toEqual(state);
    expect(new URL(href).searchParams.get('x')).toBe('1');
    expect(new URL(href).hash).toBe('#clips');
    expect(readSearchState('https://example.test/?category=unknown').category).toBe('unknown');
    expect(new URL(searchUrl(href, { ...state, category: '' })).searchParams.get('category'))
      .toBe('');
  });
  test('editing while the catalog is pending does not invent a category', () => {
    const href = searchUrl('https://example.test/?tag=old&x=1#clips', {
      query: 'pivo',
      tags: [],
      category: null,
    });
    const url = new URL(href);
    expect(url.searchParams.has('category')).toBe(false);
    expect(url.searchParams.getAll('tag')).toEqual([]);
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.hash).toBe('#clips');
    expect(readSearchState(href, 'osada')).toEqual({ query: 'pivo', tags: [], category: 'osada' });
  });
  test('pending edits preserve explicit scopes, including all and unknown categories', () => {
    for (const category of ['', 'pelisky', 'unknown']) {
      const href = searchUrl(`https://example.test/?category=${category}`, {
        query: 'pivo',
        tags: ['smoljak'],
        category: null,
      });
      expect(readSearchState(href, 'osada')).toEqual({
        query: 'pivo',
        tags: ['smoljak'],
        category,
      });
    }
  });
  test('source titles are searchable without becoming clickable tags', () => {
    const entries = [{ id: 'osada', title: 'Osada Žízeň GIF', keywords: ['pivo'] }];
    expect(search(entries, 'osada zizen ^pivo$').ids).toEqual(['osada']);
    expect(search(entries, 'osada', ['zizen']).ids).toEqual([]);
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
    const entries = [{ id: 'literal', title: '', keywords: ['a+b', 'ceska televize'] }, {
      id: 'regex',
      title: '',
      keywords: ['aaab'],
    }];
    expect(search(entries, '', ['a+b', 'ceska televize']).ids).toEqual(['literal']);
  });
  test('tags serialize separately from regex and can be cleared independently', () => {
    const href = searchUrl('http://localhost/?q=old&tag=old&x=1#result', {
      query: '^jak$',
      tags: ['svěrák', 'pivo'],
      category: '',
    });
    const url = new URL(href);
    expect(url.searchParams.get('q')).toBe('^jak$');
    expect(url.searchParams.getAll('tag')).toEqual(['svěrák', 'pivo']);
    expect(
      new URL(searchUrl(href, { query: '', tags: ['svěrák'], category: '' })).searchParams.getAll(
        'tag',
      ),
    )
      .toEqual(['svěrák']);
    expect(searchUrl(href, { query: '', tags: [], category: '' })).toBe(
      'http://localhost/?x=1&category=#result',
    );
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
    const url = new URL(searchUrl('http://localhost/gallery/?x=1#result', {
      query: '^jak$ pivo|víno + \\D',
      tags: [],
      category: '',
    }));
    expect(url.searchParams.get('q')).toBe('^jak$ pivo|víno + \\D');
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.hash).toBe('#result');
    expect(searchUrl(url.href, { query: '', tags: [], category: '' }))
      .toBe('http://localhost/gallery/?x=1&category=#result');
  });
});

describe('catalog boundary', () => {
  const item = {
    id: 'abc',
    url: 'https://giphy.com/gifs/abc',
    keywords: [],
    title: 'Osada GIF',
    categoryIds: ['osada', 'pelisky'],
    webp: 'https://media.giphy.com/media/abc/200w.webp',
    gif: 'https://media.giphy.com/media/abc/giphy.gif',
    mp4: 'https://media.giphy.com/media/abc/giphy.mp4',
  };
  const categories = [{ id: 'osada', label: 'Osada' }, { id: 'pelisky', label: 'Pelíšky' }];
  test('compact wire data expands to the same media links', () => {
    const wire = {
      id: item.id,
      url: item.url,
      title: item.title,
      keywords: item.keywords,
      categoryIds: item.categoryIds,
    };
    expect(parseCatalog({ categories, gifs: [wire] }).gifs[0]).toEqual(item);
    expect(
      parseCatalog({
        categories,
        gifs: [{
          ...wire,
          webp: 'https://example.test/preview',
          gif: 'javascript:alert(1)',
          mp4: 'http://evil.test/file',
        }],
      }).gifs[0],
    ).toEqual(item);
  });
  test('category membership is validated and keeps multi-category GIFs unique', () => {
    expect(parseCatalog({ categories, gifs: [item] })).toEqual({ categories, gifs: [item] });
    for (const categoryIds of [['unknown'], ['osada', 'osada'], [5], null]) {
      expect(() => parseCatalog({ categories, gifs: [{ ...item, categoryIds }] })).toThrow();
    }
    expect(() =>
      parseCatalog({
        categories: [categories[0], categories[0]],
        gifs: [{ ...item, categoryIds: ['osada'] }],
      })
    ).toThrow('Neplatná nebo opakovaná kategorie.');
    expect(description(item)).toBe('Osada GIF');
  });
  test('untagged GIFs remain valid', () => {
    expect(parseCatalog({ categories, gifs: [item] }).gifs).toEqual([item]);
  });
  test('malformed rows and untrusted URLs are rejected', () => {
    for (
      const value of [
        [],
        {},
        [null],
        [{ ...item, keywords: null }],
        [item, item],
        [{
          ...item,
          url: 'javascript:alert(1)',
        }],
        [{ ...item, url: 'https://giphy.com.attacker.test/x' }],
        [{ ...item, id: 'abc/../bad' }],
      ]
    ) {
      expect(() => parseCatalog({ categories, gifs: value })).toThrow();
    }
  });
});
