import type { Category } from './catalog';

export const DEFAULT_CATEGORY = '';
const key = 'cimrman-category';

export function rememberedCategory(
  categories: readonly Category[],
  storage?: Pick<Storage, 'getItem'>,
): string {
  try {
    const stored = (storage ?? localStorage).getItem(key);
    if (stored !== null && (stored === '' || categories.some(category => category.id === stored))) {
      return stored;
    }
  } catch { /* Category selection still works when storage is blocked. */ }
  return DEFAULT_CATEGORY;
}

export function rememberCategory(
  value: string,
  categories: readonly Category[],
  storage?: Pick<Storage, 'setItem'>,
): void {
  if (value && !categories.some(category => category.id === value)) return;
  try {
    (storage ?? localStorage).setItem(key, value);
  } catch { /* The URL remains authoritative without storage. */ }
}

export function shuffled<T>(items: readonly T[], random = Math.random): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}
