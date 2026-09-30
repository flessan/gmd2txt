# GMDPlayer — local Geometry Dash workstation

This repository now includes a local-first GMDPlayer shell around the existing Geometry Dash runtime.

## Run locally

Serve the repository root over HTTP (IndexedDB and module loading need an origin):

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/app/`. The existing legacy player remains available at `http://localhost:8000/app/play/`, and the original converter remains at `/app/converter/`.

## Import levels and saves

- Drop or browse for `.gmd` / `.txt` level files. The importer unwraps GMD `k4` payloads or decodes the compressed text format.
- Drop `CCGameManager.dat`, `CCLocalLevels.dat`, or both to create a local Save Explorer snapshot. Save decoding (XOR/base64/compression/XML) runs in the browser; unknown `.dat` files are rejected.
- Save snapshots retain original binary Blobs/bytes, decoded XML/tree data, and a separate normalized view in the IndexedDB `saveSnapshots` store. Sensitive fields are masked in viewer/export output by default.
- Review created levels and import selected or all valid levels into the same IndexedDB Library as canonical `LevelDocument`s.
- Open levels in Library, view details, or use **Play now** to open the retained legacy runtime in an application player state. Press Escape or use Back to return.

The original encoded level string remains the runtime source of truth. Parsed level settings and object data are derived inspector/cache data; unknown object fields and the original `.gmd` wrapper payload are retained. Save parsing does not make network requests and does not modify the original `.dat` files. Decoded XML/JSON exports are read-only representations; `.dat` rebuilding is not implemented.

## Texture Pack Editor (Phase 3)

Open **Tools → Texture Pack Editor** or browse to `/app/#/tools/textures`. Import one or more PNG / XML PLIST files, incomplete sheet pairs, or ZIP packs. Loose files are grouped as one workspace; ZIP entry paths are retained. Workspaces and replacement history are saved in the shared IndexedDB database (`textureWorkspaces`), separate from levels and save snapshots. The current database schema is v6; upgrades preserve earlier stores and records.

The editor parses XML PLIST sprite frames, checks PNG signatures/chunks/dimensions and frame bounds, and shows a searchable sprite list, selected-sprite preview, atlas highlight, and parsed frame metadata. Replacements are exact-slot by default: the replacement must match the cropped slot size, and the original atlas geometry and PLIST bytes remain unchanged. **Fit to slot** explicitly resizes only the replacement pixels. Reset, undo/redo, single-sheet export, full-pack ZIP export, and bulk sprite splitting are available. Multi-sheet workspaces also support an explicit **Merge sheets** export that packs sprites from each sheet into a new atlas/PLIST pair while retaining the originals in the ZIP. **Explicit repack** is a separate export operation and may change atlas dimensions and frame coordinates; it is never triggered by replacement or ordinary export.

ZIP archives are read as untrusted data: absolute/traversal paths, symlinks, encrypted/unsupported entries, corrupt checksums, excessive entry counts, and expanded-size overages are rejected. Archive contents are never executed. Imported originals remain distinct from sprite modifications. Texture workspaces are editor-only and do not override assets in the legacy gameplay renderer.

PLIST support currently targets XML property lists used for sprite sheets; binary PLISTs are not parsed. Unknown XML properties are retained, while unsupported or malformed XML/PNG inputs produce an import error. Geometry Dash save rebuilding is not supported; source `.dat` files remain read-only and unchanged.

## Phase 3.5 validation status

The bundled legacy runtime includes 30 real compressed `.txt` level payloads. All 30 now import successfully in an offline importer smoke test (390,710 parsed objects total); one asset (`22.txt`) has terminal NUL padding, which is removed from the playable payload while the original text is retained in source provenance. This checks level parsing, not browser playback.

This checkout does not include real `.gmd` files, `CCGameManager.dat` / `CCLocalLevels.dat` samples, or matching Geometry Dash PNG + XML PLIST sheet pairs. The legacy runtime has several sheet PNGs, but no corresponding PLIST files, so they cannot validate atlas/frame compatibility. Real save-platform/version coverage, exact-slot texture round trips against actual game assets, rotated real-sprite behavior, and end-to-end browser/player acceptance remain unverified. Do not treat the synthetic texture fixtures as proof of GDSplitter or full Geometry Dash compatibility. Browser automation is not configured in this repository; run the browser checklist using lawful test files before release.

