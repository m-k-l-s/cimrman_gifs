import type { Category } from './catalog';
import { groupCategories } from './categories';

const key = 'cimrman-pins';

export function defaultPins(
  categories: readonly Category[],
  counts: ReadonlyMap<string, number>,
): string[] {
  return groupCategories(categories, counts).stories
    .map(category => category.id)
    .filter(id => id !== 'bozena' && id !== 'prvni-republika');
}

export function readPins(
  categories: readonly Category[],
  counts: ReadonlyMap<string, number>,
  storage?: Pick<Storage, 'getItem'>,
): string[] {
  try {
    const stored = (storage ?? localStorage).getItem(key);
    if (stored !== null) {
      const value: unknown = JSON.parse(stored);
      if (Array.isArray(value)) {
        const known = new Set(categories.map(category => category.id));
        return [
          ...new Set(value.filter((id): id is string => typeof id === 'string' && known.has(id))),
        ];
      }
    }
  } catch { /* Pin selection still works when storage is blocked or malformed. */ }
  return defaultPins(categories, counts);
}

export function writePins(ids: readonly string[], storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(ids));
  } catch { /* Pin controls still work without persistence. */ }
}
