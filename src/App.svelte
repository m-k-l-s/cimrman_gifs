<script lang="ts">
import { onMount } from 'svelte';
import { type Gif, parseCatalog } from './catalog';
import GifCard from './GifCard.svelte';
import Icon from './Icon.svelte';
import { downloadFile, fetchMedia } from './media';
import MediaDialog from './MediaDialog.svelte';
import { readSearchState, type SearchResult, searchUrl, tagKey } from './search';
import { readTheme, setTheme, type Theme } from './theme';

let gifs = $state.raw<Gif[]>([]);
let results = $state.raw<Gif[]>([]);
const initialSearch = readSearchState(location.href);
let query = $state(initialSearch.query);
let tags = $state.raw(initialSearch.tags);
let tagFilters: HTMLDivElement;
let searchError = $state('');
let loadError = $state('');
let loading = $state(true);
let searching = $state(false);
let playing = $state(!matchMedia('(prefers-reduced-motion: reduce)').matches);
let selected = $state<Gif | null>(null);
let message = $state('');
let manualLink = $state('');
let downloading = $state.raw<string[]>([]);
let helpOpen = $state(false);
let shortcuts = $state(true);
let theme = $state<Theme>(readTheme());
let input: HTMLInputElement;
let help: HTMLDetailsElement;
let editing = false;
let noticeTimer: ReturnType<typeof setTimeout>;
const controller = new AbortController();
const themes: Theme[] = ['system', 'light', 'dark'];
const themeLabels = { system: 'Podle systému', light: 'Světlý', dark: 'Tmavý' };
const themeIcons = { system: '◧', light: '☀', dark: '☾' };
const nextTheme = $derived(themes[(themes.indexOf(theme) + 1) % themes.length]!);
const resultStatus = $derived.by(() => {
  if (loading) return 'Načítám…';
  if (loadError) return 'Katalog není dostupný';
  if (searching) return 'Hledám…';
  return results.length === gifs.length
    ? `${gifs.length} gifů`
    : `${results.length} / ${gifs.length} gifů`;
});
const builtAt = new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Prague',
}).format(new Date(__BUILD_TIME__));
const refreshedAt = new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'short',
  timeZone: 'Europe/Prague',
}).format(new Date(__DATA_CHECKED_AT__));

async function loadCatalog(): Promise<void> {
  loading = true;
  loadError = '';
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}catalog.json`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Katalog se nepodařilo načíst (HTTP ${response.status}).`);
    gifs = parseCatalog(await response.json());
  } catch (cause) {
    if (!controller.signal.aborted) {
      loadError = cause instanceof Error
        ? cause.message
        : 'Katalog se nepodařilo načíst.';
    }
  } finally {
    loading = false;
  }
}

onMount(() => {
  void loadCatalog();
  return () => {
    controller.abort();
    clearTimeout(noticeTimer);
  };
});

$effect(() => {
  const catalog = gifs;
  const value = query;
  const selectedTags = tags;
  searchError = '';
  if (!value.trim() && !selectedTags.length) {
    results = catalog;
    searching = false;
    return;
  }
  if (!catalog.length) return;
  searching = true;
  let worker: Worker | undefined;
  let deadline: ReturnType<typeof setTimeout>;
  const timer = setTimeout(() => {
    worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    const finish = ({ ids: matched, error }: SearchResult): void => {
      const ids = new Set(matched);
      results = catalog.filter((gif) => ids.has(gif.id));
      searchError = error;
      searching = false;
      clearTimeout(deadline);
      worker?.terminate();
    };
    const fail = (error: string): void => finish({ ids: [], error });
    const failToStart = (): void =>
      fail('Hledání se nepodařilo spustit. Zkuste upravit výraz nebo obnovit stránku.');
    worker.onerror = failToStart;
    deadline = setTimeout(failToStart, 10_000);
    worker.onmessage = (event: MessageEvent<SearchResult | 'ready'>): void => {
      if (event.data !== 'ready') {
        finish(event.data);
        return;
      }
      clearTimeout(deadline);
      deadline = setTimeout(
        () => fail('Výraz je příliš náročný (limit 1 s). Zjednodušte ho.'),
        1_000,
      );
      worker?.postMessage({ gifs: catalog, query: value, tags: selectedTags });
    };
  }, 120);
  return () => {
    clearTimeout(timer);
    clearTimeout(deadline);
    worker?.terminate();
  };
});

function updateQuery(value: string): void {
  query = value;
  const url = searchUrl(location.href, query, tags);
  if (url === location.href) return;
  if (editing) history.replaceState(null, '', url);
  else {
    history.pushState(null, '', url);
    editing = true;
  }
}

function restoreQuery(): void {
  editing = false;
  ({ query, tags } = readSearchState(location.href));
}