## Architecture

- `app/shell/` — hash-routed GMDPlayer UI.
- `core/documents/` — canonical level document and compatibility parser.
- `core/import/` — file detection, grouped import sessions, and level importer.
- `core/storage/` — IndexedDB Library and save-snapshot operations.
- `core/saves/` — local save decoding, XML parsing, normalization, and safe masking.
- `core/runtime/` — UI-facing player adapter.
- `app/play/` — preserved legacy game runtime and a narrow postMessage bridge.

The legacy `GameCacheManager` remains the runtime asset cache. It is not used as the Library database. The game/editor systems remain intact; local audio uses the `PlayerAdapter` and a small bridge into the existing audio manager rather than a second gameplay system.

## Songs & Audio and Level Workbench (Phase 4)

Open **Tools → Songs & Audio** at `/app/#/tools/audio`, the unified **Assets** workspace at `/app/#/tools/assets`, and per-level workbench details from a Library level. **Inspect level** opens `/app/#/library/inspect/{levelId}` with human-readable statistics plus raw/decoded read-only views.

Audio files are imported only from the user's local device (MP3, OGG, Opus, WAV, M4A/MP4, AAC, FLAC, or WebM; maximum 512 MiB per file). File blobs and versioned metadata live in the IndexedDB `audioAssets` store. Search, format filtering, sorting, preview, display-name editing, optional song ID / artist / album / notes, and usage links are local-only. No music API, scraper, or automatic downloader is used. Browser codec support varies; playback is not guaranteed for every declared format.

A level's local song override and its optional texture-workspace link, tags, and notes are versioned `applicationMetadata` on the Library record, separate from both the original encoded level string and its parsed representation. The reusable `SongResolver` resolves a linked local blob first; missing/deleted links remain visible and fall back to the level's original official/custom song behavior. `PlayerAdapter` passes the local blob to the existing runtime; a narrow audio-manager hook prioritizes that local override while preserving the legacy song path when no playable override exists. Texture workspaces remain editor-only and are not loaded into gameplay.

The Phase 4 IndexedDB schema added `audioAssets` at v4; Phase 5 added `projects` and `projectPreferences` at v5; Phase 6 adds the shared `workbenchData` store at v6 for saved searches, workspace preferences, favorites/tags, and bounded recent activity. Each upgrade is additive and leaves existing level, audio, save, texture, and project records intact. New level records keep source provenance (`filename`, size, MIME type, origin, and content hash) in `LevelDocument.source`; app-specific relationships and notes never get written into the raw source payload. Deleting a linked song or texture workspace does not delete level metadata: the workbench reports the missing asset. The Inspector's object/trigger/portal labels intentionally use a partial community mapping and leave unknown/version-specific IDs numeric.

## Projects, Backup & Restore (Phase 5)

Open the project browser at `/app/#/projects`; project details are at `/app/#/projects/{projectId}`, and backup inspection / selective restore is at `/app/#/projects/restore`. Projects are local containers of **references** to global Library resources. A level, song, texture workspace, or save snapshot can belong to several projects; adding/removing membership does not move or delete the resource. The shell marks the active project, while the global Library and tools remain available.

Create, rename, archive, duplicate, export, and remove projects from the project workspace. Duplication creates new level, audio, texture, and save record IDs and updates relationships within the copy. Mutable texture data is cloned; audio `Blob`s are immutable and can be shared by IndexedDB without copying their contents. Removing a project deletes only its project record. Missing resource references remain visible rather than preventing a project from opening.

Export uses the `.gmdproject` extension. It is a ZIP32 archive containing a versioned `manifest.json`, `project/project.json`, resource records under `resources/`, and binary payloads under `blobs/`. The manifest includes project metadata, memberships, original local IDs, resource types, source/provenance summaries, file sizes, and CRC-32 checksums. Resource records preserve the original level payload, parsed/application metadata, audio blobs, texture source sheets and modifications, and original save snapshot data. Application metadata remains outside the Geometry Dash source string.

