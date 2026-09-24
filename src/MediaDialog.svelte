<script lang="ts">
import { onMount, tick } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';
import { type Category, type Gif, isSticker } from './catalog';
import Icon from './Icon.svelte';
import { canShareFile, downloadFile, fetchMedia, type MediaFormat, shareMediaFile } from './media';
import { tagKey } from './search';

let { gif, categories, tags, category, ontag, oncategory, onclose }: {
  gif: Gif;
  categories: Category[];
  tags: string[];
  category: string;
  ontag: (tag: string) => void;
  oncategory: (id: string) => void;
  onclose: () => void;
} = $props();
let dialog: HTMLDialogElement;
let image = $state<HTMLImageElement>();
let file = $state<File | null>(null);
let error = $state('');
let message = $state('');
let manualLink = $state('');
let preparing = $state(false);
let busy = $state(false);
let deferred = $state(false);
let objectUrl = $state('');
let format = $state<MediaFormat>('mp4');
const compact = new MediaQuery('(max-width: 600px), (pointer: coarse)');
const sticker = $derived(isSticker(gif));
const formatName = $derived(format === 'gif' ? 'GIF' : 'video');
const downloadName = $derived(format === 'gif' ? 'GIF' : 'MP4');
let shareSupported = $derived(file ? canShareFile(file) : false);
let controller = new AbortController();

async function prepare(next: MediaFormat = format, forceFile = false): Promise<File | undefined> {
  controller.abort();
  const request = new AbortController();
  controller = request;
  format = next;
  file = null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = '';
  preparing = true;
  error = '';
  message = '';
  manualLink = '';
  deferred = next === 'gif' && compact.current && !forceFile
    && !canShareFile(new File([], 'animation.gif', { type: 'image/gif' }));
  if (deferred) {
    preparing = false;
    return;
  }
  try {
    const ready = await fetchMedia(gif, next, request.signal);
    if (request.signal.aborted) return;
    file = ready;
    if (next === 'mp4') objectUrl = URL.createObjectURL(file);
    return ready;
  } catch (cause) {
    if (!request.signal.aborted) {
      error = cause instanceof Error
        ? cause.message
        : 'Soubor se nepodařilo připravit.';
    }
  } finally {
    if (!request.signal.aborted) preparing = false;
  }
}

async function selectFormat(next: MediaFormat): Promise<void> {
  if (next === format || busy) return;
  void prepare(next);
  if (next === 'gif') {
    await tick();
    dialog.scrollTop = 0;
    image?.focus({ preventScroll: true });
  }
}

async function copyLink(): Promise<void> {
  error = '';
  message = '';
  manualLink = '';
  try {
    await navigator.clipboard.writeText(gif.gif);
    message = 'Odkaz na GIF zkopírován.';
  } catch {
    manualLink = gif.gif;
    error = 'Schránka není dostupná. Zkopírujte odkaz ručně:';
  }
}

async function shareFile(): Promise<void> {
  if (!file || busy) return;
  busy = true;
  error = '';
  message = '';
  manualLink = '';
  try {
    if (await shareMediaFile(file) && !controller.signal.aborted) {
      message = 'Otevřeno systémové sdílení.';
    }
  } catch {
    if (!controller.signal.aborted) {
      error = 'Sdílení se nepodařilo. Stáhněte soubor a přiložte ho v aplikaci.';
    }
  } finally {
    busy = false;
  }
}

async function saveFile(): Promise<void> {
  if (busy || preparing) return;
  busy = true;
  error = '';
  try {
    const ready = file ?? await prepare(format, true);
    if (!ready || controller.signal.aborted) return;
    downloadFile(ready);
    message = 'Stahování zahájeno. Soubor můžete přiložit nebo zkopírovat ze správce souborů.';
  } catch {
    if (!controller.signal.aborted) error = 'Stažení se nepodařilo.';
  } finally {
    busy = false;
  }
}

onMount(() => {
  dialog.showModal();
  void prepare(sticker || compact.current ? 'gif' : 'mp4');
  return () => {
    controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    dialog.close();
  };
});
</script>

