<script lang="ts">
import { onMount } from 'svelte';
import type { Gif } from './catalog';
import Icon from './Icon.svelte';
import { canShareFile, downloadFile, fetchMedia } from './media';

let { gif, onclose }: { gif: Gif; onclose: () => void } = $props();
let dialog: HTMLDialogElement;
let file = $state<File | null>(null);
let error = $state('');
let message = $state('');
let manualLink = $state('');
let preparing = $state(false);
let busy = $state(false);
let objectUrl = $state('');
let shareSupported = $derived(file ? canShareFile(file) : false);
const controller = new AbortController();

async function prepare(): Promise<void> {
  preparing = true;
  error = '';
  message = '';
  try {
    const ready = await fetchMedia(gif, 'mp4', controller.signal);
    if (controller.signal.aborted) return;
    file = ready;
    objectUrl = URL.createObjectURL(file);
  } catch (cause) {
    if (!controller.signal.aborted) {
      error = cause instanceof Error
        ? cause.message
        : 'Video se nepodařilo připravit.';
    }
  } finally {
    preparing = false;
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

async function share(data: ShareData): Promise<void> {
  if (!navigator.share) {
    await copyLink();
    if (!manualLink) message = 'Sdílení tu není dostupné. Odkaz na GIF je zkopírovaný.';
    return;
  }
  busy = true;
  error = '';
  message = '';
  manualLink = '';
  try {
    await navigator.share(data);
    if (data.files && !controller.signal.aborted) message = 'Video předáno ke sdílení.';
  } catch (cause) {
    if (
      !controller.signal.aborted && !(cause instanceof DOMException && cause.name === 'AbortError')
    ) {
      error = data.files
        ? 'Sdílení se nepodařilo. Stáhněte video a přiložte ho v aplikaci.'
        : 'Odkaz se nepodařilo sdílet. Zkuste ho zkopírovat.';
    }
  } finally {
    busy = false;
  }
}

async function saveGif(): Promise<void> {
  busy = true;
  error = '';
  message = '';
  try {
    const ready = await fetchMedia(gif, 'gif', controller.signal);
    if (controller.signal.aborted) return;
    downloadFile(ready);
    message = 'Stahování GIFu zahájeno.';
  } catch (cause) {
    if (!controller.signal.aborted) {
      error = cause instanceof Error
        ? cause.message
        : 'GIF se nepodařilo stáhnout.';
    }
  } finally {
    busy = false;
  }
}

onMount(() => {
  dialog.showModal();
  void prepare();
  return () => {
    controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    dialog.close();
  };
});
</script>

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
  {#if objectUrl}
    <video src={objectUrl} controls muted loop playsinline aria-label="Vybraný Cimrmanův gif">
    </video>
  {:else}
    <div class="video-placeholder">
      {preparing ? 'Připravuji video…' : 'Video není dostupné.'}
    </div>
  {/if}
  <div class="link-actions" role="group" aria-label="Odkaz">
    <button onclick={copyLink} disabled={busy}><Icon name="copy" /> Kopírovat odkaz</button>
    <button onclick={() => share({ url: gif.gif })} disabled={busy}>
      <Icon name="share" /> Sdílet odkaz
    </button>
  </div>
  <div class="dialog-actions" role="group" aria-label="Soubor s animací">
    {#if shareSupported}<button
        class="primary share-file"
        onclick={() => {
          if (file) void share({ files: [file] });
        }}
        disabled={busy}
      >
        <Icon name="share" /> Sdílet video
      </button>{/if}
    <button
      class:primary={!shareSupported}
      disabled={!file || busy || preparing}
      onclick={() => {
        if (file) {
          downloadFile(file);
          message = 'Stahování videa zahájeno.';
        }
      }}
    >
      <Icon name="download" /> Stáhnout MP4
    </button>
    <button disabled={busy} onclick={saveGif}><Icon name="download" /> Stáhnout GIF</button>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if manualLink}<input
      aria-label="Odkaz pro ruční zkopírování"
      readonly
      value={manualLink}
      onfocus={(event) => event.currentTarget.select()}
    />{/if}
  {#if !file && !preparing}<button class="retry" onclick={prepare} disabled={busy}>
      Zkusit znovu
    </button>{/if}
  <p role="status">{message}</p>
  <p class="muted file-info">
    <a href={gif.url} target="_blank" rel="noreferrer">Originál na Giphy ↗</a>
    {#if file}
      · MP4 · {(file.size / 1024 / 1024).toFixed(1)} MiB{/if}
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
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  margin-bottom: 14px;
}
h2 {
  font-size: 1.125rem;
  margin: 0;
}
video, .video-placeholder {
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
.dialog-actions, .link-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.link-actions {
  margin: 14px 0;
}
.dialog-actions {
  border-top: 1px solid var(--border);
  padding-top: 14px;
}
.dialog-actions .share-file {
  grid-column: 1 / -1;
}
.dialog-actions button, .link-actions button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  min-width: 0;
  padding: 8px;
  line-height: 1.25;
}
.dialog-actions :global(svg), .link-actions :global(svg) {
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
