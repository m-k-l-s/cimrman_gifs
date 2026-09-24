import { describe, expect, test } from 'bun:test';
import { DEFAULT_CATEGORY, rememberCategory, rememberedCategory, shuffled } from '../src/discovery';
import { readSearchState, searchUrl } from '../src/search';

const categories = [
  { id: DEFAULT_CATEGORY, label: 'Cimrman' },
  { id: 'pelisky', label: 'Pelíšky' },
];
function storage(value: string | null = null) {
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('remembered category', () => {
  test('first visits default to Cimrman; missing categories fall back to all', () => {
    expect(rememberedCategory(categories, storage())).toBe(DEFAULT_CATEGORY);
    expect(rememberedCategory([], storage())).toBe('');
  });
  test('remembers both a programme and the empty all-category selection', () => {
    const store = storage();
    rememberCategory('pelisky', categories, store);
    expect(rememberedCategory(categories, store)).toBe('pelisky');
    rememberCategory('', categories, store);
    expect(rememberedCategory(categories, store)).toBe('');
  });
  test('stale preferences fall back without hiding explicit unknown URL categories', () => {
    const store = storage('removed');
    expect(rememberedCategory(categories, store)).toBe(DEFAULT_CATEGORY);
    rememberCategory('unknown', categories, store);
    expect(store.getItem()).toBe('removed');
    expect(readSearchState('https://example.test/?category=unknown', DEFAULT_CATEGORY).category)
      .toBe('unknown');
  });
  test('explicit URL categories, including all, override the saved preference', () => {
    const saved = rememberedCategory(categories, storage('pelisky'));
    expect(readSearchState('https://example.test/', saved).category).toBe('pelisky');
    expect(readSearchState('https://example.test/?category=cimrmani', saved).category)
      .toBe(DEFAULT_CATEGORY);
    const all = searchUrl('https://example.test/', { query: '', tags: [], category: '' });
    expect(readSearchState(all, saved).category).toBe('');
  });
  test('blocked storage never prevents browsing', () => {
    const blocked = {
      getItem: (): string | null => {
        throw new Error('Blocked');
      },
      setItem: (): void => {
        throw new Error('Blocked');
      },
    };
    expect(rememberedCategory(categories, blocked)).toBe(DEFAULT_CATEGORY);
    expect(() => rememberCategory('pelisky', categories, blocked)).not.toThrow();
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
