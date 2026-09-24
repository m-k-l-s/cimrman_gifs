import { describe, expect, test } from 'bun:test';
import { defaultPins, readPins, writePins } from '../src/pins';

const categories = Object.freeze([
  Object.freeze({ id: 'pelisky', label: 'Pelíšky' }),
  Object.freeze({ id: 'navstevnici', label: 'Návštěvníci' }),
  Object.freeze({ id: 'tomas-holy', label: 'Tomáš Holý' }),
  Object.freeze({ id: 'cimrmani', label: 'Cimrman' }),
  Object.freeze({ id: 'osada', label: 'Osada' }),
  Object.freeze({ id: 'bozena', label: 'Božena' }),
  Object.freeze({ id: 'prvni-republika', label: 'První republika' }),
  Object.freeze({ id: 'vecernicek', label: 'Večerníček' }),
  Object.freeze({ id: 'stardance', label: 'StarDance' }),
  Object.freeze({ id: 'stardance-2025', label: 'StarDance 2025' }),
]);
const defaults = ['cimrmani', 'pelisky', 'osada', 'tomas-holy', 'navstevnici'];
const stored = (value: string | null) => ({ getItem: () => value });

describe('category pin preferences', () => {
  test('defaults lead with four programmes and exclude Božena, První republika and other groups', () => {
    const originalCategories = [...categories];
    expect(defaultPins(categories)).toEqual(defaults);
    expect(defaultPins([...categories].reverse())).toEqual(defaults);
    expect(defaultPins(categories.filter(category => category.id !== 'cimrmani')))
      .toEqual(defaults.slice(1));
    expect(defaultPins([])).toEqual([]);
    expect(categories).toEqual(originalCategories);
  });

  test('remaining stories use Czech label order; exclusions match exact IDs', () => {
    const extended = [
      ...categories,
      { id: 'novy-pribeh', label: 'Nový příběh' },
      { id: 'bozena-special', label: 'Božena speciál' },
      { id: 'cesta', label: 'Cesta' },
      { id: 'cesky-pribeh', label: 'Český příběh' },
      { id: 'ivan', label: 'Ivan' },
      { id: 'chata', label: 'Chata' },
      { id: 'hrad', label: 'Hrad' },
      { id: 'pece-cela-zeme', label: 'Peče celá země' },
      { id: 'chi-chi-na-gauci', label: 'Chi Chi na gauči' },
    ];
    expect(defaultPins(extended)).toEqual([
      'cimrmani',
      'pelisky',
      'osada',
      'tomas-holy',
      'bozena-special',
      'cesta',
      'cesky-pribeh',
      'hrad',
      'chata',
      'ivan',
      'navstevnici',
      'novy-pribeh',
    ]);
  });

  test('missing storage uses defaults but intentionally empty pins remain empty', () => {
    expect(readPins(categories, stored(null))).toEqual(defaults);
    expect(readPins(categories, stored('[]'))).toEqual([]);
  });

  test('valid arrays keep chosen order while removing unknown IDs, duplicates and nonstrings', () => {
    const value = JSON.stringify(['osada', 'removed', 7, 'pelisky', null, 'osada', {}, 'cimrmani']);
    expect(readPins(categories, stored(value))).toEqual(['osada', 'pelisky', 'cimrmani']);
    expect(readPins(categories, stored('["removed",7,null]'))).toEqual([]);
    expect(readPins(categories, stored('["vecernicek","bozena","prvni-republika"]')))
      .toEqual(['vecernicek', 'bozena', 'prvni-republika']);
  });

  test('malformed JSON and nonarray values use defaults', () => {
    for (const value of ['', '{broken', '{}', 'null', 'true', '7', '"osada"']) {
      expect(readPins(categories, stored(value))).toEqual(defaults);
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
    expect(readPins(categories, storage)).toEqual(defaults);
    expect(() => writePins(['osada'], storage)).not.toThrow();
  });
});
