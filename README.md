# gmd2txt

**Convert Geometry Dash level files both ways — `.gmd` ⇄ `.txt` — privately, in your browser.**

Drop a file, get the other format. Nothing to install, no account, no upload, no ads:
the conversion runs entirely inside the browser tab and keeps working offline.

```
.gmd  ──►  .txt   the level string inside the export, ready to paste anywhere
.txt  ──►  .gmd   a proper level file, with name, creator and song filled in
```

## Run it

The app is static, so any web server works (local files need an origin for modules and storage):

```sh
python3 -m http.server 8000
```

Then open **<http://localhost:8000/app/>**. The repository root also redirects there.

Install it from the browser's address bar (or *Install app*) to get a desktop/phone icon that
works offline.

## How people use it

1. **Drop** one or more `.gmd` / `.txt` files on the page, choose files, or paste a level string.
   Dragging a folder of exports in also works — everything is converted in one pass.
2. **See what's inside.** Every result reports the level's object count, creator, song, portals,
   triggers, game modes and start position, so the file is not a black box.
3. **Take the result.** Copy the text, download the converted file, download everything as a `.zip`,
   open the *Readable text* view to inspect the decoded level, or hit **Play preview** to load the
   level into the bundled Geometry Dash runtime.

Mistakes are explained in plain language ("this looks like a save file, not a level file") instead of
throwing errors, and every download button also has a copy button for people who just want the text.

## What each format is

| | `.gmd` | `.txt` |
|---|---|---|
| What it is | A Geometry Dash level export (an XML plist) | The raw level string |
| Contains | The level data (`k4`) plus name, creator, description, song | The level data only |
| Looks like | Readable XML | Usually compressed text starting with `H4sI…` |
| Used by | Level sharing, GDShare and similar tools | Modded clients, level-string fields, plain-text backups |

The converter reads both the classic `<k>k4</k><s>…</s>` exports and standard plist
`<key>k4</key><string>…</string>` documents, tolerates byte-order marks, terminal NUL padding and
URL-safe base64, and writes gzip-compressed level strings the way the game expects. The level data
itself is never rewritten — it is embedded or extracted byte-for-byte.

## Privacy

* No server, no analytics, no network requests for your files. Open the app with the network off —
  it still converts.
* Converted files are kept in this browser's own IndexedDB storage so you can download them again
  later ("Saved in this browser"). Deleting them there does not touch your originals.
* Downloads are produced with object URLs and never leave the machine.

## Browser support

Any current Chrome, Edge, Firefox or Safari. Conversion prefers the built-in
`CompressionStream`/`DecompressionStream` and falls back to the bundled pako library when a browser
does not have them. Copying falls back to the legacy `execCommand` path when the async clipboard API
is unavailable, and the whole app is usable from a phone.

## Advanced workshop (optional)

Everything that is not part of the one-file conversion lives behind the **Advanced workshop** link —
it is the previous GMDPlayer workbench, unchanged, at `/app/workbench/`:

* **Save explorer** — decode `CCGameManager.dat` / `CCLocalLevels.dat`, browse local levels and
  custom songs, mask sensitive fields, export read-only decoded views.
* **Texture pack editor** — import PNG/PLIST sprite sheets or ZIP packs, replace sprites, export
  sheets, merge or repack atlases.
* **Songs & audio** — local audio library with per-level overrides.
* **Projects & backups** — `.gmdproject` archives with checksummed restore.

It is deliberately kept out of the main flow: the converter is the product, the workshop is the
power-user drawer. `/app/converter/` (the original one-file extractor) now redirects to the converter.

## Project layout

```
app/
  index.html          the converter (single screen, no build step)
  main.js             converter UI: converting, results, storage, preview player
  assets/gmd2txt.css  converter styles (light + dark, no external fonts)
  workbench/          the advanced GMDPlayer workshop (index.html, main.js, workbench.css)
  converter/          redirect for the old extractor URL
  play/               the preserved Geometry Dash runtime + its postMessage bridge
core/
  convert/level-file.js   the whole conversion core: read, detect, scan, write (pure, tested)
  documents/ import/ inspector/ runtime/ storage/ ...   shared modules used by both UIs
sw.js                 service worker: caches app code so the converter works offline
tests/                Node test suite (no browser needed)
```

`core/convert/level-file.js` is the single source of truth for level-file handling: text in, text
out, no DOM and no storage. `app/main.js` only formats results and talks to people; the workshop
reuses the same storage schema, so a level converted on the front page appears in the Library there.

## Development

```sh
node --experimental-default-type=module --test     # 66 tests
node --check app/main.js                           # syntax check any module
```

Coverage includes real bundled level exports (`.txt` → `.gmd` → `.txt` round trips that compare the
payload byte-for-byte), hand-written and standard-plist `.gmd` wrappers, XML entity handling, NUL
padding, URL-safe base64, the pako fallback, friendly failure codes (save files, truncated data,
oversized files), level scanning, song resolution, Library documents, storage migrations and the
workshop's existing suites.

A browser checklist (headless Chrome, not part of the repo) covers: first paint with no console
errors, dropping a real level, pasting a level string, the bundled sample levels, downloads landing
on disk and containing the payload, copy-to-clipboard, dark mode, a phone-width layout without
horizontal overflow, the offline reload, the save-file error path, and the workshop still booting.

## Known limitations

* This checkout contains 30 real `.txt` level exports but **no real `.gmd` files**, so `.txt → .gmd`
  is verified end-to-end against real data while `.gmd → .txt` is verified against generated and
  hand-written wrappers. If you have a `.gmd` export that misbehaves, that is the most useful bug
  report to send.
* Official song names come from the bundled `allLevels.js` list; custom (Newgrounds) songs are left
  as `Custom song #<id>` because naming them would require a network lookup, which this app does
  not do.
* Levels are stored with a light parse (header + object count). The advanced workshop's inspector
  re-parses a level string on demand for full object/trigger statistics.
* Save files (`CCGameManager.dat`) are intentionally out of the converter's scope — they are handled
  by the workshop's save explorer instead.
* The gameplay preview loads the bundled runtime; it is a bonus, and playback fidelity depends on
  that runtime (and on the browser's WebGL/audio support), not on this converter.

## Credits & licence

Built on the GMDPlayer codebase and the Web Dashers runtime that ship in this repository.
Geometry Dash is a trademark of RobTop Games; this project is unofficial and not affiliated.
See [LICENSE](./LICENSE).
