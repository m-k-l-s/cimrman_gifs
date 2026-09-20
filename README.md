# [Gify z Divadla Járy Cimrmana][site]

Jednoduchý nástroj pro vyhledávání, prohlížení a sdílení cimrmanovských gifů.
Gify na Giphy zveřejnila [Česká televize][collection].

## Použití

Hledání nerozlišuje velikost písmen ani diakritiku a podporuje regulární výrazy.
Výrazy oddělené mezerou musí platit všechny, například `svěrák ^jak$`.
Kliknutím na štítky výběr dále zúžíte.
Vybrané štítky lze jednotlivě odebrat nebo všechny zrušit.
Další štítky pod obrázkem zobrazíte posunutím do strany.

Kliknutím na gif otevřete nabídku pro kopírování odkazu, sdílení a stažení.
Na počítači se rychlé akce zobrazí také po najetí myší.
Stažený soubor lze zkopírovat ze správce souborů a vložit do jiné aplikace.
Samotný web neumí zaručit vložení animace ze schránky.

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

Curated metadata lives in [resources/cimrman_id_url.json][catalog].
Refresh uses the official Giphy API and retains known clips.
Build and refresh share the [keyword correction policy][pipeline].
Set `GIPHY_API_KEY` or put the key in the ignored `API_KEY` file.
The refresh report lists missing search results and clips needing keywords.
See [architecture and verification][verification] for behavior and test limits.

[site]: https://cimrman.zelinka.dev
[collection]: https://giphy.com/ceska_televize/cimrmani
[catalog]: resources/cimrman_id_url.json
[pipeline]: scripts/catalog.py
[verification]: docs/verification.md