function updateTags(next: string[]): void {
  tags = next;
  editing = false;
  history.pushState(null, '', searchUrl(location.href, query, tags));
  // A clicked card may disappear when the AND filter narrows the results.
  // Keep a stable keyboard recovery point beside the active chips.
  if (tags.length) tagFilters.focus();
  else input.focus();
}

function toggleTag(tag: string): void {
  const key = tagKey(tag);
  updateTags(
    tags.some((selectedTag) => tagKey(selectedTag) === key)
      ? tags.filter((selectedTag) => tagKey(selectedTag) !== key)
      : [...tags, tag],
  );
}

function notify(text: string): void {
  clearTimeout(noticeTimer);
  message = text;
  manualLink = '';
  noticeTimer = setTimeout(() => {
    message = '';
  }, 7_000);
}

async function copyLink(gif: Gif): Promise<void> {
  try {
    await navigator.clipboard.writeText(gif.gif);
    notify('Odkaz na GIF zkopírován.');
  } catch {
    notify('Schránka není dostupná. Zkopírujte odkaz ručně:');
    clearTimeout(noticeTimer);
    manualLink = gif.gif;
  }
}

async function saveAnimation(gif: Gif): Promise<void> {
  if (downloading.includes(gif.id)) return;
  downloading = [...downloading, gif.id];
  try {
    const file = await fetchMedia(gif, 'gif', controller.signal);
    if (controller.signal.aborted) return;
    downloadFile(file);
    notify('Stahování GIFu zahájeno. Soubor lze kopírovat ze správce souborů.');
  } catch (cause) {
    if (!controller.signal.aborted) {
      notify(cause instanceof Error ? cause.message : 'GIF se nepodařilo stáhnout.');
    }
  } finally {
    downloading = downloading.filter((id) => id !== gif.id);
  }
}

function keydown(event: KeyboardEvent): void {
  if (selected || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape') {
    if (!document.querySelector('#site-info:popover-open')) helpOpen = false;
    return;
  }
  const target = event.target;
  if (
    target instanceof HTMLElement
    && (target.isContentEditable || target.closest('input, textarea, select, button, summary, a'))
  ) return;
  if (!shortcuts) return;
  if (event.key === '/') {
    event.preventDefault();
    input.focus();
  }
  if (event.key === '?') {
    event.preventDefault();
    helpOpen = !helpOpen;
    help.querySelector('summary')?.focus();
  }
}
</script>

<svelte:window onpopstate={restoreQuery} onkeydown={keydown} />

