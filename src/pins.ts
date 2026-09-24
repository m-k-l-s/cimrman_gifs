import type { Category } from './catalog';
import { isStoryCategory } from './categories';

const key = 'cimrman-pins';
const leadingPins = new Map(
  ['cimrmani', 'pelisky', 'osada', 'tomas-holy'].map((id, rank) => [id, rank]),
);
const alphabet = new Intl.Collator('cs');

export function defaultPins(categories: readonly Category[]): string[] {
  return categories
    .filter(category =>
      isStoryCategory(category)
      && category.id !== 'bozena' && category.id !== 'prvni-republika'
    )
    .sort((first, second) =>
      (leadingPins.get(first.id) ?? leadingPins.size)
        - (leadingPins.get(second.id) ?? leadingPins.size)
      || alphabet.compare(first.label, second.label)
    )
    .map(category => category.id);
}

export function readPins(
  categories: readonly Category[],
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
  return defaultPins(categories);
}

export function writePins(ids: readonly string[], storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(ids));
  } catch { /* Pin controls still work without persistence. */ }
}
