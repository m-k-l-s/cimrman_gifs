import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Run after `bun run build`. All interaction uses the installed agent-browser CLI.
const root = resolve(import.meta.dir, '..');
const dist = resolve(root, 'dist');
const session = `cimrman-verify-${process.pid}`;
type Entry = { id: string; url: string; keywords: string[]; mp4: string; gif: string };
type BrowserData = {
  result?: unknown;
  refs?: Record<string, { role: string; name: string }>;
};

assert(await Bun.file(resolve(dist, 'index.html')).exists(), 'Build first: bun run build');
const catalog: Entry[] = await Bun.file(resolve(dist, 'catalog.json')).json();
assert(catalog.length > 0, 'The built catalog must contain clips');
const fixture = catalog.find(entry => entry.id === 'H35lI7mvlYpfZpJB2m');
assert(fixture, 'The historical browser fixture must remain in the catalog');
assert(
  ['ja', 'smoljak', 'jidlo'].every(tag => fixture.keywords.includes(tag)),
  'The browser fixture must retain its curated tags',
);
let catalogResponse: Response | undefined;
let workerDelayMs = 0;
let delayedWorkerRequests = 0;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
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
    cmd: ['agent-browser', '--session', session, '--headed', 'false', '--json', ...args],
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

const wait = (condition: string) => browser('wait', '--fn', condition);
const label = (entry: Entry) => entry.keywords.join(' · ') || 'Cimrmanův gif';
const normalized = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function expectedLabels(query: string, tags: string[] = [], entries = catalog): string[] {
  const patterns = query.trim().split(/\s+/).filter(Boolean)
    .map((word) => new RegExp(normalized(word), 'i'));
  return entries.filter((entry) =>
    tags.every((tag) =>
      entry.keywords.some((word) =>
        normalized(word).trim().toLowerCase() === normalized(tag).trim().toLowerCase()
      )
    ) && patterns.every((pattern) => entry.keywords.some((word) => pattern.test(normalized(word))))
  ).map(label);
}

async function results(query: string, tags: string[] = [], entries = catalog): Promise<void> {
  const expected = expectedLabels(query, tags, entries);
  const condition = `
    document.querySelector('#query')?.value === ${JSON.stringify(query)} &&
    (new URL(location.href).searchParams.get('q') ?? '') === ${JSON.stringify(query)} &&
    JSON.stringify(new URL(location.href).searchParams.getAll('tag')) === JSON.stringify(${
    JSON.stringify(tags)
  }) &&
    !document.querySelector('#search-error') &&
    document.querySelectorAll('article.gif-card').length === ${expected.length} &&
    document.querySelector('#results-count')?.textContent.includes(${
    JSON.stringify(String(expected.length))
  })
  `;
  try {
    await wait(condition);
  } catch (error) {
    console.error(
      'Search state after failure:',
      await evaluate(`({
      url: location.href, query: document.querySelector('#query')?.value,
      tags: new URL(location.href).searchParams.getAll('tag'),
      status: document.querySelector('#results-count')?.textContent,
      cards: document.querySelectorAll('article.gif-card').length,
      error: document.querySelector('#search-error')?.textContent ?? null,
      focus: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.id
    })`).catch(() => 'Browser state unavailable'),
    );
    throw error;
  }
  assert.deepEqual(
    await evaluate(`({
      labels: Array.from(document.querySelectorAll('article.gif-card'), card => card.getAttribute('aria-label')),
      tags: Array.from(document.querySelectorAll('.tag-filters button[aria-label]'), button =>
        button.getAttribute('aria-label').replace('Odebrat štítek: ', ''))
    })`),
    { labels: expected, tags },
    `Results for ${JSON.stringify({ query, tags })}`,
  );
}

async function search(query: string, tags: string[] = [], entries = catalog): Promise<void> {
  await browser('fill', '#query', query);
  await results(query, tags, entries);
  await browser('press', 'Enter');
}

