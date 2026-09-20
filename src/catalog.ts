export interface Gif {
  id: string;
  url: string;
  keywords: string[];
  webp: string;
  gif: string;
  mp4: string;
}

export function parseCatalog(value: unknown): Gif[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Katalog je prázdný nebo poškozený.');
  }
  const ids = new Set<string>();
  return value.map((item: unknown) => {
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
    for (const key of ['url', 'webp', 'gif', 'mp4'] as const) {
      if (typeof row[key] !== 'string') throw new Error('Chybí odkaz na médium.');
      const url = new URL(row[key]);
      const host = key === 'url' ? 'giphy.com' : 'media.giphy.com';
      if (
        url.protocol !== 'https:' || url.hostname !== host || url.username || url.password
        || url.port
      ) {
        throw new Error('Nepovolený odkaz v katalogu.');
      }
    }
    return row as unknown as Gif;
  });
}

export function description(gif: Gif): string {
  return gif.keywords.length ? gif.keywords.join(' · ') : 'Cimrmanův gif';
}
