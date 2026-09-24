import { strict as assert } from 'node:assert';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { type Catalog, type Gif as Entry, parseCatalog } from '../src/catalog';

// Run after `bun run build`. All interaction uses the installed agent-browser CLI.
const root = resolve(import.meta.dir, '..');
const dist = resolve(root, 'dist');
let session = `cimrman-verify-${process.pid}`;
const initPath = resolve(root, 'artifacts', `browser-init-${process.pid}.js`);
type ResultOptions = {
  entries?: Entry[];
  categories?: Catalog['categories'];
  category?: string;
};
const BATCH = 96;
const LEGACY_CATEGORY = 'cimrmani';
const PRIMARY_CATEGORIES = ['cimrmani', 'osada', 'pelisky', 'tomas-holy'];
const CATEGORY_STORAGE = 'cimrman-category';
const PIN_STORAGE = 'cimrman-pins';
const BAR_CATEGORIES =
  'header .category-nav .category-item > .category-button, header .category-nav > button[data-category=""]';
const COMPACT_CATEGORIES = '(max-width: 600px), (pointer: coarse)';
// Deterministic random sources exercise shuffle boundaries without product test hooks.
const browserInit = `(() => {
  let rotate = false, blocked = false;
  try {
    rotate = sessionStorage.getItem('__smoke-shuffle') === 'rotate';
    blocked = sessionStorage.getItem('__smoke-block-storage') === 'true';
  } catch {}
  Math.random = () => rotate ? 0 : 1 - Number.EPSILON;
  if (blocked) Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Storage blocked for smoke test', 'SecurityError'); }
  });
})();`;
let rotateCatalog = false;
type BrowserData = {
  result?: unknown;
  refs?: Record<string, { role: string; name: string }>;
};

assert(await Bun.file(resolve(dist, 'index.html')).exists(), 'Build first: bun run build');
const dataset = parseCatalog(await Bun.file(resolve(dist, 'catalog.json')).json());
assert(
  Array.isArray(dataset.gifs) && Array.isArray(dataset.categories),
  'Build the categorized catalog first',
);
const catalog = dataset.gifs;
assert(catalog.length > 0, 'The built catalog must contain clips');
assert(
  dataset.categories.some(category => category.id === LEGACY_CATEGORY),
  'The historical category must remain available',
);
const fixture = catalog.find(entry => entry.id === 'H35lI7mvlYpfZpJB2m');
assert(fixture, 'The historical browser fixture must remain in the catalog');
assert(
  ['ja', 'smoljak', 'jidlo'].every(tag => fixture.keywords.includes(tag)),
  'The browser fixture must retain its curated tags',
);
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await Bun.write(initPath, browserInit);
let catalogResponse: Response | undefined;
let catalogGate: Promise<void> | undefined;
let workerDelayMs = 0;
let delayedWorkerRequests = 0;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === '/catalog.json' && catalogGate) await catalogGate;
    if (pathname === '/catalog.json' && catalogResponse) return catalogResponse.clone();
    if (workerDelayMs && /^\/assets\/search\.worker-[^/]+\.js$/.test(pathname)) {
      delayedWorkerRequests++;
      await Bun.sleep(workerDelayMs);
    }
    const path = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(`${dist}${sep}`)) return new Response('Not found', { status: 404 });
    const file = Bun.file(path);
    return await file.exists()
      ? new Response(file, { headers: { 'Cache-Control': 'no-store' } })
      : new Response('Not found', { status: 404 });
  },
});
const origin = server.url.origin;

async function browser(...args: string[]): Promise<BrowserData> {
  const operation = args[0] === 'wait' ? args.join(' ') : args.slice(0, 2).join(' ');
  const child = Bun.spawn({
    cmd: [
      'agent-browser',
      '--session',
      session,
      '--headed',
      'false',
      '--json',
      '--init-script',
      initPath,
      ...args,
    ],
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    // Kill this command's wrapper and native CLI child, never another browser session.
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGKILL');
    } catch { /* The command may have just exited. */ }
  }, 45_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert(!timedOut, `agent-browser ${operation} exceeded the 45-second command limit`);
    assert.equal(code, 0, `agent-browser ${operation} failed: ${stdout}\n${stderr}`);
    const response = JSON.parse(stdout) as { success: boolean; error: unknown; data: BrowserData };
    assert(response.success, `agent-browser ${operation}: ${JSON.stringify(response.error)}`);
    return response.data;
  } finally {
    clearTimeout(watchdog);
  }
}

async function evaluate<T>(script: string): Promise<T> {
  return (await browser('eval', '-b', Buffer.from(script).toString('base64'))).result as T;
}

async function ref(role: string, name: string | RegExp): Promise<string> {
  const { refs } = await browser('snapshot', '-i');
  const match = Object.entries(refs ?? {}).find(([, element]) =>
    (element.role === role || (role === 'textbox' && element.role === 'searchbox'))
    && (typeof name === 'string' ? element.name === name : name.test(element.name))
  );
  assert(match, `Missing ${role}: ${name}`);
  return `@${match[0]}`;
}

async function click(name: string | RegExp): Promise<void> {
  await browser('click', await ref('button', name));
}

const compactCategories = () =>
  evaluate<boolean>(`matchMedia(${JSON.stringify(COMPACT_CATEGORIES)}).matches`);

async function chooseCategory(category: string): Promise<void> {
  const compact = await compactCategories();
  const shortcut = category
    ? `header .category-nav .category-item > .category-button[data-category=${
      JSON.stringify(category)
    }]`
    : 'header .category-nav > button[data-category=""]';
  if (
    !compact && await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(shortcut)})`)
  ) {
    await browser('focus', shortcut);
    await browser('press', 'Enter');
  } else {
    await browser('focus', '#category');
    await browser('press', 'Enter');
    await wait(`!!document.querySelector('#category-menu:popover-open')`);
    await browser('focus', `#category-menu button[data-category=${JSON.stringify(category)}]`);
    await browser('press', 'Enter');
    await wait(`!document.querySelector('#category-menu:popover-open') &&
      document.activeElement === document.querySelector(${
      JSON.stringify(compact ? '#category' : shortcut)
    })`);
  }
}