<a href="#search" class="skip">Přejít na hledání</a>
<main>
  <header>
    <h1>
      <a class="brand" href={import.meta.env.BASE_URL}>Cimrmanovy gify<span
          class="brand-dot"
          aria-hidden="true"
        >.</span></a>
    </h1>
    <div class="header-actions">
      <button
        class="quiet"
        onclick={() => {
          playing = !playing;
        }}
        aria-label={playing ? 'Pozastavit náhledy' : 'Přehrávat náhledy'}
        aria-pressed={playing}
      >
        {playing ? 'Ⅱ' : '▶'} <span>Náhledy</span>
      </button>
      <button
        class="theme-button quiet"
        onclick={() => {
          theme = nextTheme;
          setTheme(theme);
        }}
        aria-label={`${themeLabels[theme]}. Přepnout: ${themeLabels[nextTheme]}`}
        title={themeLabels[theme]}
      >
        {themeIcons[theme]}
      </button>
      <button
        class="info-button quiet"
        popovertarget="site-info"
        aria-label="O webu"
        title="O webu"
      >
        <Icon name="info" />
      </button>
      <aside id="site-info" popover="auto" aria-label="O webu">
        <div class="info-links">
          <a href="https://github.com/m-k-l-s/cimrman_gifs" target="_blank" rel="noreferrer"
          >GitHub ↗</a>
          <a
            href={`https://github.com/m-k-l-s/cimrman_gifs/commit/${__BUILD_REVISION__}`}
            target="_blank"
            rel="noreferrer"
            title={__BUILD_DIRTY__ ? 'Revize zdrojů; sestavení obsahuje lokální změny' : 'Revize zdrojů na GitHubu'}
          ><code>{__BUILD_REVISION__}{__BUILD_DIRTY__ ? '*' : ''}</code></a>
        </div>
        <p class="info-build">
          Sestavení <time datetime={__BUILD_TIME__} title="Europe/Prague">{builtAt}</time>
        </p>
      </aside>
    </div>
  </header>

  <section id="search" aria-label="Hledání gifů">
    <label class="sr-only" for="query">Hledat v hláškách</label>
    <div class="search-field">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input
        bind:this={input}
        id="query"
        type="search"
        value={query}
        oninput={(event) => updateQuery(event.currentTarget.value)}
        onblur={() => {
          editing = false;
        }}
        onkeydown={(event) => {
          if (event.key === 'Enter') editing = false;
          if (event.key === 'Escape') event.preventDefault();
        }}
        autocomplete="off"
        spellcheck="false"
        placeholder="Třeba: svěrák ^jak"
        aria-invalid={!!searchError}
        aria-describedby={searchError ? 'search-hint search-error' : 'search-hint'}
      />
      {#if query}<button
          class="clear"
          aria-label="Vymazat hledání"
          onclick={() => {
            editing = false;
            updateQuery('');
            input.focus();
          }}
        >
          ✕
        </button>{/if}
    </div>
    <div
      class="tag-filters"
      bind:this={tagFilters}
      tabindex="-1"
      role="group"
      aria-label="Vybrané štítky, všechny musí odpovídat"
    >
      {#if tags.length}
        <span class="filter-label">Všechny štítky:</span>
        {#each tags as tag (tagKey(tag))}
          <button
            class="filter-chip"
            onclick={() => toggleTag(tag)}
            aria-label={`Odebrat štítek: ${tag}`}
          >
            {tag} <span aria-hidden="true">×</span>
          </button>
        {/each}
        <button class="clear-tags" onclick={() => updateTags([])}>Zrušit štítky</button>
      {/if}
    </div>
    <div class="search-meta">
      <span id="results-count" role="status">{resultStatus}</span>
      <span id="search-hint" class="sr-only"
      >Regexy oddělené mezerou. Kliknutím na štítek zúžíte výběr.</span>
      <details bind:this={help} bind:open={helpOpen}>
        <summary>Nápověda</summary>
        <div class="help-content">
          <p>
            <strong>Hledání.</strong> Každý výraz musí odpovídat některému klíčovému
            slovu. <code>^jak$</code> najde samotné „jak“, <code>svěrák smoljak</code> oba
            herce, <code>pivo|vino</code> jednu z možností. Velká písmena ani diakritika
            nevadí. Příliš náročný regex se po 1 s zastaví. Vybrané štítky musí
            souhlasit všechny a zároveň platí hledaný výraz. Křížek odebere jeden štítek,
            Zrušit štítky ponechá text hledání. Štítky pod obrázkem lze posouvat do strany.
          </p>
          <p>
            <strong>Odkaz.</strong> Kopírování i sdílení používá přímý odkaz na GIF.
            Příjemce rozhoduje, zda zobrazí náhled.
          </p>
          <p>
            <strong>Pohyblivý obrázek.</strong> Kliknutí na GIF otevře možnosti. Stáhnout GIF
            uloží přímo animovaný soubor. Sdílet video připraví MP4 pro systémové
            sdílení nebo stažení. Na počítači lze stažený soubor kopírovat ze správce
            souborů. Limit stažení je 25 MiB na soubor.
          </p>
          <p>
            <strong>Klávesnice.</strong> <kbd>/</kbd> hledání, <kbd>?</kbd> nápověda, <kbd
            >Esc</kbd> zavře dialog. Běžné klávesy fungují i bez zkratek.
          </p>
          <label class="checkbox"><input type="checkbox" bind:checked={shortcuts} /> Povolit
            klávesové zkratky</label>
          <p>
            Gify: <a
              href="https://giphy.com/ceska_televize/cimrmani"
              target="_blank"
              rel="noreferrer"
            >Česká televize / Giphy</a> · aktualizováno <time datetime={__DATA_CHECKED_AT__}>{
              refreshedAt
            }</time>. Autor: <a href="https://github.com/m-k-l-s">Mikuláš Zelinka</a>.
          </p>
        </div>
      </details>
    </div>
  </section>

  {#if loadError}
    <div class="empty-state" role="alert">
      <p>{loadError}</p>
      <button onclick={loadCatalog}>Zkusit znovu</button>
    </div>
  {:else if !loading}
    {#if searchError}<p id="search-error" class="error" role="alert">{searchError}</p>{/if}
    {#if !results.length && !searching && !searchError}<p class="empty-state">
        Žádná hláška neodpovídá. Zkuste kratší výraz.
      </p>{/if}
    <div class="gallery" aria-busy={searching}>
      {#each results as gif (gif.id)}
        <GifCard
          {gif}
          playing={playing && selected === null}
          downloading={downloading.includes(gif.id)}
          {tags}
          ontag={toggleTag}
          oncopy={copyLink}
          onvideo={(item) => {
            selected = item;
          }}
          ondownload={saveAnimation}
        />
      {/each}
    </div>
  {/if}
</main>

<div class="notice" class:visible={!!message} role="status" aria-live="polite">
  {message}
  {#if manualLink}<input
      aria-label="Odkaz pro ruční zkopírování"
      readonly
      value={manualLink}
      onfocus={(event) => event.currentTarget.select()}
    />{/if}
  {#if message}<button
      onclick={() => {
        message = '';
        manualLink = '';
      }}
      aria-label="Zavřít oznámení"
    >
      ✕
    </button>{/if}
</div>
{#if selected}<MediaDialog
    gif={selected}
    onclose={() => {
      selected = null;
    }}
  />{/if}
