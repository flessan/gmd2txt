/**
 * Sprite studio — the friendly half of the texture tooling.
 *
 * Open a texture pack and every sprite in it is cut out and shown as its own
 * picture. Clicking one opens it on its own with its real pixel size, and a
 * replacement image is scaled into the original slot automatically. The
 * advanced workshop still exists for repacking, merging and project work; this
 * page deliberately does one thing at a time.
 *
 * Performance notes: a sheet can hold thousands of sprites, so the atlas PNG is
 * decoded once per sheet, sprites are cropped from that cached bitmap, and the
 * crops are painted straight onto canvases (no PNG encoding in the hot path).
 */
import { importTextureFiles, getSpriteEntries, applySpriteModification, resetSprite } from "../../core/textures/texture-pack.js";
import { extractSprite, createSpriteReplacement, canvasToPngBytes, decodePng, fitRect } from "../../core/textures/sprites.js";
import { exportTexturePack, exportSplitSprites } from "../../core/textures/texture-export.js";
import { saveTextureWorkspace, getTextureWorkspace, getTextureWorkspaceSummaries } from "../../core/storage/texture-database.js";

const $ = selector => document.querySelector(selector);
const dom = {
  root: $("#studio-root"),
  empty: $("#empty-state"),
  browser: $("#browser"),
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
  version: $("#studio-version")
};

const state = {
  pack: null,
  selected: null,
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
  for (const entry of atlasCache.values()) entry.bitmap?.close?.();
  atlasCache.clear();
  for (const canvas of spriteCanvasCache.values()) canvas.close?.();
  spriteCanvasCache.clear();
  spriteCanvasPromises.clear();
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
  dom.browser.hidden = !hasPack;
  dom.openSprites.hidden = hasPack;
  renderHeader();
  if (!hasPack) return;
  renderSheetFilter();
  renderGrid();
  renderDetail();
}

/* ------------------------------------------------------------------- detail */

let zoom = 1;

/** Paints the sprite into the detail canvas at the current zoom level. */
function paintDetail(sprite) {
  const target = dom.detailCanvas;
  const scale = Math.max(1, Math.min(8, zoom));
  const width = Math.max(1, Math.round(sprite.width * scale));
  const height = Math.max(1, Math.round(sprite.height * scale));
  target.width = width;
  target.height = height;
  const ctx = target.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(sprite, 0, 0, sprite.width, sprite.height, 0, 0, width, height);
  return { width: sprite.width, height: sprite.height };
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
    if (canvas) natural = paintDetail(canvas);
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
  dom.detailCaption.innerHTML = `Shown at ${zoom}× · ` + [1, 2, 4, 8].map(value =>
    `<button type="button" class="btn ghost small ${value === zoom ? "is-active" : ""}" data-action="zoom" data-zoom="${value}">${value}×</button>`
  ).join(" ");

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

/** Decodes any image the browser can read and re-encodes it as PNG bytes. */
async function imageToPngBytes(file) {
  let bitmap = null;
  if (typeof createImageBitmap === "function") {
    try { bitmap = await createImageBitmap(file); } catch (_) { bitmap = null; }
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
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return { bytes: await canvasToPngBytes(canvas), width: canvas.width, height: canvas.height };
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
    const canvas = await createSpriteReplacement(sheet.source.png, frame, replacement.bytes, mode);
    const bytes = await canvasToPngBytes(canvas);
    canvas.close?.();
    applySpriteModification(state.pack, sheet.id, ref.name, bytes, { mode, sourceName: replacement.name });
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
    toast(`Opened ${pack.name}: ${usable.length} sprites from ${Object.keys(pack.sheets).length} sheet(s).${broken.length ? ` ${broken.length} note(s) — see the workshop for details.` : ""}`);
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
        fetch(`../play/assets/sheets/${png}`),
        fetch(`../play/assets/sheets/${json}`)
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
    state.selected = { sheetId: card.dataset.sheet, name: card.dataset.sprite };
    state.replacement = null;
    // Small sprites open zoomed in enough to actually see; the caption says so.
    const selectedFrame = frameOf(state.selected);
    const selectedSize = logicalSize(selectedFrame || { frame: { width: 32, height: 32 } });
    zoom = Math.max(1, Math.min(8, Math.round(160 / Math.max(selectedSize.width, selectedSize.height))));
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
    if (canvas) paintDetail(canvas);
    for (const button of dom.detailCaption.querySelectorAll("[data-action=zoom]")) {
      button.classList.toggle("is-active", Number(button.dataset.zoom) === zoom);
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

  // Dropping a pack anywhere starts a new one.
  let fileDepth = 0;
  const isPackDrop = event => [...(event.dataTransfer?.types || [])].includes("Files") && !event.target.closest("#replace-drop");
  for (const type of ["dragenter", "dragover"]) {
    window.addEventListener(type, event => {
      if (!isPackDrop(event)) return;
      event.preventDefault();
      if (type === "dragenter") fileDepth++;
      dom.empty.classList.add("is-over");
    });
  }
  window.addEventListener("dragleave", () => { fileDepth = Math.max(0, fileDepth - 1); if (!fileDepth) dom.empty.classList.remove("is-over"); });
  window.addEventListener("dragover", event => event.preventDefault());
  window.addEventListener("drop", event => {
    if (!event.dataTransfer?.files?.length || event.target.closest("#replace-drop")) return;
    event.preventDefault();
    fileDepth = 0;
    dom.empty.classList.remove("is-over");
    openPack(event.dataTransfer.files);
  });

  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && state.selected) {
      state.selected = null;
      state.replacement = null;
      render();
    }
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  const script = new URL("../../sw.js", location.href);
  const scope = new URL("../../", location.href);
  navigator.serviceWorker.register(script, { scope }).catch(() => {});
}

function start() {
  dom.version.textContent = window.GMDPLAYER_META ? `${window.GMDPLAYER_META.name} ${window.GMDPLAYER_META.version}` : "";
  dom.root.dataset.ready = "yes";
  bindEvents();
  registerServiceWorker();
  render();
  renderSavedPacks();
}

start();

// Exposed for the browser test harness: it drives the same code paths the UI does.
window.__spriteStudio = { state, openPack, importTextureFiles, createSpriteReplacement, fitRect, spriteCanvas };