async function wait(condition: string): Promise<void> {
  // Native wait can stall its daemon; CLI eval plus a host-side pause leaves the page responsive.
  const deadline = performance.now() + 25_000;
  while (performance.now() < deadline) {
    if (await evaluate<boolean>(condition)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Browser condition did not become true within 25 seconds: ${condition}`);
}
const label = (entry: Entry) => entry.keywords.join(' · ') || entry.title || 'Gif České televize';
const normalized = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function expectedEntries(query: string, tags: string[], entries: Entry[]): Entry[] {
  const patterns = query.trim().split(/\s+/).filter(Boolean)
    .map((word) => new RegExp(normalized(word), 'i'));
  return entries.filter((entry) =>
    tags.every((tag) =>
      entry.keywords.some((word) =>
        normalized(word).trim().toLowerCase() === normalized(tag).trim().toLowerCase()
      )
    ) && patterns.every((pattern) =>
      [entry.title, ...entry.keywords].some(word =>
        word && pattern.test(normalized(word))
      )
    )
  );
}

async function results(
  query: string,
  tags: string[] = [],
  options: ResultOptions = {},
): Promise<void> {
  const {
    entries = catalog,
    categories = dataset.categories,
    category = LEGACY_CATEGORY,
  } = options;
  const compact = await compactCategories();
  const categoryLabel = category
    ? categories.find(item => item.id === category)?.label ?? 'Neznámý pořad'
    : 'Vše';
  // Fisher–Yates with zero rotates left once; a value just below one leaves order intact.
  const ordered = rotateCatalog && entries.length ? [...entries.slice(1), entries[0]!] : entries;
  const scoped = category ? ordered.filter(entry => entry.categoryIds.includes(category)) : ordered;
  const matches = expectedEntries(query, tags, scoped);
  const count = matches.length === scoped.length
    ? `${scoped.length} gifů`
    : `${matches.length} / ${scoped.length} gifů`;
  const condition = `
    document.querySelector('#query')?.value === ${JSON.stringify(query)} &&
    (new URL(location.href).searchParams.get('q') ?? '') === ${JSON.stringify(query)} &&
    new URL(location.href).searchParams.get('category') === ${JSON.stringify(category)} &&
    document.querySelector('#category')?.tagName === 'BUTTON' &&
    JSON.stringify(new URL(location.href).searchParams.getAll('tag')) === JSON.stringify(${
    JSON.stringify(tags)
  }) &&
    !document.querySelector('#search-error') &&
    document.querySelectorAll('article.gif-card').length === ${matches.length} &&
    document.querySelector('#results-count')?.textContent.trim() === ${JSON.stringify(count)}
  `;
  await wait(condition);
  assert.deepEqual(
    await evaluate(`({
      ids: Array.from(document.querySelectorAll('article.gif-card'), card => card.dataset.id),
      labels: Array.from(document.querySelectorAll('article.gif-card'), card => card.getAttribute('aria-label')),
      tags: Array.from(document.querySelectorAll('.tag-filters button[aria-label]'), button =>
        button.getAttribute('aria-label').replace('Odebrat štítek: ', '')),
      rendered: document.querySelector('#rendered-count')?.textContent.trim().replace(/\\s+/g, ' ') ?? null,
      more: !!document.querySelector('#load-more'),
      primaryState: [...document.querySelectorAll(${
      JSON.stringify(BAR_CATEGORIES)
    })].filter(button => button.checkVisibility()).every(button =>
        button.getAttribute('aria-pressed') === String(button.dataset.category === ${
      JSON.stringify(category)
    })),
      activeCategories: [...document.querySelectorAll(${JSON.stringify(BAR_CATEGORIES)})]
        .filter(button => button.checkVisibility() && button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.category),
      menuTarget: document.querySelector('#category').getAttribute('popovertarget'),
      pickerLabel: document.querySelector('#category').getAttribute('aria-label')
    })`),
    {
      ids: matches.map(entry => entry.id),
      labels: matches.map(label),
      tags,
      rendered: null,
      more: false,
      primaryState: true,
      activeCategories: !compact && (!category || categories.some(item => item.id === category))
        ? [category]
        : [],
      menuTarget: 'category-menu',
      pickerLabel: compact ? `Vybrat pořad: ${categoryLabel}` : 'Další pořady',
    },
    `Results for ${JSON.stringify({ query, tags, category })}`,
  );
}

async function search(
  query: string,
  tags: string[] = [],
  options: ResultOptions = {},
): Promise<void> {
  await browser('fill', '#query', query);
  await results(query, tags, options);
  await browser('press', 'Enter');
}

async function lazyMedia(): Promise<void> {
  // The preloading margin is wider than the playback viewport. Inspect shell geometry because
  // content-visibility may skip the layout of a far-away card's children.
  await wait(
    `document.querySelectorAll('article video[src], article img[src]:not(.native-image)').length > 0 &&
    [...document.querySelectorAll('article video, article img:not(.native-image), article .quick-actions')].every(item => {
      const box = item.closest('article').getBoundingClientRect();
      return box.bottom >= -601 && box.top <= innerHeight + 601;
    }) && [...document.querySelectorAll('article video')].every(video => {
      const box = video.closest('article').getBoundingClientRect();
      return (box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth)
        || video.paused;
    })`,
  );
  const state = await evaluate<{ shells: number; mounted: number; actions: number }>(`({
    shells: document.querySelectorAll('article.gif-card').length,
    mounted: document.querySelectorAll('article video, article img:not(.native-image)').length,
    actions: document.querySelectorAll('article .quick-actions').length
  })`);
  assert(state.mounted < state.shells, 'Distant shells should contain no mounted media');
  assert.equal(state.actions, state.mounted, 'Quick actions mount only with nearby media');
  console.log(`  lazy media: ${state.mounted}/${state.shells} shells mounted near the viewport`);
}

async function continuousGallery(): Promise<void> {
  const ids = () =>
    evaluate<string[]>(
      `Array.from(document.querySelectorAll('article.gif-card'), card => card.dataset.id)`,
    );
  const before = await ids();
  await browser('scrollintoview', 'article.gif-card:last-child');
  await wait(`(() => {
    const card = document.querySelector('article.gif-card:last-child');
    const box = card.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight + 1 && !!card.querySelector('video, img:not(.native-image)');
  })()`);
  assert.deepEqual(
    await ids(),
    before,
    'Normal scrolling reaches the final clip without changing order',
  );
  await lazyMedia();
  await browser('scrollintoview', '#query');
}

async function noOverflow(): Promise<void> {
  assert(
    await evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth'),
    'Horizontal overflow',
  );
}

async function categoryControls(
  categories = dataset.categories,
  entries = catalog,
  pins = PRIMARY_CATEGORIES,
  retainedOrder?: string[],
): Promise<void> {
  const active = await evaluate<string>(
    `new URL(location.href).searchParams.get('category') ?? ''`,
  );
  const compact = await compactCategories();
  const pinned = pins.filter(id => categories.some(category => category.id === id));
  const barIds = retainedOrder ? [...retainedOrder] : [...pinned];
  if (
    !retainedOrder && active && !pinned.includes(active)
    && categories.some(category => category.id === active)
  ) {
    barIds.push(active);
  }
  await wait(
    `JSON.stringify([...document.querySelectorAll('header .category-item > .category-button')].filter(button => button.checkVisibility()).map(button => button.dataset.category)) === ${
      JSON.stringify(JSON.stringify(compact ? [] : barIds))
    } &&
    !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.target instanceof Element && animation.effect.target.closest('.category-item'))`,
  );
  const count = (id: string) => entries.filter(entry => entry.categoryIds.includes(id)).length;
  const entertainment = (id: string) =>
    id === 'stardance' || id.startsWith('stardance-')
    || ['vecernicek', 'pece-cela-zeme', 'chi-chi-na-gauci'].includes(id);
  const alphabetical = (a: Catalog['categories'][number], b: Catalog['categories'][number]) =>
    a.label.localeCompare(b.label, 'cs');
  const pinState = (category: Catalog['categories'][number]) => ({
    id: category.id,
    pressed: String(pinned.includes(category.id)),
    label: `${pinned.includes(category.id) ? 'Odepnout' : 'Připnout'} pořad: ${category.label}`,
  });
  const remaining = compact
    ? categories.filter(category => !pinned.includes(category.id))
    : categories;
  const groups = [
    ...(compact
      ? [{
        id: 'pinned',
        label: 'Oblíbené',
        categories: pinned.map(id => categories.find(category => category.id === id)!),
      }]
      : []),
    {
      id: 'stories',
      label: 'Filmy a seriály',
      categories: remaining.filter(category => !entertainment(category.id))
        .sort((a, b) => count(b.id) - count(a.id) || alphabetical(a, b)),
    },
    {
      id: 'other',
      label: 'Zábava a dětské pořady',
      categories: remaining.filter(category => entertainment(category.id)).sort(alphabetical),
    },
  ].filter(group => group.categories.length).map(group => ({
    id: group.id,
    label: group.label,
    options: group.categories.map(category => ({
      id: category.id,
      label: `Zvolit pořad: ${category.label}`,
      count: String(count(category.id)),
      pin: { ...pinState(category), text: pinned.includes(category.id) ? 'Odepnout' : 'Připnout' },
    })),
  }));
  assert.deepEqual(
    await evaluate(`(() => {
      const pin = button => ({id: button.dataset.pin, pressed: button.getAttribute('aria-pressed'), label: button.getAttribute('aria-label')});
      return {
        bar: Array.from(document.querySelectorAll(${
      JSON.stringify(BAR_CATEGORIES)
    })).filter(button => button.checkVisibility()).map(button =>
          ({ id: button.dataset.category, label: button.textContent.trim() })),
        barPins: ${
      compact
        ? '[]'
        : "Array.from(document.querySelectorAll('header .category-nav .category-item > .pin-toggle'), pin)"
    },
        barPinPosition: ${
      compact
        ? '[]'
        : "Array.from(document.querySelectorAll('header .category-nav .category-item > .pin-toggle'), button => getComputedStyle(button).position)"
    },
        order: Array.from(document.querySelectorAll('header .category-nav .category-item > .category-button, header .category-nav > button')).filter(button => button.checkVisibility()).map(
          button => button.id === 'category' ? '#category' : button.dataset.category),
        allPin: !!document.querySelector('.pin-toggle[data-pin=""]'),
        menuAll: document.querySelector('#category-menu button[data-category]')?.dataset.category,
        menuAllLabel: document.querySelector('#category-menu button[data-category=""]')?.getAttribute('aria-label'),
        groups: Array.from(document.querySelectorAll('#category-menu .category-group')).map(group => ({
          id: group.dataset.group,
          label: document.getElementById(group.getAttribute('aria-labelledby')).textContent.trim(),
          options: Array.from(group.querySelectorAll('button[data-category]'), button => ({
            id: button.dataset.category, label: button.getAttribute('aria-label'),
            count: String(parseInt(button.parentElement.querySelector('.category-count').textContent, 10)),
            pin: {...pin(button.parentElement.querySelector('.pin-toggle')), text: button.parentElement.querySelector('.pin-toggle').textContent.trim()}
          }))
        }))
      };
    })()`),
    {
      bar: compact ? [] : [{ id: '', label: 'Vše' }].concat(
        barIds.map(id => ({ id, label: categories.find(category => category.id === id)!.label })),
      ),
      barPins: compact
        ? []
        : barIds.map(id => pinState(categories.find(category => category.id === id)!)),
      barPinPosition: compact ? [] : barIds.map(() => 'absolute'),
      order: compact ? ['#category'] : ['', ...barIds, '#category'],
      allPin: false,
      menuAll: '',
      menuAllLabel: 'Zvolit pořad: Vše',
      groups,
    },
    'Pinned and temporary active categories match the bar; the popover retains every grouped category',
  );
}

async function headerLayout(): Promise<void> {
  assert(
    await evaluate(`(() => {
    const brand = document.querySelector('header .brand').getBoundingClientRect();
    const nav = document.querySelector('header .category-nav');
    const box = nav.getBoundingClientRect();
    const actions = document.querySelector('header .header-actions').getBoundingClientRect();
    const compact = matchMedia(${JSON.stringify(COMPACT_CATEGORIES)}).matches;
    const controls = [...nav.querySelectorAll('button')].filter(button => button.checkVisibility() && !button.closest('#category-menu'));
    return Math.max(brand.top, box.top, actions.top) < Math.min(brand.bottom, box.bottom, actions.bottom) &&
      brand.left >= 0 && brand.right <= box.left + 1 && box.right <= actions.left + 1 &&
      actions.right <= innerWidth && box.width > 0 && (compact
        ? controls.length === 1 && controls[0].id === 'category'
        : ['auto', 'scroll'].includes(getComputedStyle(nav).overflowX));
  })()`),
    'Header stays on one row with visible brand/actions and contained category scrolling',
  );
  await noOverflow();
}

async function keyboardCategories(): Promise<void> {
  if (await compactCategories()) {
    await chooseCategory('');
    await results('', [], { category: '' });
    await chooseCategory(LEGACY_CATEGORY);
    await results('');
    return;
  }
  const count = await evaluate<number>(
    `document.querySelectorAll('header .category-nav button').length`,
  );
  await browser('focus', 'header .category-nav > button[data-category=""]');
  await browser('press', 'Enter');
  await results('', [], { category: '' });
  let reachedMore = false;
  for (let index = 0; index <= count; index++) {
    await wait(`(() => {
      const nav = document.querySelector('header .category-nav');
      const active = document.activeElement;
      const box = active.getBoundingClientRect(), bounds = nav.getBoundingClientRect();
      return nav.contains(active) && active.tagName === 'BUTTON' && box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
    })()`);
    if (
      await evaluate<boolean>(
        `document.activeElement.id === 'category'`,
      )
    ) {
      reachedMore = true;
      break;
    }
    await browser('press', 'Tab');
  }
  assert(reachedMore, 'Keyboard starts at Vše and reaches Další after category and pin controls');
  await chooseCategory(LEGACY_CATEGORY);
  await results('');
}

async function galleryCards(): Promise<void> {
  assert.equal(
    await evaluate(
      `document.querySelectorAll('article .keywords, article .tag, article .open-mark').length`,
    ),
    0,
    'Gallery cards have no tag rows or three-dot markers',
  );
  if (!await compactCategories()) {
    assert(
      await evaluate(`[...document.querySelectorAll('article .native-image')]
        .every(image => !image.checkVisibility())`),
      'Desktop previews have no native-image interaction overlay',
    );
  }
  await noOverflow();
}

async function hoverPlayback(): Promise<void> {
  const control = '.desktop-settings .playback-button';
  assert(
    await evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(control)});
      return !button.textContent.trim() && !!button.querySelector('svg') &&
        !!button.getAttribute('aria-label') && !!button.title &&
        getComputedStyle(document.querySelector('.header-actions')).borderInlineStartWidth === '0px';
    })()`),
    'Desktop autoplay uses an accessible icon without text or a header divider',
  );
  const wasPlaying = await evaluate<boolean>(
    `document.querySelector(${JSON.stringify(control)}).getAttribute('aria-pressed') === 'true'`,
  );
  if (wasPlaying) await browser('click', control);
  const card = 'article.gif-card:first-child';
  const media = `${card} .media`;
  const preview = `${card} .preview`;
  const paused = `[...document.querySelectorAll('article video')].every(video => video.paused) &&
    [...document.querySelectorAll('article img:not(.native-image)')]
      .every(image => image.src.endsWith('200w_s.gif'))`;
  await wait(paused);
  await browser('hover', preview);
  await wait(`(() => {
    const target = document.querySelector('${preview} video, ${preview} img:not(.native-image)');
    return target instanceof HTMLVideoElement ? !target.paused && target.readyState >= 2
      : target?.src.endsWith('200w.webp');
  })()`);
  assert(
    await evaluate(`[...document.querySelectorAll('article:not(:first-child) video')]
      .every(video => video.paused) &&
      [...document.querySelectorAll('article:not(:first-child) img:not(.native-image)')]
        .every(image => image.src.endsWith('200w_s.gif'))`),
    'Hover plays only the selected preview while autoplay stays paused',
  );
  await browser('hover', '#query');
  await wait(paused);
  // A touch pointer entering a card must not leave a sticky hover override.
  await evaluate(`(async () => {
    document.querySelector('${media}').dispatchEvent(new PointerEvent('pointerenter', {
      pointerType: 'touch', bubbles: false
    }));
    await new Promise(requestAnimationFrame);
  })()`);
  assert(await evaluate(paused), 'Touch entry leaves globally paused previews still');
  await browser('hover', preview);
  await browser('click', preview);
  await wait(`!!document.querySelector('dialog[open]') && (${paused})`);
  // Keep an explicit hover behind the modal to test suspension independently of hit testing.
  await evaluate(`(async () => {
    document.querySelector('${media}').dispatchEvent(new PointerEvent('pointerenter', {
      pointerType: 'mouse', bubbles: false
    }));
    await new Promise(requestAnimationFrame);
  })()`);
  assert(await evaluate(paused), 'An open detail suspends even a hovered gallery preview');
  await browser('press', 'Escape');
  await wait(`!document.querySelector('dialog')`);
  await browser('hover', preview);
  await browser('hover', '#query');
  await wait(paused);
  if (wasPlaying) await browser('click', control);
  console.log(
    '✓ Paused previews play on mouse hover, stop on exit, and respect touch and dialog suspension',
  );
}