Example manifest shape (IDs and checksums abbreviated):

```json
{
  "format": "gmdplayer-project",
  "version": 1,
  "project": { "id": "project-…", "name": "My Workspace" },
  "membership": {
    "levels": ["level-…"], "audioAssets": ["audio-…"],
    "textureWorkspaces": [], "saveSnapshots": []
  },
  "resources": [
    { "type": "levels", "originalId": "level-…", "recordPath": "resources/000001.json", "filename": "level.gmd" }
  ],
  "files": [
    { "path": "resources/000001.json", "size": 1234,
      "checksum": { "algorithm": "crc32", "value": "…" } }
  ]
}
```

Import first validates ZIP paths, manifest structure/version, resource IDs, file sizes, and checksums, then presents per-resource selection. Restore is additive: imported assets receive new local IDs, relationships among included resources are remapped, and links to excluded or absent assets are marked unavailable. Existing records are never silently replaced. Selected records and the new project are staged before one multi-store IndexedDB read/write transaction; transaction failure aborts the restore without intentionally modifying existing records. The current v6 IndexedDB schema retains the Phase 5 `projects` and `projectPreferences` stores and adds `workbenchData`; upgrades do not clear levels, audio, texture, save, or project records.

Project archives currently use ZIP32 with stored (uncompressed) entries and a 1 GiB uncompressed-size limit; each resource file is limited to 512 MiB. CRC-32 detects accidental corruption but is not a cryptographic authenticity signature. Export keeps Blob data as Blob-backed ZIP parts to avoid an extra archive-sized concatenation. Import currently reads the selected archive into memory before extracting entries, so very large restores may be constrained by browser memory; cancelling cannot interrupt the browser's initial `File.arrayBuffer()` read. No cloud, account, or project-sharing feature is included.

## Power tools & workflow acceleration (Phase 6)

The shared shell adds a global command palette (**Ctrl/Cmd+K**) and Quick Open (**Ctrl/Cmd+P**). In either overlay, type to filter, use Up/Down to move, Enter to open/run, and Escape to close and return focus. **Ctrl/Cmd+F** focuses the current workspace search; **Ctrl/Cmd+A** selects visible rows in supported workspaces; Space toggles a focused row, Shift+Arrow extends selection, and Escape clears selections. **Ctrl/Cmd+Z**, **Ctrl/Cmd+Shift+Z**, and **Ctrl/Cmd+Y** navigate the bounded session undo history (texture replacements use their persisted workspace history). Shortcuts avoid text-entry controls; destructive batch operations still require confirmation.

Library, audio, assets, textures, saves, and project resource lists support multi-selection and contextual bulk workflows, including tags/favorites, project membership, exports, and safe removals. Search filters combine text, type, tags (all/any), project, favorite, date, and workspace-specific fields; named searches and sort/view choices persist locally. Bulk operations retain per-item results and report partial failures. Directory imports use relative paths to keep similarly named files from separate folders apart; `.gmdproject` archives are previewed one at a time. Imports provide progress, per-file results, cancellation where the browser operation is interruptible, and duplicate choices. Chunked content fingerprints are persisted for supported imports (including texture source files) and offer a copy-or-skip decision; they are content fingerprints, not authenticity checks.

Quick Open caches its index until workspace refresh. Startup uses cursor-built lightweight Library and texture catalog summaries; full source payloads, parsed level arrays, atlas bytes, and PLIST data are fetched only when a record is opened or exported. Visible lists are paginated; search rendering is debounced. Recent activity is bounded to 100 entries. The active project is restored only if it still exists and is not archived. Original level/save inputs remain distinct from application metadata, and project membership continues to reference globally stored resources without transferring ownership. Keyboard navigation, semantic controls, selection state, and the palette focus loop provide basic accessibility; no automated browser accessibility audit has been run.

