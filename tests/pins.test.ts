import { describe, expect, test } from 'bun:test';
import { defaultPins, readPins, writePins } from '../src/pins';

const categories = Object.freeze([
  Object.freeze({ id: 'pelisky', label: 'Pelíšky' }),
  Object.freeze({ id: 'navstevnici', label: 'Návštěvníci' }),
  Object.freeze({ id: 'cimrmani', label: 'Cimrman' }),
  Object.freeze({ id: 'osada', label: 'Osada' }),
  Object.freeze({ id: 'bozena', label: 'Božena' }),
  Object.freeze({ id: 'prvni-republika', label: 'První republika' }),
  Object.freeze({ id: 'vecernicek', label: 'Večerníček' }),
  Object.freeze({ id: 'stardance', label: 'StarDance' }),
  Object.freeze({ id: 'stardance-2025', label: 'StarDance 2025' }),
]);
const counts = new Map([
  ['cimrmani', 414],
  ['pelisky', 289],
  ['osada', 254],
  ['navstevnici', 46],
  ['bozena', 500],
  ['prvni-republika', 600],
  ['vecernicek', 700],
  ['stardance', 800],
  ['stardance-2025', 900],
]);
const defaults = ['cimrmani', 'pelisky', 'osada', 'navstevnici'];
const stored = (value: string | null) => ({ getItem: () => value });

describe('category pin preferences', () => {
  test('defaults contain count-sorted stories except Božena and První republika', () => {
    const originalCategories = [...categories];
    const originalCounts = [...counts];
    expect(defaultPins(categories, counts)).toEqual(defaults);
    expect(defaultPins([], counts)).toEqual([]);
    expect(categories).toEqual(originalCategories);
    expect([...counts]).toEqual(originalCounts);
  });

  test('new story categories join defaults automatically; exclusions match exact IDs', () => {
    const extended = [
      ...categories,
      { id: 'novy-pribeh', label: 'Nový příběh' },
      { id: 'bozena-special', label: 'Božena speciál' },
      { id: 'pece-cela-zeme', label: 'Peče celá země' },
      { id: 'chi-chi-na-gauci', label: 'Chi Chi na gauči' },
    ];
    expect(defaultPins(extended, counts))
      .toEqual([...defaults, 'bozena-special', 'novy-pribeh']);
  });

  test('missing storage uses defaults but intentionally empty pins remain empty', () => {
    expect(readPins(categories, counts, stored(null))).toEqual(defaults);
    expect(readPins(categories, counts, stored('[]'))).toEqual([]);
  });

  test('valid arrays keep chosen order while removing unknown IDs, duplicates and nonstrings', () => {
    const value = JSON.stringify(['osada', 'removed', 7, 'pelisky', null, 'osada', {}, 'cimrmani']);
    expect(readPins(categories, counts, stored(value))).toEqual(['osada', 'pelisky', 'cimrmani']);
    expect(readPins(categories, counts, stored('["removed",7,null]'))).toEqual([]);
    expect(readPins(categories, counts, stored('["vecernicek","bozena","prvni-republika"]')))
      .toEqual(['vecernicek', 'bozena', 'prvni-republika']);
  });

  test('malformed JSON and nonarray values use defaults', () => {
    for (const value of ['', '{broken', '{}', 'null', 'true', '7', '"osada"']) {
      expect(readPins(categories, counts, stored(value))).toEqual(defaults);
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
    expect(readPins(categories, counts, storage)).toEqual(['pelisky']);
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
    expect(readPins(categories, counts, storage)).toEqual(defaults);
    expect(() => writePins(['osada'], storage)).not.toThrow();
  });
});
