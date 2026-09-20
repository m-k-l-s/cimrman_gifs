import type { Gif } from './catalog';

export interface SearchResult {
  ids: string[];
  error: string;
}

export interface SearchState {
  query: string;
  tags: string[];
}

export function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function tagKey(tag: string): string {
  return normalize(tag).trim().toLowerCase();
}

function uniqueTags(tags: readonly string[]): string[] {
  return [
    ...new Map(tags.filter((tag) => tag.trim()).map((tag) => [tagKey(tag), tag.trim()])).values(),
  ];
}

export function readSearchState(href: string): SearchState {
  const url = new URL(href);
  return {
    query: url.searchParams.get('q') ?? '',
    tags: uniqueTags(url.searchParams.getAll('tag')),
  };
}

export function search(
  gifs: Pick<Gif, 'id' | 'keywords'>[],
  query: string,
  tags: readonly string[] = [],
): SearchResult {
  try {
    const selected = tags.map(tagKey);
    const patterns = query.trim().split(/\s+/).filter(Boolean).map((term) =>
      new RegExp(normalize(term), 'i')
    );
    return {
      ids: gifs.filter((gif) =>
        selected.every((tag) => gif.keywords.some((word) => tagKey(word) === tag))
        && patterns.every((pattern) => gif.keywords.some((word) => pattern.test(normalize(word))))
      )
        .map((gif) => gif.id),
      error: '',
    };
  } catch {
    return { ids: [], error: 'Neplatný regulární výraz. Zkontrolujte závorky a speciální znaky.' };
  }
}

export function searchUrl(href: string, query: string, tags: readonly string[] = []): string {
  const url = new URL(href);
  if (query) url.searchParams.set('q', query);
  else url.searchParams.delete('q');
  url.searchParams.delete('tag');
  for (const tag of uniqueTags(tags)) url.searchParams.append('tag', tag);
  return url.href;
}
