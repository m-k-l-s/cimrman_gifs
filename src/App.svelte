<script lang="ts">
import { onMount, tick } from 'svelte';
import { type Category, type Gif, parseCatalog } from './catalog';
import CategoryNav from './CategoryNav.svelte';
import { DEFAULT_CATEGORY, rememberCategory, rememberedCategory, shuffled } from './discovery';
import GifCard from './GifCard.svelte';
import Icon from './Icon.svelte';
import { downloadFile, fetchMedia, shareMediaFile } from './media';
import MediaDialog from './MediaDialog.svelte';
import { readSearchState, type SearchResult, searchUrl, tagKey } from './search';
import { readTheme, setTheme, type Theme } from './theme';

let gifs = $state.raw<Gif[]>([]);
const catalogReady = $derived(gifs.length > 0);
let categories = $state.raw<Category[]>([]);
let results = $state.raw<Gif[]>([]);
const initialSearch = readSearchState(location.href, DEFAULT_CATEGORY);
let query = $state(initialSearch.query);
let tags = $state.raw(initialSearch.tags);
let category = $state(initialSearch.category);
const pageSize = 96;
let visibleCount = $state(pageSize);
const visibleResults = $derived(results.slice(0, visibleCount));
const scopedGifs = $derived(
  category ? gifs.filter(gif => gif.categoryIds.includes(category)) : gifs,
);
const unknownCategory = $derived(!!category && !categories.some(item => item.id === category));
const categoryCounts = $derived.by(() => {
  const counts = new Map<string, number>();
  for (const gif of gifs) {
    for (const id of gif.categoryIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
});
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
  return results.length === scopedGifs.length
    ? `${scopedGifs.length} gifů`
    : `${results.length} / ${scopedGifs.length} gifů`;
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
    const loaded = parseCatalog(await response.json());
    categories = loaded.categories;
    gifs = shuffled(loaded.gifs);
    category = readSearchState(location.href, rememberedCategory(categories)).category;
    history.replaceState(null, '', searchUrl(location.href, { query, tags, category }));
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

$effect(() => rememberCategory(category, categories));

$effect(() => {
  const catalog = scopedGifs;
  const value = query;
  const selectedTags = tags;
  searchError = '';
  visibleCount = pageSize;
  if (!catalog.length || (!value.trim() && !selectedTags.length)) {
    results = catalog;
    searching = false;
    return;
  }
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
  const url = searchUrl(location.href, { query, tags, category: catalogReady ? category : null });
  if (url === location.href) return;
  if (editing) history.replaceState(null, '', url);
  else {
    history.pushState(null, '', url);
    editing = true;
  }
}

function restoreQuery(): void {
  editing = false;
  ({ query, tags, category } = readSearchState(
    location.href,
    catalogReady ? rememberedCategory(categories) : DEFAULT_CATEGORY,
  ));
  history.replaceState(
    null,
    '',
    searchUrl(location.href, { query, tags, category: catalogReady ? category : null }),
  );
}

function updateTags(next: string[]): void {
  tags = next;
  editing = false;
  history.pushState(
    null,
    '',
    searchUrl(location.href, { query, tags, category: catalogReady ? category : null }),
  );
  // Filtering may remove the card that opened the dialog.
  // Keep focus beside the active filters.
  if (tags.length) tagFilters.focus();
  else input.focus();
}

function updateCategory(value: string): void {
  if (value === category) return;
  category = value;
  editing = false;
  history.pushState(null, '', searchUrl(location.href, { query, tags, category }));
}

async function loadMore(): Promise<void> {
  const next = results[visibleCount];
  visibleCount += pageSize;
  await tick();
  if (next) {
    document.querySelector<HTMLButtonElement>(`article[data-id="${next.id}"] .preview`)?.focus();
  }
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

async function shareAnimation(file: File): Promise<void> {
  try {
    if (await shareMediaFile(file) && !controller.signal.aborted) {
      notify('Otevřeno systémové sdílení.');
    }
  } catch {
    if (!controller.signal.aborted) notify('Sdílení se nepodařilo. Zkuste stáhnout GIF.');
  }
}

function keydown(event: KeyboardEvent): void {
  if (selected || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape') {
    if (!document.querySelector('[popover]:popover-open')) helpOpen = false;
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

{#snippet playbackControl()}
  <button
    class="playback-button quiet"
    onclick={() => {
      playing = !playing;
    }}
    aria-label={playing ? 'Pozastavit náhledy' : 'Přehrávat náhledy'}
    aria-pressed={playing}
  >
    <span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span> Náhledy
  </button>
{/snippet}

{#snippet themeControl(expanded = false)}
  <button
    class="theme-button quiet"
    onclick={() => {
      theme = nextTheme;
      setTheme(theme);
    }}
    aria-label={`${themeLabels[theme]}. Přepnout: ${themeLabels[nextTheme]}`}
    title={themeLabels[theme]}
  >
    <span aria-hidden="true">{themeIcons[theme]}</span>
    {#if expanded}<span>{themeLabels[theme]}</span>{/if}
  </button>
{/snippet}

<a href="#search" class="skip">Přejít na hledání</a>
<main>
  <header>
    <h1>
      <a class="brand" href={import.meta.env.BASE_URL}>Gify ČT<span
          class="brand-dot"
          aria-hidden="true"
        >.</span></a>
    </h1>
    <CategoryNav
      {categories}
      counts={categoryCounts}
      {category}
      total={gifs.length}
      ready={catalogReady}
      onselect={updateCategory}
    />
    <div class="header-actions">
      <div class="desktop-settings">
        {@render playbackControl()}
        {@render themeControl()}
        <button
          class="info-button quiet"
          popovertarget="site-info"
          aria-label="O webu"
          title="O webu"
        >
          <Icon name="info" />
        </button>
      </div>
      <button
        id="mobile-settings"
        class="info-button quiet"
        popovertarget="site-info"
        aria-label="Nastavení"
        title="Nastavení"
      >
        <Icon name="settings" />
      </button>
      <aside id="site-info" popover="auto" aria-label="Nastavení a informace">
        <div class="mobile-controls">
          {@render playbackControl()}
          {@render themeControl(true)}
        </div>
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
            <strong>Hledání.</strong> Pořad zúží výběr a ponechá hledání i štítky.
            Každý výraz musí odpovídat názvu nebo některému klíčovému slovu. <code
            >^jak$</code> najde samotné „jak“, <code>svěrák smoljak</code> oba herce, <code
            >pivo|vino</code> jednu z možností. Velká písmena ani diakritika nevadí. Příliš
            náročný regex se po 1 s zastaví. Vybrané štítky musí souhlasit všechny a
            zároveň platí hledaný výraz. Křížek odebere jeden štítek, Zrušit štítky
            ponechá text hledání. Pořad a štítky vyberete také v detailu GIFu.
          </p>
          <p>
            <strong>Odkaz.</strong> Kopírování používá přímý odkaz na GIF. Příjemce
            rozhoduje, zda zobrazí náhled.
          </p>
          <p>
            <strong>Pohyblivý obrázek.</strong> V detailu vyberte video nebo GIF. Sdílení
            předá skutečný soubor systémové nabídce. Pokud není dostupné, soubor stáhněte
            a přiložte v cílové aplikaci. Na počítači ho lze také přetáhnout nebo
            zkopírovat ze správce souborů. U GIFu lze zkusit nabídku obrázku → Kopírovat
            obrázek. Animaci a způsob zobrazení určuje příjemce. Limit stažení je 25 MiB na
            soubor.
          </p>
          <p>
            <strong>Klávesnice.</strong> <kbd>/</kbd> hledání, <kbd>?</kbd> nápověda, <kbd
            >Esc</kbd> zavře dialog. Běžné klávesy fungují i bez zkratek.
          </p>
          <label class="checkbox"><input type="checkbox" bind:checked={shortcuts} /> Povolit
            klávesové zkratky</label>
          <p>
            Gify: <a
              href="https://giphy.com/ceska_televize"
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
        {
          unknownCategory
          ? 'Tato kategorie není dostupná. Zvolte jiný pořad.'
          : 'Žádná hláška neodpovídá. Zkuste jiný pořad nebo kratší výraz.'
        }
      </p>{/if}
    <div class="gallery" aria-busy={searching}>
      {#each visibleResults as gif (gif.id)}
        <GifCard
          {gif}
          playing={playing && selected === null}
          downloading={downloading.includes(gif.id)}
          oncopy={copyLink}
          onvideo={(item) => {
            selected = item;
          }}
          ondownload={saveAnimation}
          onshare={shareAnimation}
        />
      {/each}
    </div>
    {#if results.length > pageSize}
      <div class="more-results">
        <span id="rendered-count" role="status">Zobrazeno {visibleResults.length} z {
            results.length
          }</span>
        {#if visibleResults.length < results.length}
          <button id="load-more" onclick={loadMore} disabled={searching}>Načíst další</button>
        {/if}
      </div>
    {/if}
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
    categories={categories.filter(item => selected?.categoryIds.includes(item.id))}
    {tags}
    {category}
    ontag={async (tag) => {
      selected = null;
      await tick();
      toggleTag(tag);
    }}
    oncategory={async (id) => {
      selected = null;
      await tick();
      updateCategory(id);
      input.focus();
    }}
    onclose={() => {
      selected = null;
    }}
  />{/if}
