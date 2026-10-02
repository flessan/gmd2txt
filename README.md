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
   open the *Readable text* view to inspect the decoded level, or hit **Play preview** to jump straight
   into the bundled Geometry Dash runtime.

The preview is *pre-warmed*: as soon as a level has been converted, the runtime boots quietly in the
background and the converted level is handed to it, paused at the first obstacle. "Play preview" then
opens directly into gameplay — no loading screen and no "waiting for level" dead end. The same runtime
is reused for the next preview (the level simply restarts), and the standalone player at
`/app/play/` picks a bundled level by itself (`/app/play/?level=level_7` for a specific one).

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

## One page, five rooms

The workspace is a single page (`/app/`) with a single stylesheet. There is no second page to load
and no second stylesheet: the rooms are sections of the same document, switched from the menu at the
top (or with the number keys).

| Room | What it does |
| --- | --- |
| **Convert files** | `.gmd` ⇄ `.txt`, both ways, in batches, with a preview of what is inside |
| **Sprite studio** | every sprite in a texture pack as its own picture, with pixel sizes, and a replacement image fitted into the original slot (the saved packs *are* the texture workspaces) |
| **Play a level** | the 22 bundled levels run in the bundled runtime, inside the page |
| **Saved files** | the conversions kept in this browser, ready to download again |
| **Save file reader** | read `CCGameManager.dat` — stats, coins, demons, level progress — with ids masked and nothing written back |

Dropping a file anywhere routes it by type: a level goes to the converter, a texture pack to the
studio, a `.dat` to the save reader.

## Project layout

```
app/
  index.html            the whole workspace: one page, five rooms
  workspace.js          the shell: rooms, dropping/pasting, storage summary, shortcuts
  views/convert.js      converter room (uses core/convert/level-file.js)
  views/textures.js     sprite studio room (uses core/textures/*)
  views/savefile.js     save reader room (uses core/saves/save-decoder.js)
  assets/workspace.css  the only stylesheet
  play/                 the preserved Geometry Dash runtime + its postMessage bridge
core/
  convert/level-file.js   the whole conversion core: read, detect, scan, write (pure, tested)
  textures/ saves/ documents/ storage/ runtime/ ...   shared modules the rooms use
sw.js                 service worker: caches the workspace so it works offline
tests/                Node test suite (no browser needed)
```

`core/convert/level-file.js` is the single source of truth for level-file handling: text in, text
out, no DOM and no storage. `app/views/convert.js` only formats results and talks to people;
the other rooms reuse the same storage schema, so a level converted in the converter room appears in
*Saved files* straight away.

## Development

```sh
node --experimental-default-type=module --test     # 66 tests
node --check app/workspace.js                      # syntax check any module
```

Coverage includes real bundled level exports (`.txt` → `.gmd` → `.txt` round trips that compare the
payload byte-for-byte), hand-written and standard-plist `.gmd` wrappers, XML entity handling, NUL
padding, URL-safe base64, the pako fallback, friendly failure codes (save files, truncated data,
oversized files), level scanning, song resolution, Library documents, storage migrations, sprite
replacement and fit modes, JSON/plist atlas parsing, save decoding and the single-page structure.

A browser checklist (headless Chrome, not part of the repo) covers: first paint with no console
errors, dropping a real level, pasting a level string, the bundled sample levels, downloads landing
on disk and containing the payload, the sprite studio (individual sprites, pixel sizes, replacing an
image, undo), playing a bundled level, the save reader, a phone-width layout without horizontal
overflow and the offline reload.

## Known limitations

* This checkout contains 30 real `.txt` level exports but **no real `.gmd` files**, so `.txt → .gmd`
  is verified end-to-end against real data while `.gmd → .txt` is verified against generated and
  hand-written wrappers. If you have a `.gmd` export that misbehaves, that is the most useful bug
  report to send.
* Official song names come from the bundled `allLevels.js` list; custom (Newgrounds) songs are left
  as `Custom song #<id>` because naming them would require a network lookup, which this app does
  not do.
* Levels are stored with a light parse (header + object count); `core/inspector/level-inspector.js`
  can re-parse one on demand for full object/trigger statistics.
* Save files (`CCGameManager.dat`) are out of the converter's scope on purpose: the *Save file
  reader* room reads them and never writes them back.
* The gameplay preview loads the bundled runtime; it is a bonus, and playback fidelity depends on
  that runtime (and on the browser's WebGL/audio support), not on this converter. The first preview on
  a cold page still waits a few seconds for that runtime to boot; previews after it start instantly.

## Credits & licence

Built on the GMDPlayer codebase and the Web Dashers runtime that ship in this repository.
Geometry Dash is a trademark of RobTop Games; this project is unofficial and not affiliated.
See [LICENSE](./LICENSE).