async function nativeGalleryContext(): Promise<void> {
  assert(await compactCategories(), 'Native image gesture coverage needs a compact viewport');
  await browser('scrollintoview', 'article.gif-card:first-child');
  await wait(`document.querySelectorAll('article .native-image').length >= 2`);
  assert.equal(
    await evaluate(`document.querySelectorAll('article .native-image[src]').length`),
    0,
    'Browsing leaves every original-image interaction layer without a source',
  );
  const ids = await evaluate<string[]>(`[...document.querySelectorAll('article .native-image')]
    .slice(0, 2).map(image => image.closest('article').dataset.id)`);
  for (const id of ids) {
    const entry = catalog.find(item => item.id === id);
    assert(entry, 'Native context target belongs to the loaded catalog');
    const selector = `article[data-id=${JSON.stringify(id)}] .native-image`;
    await browser('scrollintoview', selector);
    const point = await evaluate<{ x: number; y: number }>(`(() => {
      const image = document.querySelector(${JSON.stringify(selector)});
      const box = image.getBoundingClientRect();
      window.__nativeTarget = image;
      window.__nativeContext = null;
      window.addEventListener('contextmenu', event => {
        window.__nativeContext = { tag: event.target.tagName, trusted: event.isTrusted,
          sameTarget: event.target === image, source: event.target.currentSrc || event.target.src,
          prevented: event.defaultPrevented };
      }, { once: true });
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    await browser('mouse', 'move', String(Math.round(point.x)), String(Math.round(point.y)));
    await browser('mouse', 'down', 'right');
    await browser('mouse', 'up', 'right');
    await wait('!!window.__nativeContext');
    assert.deepEqual(await evaluate('window.__nativeContext'), {
      tag: 'IMG',
      trusted: true,
      sameTarget: true,
      source: entry.gif,
      prevented: false,
    });
    assert.deepEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('article .native-image[src]'), image => image.src)`,
      ),
      [entry.gif],
      'Only the selected original GIF is assigned to the native interaction layer',
    );
    assert(await evaluate(`!document.querySelector('dialog')`));
    assert(
      await evaluate(`(() => {
        window.__nativeTarget.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 1}));
        return !document.querySelector('dialog');
      })()`),
      'A compatibility click from the context gesture must not open the detail dialog',
    );
    await browser('press', 'Escape');
  }
  const preview = `article[data-id=${JSON.stringify(ids[1])}] .preview`;
  // A fresh pointer gesture and a keyboard activation both retain the detail fallback.
  for (const keyboard of [true, false]) {
    if (keyboard) {
      await browser('focus', preview);
      await browser('press', 'Enter');
    } else await browser('click', preview);
    await wait(`!!document.querySelector('dialog[open]')`);
    await click('Zavřít');
    await wait(`!document.querySelector('dialog') &&
      document.activeElement === document.querySelector(${JSON.stringify(preview)})`);
  }
  await browser('scrollintoview', 'article.gif-card:last-child');
  await wait(`!document.querySelector('article .native-image[src]') &&
    !window.__nativeTarget.isConnected && !window.__nativeTarget.hasAttribute('src')`);
  await browser('scrollintoview', '#query');
  await evaluate('delete window.__nativeContext; delete window.__nativeTarget');
  console.log(
    '✓ Trusted contextmenu targets one original GIF; tap/keyboard fallback and far cleanup remain intact',
  );
}