async function lazyMedia(): Promise<void> {
  // Chromium can retain currentSrc after a failed load; these fields prove resource release.
  await wait(`document.querySelectorAll('article video[src]').length > 0 &&
    [...document.querySelectorAll('article video:not([src])')]
      .every(video => video.readyState === 0 && video.networkState === 0 &&
        video.buffered.length === 0 && video.paused)`);
  const state = await evaluate<{ total: number; loaded: number; outside: number }>(`(() => {
    const videos = [...document.querySelectorAll('article video')];
    const loaded = videos.filter(video => video.hasAttribute('src'));
    return {
      total: videos.length,
      loaded: loaded.length,
      outside: loaded.filter(video => {
        const box = video.getBoundingClientRect();
        return box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth;
      }).length
    };
  })()`);
  assert(state.loaded < state.total, 'Only visible clips should load media');
  assert.equal(state.outside, 0, 'Offscreen clips should have no video source');
  console.log(`  lazy media: ${state.loaded}/${state.total} clips loaded in the viewport`);
}

async function noOverflow(): Promise<void> {
  assert(
    await evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth'),
    'Horizontal overflow',
  );
}

async function tagRows(): Promise<void> {
  const rows = await evaluate<{ counts: number[]; singleLine: boolean; contained: boolean }>(
    `(() => {
    const rows = [...document.querySelectorAll('article .keywords')];
    return {
      counts: rows.map(row => row.querySelectorAll('.tag').length),
      singleLine: rows.every(row => {
        const tags = [...row.querySelectorAll('.tag')];
        return !row.querySelector('details') && tags.every(tag =>
          Math.abs(tag.getBoundingClientRect().top - tags[0].getBoundingClientRect().top) <= 1);
      }),
      contained: rows.every(row => ['auto', 'scroll'].includes(getComputedStyle(row).overflowX) &&
        row.getBoundingClientRect().width <= row.closest('article').getBoundingClientRect().width)
    };
  })()`,
  );
  assert.deepEqual(
    rows.counts,
    catalog.map(entry => entry.keywords.length),
    'Every source tag remains available',
  );
  assert(rows.singleLine, 'Each card uses exactly one tag row');
  assert(rows.contained, 'Tag overflow stays inside its scrollable row');
  await noOverflow();
}

async function infoPopover(): Promise<void> {
  assert(
    await evaluate(`!document.querySelector('footer')`),
    'Build information belongs in the header popover',
  );
  await click('O webu');
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
  await browser('press', 'Escape');
  await wait(`!document.querySelector('#site-info:popover-open')`);
}

