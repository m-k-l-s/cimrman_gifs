export interface Gif {
  id: string;
  url: string;
  keywords: string[];
  title: string;
  categoryIds: string[];
  webp: string;
  gif: string;
  mp4: string;
}

export interface Category {
  id: string;
  label: string;
}

export interface Catalog {
  categories: Category[];
  gifs: Gif[];
}

export function parseCatalog(value: unknown): Catalog {
  if (!value || typeof value !== 'object') {
    throw new Error('Katalog je prázdný nebo poškozený.');
  }
  const catalog = value as Record<string, unknown>;
  if (!Array.isArray(catalog.categories) || !Array.isArray(catalog.gifs) || !catalog.gifs.length) {
    throw new Error('Katalog je prázdný nebo poškozený.');
  }
  const categoryIds = new Set<string>();
  const categories = catalog.categories.map((item: unknown): Category => {
    if (!item || typeof item !== 'object') throw new Error('Neplatná kategorie.');
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(row.id)
      || categoryIds.has(row.id) || typeof row.label !== 'string' || !row.label.trim()
    ) throw new Error('Neplatná nebo opakovaná kategorie.');
    categoryIds.add(row.id);
    return { id: row.id, label: row.label };
  });
  const ids = new Set<string>();
  const gifs = catalog.gifs.map((item: unknown): Gif => {
    if (!item || typeof item !== 'object') throw new Error('Neplatný záznam katalogu.');
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9]+$/.test(row.id) || ids.has(row.id)) {
      throw new Error('Neplatné nebo opakované ID.');
    }
    ids.add(row.id);
    if (
      !Array.isArray(row.keywords)
      || !row.keywords.every((word: unknown) => typeof word === 'string')
    ) {
      throw new Error('Neplatná klíčová slova.');
    }
    if (
      typeof row.title !== 'string' || !Array.isArray(row.categoryIds)
      || !row.categoryIds.every((id: unknown) => typeof id === 'string' && categoryIds.has(id))
      || new Set(row.categoryIds).size !== row.categoryIds.length
    ) throw new Error('Neplatný název nebo kategorie gifu.');
    if (typeof row.url !== 'string') throw new Error('Chybí odkaz na médium.');
    const url = new URL(row.url);
    if (
      url.protocol !== 'https:' || url.hostname !== 'giphy.com' || url.username || url.password
      || url.port
    ) {
      throw new Error('Nepovolený odkaz v katalogu.');
    }
    const media = `https://media.giphy.com/media/${row.id}`;
    return {
      id: row.id,
      url: row.url,
      title: row.title,
      keywords: row.keywords,
      categoryIds: row.categoryIds,
      webp: `${media}/200w.webp`,
      gif: `${media}/giphy.gif`,
      mp4: `${media}/giphy.mp4`,
    };
  });
  return { categories, gifs };
}

export function description(gif: Gif): string {
  return gif.keywords.length ? gif.keywords.join(' · ') : gif.title || 'Gif České televize';
}

export function isSticker(gif: Pick<Gif, 'url'>): boolean {
  return new URL(gif.url).pathname.startsWith('/stickers/');
}