async function infoPopover(): Promise<void> {
  const mobile = await evaluate<boolean>('innerWidth <= 600');
  const trigger = mobile ? '#mobile-settings' : '.desktop-settings [popovertarget="site-info"]';
  assert(
    await evaluate(`!document.querySelector('footer')`),
    'Build information belongs in the header popover',
  );
  assert.deepEqual(
    await evaluate(
      `Array.from(document.querySelectorAll('header .header-actions button')).filter(button =>
      !button.closest('[popover]') && button.checkVisibility()).map(button => button.id === 'mobile-settings')`,
    ),
    mobile ? [true] : [false, false, false],
    'Mobile has one settings button; desktop keeps playback, theme and information inline',
  );
  if (mobile) await ref('button', 'Nastavení');
  await browser('click', trigger);
  await wait(`!!document.querySelector('#site-info:popover-open')`);
  assert(
    await evaluate(`(() => {
    const info = document.querySelector('#site-info');
    const repository = info.querySelector('a[href="https://github.com/m-k-l-s/cimrman_gifs"]');
    const revision = info.querySelector('a[href^="https://github.com/m-k-l-s/cimrman_gifs/commit/"]');
    const time = info.querySelector('time[datetime]');
    const box = info.getBoundingClientRect();
    return !!repository && !!revision?.querySelector('code') && !!time &&
      !Number.isNaN(Date.parse(time.dateTime)) && box.left >= 0 && box.right <= innerWidth;
  })()`),
    'Information popover has repository/revision links, build time, and fits the viewport',
  );
  if (mobile) {
    const playback = '#site-info .mobile-controls .playback-button';
    const initialPlaying = await evaluate(
      `document.querySelector(${JSON.stringify(playback)}).getAttribute('aria-pressed')`,
    );
    await browser('click', playback);
    assert.notEqual(
      await evaluate(
        `document.querySelector(${JSON.stringify(playback)}).getAttribute('aria-pressed')`,
      ),
      initialPlaying,
    );
    await browser('click', playback);
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(playback)}).getAttribute('aria-pressed')`,
      ),
      initialPlaying,
    );
    const initialTheme = await evaluate<string>('document.documentElement.dataset.theme');
    const themes = new Set<string>();
    for (let index = 0; index < 3; index++) {
      await browser('click', '#site-info .mobile-controls .theme-button');
      themes.add(await evaluate<string>('document.documentElement.dataset.theme'));
    }
    assert.deepEqual([...themes].sort(), ['dark', 'light', 'system']);
    assert.equal(await evaluate('document.documentElement.dataset.theme'), initialTheme);
  }
  await browser('press', 'Escape');
  await wait(`!document.querySelector('#site-info:popover-open') &&
    document.activeElement === document.querySelector(${JSON.stringify(trigger)})`);
  if (mobile) {
    await browser('click', trigger);
    await wait(`!!document.querySelector('#site-info:popover-open')`);
    assert(
      await evaluate(
        `!document.querySelector('#site-info').contains(document.elementFromPoint(1, 1))`,
      ),
    );
    await browser('mouse', 'move', '1', '1');
    await browser('mouse', 'down');
    await browser('mouse', 'up');
    await wait(`!document.querySelector('#site-info:popover-open')`);
  }
}

async function dialogDetails(entry = fixture!, categories = dataset.categories): Promise<void> {
  const defaultGif = await compactCategories()
    || new URL(entry.url).pathname.startsWith('/stickers/');
  const filters = await evaluate<{ tags: string[]; category: string }>(`({
    tags: new URL(location.href).searchParams.getAll('tag'),
    category: new URL(location.href).searchParams.get('category') ?? ''
  })`);
  const key = (value: string) => normalized(value).trim().toLowerCase();
  assert.deepEqual(
    await evaluate(`({
      categories: Array.from(document.querySelectorAll('dialog .gif-categories button'), button => ({
        label: button.getAttribute('aria-label'), pressed: button.getAttribute('aria-pressed')
      })).sort((a, b) => a.label.localeCompare(b.label)),
      tags: Array.from(document.querySelectorAll('dialog .detail-tags button'), button => ({
        label: button.getAttribute('aria-label'), pressed: button.getAttribute('aria-pressed')
      })),
      formats: Array.from(document.querySelectorAll('dialog .format-picker [data-format]'), button => ({
        format: button.dataset.format, label: button.textContent.trim(), pressed: button.getAttribute('aria-pressed')
      })),
      emptyCategory: document.querySelector('dialog .gif-categories').textContent.trim() === 'Bez zařazení',
      wrapped: document.querySelector('dialog .detail-tags')
        ? getComputedStyle(document.querySelector('dialog .detail-tags')).flexWrap === 'wrap'
        : document.querySelector('dialog .gif-details').textContent.includes('Bez štítků'),
      contained: Array.from(document.querySelectorAll('dialog .gif-details li')).every(item => {
        const box = item.getBoundingClientRect();
        const dialog = item.closest('dialog').getBoundingClientRect();
        return box.left >= dialog.left && box.right <= dialog.right;
      })
    })`),
    {
      categories: categories.filter(category => entry.categoryIds.includes(category.id))
        .map(category => ({
          label: `Filtrovat pořad: ${category.label}`,
          pressed: String(filters.category === category.id),
        })).sort((a, b) => a.label.localeCompare(b.label)),
      tags: entry.keywords.map(tag => ({
        label: `Filtrovat štítek: ${tag}`,
        pressed: String(filters.tags.some(selected => key(selected) === key(tag))),
      })),
      formats: ['mp4', 'gif'].map(format => ({
        format,
        label: format === 'mp4' ? 'Video (MP4)' : 'GIF',
        pressed: String(format === (defaultGif ? 'gif' : 'mp4')),
      })),
      emptyCategory: entry.categoryIds.length === 0,
      wrapped: true,
      contained: true,
    },
    'Details expose every effective tag/category as a filter with the current pressed state',
  );
}

async function originalGifImage(entry = fixture!): Promise<void> {
  const compact = await compactCategories();
  const selected = await evaluate<boolean>(
    `document.querySelector('dialog [data-format="gif"]')?.getAttribute('aria-pressed') === 'true'`,
  );
  if (!selected) {
    await browser('focus', 'dialog .format-picker [data-format="gif"]');
    await browser('press', 'Enter');
  }
  await wait(`document.querySelector('dialog img')?.complete &&
    document.querySelector('dialog img')?.naturalWidth > 0 &&
    (${selected} || document.activeElement === document.querySelector('dialog img'))`);
  assert.deepEqual(
    await evaluate(`({
      src: document.querySelector('dialog img').src,
      currentSrc: document.querySelector('dialog img').currentSrc,
      alt: document.querySelector('dialog img').alt,
      describedBy: document.querySelector('dialog img').getAttribute('aria-describedby'),
      belowHeading: document.querySelector('dialog img').getBoundingClientRect().top >=
        document.querySelector('dialog .dialog-heading').getBoundingClientRect().bottom,
      video: !!document.querySelector('dialog video'),
      hint: document.querySelector('#image-copy-hint')?.textContent.trim(),
      imageFirst: !${compact} ||
        (document.querySelector('dialog img').getBoundingClientRect().bottom <=
          document.querySelector('dialog .format-picker').getBoundingClientRect().top &&
        document.querySelector('#image-copy-hint').getBoundingClientRect().bottom <=
          document.querySelector('dialog .format-picker').getBoundingClientRect().top),
      gifSelected: document.querySelector('dialog [data-format="gif"]').getAttribute('aria-pressed')
    })`),
    {
      src: entry.gif,
      currentSrc: entry.gif,
      alt: 'Původní animovaný GIF',
      describedBy: 'image-copy-hint',
      belowHeading: true,
      video: false,
      hint: compact ? 'Podržte GIF pro sdílení.' : 'Nabídka obrázku → Kopírovat obrázek',
      imageFirst: true,
      gifSelected: 'true',
    },
    'Original mode exposes the HTTPS GIF image to native browser actions',
  );
  if (!compact) {
    await browser('focus', 'dialog .format-picker [data-format="mp4"]');
    await browser('press', 'Enter');
    await wait(`!document.querySelector('dialog img') &&
      !!document.querySelector('dialog video, dialog .video-placeholder')`);
  }
}

async function discovery(): Promise<void> {
  const stored = () =>
    evaluate<string | null>(`localStorage.getItem(${JSON.stringify(CATEGORY_STORAGE)})`);
  const other = PRIMARY_CATEGORIES.find(id =>
    id !== LEGACY_CATEGORY && dataset.categories.some(category => category.id === id)
  );
  assert(other, 'Discovery regression needs a second primary category');
  await browser('open', origin);
  assert.equal(
    await evaluate('Math.random()'),
    1 - Number.EPSILON,
    'Owned browser init controls randomness',
  );
  await results('');
  await categoryControls();
  assert.equal(await stored(), LEGACY_CATEGORY, 'First visit remembers Cimrman');
  await chooseCategory(other);
  await results('', [], { category: other });
  await browser('open', origin);
  await results('', [], { category: other });
  await chooseCategory('');
  await results('', [], { category: '' });
  assert.equal(await stored(), '', 'All is a stored preference, not missing storage');
  await browser('back');
  await results('', [], { category: other });
  assert.equal(await stored(), other, 'Back navigation updates the preference');
  await browser('forward');
  await results('', [], { category: '' });
  assert.equal(await stored(), '');
  await browser('open', origin);
  await results('', [], { category: '' });
  await categoryControls();
  await browser('open', `${origin}/?category=${LEGACY_CATEGORY}&q=SMOLJ%C3%81K&tag=ja`);
  await results('SMOLJÁK', ['ja']);
  assert.equal(await stored(), LEGACY_CATEGORY, 'Explicit category overrides the saved All scope');
  await evaluate(
    `localStorage.setItem(${JSON.stringify(CATEGORY_STORAGE)}, ${JSON.stringify(other)})`,
  );
  await browser('open', `${origin}/?category=unknown-smoke-category`);
  await results('', [], { category: 'unknown-smoke-category' });
  assert.equal(await stored(), other, 'Unknown explicit URLs do not poison the saved preference');
  await browser('open', origin);
  await results('', [], { category: other });
  await evaluate(
    `localStorage.setItem(${JSON.stringify(CATEGORY_STORAGE)}, 'unknown-saved-category')`,
  );
  await browser('open', origin);
  await results('');
  console.log(
    '✓ First-visit Cimrman, remembered All/category, explicit URLs, history and invalid preferences',
  );

  await evaluate(
    `localStorage.setItem(${JSON.stringify(CATEGORY_STORAGE)}, ${JSON.stringify(other)});
    sessionStorage.setItem('__smoke-block-storage', 'true')`,
  );
  await browser('open', origin);
  await results('');
  await chooseCategory('');
  await results('', [], { category: '' });
  await browser('reload');
  await results('', [], { category: '' });
  await evaluate(`sessionStorage.removeItem('__smoke-block-storage')`);
  await browser('open', origin);
  await results('', [], { category: other });
  console.log(
    '✓ Blocked preference reads/writes keep category controls and explicit All URLs usable',
  );

  // A small mixed fixture proves complete membership and stable per-load ordering.
  const sample = [
    ...catalog.filter(entry => entry.categoryIds.includes(LEGACY_CATEGORY)).slice(0, BATCH),
    ...catalog.filter(entry => !entry.categoryIds.includes(LEGACY_CATEGORY)).slice(0, 3),
  ];
  assert.equal(sample.length, BATCH + 3);
  catalogResponse = Response.json({ categories: dataset.categories, gifs: sample });
  const all = { entries: sample, category: '' };
  const ids = () =>
    evaluate<string[]>(
      `Array.from(document.querySelectorAll('article.gif-card'), card => card.dataset.id)`,
    );
  await browser('open', `${origin}/?category=`);
  await results('', [], all);
  const identityOrder = await ids();
  assert.deepEqual(
    await ids(),
    sample.map(entry => entry.id),
    'Every fixture record survives the shuffle',
  );
  await evaluate(`sessionStorage.setItem('__smoke-shuffle', 'rotate')`);
  rotateCatalog = true;
  await browser('reload');
  assert.equal(await evaluate('Math.random()'), 0);
  await results('', [], all);
  const rotatedOrder = await ids();
  assert.notDeepEqual(rotatedOrder, identityOrder, 'A new page load receives a new permutation');
  await search('SMOLJÁK', [], all);
  await chooseCategory(LEGACY_CATEGORY);
  await results('SMOLJÁK', [], { entries: sample });
  await chooseCategory('');
  await results('SMOLJÁK', [], all);
  await search('', [], all);
  assert.deepEqual(await ids(), rotatedOrder, 'Filtering preserves the per-load ordering');
  assert.deepEqual(await ids(), [...sample.slice(1), sample[0]!].map(entry => entry.id));
  await evaluate(`sessionStorage.removeItem('__smoke-shuffle')`);
  rotateCatalog = false;
  await browser('reload');
  await results('', [], all);
  assert.deepEqual(await ids(), identityOrder);
  catalogResponse = undefined;
  await evaluate(`localStorage.removeItem(${JSON.stringify(CATEGORY_STORAGE)})`);
  await browser('open', `${origin}/?category=`);
  await results('', [], { category: '' });
  console.log(
    '✓ Deterministic reload shuffles retain all records and stable filtering order',
  );
}

async function pendingCatalog(): Promise<void> {
  const category = 'osada';
  assert(
    dataset.categories.some(item => item.id === category),
    'Pending-load regression needs Osada',
  );
  await browser('open', `${origin}/?category=`);
  await results('', [], { category: '' });
  const pendingScope = async () => {
    assert.deepEqual(
      await evaluate(`({
        explicit: new URL(location.href).searchParams.has('category'),
        saved: localStorage.getItem(${JSON.stringify(CATEGORY_STORAGE)})
      })`),
      { explicit: false, saved: category },
      'Pending edits preserve the absent category and remembered scope',
    );
  };
  for (const action of ['typing', 'clear-tags', 'history'] as const) {
    await evaluate(
      `localStorage.setItem(${JSON.stringify(CATEGORY_STORAGE)}, ${JSON.stringify(category)})`,
    );
    let release!: () => void;
    catalogGate = new Promise<void>(resolve => {
      release = resolve;
    });
    try {
      await browser('open', action === 'clear-tags' ? `${origin}/?tag=ja&tag=smoljak` : origin);
      await wait(
        `document.querySelector('#category')?.disabled && !!document.querySelector('#query')`,
      );
      if (action === 'clear-tags') {
        await click('Zrušit štítky');
        await wait(`new URL(location.href).searchParams.getAll('tag').length === 0`);
      } else {
        await browser('fill', '#query', 'pivo');
        await browser('press', 'Enter');
        if (action === 'history') {
          await browser('fill', '#query', 'vino');
          await browser('press', 'Enter');
          await browser('back');
          await wait(`document.querySelector('#query').value === 'pivo'`);
          await pendingScope();
          await browser('forward');
          await wait(`document.querySelector('#query').value === 'vino'`);
          await browser('back');
          await wait(`document.querySelector('#query').value === 'pivo'`);
        }
      }
      await pendingScope();
    } finally {
      catalogGate = undefined;
      release();
    }
    await results(action === 'clear-tags' ? '' : 'pivo', [], { category });
  }
  await evaluate(
    `localStorage.setItem(${JSON.stringify(CATEGORY_STORAGE)}, ${JSON.stringify(category)})`,
  );
  catalogResponse = new Response('Unavailable', { status: 503 });
  try {
    await browser('open', `${origin}/?tag=ja`);
    await wait(`!!document.querySelector('[role="alert"]')`);
    await browser('fill', '#query', 'pivo');
    await click('Zrušit štítky');
    await pendingScope();
  } finally {
    catalogResponse = undefined;
  }
  await click('Zkusit znovu');
  await results('pivo', [], { category });
  await browser('open', `${origin}/?category=`);
  await results('', [], { category: '' });
  console.log(
    '✓ Pending/failed catalog edits, tag clearing, history and Retry retain the remembered category',
  );
}

async function openCategoryMenu(): Promise<void> {
  await browser('focus', '#category');
  await browser('press', 'Enter');
  await wait(`!!document.querySelector('#category-menu:popover-open')`);
}

async function pinInvariants(): Promise<void> {
  const defaults = PRIMARY_CATEGORIES.filter(id =>
    dataset.categories.some(category => category.id === id)
  );
  const extra = dataset.categories.find(category => !defaults.includes(category.id));
  assert(extra, 'Pin regression needs an initially unpinned category');
  let pins = [...defaults];
  const state = () =>
    evaluate(`({
    url: location.href, query: document.querySelector('#query').value,
    tags: new URL(location.href).searchParams.getAll('tag'),
    count: document.querySelector('#results-count').textContent,
    ids: [...document.querySelectorAll('article.gif-card')].map(card => card.dataset.id)
  })`);
  const saved = () => evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(PIN_STORAGE)}))`);
  const toggleBar = async (id: string) => {
    const before = await state();
    const beforeOrder = await evaluate<string[]>(
      `[...document.querySelectorAll('header .category-item > .category-button')].map(button => button.dataset.category)`,
    );
    const active = await evaluate<string>(
      `new URL(location.href).searchParams.get('category') ?? ''`,
    );
    await browser('focus', `header .category-item > .category-button[data-category="${id}"]`);
    await browser('press', 'Tab');
    assert.equal(await evaluate('document.activeElement.dataset.pin'), id);
    await browser('press', 'Enter');
    if (pins.includes(id)) pins = pins.filter(pin => pin !== id);
    else if (id === active) pins.splice(beforeOrder.indexOf(id), 0, id);
    else pins = [...pins, id];
    await categoryControls(
      dataset.categories,
      catalog,
      pins,
      id === active ? beforeOrder : undefined,
    );
    assert.deepEqual(
      await state(),
      before,
      'Bar pin editing preserves filters, URL and rendered order',
    );
    assert.deepEqual(await saved(), pins);
  };
  const toggleMenu = async (id: string) => {
    const before = await state();
    const selector = `#category-menu .pin-toggle[data-pin="${id}"]`;
    await browser('focus', selector);
    await browser('press', 'Enter');
    pins = pins.includes(id) ? pins.filter(pin => pin !== id) : [...pins, id];
    await wait(`!!document.querySelector('#category-menu:popover-open') &&
      document.activeElement === document.querySelector(${JSON.stringify(selector)})`);
    await categoryControls(dataset.categories, catalog, pins);
    assert.deepEqual(
      await state(),
      before,
      'Menu pin editing preserves filters, URL and rendered order',
    );
    assert.deepEqual(await saved(), pins);
  };
  const reset = async (retainedOrder?: string[]) => {
    const before = await state();
    await browser('focus', await ref('button', 'Obnovit výchozí'));
    await browser('press', 'Enter');
    pins = [...defaults];
    await wait(`!!document.querySelector('#category-menu:popover-open') &&
      document.activeElement.textContent.trim() === 'Obnovit výchozí'`);
    await categoryControls(dataset.categories, catalog, pins, retainedOrder);
    assert.deepEqual(await state(), before, 'Reset changes only pin preferences');
    assert.deepEqual(await saved(), pins);
  };

  await browser('open', `${origin}/?category=`);
  await evaluate(`localStorage.removeItem(${JSON.stringify(PIN_STORAGE)})`);
  await browser('reload');
  await results('', [], { category: '' });
  await categoryControls();
  await toggleBar('osada');
  assert.equal(
    await evaluate('document.activeElement.id'),
    'category',
    'Removing an inactive bar item restores the menu trigger',
  );
  await openCategoryMenu();
  await toggleMenu('osada');
  await toggleMenu(extra.id);
  assert.equal(pins.at(-1), extra.id, 'New pins append to the personal bar');
  await reset();
  await browser('press', 'Escape');
  await wait(
    `!document.querySelector('#category-menu:popover-open') && document.activeElement.id === 'category'`,
  );
  console.log('✓ Default pins, bar/menu edits and reset preserve gallery order and scope');

  await browser('open', `${origin}/?category=${LEGACY_CATEGORY}&q=SMOLJ%C3%81K&tag=ja`);
  await results('SMOLJÁK', ['ja']);
  await toggleBar(LEGACY_CATEGORY);
  assert.equal(await evaluate('document.activeElement.dataset.pin'), LEGACY_CATEGORY);
  await toggleBar(LEGACY_CATEGORY);
  await toggleBar(LEGACY_CATEGORY);
  await chooseCategory(extra.id);
  await results('SMOLJÁK', ['ja'], { category: extra.id });
  await categoryControls(dataset.categories, catalog, pins);
  await toggleBar(extra.id);
  await browser('reload');
  await results('SMOLJÁK', ['ja'], { category: extra.id });
  await categoryControls(dataset.categories, catalog, pins);

  for (
    const [value, expected] of [
      ['[]', []],
      ['[', defaults],
      ['["removed-category"]', []],
      [JSON.stringify([extra.id, 'removed-category', extra.id, 'osada']), [extra.id, 'osada']],
    ] as [string, string[]][]
  ) {
    await evaluate(
      `localStorage.setItem(${JSON.stringify(PIN_STORAGE)}, ${JSON.stringify(value)})`,
    );
    await browser('reload');
    await results('SMOLJÁK', ['ja'], { category: extra.id });
    pins = expected;
    await categoryControls(dataset.categories, catalog, pins);
  }
  await openCategoryMenu();
  await reset([extra.id, ...defaults]);
  await browser('press', 'Escape');
  await wait(`!document.querySelector('#category-menu:popover-open')`);
  console.log(
    '✓ Active unpinned category remains visible; saved, empty, malformed and unknown pins reload correctly',
  );

  await evaluate(
    `localStorage.setItem(${JSON.stringify(PIN_STORAGE)}, ${
      JSON.stringify(JSON.stringify([extra.id]))
    })`,
  );
  let release!: () => void;
  catalogGate = new Promise<void>(resolve => {
    release = resolve;
  });
  try {
    await browser('open', `${origin}/?category=${LEGACY_CATEGORY}`);
    await wait(`document.querySelector('#category').disabled`);
    assert.deepEqual(
      await saved(),
      [extra.id],
      'Pending catalog must not overwrite pin preferences',
    );
  } finally {
    catalogGate = undefined;
    release();
  }
  await results('');
  await categoryControls(dataset.categories, catalog, [extra.id]);
  await evaluate(`localStorage.setItem(${JSON.stringify(PIN_STORAGE)}, '[]')`);
  catalogResponse = new Response('Unavailable', { status: 503 });
  try {
    await browser('open', `${origin}/?category=${LEGACY_CATEGORY}`);
    await wait(`!!document.querySelector('[role="alert"]')`);
    assert.deepEqual(
      await saved(),
      [],
      'Failed catalog must not overwrite intentionally empty pins',
    );
  } finally {
    catalogResponse = undefined;
  }
  await click('Zkusit znovu');
  await results('');
  pins = [];
  await categoryControls(dataset.categories, catalog, pins);
  await openCategoryMenu();
  await reset();
  await browser('press', 'Escape');
  await wait(`!document.querySelector('#category-menu:popover-open')`);
  await chooseCategory('');
  await results('', [], { category: '' });
  console.log('✓ Pin hydration waits for a valid catalog, including Retry after failure');
}

