# Architecture and verification

## Boundaries

- `App.svelte` owns catalog loading, URL filters and page controls.
- `CategoryNav.svelte` owns the category picker and personal pin controls.
- `GifCard.svelte` owns preview visibility, playback and quick actions.
- `MediaDialog.svelte` owns metadata filters, prepared files and sharing actions.
- `search.ts` defines matching and URL serialization.
- `search.worker.ts` isolates regex execution from the interface.
- `catalog.ts` validates incoming data; `media.ts` validates downloaded files.
- `discovery.ts` owns category preferences and the non-mutating browser shuffle.
- `pins.ts` validates and stores favourite category IDs separately from active filters.
- The Python generator is offline; the metadata refresh is an explicit command.

Readable source JSON is tracked in `resources/`.
Only the generated, minified `public/catalog.json` is shipped to the browser.
It contains IDs, source links, titles, cleaned keywords and category membership.
The browser derives media URLs from validated IDs at the catalog boundary.

Svelte runes hold local state; the URL holds shareable filters.
Pinned categories and the complete category picker share the title row.
Pin changes preserve active filters, URL state and gallery order.
An active unpinned category remains temporarily visible in the bar.
Saved empty pin lists are intentional; missing or malformed preferences use defaults.
All is the first shortcut; the first-visit default is Cimrman.
Desktop pin controls appear on hover or focus without reserving space or moving tabs.
Touch and narrow layouts use one category picker, with favourites first in its menu.
Pinning the active category preserves its position; reduced motion skips transitions.
The URL overrides the saved category, including an explicit empty value for All.
Invalid saved categories fall back to the default.
Explicit unknown links keep their empty-state explanation.
Storage failures leave URL-based navigation functional.
The menu sorts films and series by total count, independent of active filters.
Entertainment and children's programmes follow in a separate alphabetical group.
The desktop category strip scrolls horizontally and reveals keyboard focus.
Enlarged text can reflow the header without hiding controls.
Native dialogs and popovers handle focus and dismissal.
Mobile settings reuse the desktop info popup and shared playback/theme controls.
There is no router, state library, component library or server runtime.
`package.json` owns commands; tool configs own their rules.
Bun and uv lockfiles pin dependencies.
Markdown uses short sentences, one per source line.

## Checks

`bun run verify` runs static checks, unit tests, a build and browser tests.
The browser suite serves that build from a temporary loopback server.
It covers categories, regex, AND tags, URL history, loading failures and recovery.
It also covers media cleanup, keyboard navigation and narrow layouts.
Search examines every record in the selected category.
Every matching clip has a lightweight square placeholder, so scrolling has no pagination gate.
Native content visibility skips offscreen rendering while keeping keyboard access and stable layout.
Two shared observers prepare nearby previews and play only visible clips.
The browser shuffles the full catalog once after loading it.
Filters, history and scrolling preserve that page's order.
Generated data remains deterministic; discovery order is not written back to the source.
Scrolling never moves keyboard focus.
The gallery shows media without tag badges.
The GIF detail wraps all keywords and category labels as filter buttons.
Selecting a filter closes the dialog and moves focus beside the search filters.
A pathological regex must time out without freezing the page.
Worker loading has a separate deadline from regex execution.
A closed dialog must unmount before the test starts the next action.

Clipboard and share mocks verify payloads and user activation.
They do not establish native delivery to receiving applications.
Real-media screenshots were inspected on desktop and mobile, in light and dark.
Sampled accessibility audits found no violations, with manual checks still needed.
This is not a full device or assistive-technology certification.

## Media behavior

Far previews unmount; videos clear their source and call `load()` to release buffers.
Nearby previews stay prepared for smooth scrolling and reuse normal HTTP caching.
Sticker previews use animated WebP or a still image when paused.
The canonical Giphy page path identifies stickers without adding payload fields.
Closing the dialog or changing format aborts preparation and revokes its video URL.
No late download or URL creation is allowed after closure.
Download validation checks HTTP status, MIME type, size and file signature.
Signature checks reject obvious bad responses; they are not a full media decoder.

