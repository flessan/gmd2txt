/**
 * Sprite studio — the friendly half of the texture tooling.
 *
 * Open a texture pack and the sheet is shown as one large atlas image: click
 * any sprite on it and it opens on its own with its real pixel size. A switch
 * turns the same pack into a gallery of individual sprite pictures, and either
 * way a replacement image is scaled into the original slot automatically.
 *
 * Performance notes: a sheet can hold thousands of sprites, so the atlas PNG is
 * decoded once per sheet, sprites are cropped from that cached bitmap, and the
 * crops are painted straight onto canvases (no PNG encoding in the hot path).
 */
import { importTextureFiles, getSpriteEntries, applySpriteModification, resetSprite } from "../../core/textures/texture-pack.js";
import { extractSprite, createSpriteReplacement, createSpriteReplacementBytes, canvasToPngBytes, decodePng, fitRect, isPngBytes, pngDimensions } from "../../core/textures/sprites.js";
import { exportTexturePack, exportSplitSprites } from "../../core/textures/texture-export.js";
import { saveTextureWorkspace, getTextureWorkspace, getTextureWorkspaceSummaries } from "../../core/storage/texture-database.js";

const $ = selector => document.querySelector(selector);
const dom = {
  root: $("#workspace-root"),
  empty: $("#empty-state"),
  browser: $("#browser"),
  atlas: $("#atlas"),
  atlasSheets: $("#atlas-sheets"),
  atlasCount: $("#atlas-count"),
  atlasZoom: $("#atlas-zoom"),
  viewSwitch: $("#view-switch"),
  grid: $("#sprite-grid"),
  search: $("#sprite-search"),
  sheetFilter: $("#sheet-filter"),
  sort: $("#sprite-sort"),
  onlyEdited: $("#only-edited"),
  count: $("#sprite-count"),
  loadMore: $("#load-more"),
  splitSheet: $("#split-sheet"),
  detail: $("#detail"),
  detailTitle: $("#detail-title"),
  detailSub: $("#detail-sub"),
  detailCanvas: $("#detail-canvas"),
  detailGrid: $("#detail-grid"),
  detailStage: $("#detail-stage"),
  detailPixel: $("#detail-pixel"),
  detailCaption: $("#detail-caption"),
  detailFacts: $("#detail-facts"),
  detailDownload: $("#detail-download"),
  detailRevert: $("#detail-revert"),
  detailClose: $("#detail-close"),
  packName: $("#pack-name"),
  openPack: $("#open-pack"),
  openSprites: $("#open-sprites"),
  downloadPack: $("#download-pack"),
  packInput: $("#pack-input"),
  folderInput: $("#folder-input"),
  choosePack: $("#choose-pack"),
  openBundled: $("#open-bundled"),
  replaceDrop: $("#replace-drop"),
  replaceInput: $("#replace-input"),
  replaceChoose: $("#replace-choose"),
  replacePreview: $("#replace-preview"),
  replaceSource: $("#replace-source"),
  replaceSourceCaption: $("#replace-source-caption"),
  replaceResult: $("#replace-result"),
  replaceResultCaption: $("#replace-result-caption"),
  replaceModes: $("#replace-modes"),
  replaceActions: $("#replace-actions"),
  replaceApply: $("#replace-apply"),
  replaceCancel: $("#replace-cancel"),
  toast: $("#studio-toast"),
  status: $("#studio-status"),
};

const state = {
  pack: null,
  selected: null,
  viewMode: "atlas",   // "atlas" = the sheet itself, "sprites" = one picture per sprite
  atlasZoom: "fit",    // "fit" | "1" (one sheet pixel per screen pixel) | 2 | 4
  query: "",
  sheet: "all",
  sort: "sheet",
  onlyEdited: false,
  limit: 150,
  replacement: null
};

const BATCH = 150;
let toastTimer = null;
function toast(message, isError = false) {
  dom.toast.textContent = message;
  dom.toast.classList.toggle("is-error", isError);
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 4200);
}

const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const sanitizeName = value => String(value || "texture-pack").replace(/[^\w.-]+/g, "_").slice(0, 120) || "texture-pack";

/* ---------------------------------------------------------------- references */

/** A reference is either a gallery row ({ sheetId, frame }) or a plain { sheetId, name }. */
function refOf(reference) {
  if (!reference) return null;
  const name = reference.frame?.name || reference.name;
  if (!name || !reference.sheetId) return null;
  return { sheetId: reference.sheetId, name };
}
const sheetOf = reference => state.pack?.sheets?.[reference?.sheetId] || null;
function frameOf(reference) {
  const ref = refOf(reference);
  return ref ? sheetOf(ref)?.parsed?.frames?.[ref.name] || null : null;
}
function modificationOf(reference) {
  const ref = refOf(reference);
  return ref ? state.pack?.modifications?.[ref.sheetId]?.[ref.name] || null : null;
}
const isEdited = reference => Boolean(modificationOf(reference)?.png);
const logicalSize = frame => frame?.rotated
  ? { width: frame.frame.height, height: frame.frame.width }
  : { width: frame.frame.width, height: frame.frame.height };

const allSprites = () => getSpriteEntries(state.pack);

function visibleSprites() {
  const query = state.query.trim().toLowerCase();
  let rows = allSprites();
  if (state.sheet !== "all") rows = rows.filter(entry => entry.sheetId === state.sheet);
  if (state.onlyEdited) rows = rows.filter(entry => isEdited(entry));
  if (query) rows = rows.filter(entry => entry.frame.name.toLowerCase().includes(query));
  const sorted = [...rows];
  if (state.sort === "name") sorted.sort((a, b) => a.frame.name.localeCompare(b.frame.name));
  else if (state.sort === "size-desc") sorted.sort((a, b) => logicalSize(b.frame).width * logicalSize(b.frame).height - logicalSize(a.frame).width * logicalSize(a.frame).height);
  else if (state.sort === "size-asc") sorted.sort((a, b) => logicalSize(a.frame).width * logicalSize(a.frame).height - logicalSize(b.frame).width * logicalSize(b.frame).height);
  else if (state.sort === "edited") sorted.sort((a, b) => Number(isEdited(b)) - Number(isEdited(a)));
  return { rows: sorted, total: sorted.length };
}

/* -------------------------------------------------- atlases and sprite crops */

const atlasCache = new Map();   // sheetId -> { bitmap, used }
const ATLAS_CACHE_LIMIT = 4;
const spriteCanvasCache = new Map();   // key -> extracted canvas
const spriteCanvasPromises = new Map();
const SPRITE_CACHE_LIMIT = 400;
let thumbObserver = null;