async function mobilePinMenu(): Promise<void> {
  await browser('focus', '#query');
  assert(
    await evaluate(
      `!Array.from(document.querySelectorAll(${
        JSON.stringify(BAR_CATEGORIES)
      })).some(button => button.checkVisibility()) &&
       document.querySelector('#category').checkVisibility()`,
    ),
    'Compact navigation exposes the category picker without desktop tabs',
  );
  await openCategoryMenu();
  assert(
    await evaluate(`(() => {
      const box = document.querySelector('#category-menu').getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    })()`),
    'The category popover fits the narrow viewport',
  );
  const before = await evaluate('location.href');
  const pin = `#category-menu .pin-toggle[data-pin="${LEGACY_CATEGORY}"]`;
  await browser('focus', pin);
  await browser('press', 'Enter');
  await wait(
    `document.querySelector(${JSON.stringify(pin)}).getAttribute('aria-pressed') === 'false' &&
    !!document.querySelector('#category-menu:popover-open') &&
    document.activeElement === document.querySelector(${JSON.stringify(pin)}) &&
    document.activeElement.closest('.category-group').dataset.group === 'stories'`,
  );
  await browser('press', 'Enter');
  await wait(
    `document.querySelector(${JSON.stringify(pin)}).getAttribute('aria-pressed') === 'true' &&
    document.activeElement === document.querySelector(${JSON.stringify(pin)}) &&
    document.activeElement.closest('.category-group').dataset.group === 'pinned'`,
  );
  assert.equal(await evaluate('location.href'), before);
  await browser('press', 'Escape');
  await wait(
    `!document.querySelector('#category-menu:popover-open') && document.activeElement.id === 'category'`,
  );
  await openCategoryMenu();
  assert(
    await evaluate(
      `!document.querySelector('#category-menu').contains(document.elementFromPoint(1, 1))`,
    ),
  );
  await browser('mouse', 'move', '1', '1');
  await browser('mouse', 'down');
  await browser('mouse', 'up');
  await wait(`!document.querySelector('#category-menu:popover-open')`);
  await noOverflow();
}

