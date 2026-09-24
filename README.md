# [Gify České televize][site]

Jednoduchý nástroj pro vyhledávání, prohlížení a sdílení gifů České televize.
Zdrojem je [profil České televize na Giphy][collection].

## Použití

Oblíbené zobrazí gify ze všech připnutých pořadů.
Kliknutím na název webu se vrátíte do Oblíbených a zrušíte hledání i štítky.
Volba Oblíbené v nabídce pořadů hledání i štítky zachová.
Při první návštěvě se otevřou Oblíbené, příště poslední výběr.
Kategorie uvedená v odkazu má přednost před uloženou volbou.
Na počítači mají oblíbené pořady tlačítka v horní liště, všechny najdete v nabídce Další.
Špendlíkem v liště nebo nabídce Další připnete a odepnete oblíbené pořady.
Na počítači se špendlík ukáže po najetí nebo při ovládání klávesnicí.
Na mobilu jsou oblíbené pořady nahoře v nabídce.
Volba se ukládá v tomto prohlížeči; Obnovit výchozí vrátí původní lištu.
Připnutí a odepnutí rovnou změní obsah Oblíbených.
Samostatně vybraný pořad zůstane po odepnutí otevřený a viditelný v liště.
Filmy a seriály jsou seřazené podle počtu gifů.
Zábavné a dětské pořady jsou zvlášť na konci podle abecedy.
Změna pořadu zachová hledání i vybrané štítky.
Hledání nerozlišuje velikost písmen ani diakritiku a podporuje regulární výrazy.
Výrazy oddělené mezerou musí platit všechny, například `svěrák ^jak$`.
Hledá se v názvech a štítcích.
Popisy a zařazení ze zdroje mohou být neúplné nebo chybné.
Kliknutím na štítky v detailu GIFu výběr dále zúžíte.
Vybrané štítky lze jednotlivě odebrat nebo všechny zrušit.
Galerie pokračuje plynule při posouvání; hledání prochází všechny gify ve výběru.
Načítají se jen blízké náhledy a přehrávají se pouze viditelné.
Při každém načtení stránky se pořadí gifů promíchá.
Při hledání, filtrování a posouvání se už nemění.

Kliknutím na gif otevřete detail pro sdílení a stažení skutečného souboru.
Na mobilu podržte už náhled v galerii pro sdílení původního GIFu.
Plný GIF se začne načítat až při podržení.
Klepnutí otevře detail rovnou s GIFem.
Vyberte video (MP4) nebo GIF.
Video je obvykle menší; GIF zachová animovaný obrázek a průhlednost.
Sdílení předá vybraný soubor systémové nabídce bez přidaného odkazu.
Pokud prohlížeč sdílení souborů neumí, soubor stáhněte a přiložte v cílové aplikaci.
V detailu uvidíte všechny štítky a kliknutím na pořad zúžíte výběr.
Na počítači se rychlé akce zobrazí také po najetí myší.
Sdílet GIF v překryvu otevře systémovou nabídku bez otevírání detailu.
Pokud nabídka obsahuje Kopírovat, tuto volbu je potřeba vybrat ručně.
Po výběru GIFu lze použít nabídku obrázku → Kopírovat obrázek.
Firefox pro Windows má [volitelné kopírování GIFu jako souboru][firefox-copy].
V `about:config` ho zapíná `clipboard.imageAsFile.enabled = true`.
Stažený soubor lze zkopírovat ze správce souborů a vložit do jiné aplikace.
Zachování animace při vložení závisí na prohlížeči a cílové aplikaci.
Kopírování odkazu je samostatná možnost.
Na mobilu najdete přehrávání, vzhled a informace o webu pod tlačítkem nastavení.

## Development

Svelte, TypeScript and Vite provide the static frontend.
Python tooling uses uv and the standard library.
fnm reads [.node-version](.node-version).
uv reads [.python-version](.python-version).
Project commands live in [package.json](package.json).

```sh
fnm use --install-if-missing
bun install --frozen-lockfile
uv sync --locked --managed-python
bun run dev
```

Run `bun run` to list the available commands.
Browser verification also uses the installed `agent-browser` CLI.

The [Pages workflow][deployment] checks pull requests and builds the site.
Changes merged into `master` publish `dist/` to the existing GitHub Pages domain.
Deployment uses the tracked catalog snapshot and needs no Giphy credentials.

Curated Cimrman keywords live in [resources/cimrman_id_url.json][catalog].
They take precedence over Giphy tags, including explicitly empty keyword lists.
Identical original GIF hashes share one browser entry, with combined titles and categories.
Keywords combine across duplicates; curated keywords take precedence for the whole group.
Different or missing hashes stay separate, as do GIFs and stickers.
Every source ID remains in the snapshot; the refresh report lists merged uploads.
Refresh generates the [Giphy snapshot][snapshot] from channel JSON feeds.
Collection membership provides categories; explicit pipeline rules fill known gaps.
Only unambiguous programme tags fill an empty category assignment.
The developer search API cannot enumerate the full account.
The offline build applies the [keyword correction policy][pipeline].
It removes exact publisher labels and assigned-category labels from tags.
Shared aliases live in [scripts/policy.py][tag-policy].
Source tags remain intact in the snapshot.
Tracked source JSON stays readable; the site loads only generated, minified data.
The browser derives media URLs from validated GIF IDs.
Edit pipeline inputs and policies, then regenerate; never patch generated data.
The refresh report records coverage, exclusions and retained historical clips.
Its `reviewNeeded` section flags metadata gaps and conflicts for human review.
See [architecture and verification][verification] for behavior and test limits.
The [sharing policy][sharing] explains formats, browser fallbacks and recipient evidence.

[site]: https://cimrman.zelinka.dev
[collection]: https://giphy.com/ceska_televize
[catalog]: resources/cimrman_id_url.json
[snapshot]: resources/giphy.json
[pipeline]: scripts/catalog.py
[tag-policy]: scripts/policy.py
[verification]: docs/verification.md
[deployment]: .github/workflows/pages.yaml
[sharing]: docs/sharing.md
[firefox-copy]: https://bugzilla.mozilla.org/show_bug.cgi?id=2007628