async function sheetAtlas(sheet) {
  const cached = atlasCache.get(sheet.id);
  if (cached) {
    cached.used = performance.now();
    return cached.bitmap;
  }
  const bitmap = await decodePng(sheet.source.png);
  atlasCache.set(sheet.id, { bitmap, used: performance.now() });
  while (atlasCache.size > ATLAS_CACHE_LIMIT) {
    const [oldestId] = [...atlasCache.entries()].sort((a, b) => a[1].used - b[1].used)[0];
    atlasCache.get(oldestId)?.bitmap?.close?.();
    atlasCache.delete(oldestId);
  }
  return bitmap;
}

function releaseCaches() {
  atlasBoxes.clear();
  for (const bitmap of modificationBitmaps.values()) bitmap?.close?.();
  modificationBitmaps.clear();
  for (const entry of atlasCache.values()) entry.bitmap?.close?.();
  atlasCache.clear();
  for (const canvas of spriteCanvasCache.values()) canvas.close?.();
  spriteCanvasCache.clear();
  spriteCanvasPromises.clear();
}

const modificationBitmaps = new Map();   // key -> decoded replacement art

/** A decoded replacement image, so the atlas can show your edit on the sheet. */
async function modificationBitmap(sheetId, name) {
  const modification = state.pack?.modifications?.[sheetId]?.[name];
  if (!modification?.png) return null;
  const key = `${sheetId}\u0000${name}\u0000${modification.updatedAt || 0}`;
  if (modificationBitmaps.has(key)) return modificationBitmaps.get(key);
  const bitmap = await decodePng(modification.png).catch(() => null);
  if (bitmap) modificationBitmaps.set(key, bitmap);
  return bitmap;
}

function forgetSpriteCanvases(sheetId, name) {
  const prefix = `${sheetId}\u0000${name}\u0000`;
  for (const key of [...spriteCanvasCache.keys()]) {
    if (!key.startsWith(prefix)) continue;
    spriteCanvasCache.get(key)?.close?.();
    spriteCanvasCache.delete(key);
  }
}

/** Keeps the main thread free while a viewport full of sprites is prepared. */
const workQueue = [];
let workRunning = 0;
const WORK_CONCURRENCY = 4;
function queueWork(task) {
  return new Promise((resolve, reject) => {
    workQueue.push({ task, resolve, reject });
    pumpWork();
  });
}
function pumpWork() {
  while (workRunning < WORK_CONCURRENCY && workQueue.length) {
    const { task, resolve, reject } = workQueue.shift();
    workRunning++;
    task().then(resolve, reject).finally(() => { workRunning--; pumpWork(); });
  }
}

function rememberSpriteCanvas(key, canvas) {
  spriteCanvasCache.set(key, canvas);
  while (spriteCanvasCache.size > SPRITE_CACHE_LIMIT) {
    const [oldestKey] = spriteCanvasCache.keys();
    spriteCanvasCache.get(oldestKey)?.close?.();
    spriteCanvasCache.delete(oldestKey);
  }
}

/** The sprite as its own picture, cropped from the cached atlas. */
async function spriteCanvas(entry, maxDimension = 220) {
  const ref = refOf(entry);
  if (!ref) return null;
  const frame = frameOf(ref);
  if (!frame) return null;
  const modification = modificationOf(ref);
  const key = `${ref.sheetId}\u0000${ref.name}\u0000${modification?.updatedAt || 0}\u0000${maxDimension}`;
  if (spriteCanvasCache.has(key)) return spriteCanvasCache.get(key);
  if (spriteCanvasPromises.has(key)) return spriteCanvasPromises.get(key);
  const promise = queueWork(async () => {
    const sheet = sheetOf(ref);
    const source = modification?.png ? await decodePng(modification.png) : await sheetAtlas(sheet);
    const closeSource = Boolean(modification?.png);
    try {
      const canvas = await extractSprite(source, frame, { maxDimension });
      rememberSpriteCanvas(key, canvas);
      return canvas;
    } finally {
      if (closeSource) source.close?.();
    }
  }).catch(() => null).finally(() => spriteCanvasPromises.delete(key));
  spriteCanvasPromises.set(key, promise);
  return promise;
}

/** Paints a sprite crop into a card canvas, pixel-perfect and centred. */
function paintCanvas(target, sprite, box = 220) {
  if (!target || !sprite) return false;
  const scale = Math.min(1, box / Math.max(sprite.width, sprite.height));
  const width = Math.max(1, Math.round(sprite.width * scale));
  const height = Math.max(1, Math.round(sprite.height * scale));
  target.width = width;
  target.height = height;
  const ctx = target.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(sprite, 0, 0, sprite.width, sprite.height, 0, 0, width, height);
  return true;
}

/** Sprites are prepared as they approach the viewport, not all 3,000 at once. */
function observeThumbs(root = dom.grid) {
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver(entries => {
    for (const item of entries) {
      if (!item.isIntersecting) continue;
      const canvas = item.target;
      const reference = { sheetId: canvas.dataset.sheet, name: canvas.dataset.sprite };
      thumbObserver.unobserve(canvas);
      spriteCanvas(reference, 220).then(sprite => {
        if (!sprite || !canvas.isConnected) return;
        paintCanvas(canvas, sprite, 220);
        canvas.closest(".sprite-card")?.classList.add("is-loaded");
      });
    }
  }, { rootMargin: "420px" });
  for (const canvas of root.querySelectorAll("canvas[data-thumb]")) thumbObserver.observe(canvas);
}


/* --------------------------------------------------------------- atlas view */

/**
 * The sheet itself, big, with every sprite clickable. The atlas is decoded once
 * (the same cache the gallery uses) and painted into a canvas; a second canvas
 * on top carries the hover/selection rectangle, so pointing at a sprite never
 * repaints the sheet.
 */
const atlasPainting = new Map();   // sheetId -> Promise
let atlasObserver = null;
const atlasBoxes = new Map();      // sheetId -> [{ name, x, y, width, height }]

function frameBoxes(sheet) {
  if (atlasBoxes.has(sheet.id)) return atlasBoxes.get(sheet.id);
  const boxes = Object.entries(sheet.parsed?.frames || {}).map(([name, frame]) => ({
    name,
    x: Number(frame.frame?.x) || 0,
    y: Number(frame.frame?.y) || 0,
    width: Number(frame.frame?.width) || 0,
    height: Number(frame.frame?.height) || 0,
    rotated: Boolean(frame.rotated)
  })).filter(box => box.width > 0 && box.height > 0);
  atlasBoxes.set(sheet.id, boxes);
  return boxes;
}