let failure: { error: unknown } | undefined;
try {
  // Catalog order and keywords can change while the historical clip's identity stays stable.
  const fixtureCard = `article.gif-card[data-id=${JSON.stringify(fixture.id)}]`;
  const fixturePreview = `${fixtureCard} .preview`;
  const revealFixture = async () => {
    await browser('scrollintoview', fixtureCard);
    await wait(`!!document.querySelector(${JSON.stringify(`${fixtureCard} .quick-actions`)})`);
  };
  const openFixture = async () => {
    await revealFixture();
    await browser('click', fixturePreview);
  };
  const waitForFilterFocus = () =>
    wait(`!document.querySelector('dialog') && document.activeElement ===
      document.querySelector(new URL(location.href).searchParams.getAll('tag').length ? '.tag-filters' : '#query')`);
  const clickTag = async (tag: string) => {
    await openFixture();
    await wait(`!!document.querySelector('dialog[open]')`);
    await browser('click', `dialog .detail-tags button[aria-label="Filtrovat štítek: ${tag}"]`);
    await waitForFilterFocus();
  };
  const clickDetailCategory = async (label: string) => {
    await openFixture();
    await wait(`!!document.querySelector('dialog[open]')`);
    await browser('click', `dialog .gif-categories button[aria-label="Filtrovat pořad: ${label}"]`);
    await wait(`!document.querySelector('dialog') && document.activeElement.id === 'query'`);
  };
  const previewName = `Možnosti GIFu: ${label(fixture)}`;
  const overlayVisible = (visible: boolean) =>
    wait(`(() => {
    const style = getComputedStyle(document.querySelector(${
      JSON.stringify(`${fixtureCard} .quick-actions`)
    }));
    return Number(style.opacity) === ${visible ? 1 : 0} && style.pointerEvents ${
      visible ? '!==' : '==='
    } 'none';
  })()`);
  await browser('session', 'list');
  await browser('set', 'viewport', '1200', '900');
  await browser('set', 'media', 'light');
  await discovery();
  await pendingCatalog();
  await pinInvariants();
  // Check the accessible name once; native-dialog transitions can leave AX snapshots stale.
  await ref('textbox', 'Hledat v hláškách');
  await ref('button', 'O webu');
  await ref('button', 'Další pořady');
  await categoryControls();
  await headerLayout();
  for (
    const category of PRIMARY_CATEGORIES.filter(id =>
      dataset.categories.some(item => item.id === id)
    )
  ) {
    await chooseCategory(category);
    await results('', [], { category });
  }
  await chooseCategory('');
  await results('', [], { category: '' });
  await galleryCards();
  await continuousGallery();
  await chooseCategory(LEGACY_CATEGORY);
  await results('');
  await galleryCards();
  await hoverPlayback();
  await infoPopover();
  await browser('click', '.desktop-settings [popovertarget="site-info"]');
  await browser('click', '#query');
  await wait(`!document.querySelector('#site-info:popover-open')`);
  await revealFixture();
  await lazyMedia();
  assert.deepEqual(
    await evaluate(`({
    mountedActions: [...document.querySelectorAll('article')].every(card =>
      !!card.querySelector('.quick-actions') === !!card.querySelector('video, img:not(.native-image)')),
    grids: document.querySelectorAll('article .card-actions').length,
    accessiblePreviews: [...document.querySelectorAll('article')].every(card =>
      !!card.querySelector('.preview[aria-haspopup="dialog"]')),
    fixtureLabel: document.querySelector(${
      JSON.stringify(fixturePreview)
    })?.getAttribute('aria-label')
  })`),
    {
      mountedActions: true,
      grids: 0,
      accessiblePreviews: true,
      fixtureLabel: previewName,
    },
    'Compact actions replace card grids',
  );
  await overlayVisible(false);
  await browser('focus', fixturePreview);
  await overlayVisible(true);
  await wait(`(() => {
    const share = document.querySelector(${
    JSON.stringify(fixtureCard)
  }).querySelector('[aria-label^="Sdílet GIF:"]');
    return !share || !share.disabled || share.getAttribute('aria-busy') === 'false';
  })()`);
  await browser('press', 'Tab');
  assert(
    await evaluate(
      `document.activeElement === [...document.querySelector(${
        JSON.stringify(fixtureCard)
      }).querySelectorAll('.quick-actions button')].find(button => !button.disabled)`,
    ),
    'Keyboard reaches the first available quick action',
  );
  await browser('focus', '#query');
  await browser('hover', fixturePreview);
  await overlayVisible(true);
  await browser('hover', '#query');
  await overlayVisible(false);
  await lazyMedia();
  await noOverflow();
  assert.deepEqual(
    await evaluate(`({
    downloads: [...document.querySelectorAll('article .quick-actions')].every(actions =>
      actions.querySelectorAll('button[aria-label^="Stáhnout GIF:"]').length === 1),
    deadCopy: [...document.querySelectorAll('article button')]
      .some(button => button.textContent.trim() === 'Kopírovat GIF')
  })`),
    { downloads: true, deadCopy: false },
    'Every mounted action group offers an actual GIF download',
  );
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await browser('screenshot', resolve(root, 'artifacts/browser-desktop.png'));
  // Inject a decode failure, then let the real source recover when it re-enters the viewport.
  await revealFixture();
  await evaluate(`(() => {
    const video = document.querySelector(${JSON.stringify(`${fixtureCard} video`)});
    window.__smokeReleasedPreview = video;
    video.src = 'data:video/mp4,invalid';
    video.load();
    void video.play().catch(() => {});
  })()`);
  await wait(`!!document.querySelector(${JSON.stringify(`${fixtureCard} .preview-error`)})`);
  await browser('scrollintoview', 'article.gif-card:last-child');
  await wait(`(() => {
    const video = window.__smokeReleasedPreview;
    return !document.querySelector(${JSON.stringify(`${fixtureCard} video`)}) &&
      !video.isConnected && !video.hasAttribute('src') && video.readyState === 0 && video.networkState === 0 &&
      video.buffered.length === 0 && video.paused;
  })()`);
  await evaluate('delete window.__smokeReleasedPreview');
  await lazyMedia();
  await revealFixture();
  await wait(`document.querySelector(${JSON.stringify(`${fixtureCard} video`)})?.readyState >= 2 &&
    !document.querySelector(${JSON.stringify(`${fixtureCard} .preview-error`)})`);
  console.log('✓ Offscreen media resource release and preview error recovery');

  for (const query of ['SMOLJÁK', '^se$ ^jsem$', 'j[íi]dlo|hlad']) await search(query);
  await browser('back');
  await results('^se$ ^jsem$');
  await browser('forward');
  await results('j[íi]dlo|hlad');
  workerDelayMs = 1_500;
  await browser('reload');
  await results('j[íi]dlo|hlad');
  workerDelayMs = 0;
  assert(delayedWorkerRequests > 0, 'Reload tolerates worker startup beyond the regex time budget');
  await search('this-clip-does-not-exist-529571');
  await browser('fill', '#query', '[');
  await wait(`!!document.querySelector('#search-error')?.textContent`);
  await search('');
  console.log('✓ Search, accents, regex AND, empty/error states, URL history and reload');

  const lastTag = fixture.keywords.at(-1)!;
  await openFixture();
  await wait(`!!document.querySelector('dialog[open]')`);
  await dialogDetails();
  await originalGifImage();
  await browser('focus', 'dialog .detail-tags li:first-child button');
  for (let index = 1; index < fixture.keywords.length; index++) await browser('press', 'Tab');
  assert.equal(
    await evaluate('document.activeElement?.getAttribute("aria-label")'),
    `Filtrovat štítek: ${lastTag}`,
  );
  await wait(`(() => {
    const tag = document.activeElement.getBoundingClientRect();
    const box = document.querySelector('dialog').getBoundingClientRect();
    return tag.left >= box.left && tag.right <= box.right && tag.top >= box.top && tag.bottom <= box.bottom;
  })()`);
  await browser('press', 'Enter');
  await waitForFilterFocus();
  await results('', [lastTag]);
  await openFixture();
  await wait(`!!document.querySelector('dialog[open]')`);
  await dialogDetails();
  await browser('click', `dialog .detail-tags button[aria-label="Filtrovat štítek: ${lastTag}"]`);
  await waitForFilterFocus();
  await results('');
  await clickTag('smoljak');
  await results('', ['smoljak']);
  assert(
    await evaluate(`document.activeElement === document.querySelector('.tag-filters')`),
    'Tag focus remains above results',
  );
  await openFixture();
  await wait(`!!document.querySelector('dialog[open]')`);
  await dialogDetails();
  await click('Zavřít');
  await wait(`!document.querySelector('dialog')`);
  await clickTag('ja');
  await results('', ['smoljak', 'ja']);
  await clickDetailCategory('Cimrman');
  await results('', ['smoljak', 'ja']);
  await search('^jidlo$', ['smoljak', 'ja']);
  await click('Odebrat štítek: smoljak');
  await results('^jidlo$', ['ja']);
  await click('Zrušit štítky');
  await results('^jidlo$');
  assert(
    await evaluate(`document.activeElement === document.querySelector('#query')`),
    'Clearing tags focuses search',
  );
  await browser('back');
  await results('^jidlo$', ['ja']);
  await browser('reload');
  await results('^jidlo$', ['ja']);
  await click('Vymazat hledání');
  await results('', ['ja']);
  await browser(
    'open',
    `${origin}/?category=${LEGACY_CATEGORY}&q=${
      encodeURIComponent('^jidlo$')
    }&tag=SMOLJ%C3%81K&tag=J%C3%A1`,
  );
  await results('^jidlo$', ['SMOLJÁK', 'Já']);
  await browser('open', `${origin}/?category=${LEGACY_CATEGORY}&tag=unknown-tag-529571`);
  await results('', ['unknown-tag-529571']);
  await click('Odebrat štítek: unknown-tag-529571');
  await results('');
  console.log(
    '✓ Detail tag/category filters, keyboard access, AND/regex filters, chips and history',
  );

  // Capture browser handoffs only; signature-only files are not recipient-delivery tests.
  const mockSharing = () =>
    evaluate(`(() => {
    const blobs = new Map(), create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    window.__smoke = { copied: [], shared: [], downloads: [], requests: [], created: [], revoked: [],
      denyCopy: false, cancelShare: false, rejectShare: false, holdShare: false, failMedia: false, capability: 'all' };
    URL.createObjectURL = blob => {
      const url = create.call(URL, blob); blobs.set(url, blob); window.__smoke.created.push(url); return url;
    };
    URL.revokeObjectURL = url => { window.__smoke.revoked.push(url); revoke.call(URL, url); };
    document.addEventListener('click', event => {
      if (event.target instanceof HTMLAnchorElement && event.target.download) {
        event.preventDefault();
        const blob = blobs.get(event.target.href);
        window.__smoke.downloads.push({ name: event.target.download, type: blob?.type, size: blob?.size });
      }
    }, true);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => {
        if (window.__smoke.denyCopy) throw new DOMException('Denied', 'NotAllowedError');
        window.__smoke.copied.push(text);
      }
    }});
    Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
      window.__smoke.shared.push({
        url: data.url, title: data.title, text: data.text,
        files: data.files?.map(file => ({ name: file.name, type: file.type, size: file.size })),
        active: navigator.userActivation.isActive
      });
      if (window.__smoke.holdShare) await new Promise(resolve => { window.__smoke.releaseShare = resolve; });
      if (window.__smoke.cancelShare) throw new DOMException('Cancelled', 'AbortError');
      if (window.__smoke.rejectShare) throw new DOMException('Failed handoff', 'DataError');
    }});
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: data => {
      const mode = window.__smoke.capability;
      if (mode === 'throws') throw new Error('Unavailable capability check');
      if (mode === 'url-only') return !!data.url && !data.files;
      if (mode === 'real-rejected') return data.files?.every(file => file.size === 0);
      return mode !== 'gif-rejected' || data.files?.every(file => file.type !== 'image/gif');
    }});
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = typeof input === 'string' ? input : input.url;
      const parsed = new URL(url, location.href);
      const format = parsed.hostname === 'media.giphy.com'
        ? parsed.pathname.endsWith('/giphy.gif') ? 'gif' : parsed.pathname.endsWith('/giphy.mp4') ? 'mp4' : null
        : null;
      if (!format) return originalFetch(input, options);
      window.__smoke.requests.push({ id: parsed.pathname.split('/').at(-2), format, signal: options?.signal });
      if (window.__smoke.failMedia) return Promise.resolve(new Response('Unavailable', { status: 503 }));
      return Promise.resolve(new Response(format === 'gif' ? 'GIF89a'
        : new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), {
        headers: { 'Content-Type': format === 'gif' ? 'image/gif' : 'video/mp4' }
      }));
    };
  })()`);
  const filePayload = (format: 'mp4' | 'gif') => ({
    name: `ct-${fixture.id}.${format}`,
    type: format === 'gif' ? 'image/gif' : 'video/mp4',
    size: format === 'gif' ? 6 : 12,
  });
  const primaryReady = async (format: 'mp4' | 'gif', share = true) => {
    const text = share
      ? `Sdílet ${format === 'gif' ? 'GIF' : 'video'}`
      : `Stáhnout ${format === 'gif' ? 'GIF' : 'MP4'}`;
    await wait(
      `document.querySelector('dialog [data-format="${format}"]')?.getAttribute('aria-pressed') === 'true' &&
      document.querySelector('dialog .dialog-actions .primary')?.textContent.trim() === ${
        JSON.stringify(text)
      } &&
      !document.querySelector('dialog .dialog-actions .primary').disabled`,
    );
  };
  const selectFormat = async (format: 'mp4' | 'gif') => {
    await browser('focus', `dialog .format-picker [data-format="${format}"]`);
    await browser('press', 'Enter');
  };
  const closeFixture = async () => {
    await click('Zavřít');
    await wait(`!document.querySelector('dialog') &&
      document.activeElement === document.querySelector(${JSON.stringify(fixturePreview)})`);
  };
  await mockSharing();
  await browser('hover', fixturePreview);
  await browser('click', `${fixtureCard} button[aria-label^="Kopírovat odkaz:"]`);
  assert.deepEqual(await evaluate('window.__smoke.copied'), [fixture.gif]);
  await browser('click', `${fixtureCard} button[aria-label^="Stáhnout GIF:"]`);
  await wait(`window.__smoke.downloads.length === 1 && !document.querySelector('dialog')`);
  assert.deepEqual(await evaluate('window.__smoke.downloads'), [filePayload('gif')]);

  // Desktop keeps MP4 as its initial format; leave the card to end its hover preparation.
  await browser('set', 'viewport', '1200', '900');
  await browser('hover', '#query');
  await browser('focus', '#query');
  const modalRequestsStart = await evaluate<number>('window.__smoke.requests.length');
  await evaluate('window.__smoke.failMedia = true');
  await openFixture();
  await wait(`!!document.querySelector('dialog [role="alert"]')`);
  assert(await evaluate(`document.querySelector('dialog .dialog-actions .primary').disabled`));
  await click('Kopírovat odkaz');
  assert.deepEqual(await evaluate('window.__smoke.copied'), [fixture.gif, fixture.gif]);
  await evaluate(
    `Object.assign(window.__smoke, { denyCopy: true, failMedia: false, cancelShare: true })`,
  );
  await click('Kopírovat odkaz');
  await wait(
    `document.querySelector('dialog input[aria-label="Odkaz pro ruční zkopírování"]')?.value === ${
      JSON.stringify(fixture.gif)
    }`,
  );
  await click('Zkusit znovu');
  await primaryReady('mp4');
  await dialogDetails();
  assert.deepEqual(
    await evaluate(
      `window.__smoke.requests.slice(${modalRequestsStart}).map(request => request.format)`,
    ),
    ['mp4', 'mp4'],
  );
  await browser('click', 'dialog .dialog-actions .primary');
  await wait(
    `window.__smoke.shared.length === 1 && !document.querySelector('dialog [role="alert"]') &&
    !document.querySelector('dialog [role="status"]').textContent.trim()`,
  );
  await evaluate(`Object.assign(window.__smoke, { cancelShare: false, holdShare: true })`);
  await browser('click', 'dialog .dialog-actions .primary');
  await wait(`typeof window.__smoke.releaseShare === 'function' &&
    [...document.querySelectorAll('dialog .format-picker button')].every(button => button.disabled)`);
  await evaluate('window.__smoke.releaseShare(); window.__smoke.holdShare = false');
  await wait(
    `document.querySelector('dialog [role="status"]')?.textContent.trim() === 'Otevřeno systémové sdílení.'`,
  );
  assert.deepEqual(await evaluate('window.__smoke.shared.at(-1)'), {
    files: [filePayload('mp4')],
    active: true,
  }, 'Only the prepared MP4 file is handed off during the user gesture');
  const firstVideoUrl = await evaluate<string>('document.querySelector("dialog video").src');
  await selectFormat('gif');
  await primaryReady('gif');
  assert(
    await evaluate(`window.__smoke.revoked.includes(${JSON.stringify(firstVideoUrl)}) &&
      !document.querySelector('dialog video') && document.querySelector('dialog img').src === ${
      JSON.stringify(fixture.gif)
    } &&
      !!(document.querySelector('dialog .dialog-actions').compareDocumentPosition(document.querySelector('dialog .gif-details')) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      ![...document.querySelectorAll('dialog button')].some(button => button.textContent.trim() === 'Sdílet odkaz')`),
    'GIF replaces the MP4 preview, revokes its blob, and keeps file actions before metadata',
  );
  await browser('click', 'dialog .dialog-actions .primary');
  await wait('window.__smoke.shared.length === 3');
  assert.deepEqual(await evaluate('window.__smoke.shared.at(-1)'), {
    files: [filePayload('gif')],
    active: true,
  }, 'Only the prepared GIF file is handed off during the user gesture');
  await click('Stáhnout GIF');
  assert.deepEqual(await evaluate('window.__smoke.downloads.at(-1)'), filePayload('gif'));
  await selectFormat('mp4');
  await primaryReady('mp4');
  await click('Stáhnout MP4');
  assert.deepEqual(await evaluate('window.__smoke.downloads.at(-1)'), filePayload('mp4'));
  const finalVideoUrl = await evaluate<string>('document.querySelector("dialog video").src');
  await closeFixture();
  assert(await evaluate(`window.__smoke.revoked.includes(${JSON.stringify(finalVideoUrl)})`));
  console.log(
    '✓ Prepared GIF/MP4 file shares, user activation, downloads, cancellation, retry and manual link fallback',
  );

  for (const capability of ['url-only', 'gif-rejected', 'throws']) {
    await evaluate(`window.__smoke.capability = ${JSON.stringify(capability)}`);
    await openFixture();
    const format = capability === 'gif-rejected' ? 'gif' : 'mp4';
    if (format === 'gif') {
      await primaryReady('mp4');
      await selectFormat('gif');
    }
    await primaryReady(format, false);
    assert.equal(
      await evaluate(`[...document.querySelectorAll('dialog .dialog-actions button')]
      .filter(button => button.textContent.trim().startsWith('Stáhnout')).length`),
      1,
    );
    await browser('click', 'dialog .dialog-actions .primary');
    assert.deepEqual(await evaluate('window.__smoke.downloads.at(-1)'), filePayload(format));
    assert.equal(
      await evaluate('window.__smoke.shared.length'),
      3,
      'Unsupported file sharing never sends a link instead',
    );
    await closeFixture();
  }
  console.log(
    '✓ URL-only sharing, rejected GIF MIME and throwing capability checks fall back to file download',
  );

  // Gate the final signature read: it may finish after a format change or dialog destruction.
  const holdValidation = (format: 'mp4' | 'gif') =>
    evaluate(`(() => {
    const read = Blob.prototype.arrayBuffer;
    window.__late = { created: window.__smoke.created.length, downloads: window.__smoke.downloads.length };
    Blob.prototype.arrayBuffer = function() {
      if (this.size !== ${format === 'gif' ? 6 : 12}) return read.call(this);
      return new Promise(resolve => {
        window.__late.release = async () => resolve(await read.call(this));
      });
    };
    window.__late.restore = () => { Blob.prototype.arrayBuffer = read; };
  })()`);
  const releaseValidation = () =>
    evaluate(`(async () => {
    await window.__late.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    window.__late.restore();
    return { created: window.__smoke.created.length - window.__late.created,
      downloads: window.__smoke.downloads.length - window.__late.downloads };
  })()`);
  await evaluate('window.__smoke.capability = "all"');
  await openFixture();
  await primaryReady('mp4');
  await holdValidation('gif');
  await selectFormat('gif');
  await wait(
    `typeof window.__late.release === 'function' && document.querySelector('dialog .primary').disabled`,
  );
  await selectFormat('mp4');
  await primaryReady('mp4');
  const currentVideoUrl = await evaluate<string>('document.querySelector("dialog video").src');
  await releaseValidation();
  await primaryReady('mp4');
  assert.equal(await evaluate('document.querySelector("dialog video").src'), currentVideoUrl);
  assert(
    await evaluate(
      `window.__smoke.requests.findLast(request => request.format === 'gif').signal.aborted`,
    ),
  );
  await browser('click', 'dialog .dialog-actions .primary');
  await wait('window.__smoke.shared.length === 4');
  assert.deepEqual(await evaluate('window.__smoke.shared.at(-1)'), {
    files: [filePayload('mp4')],
    active: true,
  }, 'A late GIF response cannot overwrite the newly selected MP4');
  await closeFixture();

  for (const format of ['mp4', 'gif'] as const) {
    if (format === 'gif') {
      await openFixture();
      await primaryReady('mp4');
    }
    await holdValidation(format);
    if (format === 'mp4') await openFixture();
    else await selectFormat('gif');
    await wait(`typeof window.__late.release === 'function'`);
    await closeFixture();
    assert.deepEqual(
      await releaseValidation(),
      { created: 0, downloads: 0 },
      `Closing during ${format} validation prevents late files and object URLs`,
    );
    assert(await evaluate('window.__smoke.requests.at(-1).signal.aborted'));
  }
  console.log(
    '✓ Rapid format switching and closing during validation abort stale work and prevent late output',
  );

  // Desktop overlay shares one prepared GIF; mocks never open an OS target or send a message.
  await browser('set', 'viewport', '1200', '900');
  const overlayShare = `${fixtureCard} .quick-actions button[aria-label^="Sdílet GIF:"]`;
  const leaveCard = async () => {
    await browser('hover', '#query');
    await browser('focus', '#query');
  };
  const remountCards = async (capability = 'all') => {
    await leaveCard();
    await evaluate(`Object.assign(window.__smoke, { capability: ${JSON.stringify(capability)},
      copied: [], shared: [], downloads: [], requests: [], cancelShare: false, rejectShare: false, failMedia: false })`);
    await search('no-card-for-overlay-test-529571');
    await search('');
  };
  const overlayReady = () =>
    wait(`!!document.querySelector(${JSON.stringify(overlayShare)}) &&
    !document.querySelector(${JSON.stringify(overlayShare)}).disabled`);
  await remountCards();
  await galleryCards();
  await Bun.sleep(300); // Observe beyond the card's brief intent delay without hovering a card.
  assert.equal(
    await evaluate('window.__smoke.requests.length'),
    0,
    'Mounting visible cards never fetches full GIFs',
  );
  await holdValidation('gif');
  await browser('hover', fixturePreview);
  await wait(
    `typeof window.__late.release === 'function' && document.querySelector(${
      JSON.stringify(overlayShare)
    }).disabled`,
  );
  assert.deepEqual(await evaluate('window.__smoke.requests.map(({id,format})=>({id,format}))'), [{
    id: fixture.id,
    format: 'gif',
  }], 'Only the intended card prepares its original GIF');
  await releaseValidation();
  await overlayReady();
  await browser('screenshot', resolve(root, 'artifacts/gallery-direct-share-desktop.png'));
  await browser('click', overlayShare);
  await wait('window.__smoke.shared.length === 1');
  assert.deepEqual(await evaluate('window.__smoke.shared[0]'), {
    files: [filePayload('gif')],
    active: true,
  }, 'Overlay shares only the actual GIF file with fresh activation');
  assert(await evaluate(`!document.querySelector('dialog') && window.__smoke.copied.length === 0`));
  await browser('hover', fixturePreview);
  await browser('click', overlayShare);
  await wait('window.__smoke.shared.length === 2');
  assert.equal(
    await evaluate('window.__smoke.requests.length'),
    1,
    'Active intent reuses its prepared file',
  );
  await click('Zavřít oznámení');
  await evaluate('window.__smoke.cancelShare = true');
  await browser('hover', fixturePreview);
  await overlayReady();
  await browser('click', overlayShare);
  await wait('window.__smoke.shared.length === 3');
  assert.equal(
    await evaluate('document.querySelector(".notice").textContent.trim()'),
    '',
    'Cancellation is silent',
  );
  await evaluate('window.__smoke.cancelShare = false; window.__smoke.rejectShare = true');
  await browser('click', overlayShare);
  await wait(`document.querySelector('.notice').textContent.includes('Sdílení se nepodařilo')`);
  await evaluate('window.__smoke.rejectShare = false');
  await leaveCard();
  await wait(`document.querySelector(${JSON.stringify(overlayShare)}).disabled`);
  const beforeKeyboard = await evaluate<number>('window.__smoke.requests.length');
  await browser('focus', fixturePreview);
  await overlayReady();
  await browser('press', 'Tab');
  assert.equal(
    await evaluate('document.activeElement.getAttribute("aria-label")'),
    `Sdílet GIF: ${label(fixture)}`,
  );
  await browser('press', 'Enter');
  await wait('window.__smoke.shared.length === 5');
  assert.equal(
    await evaluate('window.__smoke.requests.length'),
    beforeKeyboard + 1,
    'Leaving drops the old file; keyboard intent prepares anew',
  );
  assert.deepEqual(await evaluate('window.__smoke.shared.at(-1)'), {
    files: [filePayload('gif')],
    active: true,
  });
  console.log(
    '✓ Overlay prepares only the intended card, reuses active files, shares GIF bytes with activation, and handles cancellation/errors',
  );

  for (const boundary of ['leave', 'unmount']) {
    await leaveCard();
    await holdValidation('gif');
    await browser('hover', fixturePreview);
    await wait(`typeof window.__late.release === 'function'`);
    if (boundary === 'leave') await leaveCard();
    else await search('no-card-for-overlay-test-529571');
    assert(await evaluate('window.__smoke.requests.at(-1).signal.aborted'));
    assert.deepEqual(await releaseValidation(), { created: 0, downloads: 0 });
    assert.equal(
      await evaluate('window.__smoke.shared.length'),
      5,
      'Late preparation never initiates sharing',
    );
    if (boundary === 'leave') {
      assert(await evaluate(`document.querySelector(${JSON.stringify(overlayShare)}).disabled`));
    }
    await leaveCard();
    if (boundary === 'unmount') await search('');
  }
  for (const capability of ['url-only', 'throws', 'real-rejected']) {
    await remountCards(capability);
    await browser('hover', fixturePreview);
    if (capability === 'real-rejected') {
      await wait('window.__smoke.requests.length === 1');
      await wait(`!document.querySelector(${JSON.stringify(overlayShare)})`);
    } else {
      await Bun.sleep(300);
      assert.equal(await evaluate('window.__smoke.requests.length'), 0);
    }
    assert.equal(
      await evaluate(
        `document.querySelector(${
          JSON.stringify(fixtureCard)
        }).querySelectorAll('.quick-actions button').length`,
      ),
      2,
      'Unsupported sharing retains only link copy and GIF download',
    );
  }
  await remountCards();
  await evaluate('window.__smoke.failMedia = true');
  await browser('hover', fixturePreview);
  await wait(
    `document.querySelector(${
      JSON.stringify(overlayShare)
    })?.getAttribute('aria-busy') === 'false'`,
  );
  assert(
    await evaluate(
      `document.querySelector(${
        JSON.stringify(overlayShare)
      }).disabled && window.__smoke.shared.length === 0`,
    ),
  );
  console.log(
    '✓ Leave/unmount abort preparation; capability rejection hides sharing; failed files remain unshareable',
  );

  await remountCards();
  await browser('set', 'viewport', '390', '844');
  await browser('focus', fixturePreview);
  await Bun.sleep(300);
  assert.equal(
    await evaluate('window.__smoke.requests.length'),
    0,
    'Mobile focus does not prepare desktop sharing',
  );
  assert.equal(
    await evaluate('getComputedStyle(document.querySelector(".quick-actions")).display'),
    'none',
  );
  await galleryCards();
  await browser('screenshot', resolve(root, 'artifacts/gallery-without-markers-mobile.png'));
  await openFixture();
  await primaryReady('gif');
  await dialogDetails();
  await originalGifImage();
  assert.deepEqual(await evaluate('window.__smoke.requests.map(request=>request.format)'), ['gif']);
  await browser('click', 'dialog .dialog-actions .primary');
  await wait('window.__smoke.shared.length === 1');
  assert.deepEqual(await evaluate('window.__smoke.shared[0]'), {
    files: [filePayload('gif')],
    active: true,
  }, 'Supported mobile sharing hands off the prepared GIF during the click');
  await closeFixture();
  await evaluate(`Object.assign(window.__smoke, {
    capability: 'url-only', requests: [], downloads: [], failMedia: true
  })`);
  await openFixture();
  await primaryReady('gif', false);
  await originalGifImage();
  assert.equal(
    await evaluate('window.__smoke.requests.length'),
    0,
    'Unsupported compact sharing loads the native image without a fetchMedia/File request',
  );
  assert(
    await evaluate(`!document.querySelector('dialog [role="alert"]') &&
    !document.querySelector('dialog .retry') &&
    !document.querySelector('dialog').textContent.includes('Sdílení souborů tu není dostupné')`),
  );
  await browser('click', 'dialog .dialog-actions .primary');
  await wait(`!!document.querySelector('dialog [role="alert"]') &&
    window.__smoke.requests.length === 1`);
  assert.equal(await evaluate('window.__smoke.downloads.length'), 0);
  await evaluate('window.__smoke.failMedia = false');
  await click('Zkusit znovu');
  await primaryReady('gif', false);
  assert.deepEqual(await evaluate('window.__smoke.requests.map(request=>request.format)'), [
    'gif',
    'gif',
  ]);
  await browser('click', 'dialog .dialog-actions .primary');
  await wait('window.__smoke.downloads.length === 1');
  assert.deepEqual(await evaluate('window.__smoke.downloads[0]'), filePayload('gif'));
  assert.equal(
    await evaluate('window.__smoke.requests.length'),
    2,
    'Retry prepares a reusable file',
  );
  assert.equal(
    await evaluate('window.__smoke.shared.length'),
    1,
    'Download fallback never shares a URL',
  );
  await closeFixture();
  await openFixture();
  await primaryReady('gif', false);
  await browser('click', 'dialog .dialog-actions .primary');
  await wait('window.__smoke.downloads.length === 2');
  assert.deepEqual(await evaluate('window.__smoke.downloads.at(-1)'), filePayload('gif'));
  assert.equal(await evaluate('window.__smoke.requests.length'), 3);
  await closeFixture();
  await openFixture();
  await primaryReady('gif', false);
  await holdValidation('gif');
  await browser('click', 'dialog .dialog-actions .primary');
  await wait(`typeof window.__late.release === 'function'`);
  await closeFixture();
  assert(await evaluate('window.__smoke.requests.at(-1).signal.aborted'));
  assert.deepEqual(
    await releaseValidation(),
    { created: 0, downloads: 0 },
    'Closing during a deferred mobile download prevents a late download',
  );
  await nativeGalleryContext();
  console.log(
    '✓ Mobile defaults to native GIF, shares supported files, and prepares unsupported downloads only on demand',
  );

  await browser('set', 'viewport', '1200', '900');
  // A sticker-only fixture exercises transparent-capable images across the full gallery.
  const stickers = catalog.filter(entry => new URL(entry.url).pathname.startsWith('/stickers/'));
  const sticker = stickers[0];
  assert(sticker, 'The source catalog includes stickers');
  catalogResponse = Response.json({ categories: dataset.categories, gifs: stickers });
  const stickerOptions = { entries: stickers, category: '' };
  await browser('open', `${origin}/?category=`);
  await results('', [], stickerOptions);
  const stickerCard = `article[data-id=${JSON.stringify(sticker.id)}]`;
  await wait(
    `document.querySelector(${JSON.stringify(stickerCard + ' img:not(.native-image)')})?.src === ${
      JSON.stringify(sticker.webp)
    }`,
  );
  assert.equal(await evaluate('document.querySelectorAll("article video").length'), 0);
  await lazyMedia();
  await browser('click', '.desktop-settings .playback-button');
  await wait(
    `document.querySelector(${JSON.stringify(stickerCard + ' img:not(.native-image)')})?.src === ${
      JSON.stringify(sticker.webp.replace('200w.webp', '200w_s.gif'))
    }`,
  );
  await hoverPlayback();
  await browser('click', '.desktop-settings .playback-button');
  await wait(
    `document.querySelector(${JSON.stringify(stickerCard + ' img:not(.native-image)')})?.src === ${
      JSON.stringify(sticker.webp)
    }`,
  );
  await browser('scrollintoview', 'article.gif-card:last-child');
  await wait(
    `!document.querySelector(${JSON.stringify(stickerCard + ' img:not(.native-image)')})`,
  );
  await lazyMedia();
  await browser('scrollintoview', stickerCard);
  await browser('set', 'viewport', '320', '568');
  await results('', [], stickerOptions);
  await galleryCards();
  await browser('click', `${stickerCard} .preview`);
  await wait(
    `document.querySelector('dialog [data-format="gif"]')?.getAttribute('aria-pressed') === 'true' &&
    document.querySelector('dialog img')?.complete && document.querySelector('dialog img')?.naturalWidth > 0 &&
    !document.querySelector('dialog .primary')?.disabled && !document.querySelector('dialog [role="alert"]')`,
  );
  await dialogDetails(sticker);
  assert(
    await evaluate(`!document.querySelector('dialog video') &&
      document.querySelector('dialog img').src === ${JSON.stringify(sticker.gif)}`),
    'Stickers default to the original GIF without an MP4 conversion',
  );
  await noOverflow();
  await browser('screenshot', resolve(root, 'artifacts/file-workflow-sticker-320.png'));
  await click('Zavřít');
  await wait(`!document.querySelector('dialog')`);
  catalogResponse = undefined;
  await browser('set', 'viewport', '1200', '900');
  await browser('open', `${origin}/?category=${LEGACY_CATEGORY}`);
  await results('');
  console.log('✓ Sticker WebP/still previews, offscreen image unloading and native GIF default');

  const initialTheme = await evaluate<string>('document.documentElement.dataset.theme');
  const themes = new Set([initialTheme]);
  for (let index = 0; index < 3; index++) {
    await click(/Přepnout:/);
    themes.add(await evaluate<string>('document.documentElement.dataset.theme'));
  }
  assert.deepEqual([...themes].sort(), ['dark', 'light', 'system']);
  assert.equal(await evaluate('document.documentElement.dataset.theme'), initialTheme);
  // Mobile is an independent journey; discard the desktop driver's native-dialog state.
  await browser('close');
  session = `cimrman-mobile-${process.pid}`;
  await browser('set', 'viewport', '390', '844');
  await browser('set', 'media', 'light');
  await browser('open', `${origin}/?category=${LEGACY_CATEGORY}`);
  await results('');
  await noOverflow();
  await lazyMedia();
  await browser('screenshot', resolve(root, 'artifacts/browser-mobile.png'));
  await mockSharing();
  for (const [width, height] of [[390, 844], [320, 568]] as const) {
    await browser('set', 'viewport', String(width), String(height));
    await results('');
    await categoryControls();
    await headerLayout();
    await keyboardCategories();
    if (width === 320) await mobilePinMenu();
    if (!await evaluate<boolean>('!!window.__smoke')) await mockSharing();
    await galleryCards();
    await infoPopover();
    assert(
      await evaluate(
        `getComputedStyle(document.querySelector('.quick-actions')).display === 'none'`,
      ),
      'Narrow screens hide hover actions',
    );
    await openFixture();
    await wait(
      `!!document.querySelector('dialog[open]') && !!document.querySelector('dialog img')`,
    );
    await dialogDetails();
    await originalGifImage();
    assert(
      await evaluate(`(() => {
      const dialog = document.querySelector('dialog');
      const box = dialog.getBoundingClientRect();
      return Math.abs(box.bottom - innerHeight) <= 1 && box.top >= 0 && box.left >= 0 &&
        box.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
    })()`),
      `Action sheet fits ${width}×${height} and attaches to the bottom`,
    );
    await noOverflow();
    if (width === 390) {
      await browser('screenshot', resolve(root, 'artifacts/browser-mobile-sheet.png'));
    }
    await browser('press', 'Escape');
    await wait(`!document.querySelector('dialog') &&
      document.activeElement === document.querySelector(${JSON.stringify(fixturePreview)})`);
  }
  // Filtering is independent of the repeated native-dialog/settings interactions above.
  await browser('close');
  session = `cimrman-filters-${process.pid}`;
  await browser('set', 'viewport', '390', '844');
  await browser('open', `${origin}/?category=${LEGACY_CATEGORY}`);
  await results('');
  await mockSharing();
  await search('SMOLJÁK');
  await clickTag('smoljak');
  await results('SMOLJÁK', ['smoljak']);
  await noOverflow();
  console.log(
    '✓ Theme modes, info popover, media-only cards and 390/320px action sheets with focus restoration',
  );

  // Put meaningful records far below the viewport to prove search covers unmounted media.
  const controls = catalog.filter(entry => entry.id !== fixture.id);
  assert(
    controls.length >= BATCH + 2,
    'Category regression needs enough source clips to place matches below the viewport',
  );
  const categorySample: Catalog = {
    categories: [{ id: LEGACY_CATEGORY, label: 'Cimrman' }, { id: 'beta', label: 'Beta' }],
    gifs: [
      ...controls.slice(0, BATCH).map(entry => ({
        ...entry,
        title: 'Filler',
        keywords: ['filler'],
        categoryIds: [LEGACY_CATEGORY],
      })),
      {
        ...fixture,
        title: 'Titulek',
        keywords: ['common'],
        categoryIds: [LEGACY_CATEGORY, 'beta'],
      },
      { ...controls[BATCH]!, title: 'Alpha', keywords: ['common'], categoryIds: [LEGACY_CATEGORY] },
      { ...controls[BATCH + 1]!, title: 'Jen Název', keywords: [], categoryIds: ['beta'] },
    ],
  };
  const categoryOptions = (category: string): ResultOptions => ({
    entries: categorySample.gifs,
    categories: categorySample.categories,
    category,
  });
  catalogResponse = Response.json(categorySample);
  await browser('open', `${origin}/?category=`);
  await results('', [], categoryOptions(''));
  await categoryControls(categorySample.categories, categorySample.gifs);
  await search('^titulek$', [], categoryOptions(''));
  assert(
    await evaluate(`!!document.querySelector(${JSON.stringify(fixtureCard)})`),
    'Title search finds a clip whose media was initially unmounted',
  );
  await chooseCategory('beta');
  await results('^titulek$', [], categoryOptions('beta'));
  await search('^jen', [], categoryOptions('beta'));
  await search('', [], categoryOptions('beta'));
  await clickTag('common');
  await results('', ['common'], categoryOptions('beta'));
  await search('^titulek$', ['common'], categoryOptions('beta'));
  await clickDetailCategory('Cimrman');
  await results('^titulek$', ['common'], categoryOptions(LEGACY_CATEGORY));
  await browser('back');
  await results('^titulek$', ['common'], categoryOptions('beta'));
  await browser('forward');
  await results('^titulek$', ['common'], categoryOptions(LEGACY_CATEGORY));
  await browser('reload');
  await results('^titulek$', ['common'], categoryOptions(LEGACY_CATEGORY));
  await chooseCategory('');
  await results('^titulek$', ['common'], categoryOptions(''));
  await browser('open', `${origin}/?category=unknown&q=%5Etitulek%24&tag=common`);
  await results('^titulek$', ['common'], categoryOptions('unknown'));
  await chooseCategory('');
  await results('^titulek$', ['common'], categoryOptions(''));
  catalogResponse = undefined;
  console.log(
    '✓ Complete category results, title-only search, shared membership, preserved filters and category history',
  );

  for (
    const failure of [
      new Response('Unavailable', { status: 503 }),
      Response.json({ invalid: 'catalog' }),
    ]
  ) {
    catalogResponse = failure;
    await browser('open', `${origin}/?category=${LEGACY_CATEGORY}`);
    await wait(`!!document.querySelector('[role="alert"]')`);
    const retry = await ref('button', 'Zkusit znovu');
    catalogResponse = undefined;
    await browser('click', retry);
    await results('');
  }
  console.log('✓ Catalog HTTP and malformed-data failures recover with Retry');

  // A real pathological regex in the real worker must time out without freezing the UI.
  const difficult = [{ ...fixture, title: '', keywords: ['a'.repeat(30_000) + '!'] }];
  catalogResponse = Response.json({ ...dataset, gifs: difficult });
  await browser('open', `${origin}/?category=${LEGACY_CATEGORY}`);
  await results('', [], { entries: difficult });
  await browser('fill', '#query', '(a+)+$');
  await wait(`document.querySelector('#search-error')?.textContent.includes('limit 1 s')`);
  await search('^safe$', [], { entries: difficult });
  console.log('✓ Pathological regex worker timeout and subsequent search recovery');
} catch (error) {
  failure = { error };
  console.error(
    'Browser state after failure:',
    await evaluate(`({
    url: location.href, timeOrigin: performance.timeOrigin, readyState: document.readyState,
    viewport: [innerWidth, innerHeight], mocked: !!window.__smoke,
    query: document.querySelector('#query')?.value, category: new URL(location.href).searchParams.get('category'),
    tags: new URL(location.href).searchParams.getAll('tag'),
    status: document.querySelector('#results-count')?.textContent,
    cards: document.querySelectorAll('article.gif-card').length,
    error: document.querySelector('#search-error')?.textContent ?? document.querySelector('.empty-state[role="alert"]')?.textContent ?? null,
    focus: document.activeElement?.id || document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName,
    dialog: !!document.querySelector('dialog'), dialogOpen: !!document.querySelector('dialog[open]'),
    infoOpen: !!document.querySelector('#site-info:popover-open')
  })`).catch(() => 'Browser state unavailable'),
  );
} finally {
  try {
    await browser('close');
  } catch (error) {
    if (failure) console.error('Browser cleanup also failed:', error);
    else failure = { error };
  } finally {
    server.stop(true);
    await rm(initPath, { force: true }).catch(error => {
      if (failure) console.error('Init-script cleanup also failed:', error);
      else failure = { error };
    });
  }
}
if (failure) throw failure.error;
console.log(
  'Browser smoke passed. Screenshots saved to artifacts/; visual inspection is separate.',
);