{#snippet formatPicker()}
  <div class="format-picker" role="group" aria-label="Formát souboru">
    <button
      data-format="mp4"
      aria-pressed={format === 'mp4'}
      disabled={busy}
      onclick={() => selectFormat('mp4')}
    >
      Video (MP4)
    </button>
    <button
      data-format="gif"
      aria-pressed={format === 'gif'}
      disabled={busy}
      onclick={() => selectFormat('gif')}
    >
      GIF
    </button>
    {#if file}<span class="muted">{(file.size / 1024 / 1024).toFixed(1)} MiB</span>{/if}
  </div>
{/snippet}

<dialog
  bind:this={dialog}
  onclose={onclose}
  aria-labelledby="media-title"
  onclick={(event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top
      || event.clientY > bounds.bottom
    ) dialog.close();
  }}
>
  <div class="dialog-heading">
    <h2 id="media-title">Možnosti GIFu</h2>
    <button onclick={() => dialog.close()} aria-label="Zavřít">✕</button>
  </div>
  {#if !compact.current}{@render formatPicker()}{/if}
  {#if format === 'gif'}
    <img
      bind:this={image}
      src={gif.gif}
      alt="Původní animovaný GIF"
      tabindex="-1"
      aria-describedby="image-copy-hint"
      onerror={() => {
        error = 'GIF se nepodařilo načíst. Zkuste stažení nebo originál na Giphy.';
      }}
    />
    <p id="image-copy-hint" class="copy-hint muted">
      {
        compact.current ? 'Podržte GIF pro sdílení.' : 'Nabídka obrázku → Kopírovat obrázek'
      }
    </p>
  {:else if objectUrl}
    <video src={objectUrl} controls muted loop playsinline aria-label="Vybraný gif"></video>
  {:else}
    <div class="video-placeholder">
      {preparing ? 'Připravuji video…' : 'Video není dostupné.'}
    </div>
  {/if}
  {#if format === 'mp4'}<p class="copy-hint muted">
      {sticker ? 'Video nezachová průhledné pozadí.' : 'Menší soubor; odešle se jako video.'}
    </p>{/if}
  {#if compact.current}{@render formatPicker()}{/if}
  <div class="dialog-actions" role="group" aria-label="Soubor s animací">
    <button
      class="primary"
      onclick={shareSupported ? shareFile : saveFile}
      disabled={(!file && !deferred) || preparing || busy}
    >
      <Icon name={shareSupported ? 'share' : 'download'} />
      {
        preparing ? 'Připravuji…' : shareSupported ? `Sdílet ${formatName}` : `Stáhnout ${downloadName}`
      }
    </button>
    {#if shareSupported}<button onclick={saveFile} disabled={busy}>
        <Icon name="download" /> Stáhnout {downloadName}
      </button>{/if}
    <button class:full={!shareSupported} onclick={copyLink} disabled={busy}>
      <Icon name="copy" /> Kopírovat odkaz
    </button>
  </div>
  {#if file && !shareSupported && !compact.current}<p class="copy-hint muted">
      Sdílení souborů tu není dostupné. Stažený soubor přiložte v cílové aplikaci.
    </p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if manualLink}<input
      aria-label="Odkaz pro ruční zkopírování"
      readonly
      value={manualLink}
      onfocus={(event) => event.currentTarget.select()}
    />{/if}
  {#if !file && !preparing && !deferred}<button
      class="retry"
      onclick={() => prepare(format, true)}
      disabled={busy}
    >
      Zkusit znovu
    </button>{/if}
  <p role="status">{message}</p>
  <div class="gif-details">
    <ul class="gif-categories" aria-label="Pořady">
      {#each categories as item (item.id)}
        <li>
          <button
            aria-label={`Filtrovat pořad: ${item.label}`}
            aria-pressed={category === item.id}
            onclick={() => oncategory(item.id)}
          >
            {item.label}
          </button>
        </li>
      {:else}<li>Bez zařazení</li>{/each}
    </ul>
    {#if gif.keywords.length}
      <ul class="detail-tags" aria-label="Štítky">
        {#each gif.keywords as tag}
          <li>
            <button
              aria-label={`Filtrovat štítek: ${tag}`}
              aria-pressed={tags.some(selected => tagKey(selected) === tagKey(tag))}
              onclick={() => ontag(tag)}
            >
              {tag}
            </button>
          </li>
        {/each}
      </ul>
    {:else}<p class="muted">Bez štítků</p>{/if}
  </div>
  <p class="muted file-info">
    <a href={gif.url} target="_blank" rel="noreferrer">Originál na Giphy ↗</a>
  </p>
</dialog>

<style>
dialog {
  width: min(440px, calc(100% - 24px));
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
  max-height: calc(100dvh - 32px);
  overscroll-behavior: contain;
}
dialog::backdrop {
  background: #0009;
}
.dialog-heading {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  margin-bottom: 14px;
}
.gif-details {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}
.gif-details ul {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.gif-categories {
  color: var(--accent);
}
.gif-details .detail-tags {
  margin-top: 6px;
}
.gif-details button {
  min-height: 32px;
  max-width: 100%;
  padding: 3px 8px;
  border-color: transparent;
  border-radius: 3px;
  background: var(--hover);
  color: var(--accent);
  font-size: inherit;
  overflow-wrap: anywhere;
}
.gif-categories button {
  background: transparent;
  font-weight: 600;
}
.gif-details button[aria-pressed="true"] {
  border-color: var(--accent);
}
.gif-details p {
  margin: 4px 0 0;
}
h2 {
  font-size: 1.125rem;
  margin: 0;
}
video, img, .video-placeholder {
  display: block;
  width: 100%;
  height: min(28dvh, 240px);
  background: #18191b;
  object-fit: contain;
  border-radius: 4px;
}
.video-placeholder {
  display: grid;
  place-items: center;
  color: white;
}
p {
  font-size: 0.875rem;
}
.format-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.format-picker button {
  min-height: 40px;
  background: transparent;
  border-color: transparent;
  color: var(--muted);
}
.format-picker button[aria-pressed="true"] {
  border-color: var(--accent);
  color: var(--accent);
}
.format-picker span {
  margin-left: auto;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.dialog-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 14px 0;
}
.dialog-actions .primary, .dialog-actions .full {
  grid-column: 1 / -1;
}
.dialog-actions button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  min-width: 0;
  padding: 8px;
  line-height: 1.25;
}
.dialog-actions :global(svg) {
  flex-shrink: 0;
}
[role="status"]:empty {
  margin: 0;
}
input {
  width: 100%;
  min-height: 40px;
}
.retry {
  margin-top: 10px;
}
.file-info {
  margin: 14px 0 0;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.copy-hint {
  margin: 6px 0 0;
  font-size: 0.75rem;
}
@media (max-width: 600px), (hover: none) {
  dialog {
    position: fixed;
    inset: auto 0 0;
    margin: 0;
    width: 100%;
    max-width: 100%;
    max-height: calc(100dvh - 12px);
    border-radius: 16px 16px 0 0;
    border-bottom: 0;
    padding: 18px 16px max(18px, env(safe-area-inset-bottom));
  }
}
</style>