/** Paints one sheet into its panel canvas at full atlas resolution. */
async function paintAtlasPanel(panel) {
  const sheetId = panel.dataset.sheet;
  const sheet = state.pack?.sheets?.[sheetId];
  const canvas = panel.querySelector("canvas.atlas-canvas");
  const overlay = panel.querySelector("canvas.atlas-overlay");
  if (!sheet || !canvas || !overlay) return;
  if (atlasPainting.has(sheetId)) return atlasPainting.get(sheetId);
  const job = (async () => {
    const bitmap = await sheetAtlas(sheet);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    overlay.width = bitmap.width;
    overlay.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    // Whatever you replaced belongs on the sheet too — this is your pack, not the original.
    for (const box of frameBoxes(sheet)) {
      const edit = await modificationBitmap(sheet.id, box.name);
      if (!edit) continue;
      const logical = box.rotated ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
      try {
        ctx.drawImage(edit, 0, 0, edit.width, edit.height, box.x, box.y, logical.width, logical.height);
      } catch (_) { /* a stale edit must never blank the sheet */ }
    }
    panel.classList.add("is-painted");
    paintAtlasOverlay(panel);
  })().catch(() => null).finally(() => atlasPainting.delete(sheetId));
  atlasPainting.set(sheetId, job);
  return job;
}

/** Draws the hover/selection rectangle (and the sprite's name when it fits). */
function paintAtlasOverlay(panel) {
  const sheetId = panel.dataset.sheet;
  const overlay = panel.querySelector("canvas.atlas-overlay");
  if (!overlay || !overlay.width) return;
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const hovered = panel.dataset.hover;
  const selectedName = state.selected?.sheetId === sheetId ? state.selected.name : null;
  for (const [name, isSelected] of [[hovered, false], [selectedName, true]]) {
    if (!name) continue;
    const box = frameBoxes(state.pack.sheets[sheetId]).find(item => item.name === name);
    if (!box) continue;
    ctx.lineWidth = Math.max(2, Math.round(overlay.width / 500));
    ctx.strokeStyle = isSelected ? "#3cadf5" : "rgba(255,255,255,.92)";
    ctx.fillStyle = isSelected ? "rgba(60,173,245,.22)" : "rgba(255,255,255,.16)";
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
  }
}

/** Turns a click on the sheet into the sprite under the pointer. */
function spriteAtPoint(sheet, panel, event) {
  const canvas = panel.querySelector("canvas.atlas-canvas");
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);
  const hits = frameBoxes(sheet).filter(box => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height);
  if (!hits.length) return null;
  // Small sprites sit on top of the big sheet background — prefer the smallest.
  return hits.sort((a, b) => a.width * a.height - b.width * b.height)[0];
}

