# Architecture and verification

## Boundaries

- `App.svelte` owns catalog loading, URL filters and page controls.
- `GifCard.svelte` owns preview visibility, playback and tag actions.
- `MediaDialog.svelte` owns prepared files, link actions and native sharing.
- `search.ts` defines matching and URL serialization.
- `search.worker.ts` isolates regex execution from the interface.
- `catalog.ts` validates incoming data; `media.ts` validates downloaded files.
- The Python generator is offline; the metadata refresh is an explicit command.

Svelte runes hold local state; the URL holds shareable filters.
Native dialogs and popovers handle focus and dismissal.
There is no router, state library, component library or server runtime.
`package.json` owns commands; tool configs own their rules.
Bun and uv lockfiles pin dependencies.
Markdown uses short sentences, one per source line.

## Checks

`bun run verify` runs static checks, unit tests, a build and browser tests.
The browser suite serves that build from a temporary loopback server.
It covers search, AND tags, URL history, loading failures and recovery.
It also covers media cleanup, keyboard navigation and narrow layouts.
All catalog records remain available; tag rows scroll without wrapping.
A pathological regex must time out without freezing the page.
Worker loading has a separate deadline from regex execution.
A closed dialog must unmount before the test starts the next action.

Clipboard and share mocks verify payloads and user activation.
They do not establish native delivery to receiving applications.
Real-media screenshots were inspected on desktop and mobile, in light and dark.
Sampled accessibility audits found no violations, with manual checks still needed.
This is not a full device or assistive-technology certification.

## Media behavior

Offscreen previews remove their source and call `load()` to release buffers.
Closing the media dialog aborts preparation and revokes its object URL.
No late download or URL creation is allowed after closure.
Download validation checks HTTP status, MIME type, size and file signature.
Signature checks reject obvious bad responses; they are not a full media decoder.

A [real clip][clip] downloaded as a 32-frame GIF and a playable H.264 MP4.
Three catalog IDs were sampled across GIF, MP4 and WebP endpoints.
This does not establish availability of every remote media file.

Chromium 153 on macOS flattened copied APNG and GIF-as-PNG to one frame.
HTML and custom clipboard formats retained animation inside those formats.
They did not create a generic native file attachment.
A scratch macOS pasteboard preserved the original animated bytes.
The operating system can hold animation; the website API is the constraint.
The app therefore offers actual file sharing and downloads.
Windows and native receiving-app paste were not tested on devices.

References: [Clipboard API][clipboard], [Web Share][share] and [custom formats][web].

## Data provenance

Refresh discovers clips through the [official Giphy API][api].
Search coverage does not establish complete collection membership.
Build and refresh share one [exact keyword correction policy][pipeline].
Unrelated keywords retain their order and spelling.
With unchanged inputs, catalog bytes and modification times stay unchanged.
Each [refresh report][report] records scan time, coverage and changes.
It also lists clips still needing keywords.
API tags and titles are never imported as search keywords.
Existing records remain even when search omits them.
Refresh stages both outputs and rolls back the source if the report write fails.
Conflicting edits and failed recovery are reported explicitly.
A crash between file replacements can still leave stale provenance.
Build time is in the info popup; data freshness and credits are in Help.
Remote Git changes and internet deployment remain outside this local exercise.

[clip]: https://giphy.com/gifs/ceskatelevize-ceska-czechtv-H35lI7mvlYpfZpJB2m
[clipboard]: https://www.w3.org/TR/clipboard-apis/
[share]: https://www.w3.org/TR/web-share/
[web]: https://developer.chrome.com/blog/web-custom-formats-for-the-async-clipboard-api
[report]: ../resources/refresh-report.json
[api]: https://developers.giphy.com/docs/api/endpoint/#search-endpoint
[pipeline]: ../scripts/catalog.py
