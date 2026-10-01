importScripts("./app/app-meta.js");
const VERSION = self.GMDPLAYER_META?.version || "dev";
const REVISION = self.GMDPLAYER_META?.cacheRevision || "0";
const CACHE_PREFIX = `gmdplayer-${VERSION}-${REVISION}`;
const SHELL_CACHE = `${CACHE_PREFIX}-shell`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime`;
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./app-meta.js",
  "./assets/gmdplayer.css",
  "./assets/icons/gmdplayer-192.png",
  "./assets/icons/gmdplayer-512.png",
  "./shell/main.js",
  "./play/assets/scripts/libs/pako.min.js",
  "./play/assets/scripts/core/gmdplayer-bridge.js",
  "./play/index.html",
  "../core/audio/audio-asset.js",
  "../core/audio/song-resolver.js",
  "../core/documents/application-metadata.js",
  "../core/documents/level-document.js",
  "../core/documents/save-document.js",
  "../core/documents/tags.js",
  "../core/import/file-detector.js",
  "../core/import/handlers/level-importer.js",
  "../core/import/handlers/save-importer.js",
  "../core/import/import-session.js",
  "../core/inspector/level-inspector.js",
  "../core/projects/project-backup.js",
  "../core/projects/project-model.js",
  "../core/runtime/player-adapter.js",
  "../core/saves/save-decoder.js",
  "../core/search/local-search.js",
  "../core/startup/release-state.js",
  "../core/storage/audio-database.js",
  "../core/storage/database.js",
  "../core/storage/project-database.js",
  "../core/storage/save-database.js",
  "../core/storage/texture-database.js",
  "../core/storage/workbench-database.js",
  "../core/textures/atlas-packer.js",
  "../core/textures/plist-parser.js",
  "../core/textures/plist-writer.js",
  "../core/textures/sprites.js",
  "../core/textures/texture-download.js",
  "../core/textures/texture-export.js",
  "../core/textures/texture-merge.js",
  "../core/textures/texture-pack.js",
  "../core/textures/zip.js",
  "../core/workbench/bulk-operations.js",
  "../core/workbench/content-hash.js",
  "../core/workbench/keyboard-shortcuts.js",
  "../core/workbench/search.js",
  "../core/workbench/selection-model.js"
];
const APP_ROOT = new URL("./app/", self.registration.scope);
const ROOT_SCOPE = new URL(self.registration.scope);
const CORE_ROOT = new URL("./core/", ROOT_SCOPE);
const isAppAsset = url => url.origin === ROOT_SCOPE.origin && (url.pathname.startsWith(APP_ROOT.pathname) || url.pathname.startsWith(CORE_ROOT.pathname));
const isAppNavigation = url => url.origin === ROOT_SCOPE.origin && url.pathname.startsWith(APP_ROOT.pathname);
const resolveAsset = path => new URL(path, APP_ROOT).href;
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_ASSETS.map(resolveAsset));
    // Do not skip waiting: an update must not replace modules under an open old-version tab.
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
    await Promise.all((await caches.keys()).filter(name => name.startsWith("gmdplayer-") && !keep.has(name)).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!isAppAsset(url)) return;
  // Cache only first-party app resources. Never cache audio, user imports, ZIPs,
  // saves, level payloads, or any cross-origin content here.
  if (!/\.(?:js|mjs|css|png|jpe?g|webp|svg|ico|woff2?|ttf|otf|webmanifest|json)$/i.test(url.pathname)) return;
  event.respondWith((async () => {
    const shell = await caches.open(SHELL_CACHE), cached = await shell.match(request) || await (await caches.open(RUNTIME_CACHE)).match(request);
    const refresh = fetch(request).then(async response => {
      const length=Number(response.headers.get("content-length")||0);
      if (response.ok && response.type === "basic" && length > 0 && length <= 2 * 1024 * 1024) {
        const cache=await caches.open(RUNTIME_CACHE);await cache.put(request,response.clone());
        const keys=await cache.keys();for(const old of keys.slice(0,Math.max(0,keys.length-60)))await cache.delete(old);
      }
      return response;
    });
    if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; }
    try { return await refresh; }
    catch (_) { return new Response("This application resource is not available offline.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
  })());
});