async function selectSprite(sheetId, name, { reveal = false } = {}) {
  state.selected = refOf({ sheetId, name });
  state.replacement = null;
  for (const panel of dom.atlasSheets.querySelectorAll(".atlas-panel")) paintAtlasOverlay(panel);
  for (const card of dom.grid.querySelectorAll(".sprite-card")) {
    card.classList.toggle("is-selected", card.dataset.sheet === sheetId && card.dataset.sprite === name);
  }
  await renderDetail();
  if (reveal) dom.detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderAtlas() {
  const sheets = Object.values(state.pack?.sheets || {})
    .filter(sheet => state.sheet === "all" || sheet.id === state.sheet)
    .filter(sheet => Object.keys(sheet.parsed?.frames || {}).length);
  dom.atlas.hidden = sheets.length === 0;
  if (!sheets.length) return;
  const sprites = sheets.reduce((total, sheet) => total + Object.keys(sheet.parsed.frames).length, 0);
  dom.atlasCount.textContent = `${sheets.length} sheet${sheets.length === 1 ? "" : "s"} · ${sprites} sprites to click`;
  dom.atlasSheets.innerHTML = sheets.map(sheet => {
    const frames = Object.keys(sheet.parsed.frames).length;
    const source = sheet.source?.pngPath || `${sheet.name}.png`;
    return `<figure class="atlas-panel" data-sheet="${esc(sheet.id)}">
      <figcaption>
        <span class="atlas-name"><strong>${esc(sheet.name)}</strong><small>${esc(source)}</small></span>
        <span class="atlas-meta">${frames} sprite${frames === 1 ? "" : "s"}</span>
      </figcaption>
      <div class="atlas-frame">
        <canvas class="atlas-canvas" role="img" aria-label="${esc(sheet.name)} sprite sheet"></canvas>
        <canvas class="atlas-overlay" aria-hidden="true"></canvas>
      </div>
    </figure>`;
  }).join("");

  atlasObserver?.disconnect();
  atlasObserver = new IntersectionObserver(entries => {
    for (const item of entries) {
      if (!item.isIntersecting) continue;
      atlasObserver.unobserve(item.target);
      paintAtlasPanel(item.target);
    }
  }, { rootMargin: "300px" });
  for (const panel of dom.atlasSheets.querySelectorAll(".atlas-panel")) {
    applyAtlasZoom(panel);
    atlasObserver.observe(panel);
  }
}

/**
 * Fit, 1:1 (one sheet pixel per screen pixel), 2× or 4×.
 *
 * 1:1 divides by the device pixel ratio, so a sheet pixel lands exactly on a
 * device pixel; 2× and 4× are whole multiples of that. Nothing is ever shown
 * at a fractional scale except "Fit", which is labelled as such.
 */
function applyAtlasZoom(panel = null) {
  const targets = panel ? [panel] : dom.atlasSheets.querySelectorAll(".atlas-panel");
  const mode = String(state.atlasZoom || "fit");
  const dpr = deviceScale();
  for (const item of targets) {
    const canvas = item.querySelector("canvas.atlas-canvas");
    const overlay = item.querySelector("canvas.atlas-overlay");
    const frame = item.querySelector(".atlas-frame");
    if (!canvas || !frame) continue;
    const zoomed = mode !== "fit";
    item.classList.toggle("is-zoomed", zoomed);
    // The sheet is sized in whole device pixels, on the canvas itself — the
    // frame only scrolls. Nothing depends on the frame's border or padding.
    for (const surface of [canvas, overlay]) {
      if (!surface) continue;
      if (zoomed) {
        const multiple = Number(mode) || 1;
        surface.style.width = `${Math.round((canvas.width * multiple) / dpr)}px`;
        surface.style.height = `${Math.round((canvas.height * multiple) / dpr)}px`;
      } else {
        surface.style.removeProperty("width");
        surface.style.removeProperty("height");
      }
    }
  }
  for (const button of dom.atlasZoom.querySelectorAll("[data-atlas-zoom]")) {
    const active = button.dataset.atlasZoom === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function bindAtlas() {
  dom.atlasSheets.addEventListener("click", event => {
    const panel = event.target.closest(".atlas-panel");
    if (!panel) return;
    const sheet = state.pack?.sheets?.[panel.dataset.sheet];
    if (!sheet) return;
    const hit = spriteAtPoint(sheet, panel, event);
    if (!hit) return;
    selectSprite(sheet.id, hit.name, { reveal: true });
  });
  dom.atlasSheets.addEventListener("pointermove", event => {
    const panel = event.target.closest(".atlas-panel");
    if (!panel) return;
    const sheet = state.pack?.sheets?.[panel.dataset.sheet];
    if (!sheet) return;
    const hit = spriteAtPoint(sheet, panel, event);
    const name = hit?.name || "";
    if (panel.dataset.hover === name) return;
    panel.dataset.hover = name;
    panel.classList.toggle("is-pointing", Boolean(name));
    paintAtlasOverlay(panel);
  });
  dom.atlasSheets.addEventListener("pointerleave", event => {
    for (const panel of dom.atlasSheets.querySelectorAll(".atlas-panel[data-hover]")) {
      if (panel.contains(event.relatedTarget)) continue;
      delete panel.dataset.hover;
      panel.classList.remove("is-pointing");
      paintAtlasOverlay(panel);
    }
  });
  dom.viewSwitch.addEventListener("click", event => {
    const button = event.target.closest("[data-view-mode]");
    if (!button) return;
    setViewMode(button.dataset.viewMode);
  });
  dom.atlasZoom.addEventListener("click", event => {
    const button = event.target.closest("[data-atlas-zoom]");
    if (!button) return;
    state.atlasZoom = button.dataset.atlasZoom === "fit" ? "fit" : button.dataset.atlasZoom;
    applyAtlasZoom();
  });
}

function setViewMode(mode) {
  state.viewMode = mode === "sprites" ? "sprites" : "atlas";
  for (const button of dom.viewSwitch.querySelectorAll("[data-view-mode]")) {
    const active = button.dataset.viewMode === state.viewMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  dom.atlas.hidden = state.viewMode !== "atlas" || !state.pack;
  dom.browser.hidden = !state.pack || state.viewMode !== "sprites";
  if (state.viewMode === "atlas") renderAtlas();
  else if (state.pack) { renderGrid(); renderDetail(); }
}

/* ------------------------------------------------------------------- render */

function renderHeader() {
  const pack = state.pack;
  dom.packName.textContent = pack ? `${pack.name} · ${allSprites().length} sprites` : "No pack open";
  dom.downloadPack.hidden = !pack;
  dom.splitSheet.hidden = !pack || state.sheet === "all";
  const history = pack?.history?.length || 0;
  const replaced = Object.values(pack?.modifications || {}).reduce((total, group) => total + Object.keys(group).length, 0);
  dom.status.textContent = pack
    ? `${pack.name}: ${Object.keys(pack.sheets || {}).length} sheet(s), ${allSprites().length} sprites, ${replaced} replaced${history ? ` · ${history} change(s) in history` : ""}`
    : "Drop a .zip, .png, .plist or atlas .json anywhere on this page.";
}

function renderGrid() {
  const { rows, total } = visibleSprites();
  const shown = rows.slice(0, state.limit);
  dom.grid.innerHTML = shown.map(entry => {
    const size = logicalSize(entry.frame);
    const edited = isEdited(entry);
    const selected = state.selected && state.selected.sheetId === entry.sheetId && state.selected.name === entry.frame.name;
    return `<button type="button" class="sprite-card ${edited ? "is-edited" : ""} ${selected ? "is-selected" : ""}" role="listitem"
      data-action="open-sprite" data-sheet="${esc(entry.sheetId)}" data-sprite="${esc(entry.frame.name)}"
      aria-label="${esc(entry.frame.name)}, ${size.width} by ${size.height} pixels">
      <span class="card-art"><canvas data-thumb data-sheet="${esc(entry.sheetId)}" data-sprite="${esc(entry.frame.name)}" role="img" aria-label="${esc(entry.frame.name)}"></canvas></span>
      <span class="card-meta">
        <strong title="${esc(entry.frame.name)}">${esc(entry.frame.name)}</strong>
        <small>${size.width} × ${size.height} px</small>
      </span>
      ${edited ? '<span class="card-flag">replaced</span>' : ""}
    </button>`;
  }).join("");
  dom.count.textContent = `${total} sprite${total === 1 ? "" : "s"}${total > shown.length ? ` · showing ${shown.length}` : ""}`;
  dom.loadMore.hidden = total <= shown.length;
  dom.loadMore.textContent = `Show ${Math.min(BATCH, total - shown.length)} more`;
  observeThumbs();
}

function renderSheetFilter() {
  const sheets = Object.values(state.pack?.sheets || {});
  dom.sheetFilter.innerHTML = [
    `<option value="all">All sheets (${sheets.length})</option>`,
    ...sheets.map(sheet => {
      const count = Object.keys(sheet.parsed?.frames || {}).length;
      return `<option value="${esc(sheet.id)}" ${state.sheet === sheet.id ? "selected" : ""}>${esc(sheet.name)} (${count})</option>`;
    })
  ].join("");
}

function render() {
  const hasPack = Boolean(state.pack);
  dom.empty.hidden = hasPack;
  dom.openSprites.hidden = hasPack;
  dom.browser.hidden = !hasPack || state.viewMode !== "sprites";
  dom.atlas.hidden = !hasPack || state.viewMode !== "atlas";
  renderHeader();
  if (!hasPack) return;
  renderSheetFilter();
  if (state.viewMode === "atlas") renderAtlas();
  else renderGrid();
  renderDetail();
}

/* ------------------------------------------------------------------- detail */

let zoom = 1;
const ZOOM_STEPS = [1, 2, 4, 8, 16, 32];
const DETAIL_MAX_SIDE = 8192;
const DETAIL_MAX_BACKING = 20_000_000;
let detailSprite = null;   // the 1:1 crop — the truth the readout reports

/** Zoom snaps to a step, so the picture is only ever shown at whole scale. */
function snapZoom(value) {
  const preferred = Math.max(1, Math.min(32, Number(value) || 1));
  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(Math.log(step / preferred)) < Math.abs(Math.log(best / preferred)) ? step : best, 1);
}

/** How many device pixels a CSS pixel covers, kept whole so scaling is exact. */
const deviceScale = () => Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));

/**
 * Paints the sprite at the current zoom, one sprite pixel to a whole number of
 * device pixels. The displayed size is exactly `width × zoom` CSS pixels — no
 * CSS shrinking — and the element scrolls instead, so "8×" always means 8×.
 */
function paintDetail(sprite) {
  const target = dom.detailCanvas, grid = dom.detailGrid;
  const requested = Math.max(1, Math.min(32, Math.round(zoom)));
  const dpr = deviceScale();
  let scale = requested;
  const fits = value => sprite.width * value * dpr <= DETAIL_MAX_SIDE
    && sprite.height * value * dpr <= DETAIL_MAX_SIDE
    && sprite.width * sprite.height * value * value * dpr * dpr <= DETAIL_MAX_BACKING;
  while (scale > 1 && !fits(scale)) scale -= 1;

  const backingWidth = Math.max(1, sprite.width * scale * dpr);
  const backingHeight = Math.max(1, sprite.height * scale * dpr);
  const cssWidth = sprite.width * scale, cssHeight = sprite.height * scale;

  target.width = backingWidth; target.height = backingHeight;
  target.style.width = `${cssWidth}px`; target.style.height = `${cssHeight}px`;
  const ctx = target.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, backingWidth, backingHeight);
  ctx.drawImage(sprite, 0, 0, sprite.width, sprite.height, 0, 0, backingWidth, backingHeight);

  // The grid lives on its own canvas, so the picture itself stays untouched.
  grid.width = backingWidth; grid.height = backingHeight;
  grid.style.width = `${cssWidth}px`; grid.style.height = `${cssHeight}px`;
  const gctx = grid.getContext("2d");
  gctx.clearRect(0, 0, backingWidth, backingHeight);
  grid.hidden = scale < 8;
  if (scale >= 8) {
    const cell = scale * dpr;
    gctx.strokeStyle = "rgba(255,255,255,.18)";
    gctx.lineWidth = 1;
    gctx.beginPath();
    for (let x = 0; x <= sprite.width; x++) { const at = Math.min(backingWidth - 1, x * cell) + .5; gctx.moveTo(at, 0); gctx.lineTo(at, backingHeight); }
    for (let y = 0; y <= sprite.height; y++) { const at = Math.min(backingHeight - 1, y * cell) + .5; gctx.moveTo(0, at); gctx.lineTo(backingWidth, at); }
    gctx.stroke();
    // Every eighth line is stronger, so counting pixels stays easy.
    if (cell * 8 < backingWidth || cell * 8 < backingHeight) {
      gctx.strokeStyle = "rgba(60,173,245,.45)";
      gctx.beginPath();
      for (let x = 0; x <= sprite.width; x += 8) { const at = Math.min(backingWidth - 1, x * cell) + .5; gctx.moveTo(at, 0); gctx.lineTo(at, backingHeight); }
      for (let y = 0; y <= sprite.height; y += 8) { const at = Math.min(backingHeight - 1, y * cell) + .5; gctx.moveTo(0, at); gctx.lineTo(backingWidth, at); }
      gctx.stroke();
    }
  }
  dom.detailStage.dataset.zoom = String(scale);
  return { width: sprite.width, height: sprite.height, zoom: scale, requested, capped: scale !== requested, dpr };
}

