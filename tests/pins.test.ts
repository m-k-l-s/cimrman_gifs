import { describe, expect, test } from 'bun:test';
import { DEFAULT_PINS, defaultPins, readPins, writePins } from '../src/pins';

const categories = Object.freeze([
  Object.freeze({ id: 'pelisky', label: 'Pelíšky' }),
  Object.freeze({ id: 'navstevnici', label: 'Návštěvníci' }),
  Object.freeze({ id: 'cimrmani', label: 'Cimrman' }),
  Object.freeze({ id: 'osada', label: 'Osada' }),
]);
const stored = (value: string | null) => ({ getItem: () => value });

describe('category pin preferences', () => {
  test('known defaults keep their preferred order regardless of catalog order', () => {
    expect(DEFAULT_PINS).toEqual(['cimrmani', 'osada', 'pelisky', 'tomas-holy']);
    expect(defaultPins(categories)).toEqual(['cimrmani', 'osada', 'pelisky']);
    expect(defaultPins([])).toEqual([]);
    expect(categories.map(category => category.id))
      .toEqual(['pelisky', 'navstevnici', 'cimrmani', 'osada']);
  });

  test('missing storage uses defaults but intentionally empty pins remain empty', () => {
    expect(readPins(categories, stored(null))).toEqual(['cimrmani', 'osada', 'pelisky']);
    expect(readPins(categories, stored('[]'))).toEqual([]);
  });

  test('valid arrays keep chosen order while removing unknown IDs, duplicates and nonstrings', () => {
    const value = JSON.stringify(['osada', 'removed', 7, 'pelisky', null, 'osada', {}, 'cimrmani']);
    expect(readPins(categories, stored(value))).toEqual(['osada', 'pelisky', 'cimrmani']);
    expect(readPins(categories, stored('["removed",7,null]'))).toEqual([]);
  });

  test('malformed JSON and nonarray values use defaults', () => {
    for (const value of ['', '{broken', '{}', 'null', 'true', '7', '"osada"']) {
      expect(readPins(categories, stored(value))).toEqual(['cimrmani', 'osada', 'pelisky']);
    }
  });

  test('reads use the pin key and never rewrite stale preferences', () => {
    const readKeys: string[] = [];
    const writes: string[] = [];
    const storage = {
      getItem: (key: string) => {
        readKeys.push(key);
        return '["pelisky","removed","pelisky"]';
      },
      setItem: (key: string) => {
        writes.push(key);
      },
    };
    expect(readPins(categories, storage)).toEqual(['pelisky']);
    expect(readKeys).toEqual(['cimrman-pins']);
    expect(writes).toEqual([]);
  });

  test('writes preserve input order and support saving the intentionally empty selection', () => {
    const ids = Object.freeze(['pelisky', 'cimrmani']);
    const writes: [string, string][] = [];
    const storage = {
      setItem: (key: string, value: string) => {
        writes.push([key, value]);
      },
    };
    writePins(ids, storage);
    writePins([], storage);
    expect(writes).toEqual([
      ['cimrman-pins', '["pelisky","cimrmani"]'],
      ['cimrman-pins', '[]'],
    ]);
    expect(ids).toEqual(['pelisky', 'cimrmani']);
  });

  test('blocked storage never prevents using or changing pins', () => {
    const storage = {
      getItem: (): string | null => {
        throw new Error('Blocked');
      },
      setItem: (): void => {
        throw new Error('Blocked');
      },
    };
    expect(readPins(categories, storage)).toEqual(['cimrmani', 'osada', 'pelisky']);
    expect(() => writePins(['osada'], storage)).not.toThrow();
  });
});
