<script module lang="ts">
import { MediaQuery } from 'svelte/reactivity';

const touchLayout = new MediaQuery('(max-width: 600px), (pointer: coarse)');
let activeNativeImage: HTMLImageElement | undefined;
</script>

<script lang="ts">
import { onMount } from 'svelte';
import { description, type Gif, isSticker } from './catalog';
import Icon from './Icon.svelte';
import { canShareFile, fetchMedia } from './media';
import { observeViewport } from './viewport';

let { gif, playing, suspended, downloading, oncopy, onvideo, ondownload, onshare }: {
  gif: Gif;
  playing: boolean;
  suspended: boolean;
  downloading: boolean;
  oncopy: (gif: Gif) => void;
  onvideo: (gif: Gif) => void;
  ondownload: (gif: Gif) => void;
  onshare: (file: File) => Promise<void>;
} = $props();
let media: HTMLDivElement;
let card: HTMLElement;
let video = $state<HTMLVideoElement>();
let nativeImage = $state<HTMLImageElement>();
let nativeMenuRequested = false;
let nearby = $state(false);
let visible = $state(false);
let failed = $state(false);
let hovered = $state(false);
let focused = $state(false);
let sharing = $state(false);
let shareFile = $state<File | null>(null);
let shareError = $state(false);
let shareAvailable = $state(canShareFile(new File([], 'animation.gif', { type: 'image/gif' })));
const interested = $derived(hovered || focused);
const animating = $derived(visible && !suspended && (playing || hovered));
const label = $derived(description(gif));
const sticker = $derived(isSticker(gif));
const still = $derived(gif.webp.replace('200w.webp', '200w_s.gif'));

function prepareNativeImage(image: HTMLImageElement): void {
  nativeMenuRequested = true;
  if (activeNativeImage !== image) activeNativeImage?.removeAttribute('src');
  activeNativeImage = image;
  // Native menu handlers read this same target after the page's contextmenu listener.
  if (image.getAttribute('src') !== gif.gif) image.src = gif.gif;
}

$effect(() => {
  const image = nativeImage;
  if (!image) return;
  return () => {
    image.removeAttribute('src');
    if (activeNativeImage === image) activeNativeImage = undefined;
  };
});

$effect(() => {
  if (
    !interested || !shareAvailable
    || !matchMedia('(min-width: 601px) and (hover: hover) and (pointer: fine)').matches
  ) return;
  const controller = new AbortController();
  shareError = false;
  // Prepare before the click so opening the system menu keeps user activation.
  const timer = setTimeout(async () => {
    try {
      const ready = await fetchMedia(gif, 'gif', controller.signal);
      if (controller.signal.aborted) return;
      shareAvailable = canShareFile(ready);
      shareFile = shareAvailable ? ready : null;
    } catch {
      if (!controller.signal.aborted) shareError = true;
    }
  }, 200);
  return () => {
    clearTimeout(timer);
    controller.abort();
    shareFile = null;
  };
});

onMount(() => {
  const stopNearby = observeViewport(card, value => nearby = value, '600px 0px');
  const stopVisible = observeViewport(card, value => visible = value);
  return () => {
    stopNearby();
    stopVisible();
  };
});

$effect(() => {
  const element = video;
  if (!element) return;
  return () => {
    element.pause();
    element.removeAttribute('src');
    element.load();
  };
});

$effect(() => {
  if (!video) return;
  if (animating) {
    void video.play().catch(() => {/* Native autoplay restrictions are expected. */});
  } else video.pause();
});
</script>

<article class="gif-card" data-id={gif.id} aria-label={label} bind:this={card}>
  <div
    class="media"
    role="group"
    bind:this={media}
    onpointerenter={(event) => {
      hovered = event.pointerType === 'mouse';
    }}
    onpointerleave={() => {
      hovered = false;
    }}
    onfocusin={() => {
      focused = true;
    }}
    onfocusout={(event) => {
      focused = event.relatedTarget instanceof Node && media.contains(event.relatedTarget);
    }}
  >
    <button
      class="preview"
      onpointerdown={() => nativeMenuRequested = false}
      onclick={(event) => {
        if (!nativeMenuRequested || event.detail === 0) onvideo(gif);
      }}
      aria-label={`Možnosti GIFu: ${label}`}
      aria-haspopup="dialog"
    >
      {#if nearby && sticker}
        <img
          src={animating ? gif.webp : still}
          alt=""
          aria-hidden="true"
          onerror={() => {
            failed = true;
          }}
          onload={() => {
            failed = false;
          }}
        />
      {:else if nearby}
        <video
          bind:this={video}
          src={gif.webp.replace('200w.webp', '200w.mp4')}
          poster={still}
          muted
          loop
          playsinline
          preload={playing && !suspended ? 'metadata' : 'none'}
          aria-hidden="true"
          onerror={() => {
            failed = true;
          }}
          onloadeddata={() => {
            failed = false;
          }}
        >
        </video>
      {/if}
      {#if failed}<span class="preview-error">Náhled není dostupný</span>{/if}
      {#if nearby && touchLayout.current}
        <img
          class="native-image"
          bind:this={nativeImage}
          alt=""
          aria-hidden="true"
          oncontextmenu={(event) => prepareNativeImage(event.currentTarget)}
        />
      {/if}
    </button>
    {#if nearby}<div class="quick-actions" role="group" aria-label="Rychlé akce">
        {#if shareAvailable}<button
            onclick={async () => {
              if (!shareFile || sharing) return;
              sharing = true;
              try {
                await onshare(shareFile);
              } finally {
                sharing = false;
              }
            }}
            disabled={!shareFile || sharing}
            aria-label={`Sdílet GIF: ${label}`}
            aria-busy={!shareFile && !shareError}
            title={shareError
            ? 'GIF se nepodařilo připravit. Otevřete detail.'
            : shareFile
            ? 'Sdílet GIF'
            : 'Připravuji GIF…'}
          >
            <Icon name="share" />
          </button>{/if}
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
      </div>{/if}
  </div>
</article>

<style>
.gif-card {
  min-width: 0;
  aspect-ratio: 1;
  content-visibility: auto;
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
video, img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.native-image {
  position: absolute;
  inset: 0;
  z-index: 1;
  opacity: 0;
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
</style>