/** The pixel under the pointer, read from the 1:1 crop. */
function pixelAt(clientX, clientY) {
  if (!detailSprite) return null;
  const rect = dom.detailCanvas.getBoundingClientRect();
  const scale = Number(dom.detailStage.dataset.zoom) || zoom;
  if (!rect.width || !rect.height) return null;
  const x = Math.floor((clientX - rect.left) / scale);
  const y = Math.floor((clientY - rect.top) / scale);
  if (x < 0 || y < 0 || x >= detailSprite.width || y >= detailSprite.height) return null;
  const data = detailSprite.getContext("2d").getImageData(x, y, 1, 1).data;
  return { x, y, rgba: [data[0], data[1], data[2], data[3]] };
}

/**
 * The zoom caption: what is shown, and what that means in pixels. It is rebuilt
 * on every repaint, so the buttons can never disagree with the picture.
 */
function updateZoomCaption(extra = {}) {
  const shown = Number(dom.detailStage.dataset.zoom) || zoom;
  const sizeNote = shown === 1 ? "actual size — one sprite pixel per screen pixel" : `one sprite pixel = ${shown} screen pixels`;
  const capped = extra.capped ? ` (capped from ${extra.requested}×)` : "";
  dom.detailCaption.innerHTML =
    `<span class="zoom-note">Shown at <strong>${shown}×</strong>${capped} · ${sizeNote}</span> ` +
    ZOOM_STEPS.map(value =>
      `<button type="button" class="btn ghost small ${value === shown ? "is-active" : ""}" data-action="zoom" data-zoom="${value}">${value}×</button>`
    ).join(" ");
}

const hex2 = value => value.toString(16).padStart(2, "0");
const rgbaHex = rgba => `#${hex2(rgba[0])}${hex2(rgba[1])}${hex2(rgba[2])}${rgba[3] === 255 ? "" : hex2(rgba[3])}`;
const rgbaText = rgba => `rgba(${rgba.join(", ")})`;

function showPixel(pixel) {
  if (!dom.detailPixel) return;
  if (!pixel) {
    dom.detailPixel.innerHTML = `<span class="muted">Move over the sprite to read a pixel · click to copy its colour</span>`;
    dom.detailPixel.dataset.hex = "";
    return;
  }
  const hex = rgbaHex(pixel.rgba);
  // The swatch is drawn over a checkerboard so semi-transparent pixels read honestly.
  dom.detailPixel.dataset.hex = hex;
  dom.detailPixel.innerHTML =
    `<span class="pixel-swatch" style="background-color:${hex}"></span>` +
    `<span class="pixel-xy">x ${pixel.x} · y ${pixel.y}</span>` +
    `<code>${hex}</code><span class="muted small">${rgbaText(pixel.rgba)}</span>`;
}