let failure: { error: unknown } | undefined;
try {
  // Catalog order and keywords can change while the historical clip's identity stays stable.
  const fixtureCard = `article.gif-card[data-id=${JSON.stringify(fixture.id)}]`;
  const fixturePreview = `${fixtureCard} .preview`;
  const openFixture = () => browser('click', fixturePreview);
  const clickTag = (tag: string) =>
    browser('click', `${fixtureCard} .tag[aria-label="Filtrovat štítek: ${tag}"]`);
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
  await browser('open', origin);
  await results('');
  // Check the accessible name once; native-dialog transitions can leave AX snapshots stale.
  await ref('textbox', 'Hledat v hláškách');
  await tagRows();
  await infoPopover();
  await click('O webu');
  await browser('click', '#query');
  await wait(`!document.querySelector('#site-info:popover-open')`);
  assert.deepEqual(
    await evaluate(`({
    overlays: document.querySelectorAll('article .media .quick-actions').length,
    grids: document.querySelectorAll('article .card-actions').length,
    previews: document.querySelectorAll('article .preview[aria-haspopup="dialog"]').length,
    fixtureLabel: document.querySelector(${
      JSON.stringify(fixturePreview)
    })?.getAttribute('aria-label')
  })`),
    { overlays: catalog.length, grids: 0, previews: catalog.length, fixtureLabel: previewName },
    'Compact actions replace card grids',
  );
  await overlayVisible(false);
  await browser('focus', fixturePreview);
  await overlayVisible(true);
  await browser('press', 'Tab');
  assert.equal(
    await evaluate('document.activeElement?.getAttribute("aria-label")'),
    `Kopírovat odkaz: ${label(fixture)}`,
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
    downloads: document.querySelectorAll('article button[aria-label^="Stáhnout GIF:"]').length,
    deadCopy: [...document.querySelectorAll('article button')]
      .some(button => button.textContent.trim() === 'Kopírovat GIF')
  })`),
    { downloads: catalog.length, deadCopy: false },
    'Every card offers an actual GIF download',
  );
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await browser('screenshot', resolve(root, 'artifacts/browser-desktop.png'));
  // Inject a decode failure, then let the real source recover when it re-enters the viewport.
  await browser('scrollintoview', fixturePreview);
  await evaluate(`(() => {
    const video = document.querySelector(${JSON.stringify(`${fixtureCard} video`)});
    video.src = 'data:video/mp4,invalid';
    video.load();
    void video.play().catch(() => {});
  })()`);
  await wait(`!!document.querySelector(${JSON.stringify(`${fixtureCard} .preview-error`)})`);
  await browser('scroll', 'down', '1000');
  await wait(`(() => {
    const video = document.querySelector(${JSON.stringify(`${fixtureCard} video`)});
    return !video.hasAttribute('src') && video.readyState === 0 && video.networkState === 0 &&
      video.buffered.length === 0 && video.paused;
  })()`);
  await lazyMedia();
  await browser('scroll', 'up', '1000');
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
  await browser('focus', `${fixtureCard} .tag:first-child`);
  for (let index = 1; index < fixture.keywords.length; index++) await browser('press', 'Tab');
  assert.equal(
    await evaluate('document.activeElement?.getAttribute("aria-label")'),
    `Filtrovat štítek: ${lastTag}`,
  );
  await wait(`(() => {
    const row = document.querySelector(${JSON.stringify(`${fixtureCard} .keywords`)});
    const tag = document.activeElement.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return row.scrollLeft > 0 && tag.left >= box.left && tag.right <= box.right + 1;
  })()`);
  await browser('press', 'Enter');
  await results('', [lastTag]);
  await click(`Odebrat štítek: ${lastTag}`);
  await results('');
  await browser('focus', `${fixtureCard} .tag:first-child`);
  await wait(
    `document.querySelector(${JSON.stringify(`${fixtureCard} .keywords`)})?.scrollLeft === 0`,
  );

  await clickTag('smoljak');
  await results('', ['smoljak']);
  assert(
    await evaluate(`document.activeElement === document.querySelector('.tag-filters')`),
    'Tag focus remains above results',
  );
  assert(
    await evaluate(
      `document.querySelector('button[aria-label="Filtrovat štítek: smoljak"]')?.getAttribute('aria-pressed') === 'true'`,
    ),
  );
  await clickTag('ja');
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
    `${origin}/?q=${encodeURIComponent('^jidlo$')}&tag=SMOLJ%C3%81K&tag=J%C3%A1`,
  );
  await results('^jidlo$', ['SMOLJÁK', 'Já']);
  await browser('open', `${origin}/?tag=unknown-tag-529571`);
  await results('', ['unknown-tag-529571']);
  await click('Odebrat štítek: unknown-tag-529571');
  await results('');
  console.log(
    '✓ Complete scrolling tag rows, keyboard access, AND/regex filters, chips and history',
  );

  // Capture browser API payloads only. No OS share sheet, recipient or delivery is involved.
  const mockSharing = () =>
    evaluate(`(() => {
    window.__smoke = { copied: [], shared: [], downloads: [], denyCopy: false, cancelShare: false, failMedia: false };
    document.addEventListener('click', event => {
      if (event.target instanceof HTMLAnchorElement && event.target.download) {
        event.preventDefault();
        window.__smoke.downloads.push(event.target.download);
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
      if (window.__smoke.cancelShare) throw new DOMException('Cancelled', 'AbortError');
    }});
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === ${JSON.stringify(fixture.gif)}) {
        return Promise.resolve(new Response('GIF89a', { headers: { 'Content-Type': 'image/gif' } }));
      }
      if (url === ${JSON.stringify(fixture.mp4)}) {
        if (window.__smoke.failMedia) return Promise.resolve(new Response('Unavailable', { status: 503 }));
        // Valid MP4 signature, intentionally not a playable movie: this tests handoff only.
        return Promise.resolve(new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), {
          headers: { 'Content-Type': 'video/mp4' }
        }));
      }
      return originalFetch(input, options);
    };
  })()`);
  await mockSharing();
  await browser('hover', fixturePreview);
  await browser('click', `${fixtureCard} button[aria-label^="Kopírovat odkaz:"]`);
  assert.deepEqual(await evaluate('window.__smoke.copied'), [fixture.gif]);
  await browser('click', `${fixtureCard} button[aria-label^="Stáhnout GIF:"]`);
  await wait(`window.__smoke.downloads.length === 1 && !document.querySelector('dialog[open]')`);
  assert.deepEqual(await evaluate('window.__smoke.downloads'), [`cimrman-${fixture.id}.gif`]);
  await evaluate('window.__smoke.failMedia = true');
  await openFixture();
  await wait(`!!document.querySelector('dialog [role="alert"]')`);
  await click('Kopírovat odkaz');
  assert.deepEqual(await evaluate('window.__smoke.copied'), [fixture.gif, fixture.gif]);
  await click('Sdílet odkaz');
  assert.equal(await evaluate('window.__smoke.shared[0]?.url'), fixture.gif);
  await evaluate(
    `Object.assign(window.__smoke, { denyCopy: true, cancelShare: true, failMedia: false })`,
  );
  await click('Kopírovat odkaz');
  await wait(
    `document.querySelector('dialog input[aria-label="Odkaz pro ruční zkopírování"]')?.value === ${
      JSON.stringify(fixture.gif)
    }`,
  );
  await click('Zkusit znovu');
  await wait(
    `!!document.querySelector('dialog[open]') && [...document.querySelectorAll('dialog button')].some(button => button.textContent.trim() === 'Sdílet video' && !button.disabled)`,
  );
  await click('Sdílet video');
  await wait(`window.__smoke.shared.length === 2 &&
    !document.querySelector('dialog [role="alert"]') &&
    !document.querySelector('dialog [role="status"]')?.textContent.includes('předáno') &&
    [...document.querySelectorAll('dialog button')].every(button => !button.disabled)`);
  await evaluate('window.__smoke.cancelShare = false');
  await click('Sdílet video');
  await wait(`document.querySelector('dialog [role="status"]')?.textContent.includes('předáno')`);
  assert.deepEqual(await evaluate('window.__smoke.shared.at(-1)'), {
    files: [{ name: `cimrman-${fixture.id}.mp4`, type: 'video/mp4', size: 12 }],
    active: true,
  }, 'Share contains only the file and retains the user gesture');
  await click('Zavřít');
  await wait(`!document.querySelector('dialog') &&
    document.activeElement === document.querySelector(${JSON.stringify(fixturePreview)})`);
  console.log(
    '✓ Desktop hover/keyboard actions, dialog focus, link/download/share payloads and failure recovery (mocked APIs)',
  );

  // Close during the final header read, then resume it: neither branch may publish a late file.
  for (const format of ['mp4', 'gif']) {
    if (format === 'gif') {
      await openFixture();
      await wait(`!!document.querySelector('dialog video')`);
    }
    await evaluate(`(() => {
      const read = Blob.prototype.arrayBuffer, create = URL.createObjectURL;
      window.__late = { created: 0, downloads: window.__smoke.downloads.length };
      Blob.prototype.arrayBuffer = function() {
        return new Promise(resolve => {
          window.__late.release = async () => resolve(await read.call(this));
        });
      };
      URL.createObjectURL = blob => { window.__late.created++; return create.call(URL, blob); };
      window.__late.restore = () => { Blob.prototype.arrayBuffer = read; URL.createObjectURL = create; };
    })()`);
    if (format === 'mp4') await openFixture();
    else await click('Stáhnout GIF');
    await wait(`typeof window.__late.release === 'function'`);
    await click('Zavřít');
    await wait(`!document.querySelector('dialog')`);
    assert.deepEqual(
      await evaluate(`(async () => {
      await window.__late.release();
      await new Promise(resolve => setTimeout(resolve, 0)); // Drain validation continuations.
      window.__late.restore();
      return { created: window.__late.created, downloads: window.__smoke.downloads.length - window.__late.downloads };
    })()`),
      { created: 0, downloads: 0 },
      `Closing during ${format} validation cancels late output`,
    );
  }
  console.log('✓ Closing during MP4/GIF validation cancels late object URLs and downloads');

  const initialTheme = await evaluate<string>('document.documentElement.dataset.theme');
  const themes = new Set([initialTheme]);
  for (let index = 0; index < 3; index++) {
    await click(/Přepnout:/);
    themes.add(await evaluate<string>('document.documentElement.dataset.theme'));
  }
  assert.deepEqual([...themes].sort(), ['dark', 'light', 'system']);
  assert.equal(await evaluate('document.documentElement.dataset.theme'), initialTheme);
  await browser('set', 'viewport', '390', '844');
  await browser('reload');
  await results('');
  await noOverflow();
  await lazyMedia();
  await browser('screenshot', resolve(root, 'artifacts/browser-mobile.png'));
  await mockSharing();
  for (const [width, height] of [[390, 844], [320, 568]] as const) {
    await browser('set', 'viewport', String(width), String(height));
    await tagRows();
    await infoPopover();
    assert(
      await evaluate(
        `getComputedStyle(document.querySelector('.quick-actions')).display === 'none'`,
      ),
      'Narrow screens hide hover actions',
    );
    await openFixture();
    await wait(
      `!!document.querySelector('dialog[open]') && !!document.querySelector('dialog video')`,
    );
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
  await browser('set', 'viewport', '390', '844');
  await search('SMOLJÁK');
  await clickTag('smoljak');
  await results('SMOLJÁK', ['smoljak']);
  await noOverflow();
  console.log(
    '✓ Theme modes, info popover, one-row tags and 390/320px action sheets with focus restoration',
  );

  for (
    const failure of [
      new Response('Unavailable', { status: 503 }),
      Response.json({ invalid: 'catalog' }),
    ]
  ) {
    catalogResponse = failure;
    await browser('open', origin);
    await wait(`!!document.querySelector('[role="alert"]')`);
    const retry = await ref('button', 'Zkusit znovu');
    catalogResponse = undefined;
    await browser('click', retry);
    await results('');
  }
  console.log('✓ Catalog HTTP and malformed-data failures recover with Retry');

  // A real pathological regex in the real worker must time out without freezing the UI.
  const difficult = [{ ...fixture, keywords: ['a'.repeat(30_000) + '!'] }];
  catalogResponse = Response.json(difficult);
  await browser('open', origin);
  await results('', [], difficult);
  await browser('fill', '#query', '(a+)+$');
  await wait(`document.querySelector('#search-error')?.textContent.includes('limit 1 s')`);
  await search('^safe$', [], difficult);
  console.log('✓ Pathological regex worker timeout and subsequent search recovery');
} catch (error) {
  failure = { error };
} finally {
  try {
    await browser('close');
  } catch (error) {
    if (failure) console.error('Browser cleanup also failed:', error);
    else failure = { error };
  } finally {
    server.stop(true);
  }
}
if (failure) throw failure.error;
console.log(
  'Browser smoke passed. Screenshots saved to artifacts/; visual inspection is separate.',
);
