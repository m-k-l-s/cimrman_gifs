import type { Category } from './catalog';

const otherIds = new Set(['stardance', 'vecernicek', 'pece-cela-zeme', 'chi-chi-na-gauci']);
const alphabet = new Intl.Collator('cs');

export function isStoryCategory(category: Category): boolean {
  return !otherIds.has(category.id) && !category.id.startsWith('stardance-');
}

export function groupCategories(
  categories: readonly Category[],
  counts: ReadonlyMap<string, number>,
): { stories: Category[]; other: Category[] } {
  const stories: Category[] = [];
  const other: Category[] = [];
  for (const category of categories) {
    if (isStoryCategory(category)) stories.push(category);
    else other.push(category);
  }
  stories.sort((first, second) =>
    (counts.get(second.id) ?? 0) - (counts.get(first.id) ?? 0)
    || alphabet.compare(first.label, second.label)
  );
  other.sort((first, second) => alphabet.compare(first.label, second.label));
  return { stories, other };
}