A [real clip][clip] downloaded as a 32-frame GIF and a playable H.264 MP4.
Availability and file signatures were sampled for regular clips and stickers.
This does not establish availability of every remote media file.

Chromium 153 on macOS flattened copied APNG and GIF-as-PNG to one frame.
HTML and custom clipboard formats retained animation inside those formats.
They did not create a generic native file attachment.
A scratch macOS pasteboard preserved the original animated bytes.
These results cover scripted copying, not every browser's native image-copy command.
Firefox on Windows can copy the original GIF through an image file promise.
Its `clipboard.imageAsFile.enabled` preference controls this native [copy path][firefox-source].
Mozilla records it as a [workaround for flattened GIFs][firefox-copy].
The preference is Windows-only and disabled by default.
Selecting GIF renders the original image for the browser's native menu.
The stable image URL remains usable after closing the dialog.
Giphy serves an HTML page to navigation requests, so a new-tab link is insufficient.
It does not invoke a clipboard write or claim that copying succeeded.
File sharing and downloads remain available across other browser configurations.
Windows and native receiving-app paste were not tested on devices.
The [sharing policy][sharing] separates browser handoff from recipient behavior.

References: [Clipboard API][clipboard], [Web Share][share] and [custom formats][web].

## Data provenance

Refresh follows the account and collection JSON feeds to their pagination end.
These public website endpoints are separate from the [documented search API][api].
Search stops the uploader listing early and cannot enumerate its collections.
Missing required metadata and duplicate collection slugs stop refresh.
Failed validation leaves existing outputs intact.
The [snapshot][snapshot] stores source titles, tags and resolved category membership.
The curated Cimrman file owns handwritten keywords and historical entries.
Curated keywords override source tags, including deliberately empty lists.
Collection slugs identify categories; a GIF can belong to several categories.
One reviewed registry maps exact programme tags to category labels.
Tag hints fill empty assignments only when exactly one programme matches.
Existing collection assignments take precedence over tag hints.
Uncategorized clips remain available in the complete catalog.
The offline build applies one [exact keyword correction policy][pipeline].
Unrelated keywords retain their order and spelling.
With unchanged inputs, catalog bytes and modification times stay unchanged.
Each [refresh report][report] records scan time, coverage and changes.
The report lists exclusions, missing attribution and retained absent records.
Its `reviewNeeded` section flags ambiguous tags and membership removals.
It also lists uncategorized clips and generic titles without usable tags.
These are candidates for review; complete pagination does not establish accuracy.
`membershipChanges` records exact before/after assignments.
Fuzzy spelling matches never change titles, keywords or categories automatically.
The build removes publisher noise and redundant assigned-category tags.
Equivalent case and diacritic spellings share one tag; first spelling/order wins.
Actors, reaction words and other categories remain available for filtering.
Source titles are searchable separately.
Refresh stages both outputs and rolls back the snapshot if the report write fails.
Conflicting edits and failed recovery are reported explicitly.
A crash between file replacements can still leave stale provenance.
Build time is in the info popup; data freshness and credits are in Help.
The [Pages workflow][deployment] checks pull requests and publishes successful `master` builds.
Only `dist/` is uploaded; source snapshots and local credentials are not published as site assets.
The existing custom domain remains configured in GitHub Pages settings.

[clip]: https://giphy.com/gifs/ceskatelevize-ceska-czechtv-H35lI7mvlYpfZpJB2m
[clipboard]: https://www.w3.org/TR/clipboard-apis/
[share]: https://www.w3.org/TR/web-share/
[web]: https://developer.chrome.com/blog/web-custom-formats-for-the-async-clipboard-api
[firefox-source]: https://searchfox.org/firefox-main/source/dom/base/nsCopySupport.cpp
[firefox-copy]: https://bugzilla.mozilla.org/show_bug.cgi?id=2007628
[sharing]: sharing.md
[report]: ../resources/refresh-report.json
[api]: https://developers.giphy.com/docs/api/endpoint/#search-endpoint
[pipeline]: ../scripts/catalog.py
[snapshot]: ../resources/giphy.json
[deployment]: ../.github/workflows/pages.yaml
