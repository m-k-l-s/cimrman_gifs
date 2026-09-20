import { describe, expect, test } from 'bun:test';
import { groupCategories } from '../src/categories';

describe('category dropdown groups', () => {
  test('story categories follow total counts, not alphabetical order', () => {
    const categories = [
      { id: 'cimrmani', label: 'Cimrmani' },
      { id: 'osada', label: 'Osada' },
      { id: 'pelisky', label: 'Pelíšky' },
    ];
    const counts = new Map([['cimrmani', 40], ['osada', 300], ['pelisky', 120]]);
    expect(groupCategories(categories, counts).stories.map(category => category.id))
      .toEqual(['osada', 'pelisky', 'cimrmani']);
  });

  test('equal counts use Czech alphabetical order, including Ch after H', () => {
    const categories = [
      { id: 'chata', label: 'Chata' },
      { id: 'ivan', label: 'Ivan' },
      { id: 'cesky', label: 'Český' },
      { id: 'hrad', label: 'Hrad' },
      { id: 'cesta', label: 'Cesta' },
    ];
    const counts = new Map(categories.map(category => [category.id, 20]));
    expect(groupCategories(categories, counts).stories.map(category => category.label))
      .toEqual(['Cesta', 'Český', 'Hrad', 'Chata', 'Ivan']);
  });

  test('missing and explicit zero counts retain categories at the end alphabetically', () => {
    const categories = [
      { id: 'chata', label: 'Chata' },
      { id: 'osada', label: 'Osada' },
      { id: 'hrad', label: 'Hrad' },
    ] as const;
    expect(groupCategories(categories, new Map([['osada', 1], ['chata', 0]])))
      .toEqual({ stories: [categories[1], categories[2], categories[0]], other: [] });
  });

  test('entertainment and children sort alphabetically regardless of counts', () => {
    const categories = [
      { id: 'vecernicek', label: 'Večerníček' },
      { id: 'stardance-2024', label: 'StarDance 2024' },
      { id: 'stardancer', label: 'Taneční příběh' },
      { id: 'stardance', label: 'StarDance' },
      { id: 'pece-cela-zeme', label: 'Peče celá země' },
      { id: 'chi-chi-na-gauci', label: 'Chi Chi na gauči' },
      { id: 'stardance-special', label: 'StarDance speciál' },
    ];
    const groups = groupCategories(categories, new Map([['vecernicek', 10_000]]));
    expect(groups.stories.map(category => category.id)).toEqual(['stardancer']);
    expect(groups.other.map(category => category.id)).toEqual([
      'chi-chi-na-gauci',
      'pece-cela-zeme',
      'stardance',
      'stardance-2024',
      'stardance-special',
      'vecernicek',
    ]);
  });

  test('retains every original category and label without mutating either input', () => {
    const categories = Object.freeze(
      [
        Object.freeze({ id: 'pelisky', label: 'PELÍŠKY — původní název' }),
        Object.freeze({ id: 'vecernicek', label: 'Večerníček' }),
        Object.freeze({ id: 'cimrmani', label: 'Cimrmani' }),
      ] as const,
    );
    const counts = new Map([['pelisky', 2], ['cimrmani', 10]]);
    const originalCounts = [...counts];
    const groups = groupCategories(categories, counts);
    expect(groups.stories).toEqual([categories[2], categories[0]]);
    expect(groups.other).toEqual([categories[1]]);
    expect(groups.stories[1]).toBe(categories[0]);
    expect(categories.map(category => category.id)).toEqual(['pelisky', 'vecernicek', 'cimrmani']);
    expect([...counts]).toEqual(originalCounts);
    expect(groups.stories.length + groups.other.length).toBe(categories.length);
  });
});
