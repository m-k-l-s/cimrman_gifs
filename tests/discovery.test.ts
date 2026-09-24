import { describe, expect, test } from 'bun:test';
import { DEFAULT_CATEGORY, shuffled } from '../src/discovery';
import { readSearchState } from '../src/search';

describe('category entry points', () => {
  test('URLs without a category always use Cimrman', () => {
    expect(DEFAULT_CATEGORY).toBe('cimrmani');
    for (const query of ['', '?q=pivo', '?tag=ja']) {
      expect(readSearchState(`https://example.test/${query}`, DEFAULT_CATEGORY).category)
        .toBe('cimrmani');
    }
  });
  test('explicit categories, favourites and unknown categories remain authoritative', () => {
    for (const category of ['cimrmani', 'pelisky', '', 'unknown']) {
      expect(
        readSearchState(`https://example.test/?category=${category}`, DEFAULT_CATEGORY).category,
      )
        .toBe(category);
    }
  });
});

describe('discovery order', () => {
  test('shuffles without changing the source or losing records', () => {
    const entries = Object.freeze([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    const order = shuffled(entries, () => 0);
    expect(order.map(entry => entry.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(new Set(order)).toEqual(new Set(entries));
    expect(entries.map(entry => entry.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(order).not.toBe(entries);
    expect(shuffled(entries, () => 0.999)).toEqual([...entries]);
  });
  test('empty and single-record catalogs need no random draws', () => {
    const unexpected = () => {
      throw new Error('Unexpected draw');
    };
    expect(shuffled([], unexpected)).toEqual([]);
    expect(shuffled(['only'], unexpected)).toEqual(['only']);
  });
});