Shared Phase 6 utilities live under `core/workbench/`: selection model, filtering/sorting, chunked content hashing, bounded undo support, and batch operations. Search/view/favorite/tag/activity preferences use IndexedDB `workbenchData`; no `localStorage` migration or clearing is performed. The GMDPlayer shell is still hash-routed and the Phase 1 `app/play/` runtime remains in place.

## Release readiness & PWA (Phase 7)

GMDPlayer is installable as a browser app where the browser supports the Web App Manifest and exposes its install flow. Use **Install GMDPlayer** when the browser presents that affordance; Safari/iOS and browsers without `beforeinstallprompt` may require their own browser menu. The service worker requires HTTPS or a browser's secure localhost exception. Serve the repository root (`python3 -m http.server 8000`) and open `/app/`; `file://` is not a supported PWA origin.

After a successful initial service-worker install, the shell document, manifest, icons, CSS, shell module, all `core/` modules, and the local decompression dependency are cached. Offline navigation falls back to the cached shell. A bounded runtime cache may retain small first-party static UI/player resources that were previously visited (up to 60 resources, each at most 2 MiB). It does **not** cache audio, save files, level payloads, `.gmdproject` archives, Blob URLs, or third-party content; IndexedDB remains the source of truth for user resources. The legacy player's broader art/runtime assets may not all be available offline until visited, and online Geometry Dash services and externally hosted Poppins fonts can be unavailable offline. Browser cache eviction and storage quotas are outside GMDPlayer's control.

`app/app-meta.js` centralizes the displayed application version and cache revision. The root service worker stages versioned caches, waits rather than forcing an update beneath open tabs, and removes obsolete GMDPlayer caches on activation. Application database upgrades are additive; v1 through v6 storage is migrated by creating only missing stores, and a database created by a newer app version is refused with a retry/update message rather than cleared. GMDPlayer shell/workbench preferences are stored in IndexedDB `workbenchData`; the preserved legacy gameplay runtime retains its existing `localStorage` keys for game settings, cache, and progress. This release does not migrate or clear those legacy keys. The service worker cache contains application code, not user content. The new workbench adds no account, cloud-sync, or automatic-upload feature; the preserved player may still contact its existing external services, and the online font stylesheet may also make external requests.

First run presents a dismissible getting-started panel with direct import, projects, and Library actions. **About & diagnostics** (`#/about`) shows the application/database/backup versions, local resource counts, connection and service-worker status, browser storage estimate, and copyable non-content diagnostics. The app version is also recorded as optional `createdWith` metadata in newly exported project manifests; `.gmdproject` remains format version 1 and older backups remain accepted.

The UI uses visible focus outlines and keyboard-operable row selection; the palette traps focus and restores Escape focus. Keyboard shortcuts are platform-aware and are suspended in editable fields, media controls, and raw/code views so browser selection/find and text editing remain available there. Directory import is offered only when the browser exposes directory selection; otherwise use the standard multiple-file picker. Unsupported image decoding and local audio object-URL preview degrade with actionable messages. Responsive breakpoints stack the project and diagnostics panes; desktop remains the primary layout. This is a practical code review, not an automated screen-reader, contrast, or browser accessibility audit.

## Checks

Run the full synthetic suite with:

```sh
node --experimental-default-type=module --test
```

Latest result in this checkout: **47 passed, 0 failed**, using synthetic fixtures and a purpose-built IndexedDB migration harness. Coverage includes additive v1/v4→v6 migration, lightweight cursor-built catalog summaries, project CRUD/membership/duplication, ZIP backup round-trip and selective restore, file classification/import edge cases, texture ZIP safety and round-trips, multi-selection/search, partial batch failures, bounded activity, keyboard shortcut contexts, and content-hash behavior. All JavaScript modules pass `node --check` in ES module mode. A static HTTP smoke check serves the app entry, shell module, manifest, and service worker; browser automation and supported browser executables are unavailable in this checkout, so no browser E2E, browser accessibility audit, native file association, real Geometry Dash audio override, real texture-pack, or cross-version save compatibility test has been performed. Synthetic fixtures do not establish real-world compatibility.