function bindPixelInspector() {
  const stage = dom.detailStage;
  if (!stage) return;
  stage.addEventListener("pointermove", event => showPixel(pixelAt(event.clientX, event.clientY)));
  stage.addEventListener("pointerleave", () => showPixel(null));
  stage.addEventListener("click", async event => {
    const pixel = pixelAt(event.clientX, event.clientY);
    if (!pixel) return;
    await copyText(rgbaHex(pixel.rgba), `${rgbaHex(pixel.rgba)} copied`);
  });
}

async function copyText(text, message) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error("clipboard unavailable");
    toast(message || "Copied.");
    return true;
  } catch (_) {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.append(scratch);
    scratch.select();
    const ok = document.execCommand?.("copy");
    scratch.remove();
    toast(ok ? (message || "Copied.") : "This browser would not let the app copy.", !ok);
    return Boolean(ok);
  }
}

function fact(label, value) {
  return `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

async function renderDetail() {
  const reference = state.selected;
  const frame = frameOf(reference);
  if (!frame) {
    dom.detail.hidden = true;
    return;
  }
  const ref = refOf(reference);
  const sheet = sheetOf(ref);
  const size = logicalSize(frame);
  const modification = modificationOf(ref);
  dom.detail.hidden = false;
  dom.detailTitle.textContent = ref.name;
  dom.detailSub.textContent = `${size.width} × ${size.height} px · ${sheet.name}`;
  dom.detailRevert.hidden = !modification?.png;

  let natural = size;
  try {
    const canvas = await spriteCanvas(ref, Number.MAX_SAFE_INTEGER);
    if (canvas) {
      detailSprite = canvas;
      natural = paintDetail(canvas);
    }
  } catch (_) { /* the panel still shows the metadata if the crop fails */ }

  const sourceFile = sheet.source?.pngPath || sheet.source?.jsonPath || sheet.source?.plistPath || `${sheet.name}.png`;
  dom.detailFacts.innerHTML = [
    fact("Pixel size", `<strong>${natural.width} × ${natural.height}</strong>`),
    fact("Where it sits in the sheet", `${Math.round(frame.frame.x)}, ${Math.round(frame.frame.y)} · ${Math.round(frame.frame.width)} × ${Math.round(frame.frame.height)}${frame.rotated ? " (rotated)" : ""}`),
    fact("Sheet", `${esc(sheet.name)}<br><span class="muted small">${esc(sourceFile)}</span>`),
    fact("Status", modification?.png
      ? `Replaced by you <span class="muted small">(${esc(modification.mode || "fitted")})</span>`
      : "Original from the pack"),
    fact("Type", `PNG sprite${frame.trimmed ? ` · trimmed from ${frame.sourceSize?.width || "?"} × ${frame.sourceSize?.height || "?"}` : ""}`)
  ].join("");
  updateZoomCaption(natural);
  showPixel(null);

  if (state.replacement) await renderReplacement();
  else resetReplacementUi();
}

function resetReplacementUi() {
  dom.replacePreview.hidden = true;
  dom.replaceModes.hidden = true;
  dom.replaceActions.hidden = true;
}

/* -------------------------------------------------------------- replacement */

let replaceUrls = [];
function releaseReplaceUrls() {
  for (const url of replaceUrls) URL.revokeObjectURL(url);
  replaceUrls = [];
}

/**
 * The picture as PNG bytes.
 *
 * A PNG that is dropped in is kept exactly as it is — re-encoding it would
 * change semi-transparent pixels for no reason. Anything else (JPEG, WebP,
 * BMP…) is converted once through a canvas.
 */
async function imageToPngBytes(file) {
  const isPng = file.type === "image/png" || /\.png$/i.test(file.name || "");
  if (isPng) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isPngBytes(bytes)) {
      const size = await pngDimensions(bytes).catch(() => null);
      if (size && size.width * size.height > 40_000_000) {
        throw new Error("That image is too large to fit a sprite slot — try one under 40 megapixels.");
      }
      if (size) return { bytes, width: size.width, height: size.height, untouched: true };
    }
  }
  let bitmap = null;
  if (typeof createImageBitmap === "function") {
    try { bitmap = await createImageBitmap(file, { premultiplyAlpha: "none", colorSpaceConversion: "none" }); }
    catch (_) { try { bitmap = await createImageBitmap(file); } catch (_) { bitmap = null; } }
  }
  if (!bitmap) bitmap = await decodePng(file);
  if (!bitmap.width || !bitmap.height) throw new Error("That image has no usable pixel size.");
  if (bitmap.width * bitmap.height > 40_000_000) {
    bitmap.close?.();
    throw new Error("That image is too large to fit a sprite slot — try one under 40 megapixels.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return { bytes: await canvasToPngBytes(canvas), width: canvas.width, height: canvas.height, untouched: false };
}

async function chooseReplacement(file) {
  if (!file) return;
  try {
    const { bytes, width, height } = await imageToPngBytes(file);
    state.replacement = { bytes, width, height, name: file.name, mode: currentFitMode() };
    await renderReplacement();
  } catch (error) {
    toast(error?.message || "That image could not be read.", true);
  }
}

const currentFitMode = () => dom.replaceModes.querySelector("input[name=fit]:checked")?.value || "contain";

async function renderReplacement() {
  const reference = state.selected;
  const ref = refOf(reference);
  const frame = frameOf(ref);
  const sheet = sheetOf(ref);
  const replacement = state.replacement;
  if (!frame || !sheet?.source?.png || !replacement) {
    resetReplacementUi();
    return;
  }
  const mode = currentFitMode();
  const slot = logicalSize(frame);
  const place = fitRect({ width: replacement.width, height: replacement.height }, slot, mode === "exact" ? "contain" : mode);
  const distortion = mode === "stretch" && replacement.width !== slot.width && replacement.height !== slot.height;

  releaseReplaceUrls();
  const sourceUrl = URL.createObjectURL(new Blob([replacement.bytes], { type: "image/png" }));
  replaceUrls.push(sourceUrl);
  dom.replaceSource.src = sourceUrl;
  dom.replaceSourceCaption.innerHTML = `${esc(replacement.name || "Your image")}<br>${replacement.width} × ${replacement.height} px`;

  dom.replacePreview.hidden = false;
  dom.replaceModes.hidden = false;
  dom.replaceActions.hidden = false;

  try {
    const canvas = await createSpriteReplacement(sheet.source.png, frame, replacement.bytes, mode);
    dom.replaceResult.hidden = false;
    dom.replaceResult.width = canvas.width;
    dom.replaceResult.height = canvas.height;
    const ctx = dom.replaceResult.getContext("2d");
    ctx.imageSmoothingEnabled = mode !== "contain";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(canvas, 0, 0);
    canvas.close?.();
    dom.replaceResultCaption.innerHTML = `In the slot: <strong>${slot.width} × ${slot.height} px</strong>` +
      (mode === "contain" ? `<br><span class="muted">picture keeps its shape, edges stay transparent (${place.width} × ${place.height} used)</span>` : "") +
      (mode === "cover" ? `<br><span class="muted">fills the slot, ${distortion ? "" : "edges cropped"}</span>` : "") +
      ((mode === "stretch" || mode === "fit") ? `<br><span class="muted">stretched to the slot${distortion ? " (shape changed)" : ""}</span>` : "") +
      (mode === "exact" ? `<br><span class="muted">used exactly as it is</span>` : "");
    dom.replaceApply.disabled = false;
  } catch (error) {
    dom.replaceResult.hidden = true;
    dom.replaceResultCaption.innerHTML = `<span class="replace-error">${esc(error.message)}</span>`;
    dom.replaceApply.disabled = true;
  }
}

async function applyReplacement() {
  const reference = state.selected;
  const ref = refOf(reference);
  const frame = frameOf(ref);
  const sheet = sheetOf(ref);
  const replacement = state.replacement;
  if (!frame || !replacement) return;
  const mode = currentFitMode();
  try {
    // `exact` keeps the chosen file byte for byte; the other modes fit it and
    // re-encode exactly once.
    const result = await createSpriteReplacementBytes(sheet.source.png, frame, replacement.bytes, mode);
    applySpriteModification(state.pack, sheet.id, ref.name, result.bytes, { mode, sourceName: replacement.name });
    await saveTextureWorkspace(state.pack);
    forgetSpriteCanvases(sheet.id, ref.name);
    state.replacement = null;
    releaseReplaceUrls();
    toast(`${ref.name} replaced — download the pack when you are happy with it.`);
    render();
  } catch (error) {
    toast(error?.message || "That image could not be fitted into the sprite.", true);
  }
}

async function revertSelected() {
  const ref = refOf(state.selected);
  const frame = frameOf(ref);
  if (!frame) return;
  resetSprite(state.pack, ref.sheetId, ref.name);
  await saveTextureWorkspace(state.pack);
  forgetSpriteCanvases(ref.sheetId, ref.name);
  toast(`${ref.name} is back to the original artwork.`);
  render();
}

/* ------------------------------------------------------------------ loading */

async function openPack(files, packName = null) {
  const list = [...(files || [])];
  if (!list.length) return;
  dom.status.textContent = `Reading ${list.length} file${list.length === 1 ? "" : "s"}…`;
  try {
    const pack = await importTextureFiles(list);
    if (packName) pack.name = packName;
    const usable = getSpriteEntries(pack);
    if (!usable.length) throw new Error("No sprite metadata was found. Include the .plist or atlas .json that belongs to the PNG.");
    await saveTextureWorkspace(pack);
    selectPack(pack);
    const broken = Object.values(pack.sheets || {}).flatMap(sheet => sheet.errors || []);
    toast(`Opened ${pack.name}: ${usable.length} sprites from ${Object.keys(pack.sheets).length} sheet(s).${broken.length ? ` ${broken.length} file(s) could not be read.` : ""}`);
  } catch (error) {
    toast(error?.message || "That pack could not be opened.", true);
    dom.status.textContent = "Nothing loaded. Drop a .zip texture pack, or a PNG together with its .plist / atlas .json.";
  }
}

function selectPack(pack) {
  releaseCaches();
  releaseReplaceUrls();
  state.pack = pack;
  state.selected = null;
  state.limit = BATCH;
  state.query = "";
  state.sheet = "all";
  state.sort = "sheet";
  state.onlyEdited = false;
  state.replacement = null;
  zoom = 1;
  dom.search.value = "";
  dom.sort.value = "sheet";
  dom.onlyEdited.checked = false;
  dom.replaceInput.value = "";
  render();
}

async function openBundledSheets() {
  const wanted = [
    ["GJ_GameSheet.png", "GJ_GameSheet.json"],
    ["GJ_GameSheetIcons.png", "GJ_GameSheetIcons.json"],
    ["GJ_WebSheet.png", "GJ_WebSheet.json"]
  ];
  dom.status.textContent = "Loading the sheets that ship with the player…";
  try {
    const files = [];
    for (const [png, json] of wanted) {
      const [pngResponse, jsonResponse] = await Promise.all([
        fetch(`./play/assets/sheets/${png}`),
        fetch(`./play/assets/sheets/${json}`)
      ]);
      if (!pngResponse.ok || !jsonResponse.ok) continue;
      files.push(new File([await pngResponse.blob()], png, { type: "image/png" }));
      files.push(new File([await jsonResponse.text()], json, { type: "application/json" }));
    }
    if (!files.length) throw new Error("The bundled sheets are not available in this build.");
    await openPack(files, "Bundled game sheets");
  } catch (error) {
    toast(error?.message || "The bundled sheets could not be loaded.", true);
  }
}

async function renderSavedPacks() {
  const holder = document.getElementById("saved-packs");
  if (!holder) return;
  try {
    const packs = await getTextureWorkspaceSummaries();
    if (!packs.length) { holder.hidden = true; return; }
    holder.hidden = false;
    holder.innerHTML = `<span class="saved-label">Saved in this browser</span>` + packs.slice(0, 4).map(pack =>
      `<button type="button" class="btn ghost small" data-action="open-saved" data-id="${esc(pack.id)}">${esc(pack.name)} · ${pack.spriteCount} sprites</button>`
    ).join("");
  } catch (_) {
    holder.hidden = true;
  }
}

/* ------------------------------------------------------------------- events */

function bindEvents() {
  const choose = () => { dom.packInput.value = ""; dom.packInput.click(); };
  dom.choosePack.addEventListener("click", choose);
  dom.openPack.addEventListener("click", choose);
  dom.openSprites.addEventListener("click", choose);
  document.getElementById("choose-folder")?.addEventListener("click", () => { dom.folderInput.value = ""; dom.folderInput.click(); });
  dom.packInput.addEventListener("change", () => openPack(dom.packInput.files));
  dom.folderInput.addEventListener("change", () => openPack(dom.folderInput.files));
  dom.openBundled.addEventListener("click", openBundledSheets);

  dom.downloadPack.addEventListener("click", async () => {
    if (!state.pack) return;
    try {
      await exportTexturePack(state.pack, `${sanitizeName(state.pack.name)}.zip`);
      toast("Saved the pack with your replacements included.");
    } catch (error) {
      toast(error?.message || "The pack could not be exported.", true);
    }
  });
  dom.splitSheet.addEventListener("click", async () => {
    if (!state.pack || state.sheet === "all") return;
    try {
      await exportSplitSprites(state.pack, state.sheet);
      toast("Saved every sprite on this sheet as its own PNG.");
    } catch (error) {
      toast(error?.message || "Those sprites could not be exported.", true);
    }
  });

  dom.search.addEventListener("input", () => { state.query = dom.search.value; state.limit = BATCH; renderGrid(); });
  dom.sheetFilter.addEventListener("change", () => { state.sheet = dom.sheetFilter.value; state.limit = BATCH; render(); });
  dom.sort.addEventListener("change", () => { state.sort = dom.sort.value; renderGrid(); });
  dom.onlyEdited.addEventListener("change", () => { state.onlyEdited = dom.onlyEdited.checked; state.limit = BATCH; renderGrid(); });
  dom.loadMore.addEventListener("click", () => { state.limit += BATCH; renderGrid(); });

  dom.grid.addEventListener("click", event => {
    const card = event.target.closest("[data-action=open-sprite]");
    if (!card) return;
    selectSprite(card.dataset.sheet, card.dataset.sprite);
    // Small sprites open zoomed in enough to actually see; the caption says so.
    const selectedFrame = frameOf(state.selected);
    const selectedSize = logicalSize(selectedFrame || { frame: { width: 32, height: 32 } });
    zoom = snapZoom(160 / Math.max(selectedSize.width, selectedSize.height));
    // Only the highlight changes: rebuilding the grid would throw away every
    // sprite already cut out, and opening one should feel immediate.
    for (const other of dom.grid.querySelectorAll(".sprite-card.is-selected")) other.classList.remove("is-selected");
    card.classList.add("is-selected");
    renderDetail();
    dom.detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  dom.detailClose.addEventListener("click", () => { state.selected = null; state.replacement = null; render(); });
  dom.detailDownload.addEventListener("click", async () => {
    const ref = refOf(state.selected);
    if (!ref) return;
    const canvas = await spriteCanvas(ref, Number.MAX_SAFE_INTEGER);
    if (!canvas) { toast("This sprite could not be rendered.", true); return; }
    const bytes = await canvasToPngBytes(canvas);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeName(ref.name)}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Saved ${ref.name}.png at its full size.`);
  });
  dom.detailRevert.addEventListener("click", revertSelected);

  dom.detailCaption.addEventListener("click", async event => {
    const zoomButton = event.target.closest("[data-action=zoom]");
    if (!zoomButton) return;
    zoom = Number(zoomButton.dataset.zoom) || 1;
    const canvas = await spriteCanvas(refOf(state.selected), Number.MAX_SAFE_INTEGER);
    if (canvas) updateZoomCaption(paintDetail(canvas));
    else {
      dom.detailStage.dataset.zoom = String(zoom);
      updateZoomCaption();
    }
  });

  document.addEventListener("click", async event => {
    const saved = event.target.closest("[data-action=open-saved]");
    if (!saved) return;
    try {
      const pack = await getTextureWorkspace(saved.dataset.id);
      if (!pack) throw new Error("That pack is no longer in this browser.");
      selectPack(pack);
      toast(`Opened ${pack.name}.`);
    } catch (error) {
      toast(error?.message || "That pack could not be opened.", true);
    }
  });

  // Replacement source: picker or drag & drop onto the drop zone.
  dom.replaceChoose.addEventListener("click", () => { dom.replaceInput.value = ""; dom.replaceInput.click(); });
  dom.replaceInput.addEventListener("change", () => chooseReplacement(dom.replaceInput.files?.[0]));
  let depth = 0;
  for (const type of ["dragenter", "dragover"]) {
    dom.replaceDrop.addEventListener(type, event => {
      if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
      event.preventDefault();
      if (type === "dragenter") depth++;
      dom.replaceDrop.classList.add("is-over");
    });
  }
  dom.replaceDrop.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) dom.replaceDrop.classList.remove("is-over"); });
  dom.replaceDrop.addEventListener("drop", event => {
    event.preventDefault();
    depth = 0;
    dom.replaceDrop.classList.remove("is-over");
    const file = [...(event.dataTransfer?.files || [])].find(item => /^image\//.test(item.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(item.name));
    if (!file) { toast("Drop an image file (PNG, JPG, WebP…).", true); return; }
    chooseReplacement(file);
  });
  dom.replaceModes.addEventListener("change", () => { state.replacement = { ...state.replacement }; renderReplacement(); });
  dom.replaceApply.addEventListener("click", applyReplacement);
  dom.replaceCancel.addEventListener("click", () => { state.replacement = null; releaseReplaceUrls(); resetReplacementUi(); });

  // Dropped files are routed here by the workspace shell (`workspace.js`).

  bindAtlas();
  bindPixelInspector();
  setViewMode(state.viewMode);

  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && state.selected) {
      state.selected = null;
      state.replacement = null;
      for (const panel of dom.atlasSheets.querySelectorAll(".atlas-panel")) paintAtlasOverlay(panel);
      for (const card of dom.grid.querySelectorAll(".sprite-card.is-selected")) card.classList.remove("is-selected");
      dom.detail.hidden = true;
      resetReplacementUi();
    }
  });
}

function start() {
  dom.root.dataset.ready = "yes";
  bindEvents();
  render();
  renderSavedPacks();
}

start();

/* Exposed for the workspace shell and the browser test harness: both drive the
   same code paths the UI does. */
export const studioApi = {
  state, openPack, importTextureFiles, createSpriteReplacement, fitRect, spriteCanvas,
  setViewMode, selectSprite, frameBoxes, pixelAt, showPixel,
  detailState: () => ({ zoom, shown: Number(dom.detailStage.dataset.zoom) || zoom, sprite: detailSprite
    ? { width: detailSprite.width, height: detailSprite.height } : null }),
  openFiles: files => openPack(files),
  refreshSavedPacks: renderSavedPacks,
  showDropHint: value => dom.empty.classList.toggle("is-over", value)
};
window.__spriteStudio = studioApi;
