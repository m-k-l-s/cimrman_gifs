import type { Category } from './catalog';
import { DEFAULT_CATEGORY } from './discovery';

export const DEFAULT_PINS = [DEFAULT_CATEGORY, 'osada', 'pelisky', 'tomas-holy'] as const;
const key = 'cimrman-pins';

export function defaultPins(categories: readonly Category[]): string[] {
  const known = new Set(categories.map(category => category.id));
  return DEFAULT_PINS.filter(id => known.has(id));
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
