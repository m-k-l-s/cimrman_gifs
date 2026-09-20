<script lang="ts">
import { onMount } from 'svelte';
import { description, type Gif } from './catalog';
import Icon from './Icon.svelte';
import { tagKey } from './search';

let { gif, playing, downloading, tags, ontag, oncopy, onvideo, ondownload }: {
  gif: Gif;
  playing: boolean;
  downloading: boolean;
  tags: string[];
  ontag: (tag: string) => void;
  oncopy: (gif: Gif) => void;
  onvideo: (gif: Gif) => void;
  ondownload: (gif: Gif) => void;
} = $props();
let video: HTMLVideoElement;
let visible = $state(false);
let failed = $state(false);
const label = $derived(description(gif));

onMount(() => {
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
  });
  observer.observe(video);
  return () => {
    observer.disconnect();
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
});

$effect(() => {
  if (!video) return;
  if (!visible) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    return;
  }
  if (playing && visible) {
    void video.play().catch(() => {/* Native autoplay restrictions are expected. */});
  } else video.pause();
});
</script>

<article class="gif-card" data-id={gif.id} aria-label={label}>
  <div class="media">
    <button
      class="preview"
      onclick={() => onvideo(gif)}
      aria-label={`Možnosti GIFu: ${label}`}
      aria-haspopup="dialog"
    >
      <video
        bind:this={video}
        src={visible ? gif.webp.replace('200w.webp', '200w.mp4') : undefined}
        poster={visible ? gif.webp.replace('200w.webp', '200w_s.gif') : undefined}
        muted
        loop
        playsinline
        preload="none"
        aria-hidden="true"
        onerror={() => {
          failed = true;
        }}
        onloadeddata={() => {
          failed = false;
        }}
      >
      </video>
      {#if failed}<span class="preview-error">Náhled není dostupný</span>{/if}
      <span class="open-mark" aria-hidden="true"><Icon name="more" /></span>
    </button>
    <div class="quick-actions" role="group" aria-label="Rychlé akce">
      <button
        onclick={() => oncopy(gif)}
        aria-label={`Kopírovat odkaz: ${label}`}
        title="Kopírovat odkaz"
      >
        <Icon name="copy" />
      </button>
      <button
        onclick={() => ondownload(gif)}
        disabled={downloading}
        aria-label={`Stáhnout GIF: ${label}`}
        title={downloading ? 'Stahuji GIF…' : 'Stáhnout GIF'}
      >
        <Icon name="download" />
      </button>
    </div>
  </div>
  <div
    class="keywords"
    role="group"
    aria-label="Štítky; další zobrazíte posunutím do strany"
    title="Další štítky posunem do strany"
  >
    {#each gif.keywords as tag}
      {@const active = tags.some((selected) => tagKey(selected) === tagKey(tag))}
      <button
        class="tag"
        aria-pressed={active}
        aria-label={`Filtrovat štítek: ${tag}`}
        onclick={() => ontag(tag)}
        onfocus={(event) => {
          if (event.currentTarget.matches(':focus-visible')) {
            event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        }}
      >
        {#if active}<span aria-hidden="true">✓ </span>{/if}{tag}
      </button>
    {/each}
  </div>
</article>

<style>
.gif-card {
  min-width: 0;
}
.media {
  position: relative;
}
.preview {
  position: relative;
  display: block;
  padding: 0;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border: 0;
  background: #18191b;
  border-radius: 5px;
}
video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.open-mark {
  position: absolute;
  inset: auto 8px 8px auto;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #111c;
  color: white;
}
.quick-actions {
  display: none;
}
@media (min-width: 601px) and (hover: hover) and (pointer: fine) {
  .quick-actions {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 7px;
    background: #111e;
    opacity: 0;
    pointer-events: none;
  }
  .media:hover .quick-actions, .media:focus-within .quick-actions {
    opacity: 1;
    pointer-events: auto;
  }
  .quick-actions button {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border-color: transparent;
    background: transparent;
    color: #fff;
  }
  .quick-actions button:hover:not(:disabled) {
    background: #fff3;
  }
  .quick-actions button:focus-visible {
    outline-color: #fff;
    outline-offset: -2px;
  }
}
.preview-error {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: white;
  font-size: 0.85rem;
}
.keywords {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  padding-block: 1px;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}
.tag {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 3px;
  min-height: 26px;
  padding: 2px 6px;
  border-color: transparent;
  background: var(--hover);
  color: var(--accent);
  font-size: 0.75rem;
  white-space: nowrap;
}
.tag[aria-pressed="true"] {
  border-color: var(--accent);
}
.tag:focus-visible {
  outline-offset: -2px;
}
@media (pointer: coarse) {
  .tag {
    min-height: 32px;
  }
}
</style>
