import type { Gif } from './catalog';
import { search } from './search';

self.onmessage = (event: MessageEvent<{ gifs: Gif[]; query: string; tags: string[] }>): void => {
  self.postMessage(search(event.data.gifs, event.data.query, event.data.tags));
};

self.postMessage('ready');
