/**
 * The workspace shell.
 *
 * The whole application is this one page. The shell owns the things that are
 * shared by every room — which room is on screen, what a dropped file should
 * open, the storage summary in the footer, the keyboard shortcuts and the
 * service worker — and the rooms themselves live in `./views/`.
 *
 * A dropped file is routed by what it is, not by where it lands: a level goes to
 * the converter, a texture pack to the studio, a `.dat` to the save reader.
 */
import { getLibrarySummaries } from "../core/storage/database.js";
import { getTextureWorkspaceSummaries } from "../core/storage/texture-database.js";
import { converterApi } from "./views/convert.js";
import { studioApi } from "./views/textures.js";
import { saveReaderApi } from "./views/savefile.js";

const root = document.getElementById("workspace-root");
const toastBox = document.getElementById("toasts");
const statusBox = document.getElementById("hub-status");
const ledBox = document.getElementById("hub-led");
const savedHint = document.getElementById("saved-hint");
const versionBox = document.getElementById("version-label");
const levelGrid = document.getElementById("level-grid");

const VIEWS = {
  home: { section: document.getElementById("view-home"), title: "GMD Workspace — local tools for Geometry Dash files" },
  convert: { section: document.getElementById("view-convert"), title: "Convert levels — GMD Workspace" },
  textures: { section: document.getElementById("view-textures"), title: "Sprite studio — GMD Workspace" },
  play: { section: document.getElementById("view-play"), title: "Play a level — GMD Workspace" },
  saved: { section: document.getElementById("view-saved"), title: "Saved files — GMD Workspace" },
  save: { section: document.getElementById("view-save"), title: "Save file reader — GMD Workspace" }
};

const ROOM_KEYS = { 1: "convert", 2: "textures", 3: "play", 4: "saved", 5: "save" };
const DROP_ZONES = { home: "intake", convert: "dropzone", textures: "empty-state", save: "save-drop" };

const LEVEL_FILE = /\.(gmd|txt)$/i;
const SAVE_FILE = /\.dat$/i;
const PACK_FILE = /\.(zip|plist|png|jpe?g|webp|gif|bmp)$/i;

const state = { view: "home" };

let toastTimer = null;
function toast(message, isError = false) {
  if (!toastBox) return;
  const node = document.createElement("div");
  node.className = `toast${isError ? " error" : ""}`;
  node.textContent = message;
  toastBox.append(node);
  setTimeout(() => node.remove(), 4200);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastBox.replaceChildren(); }, 5000);
}

/* ------------------------------------------------------------------ rooms */

function viewFromHash() {
  const name = String(location.hash || "").replace(/^#\/?/, "").split(/[?&]/)[0];
  return VIEWS[name] ? name : "home";
}

function showView(name, { scroll = true } = {}) {
  const next = VIEWS[name] ? name : "home";
  const changed = state.view !== next;
  state.view = next;
  root.dataset.view = next;
  for (const [key, view] of Object.entries(VIEWS)) {
    view.section?.classList.toggle("is-active", key === next);
  }
  for (const link of document.querySelectorAll("[data-view-link]")) {
    if (link.dataset.viewLink === next) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const title = VIEWS[next].title;
  if (title) document.title = title;
  if (changed && scroll) window.scrollTo({ top: 0 });
  if (next === "play") warmPlayRoom();
  if (next === "saved") converterApi.refreshHistory();
  if (next === "textures") studioApi.refreshSavedPacks();
}

/* ------------------------------------------------------------- file intake */

function classify(files) {
  const groups = { levels: [], packs: [], saves: [], other: [] };
  for (const file of files) {
    const name = file?.name || "";
    if (LEVEL_FILE.test(name) || /^text\/plain$/i.test(file?.type || "")) groups.levels.push(file);
    else if (SAVE_FILE.test(name)) groups.saves.push(file);
    else if (PACK_FILE.test(name)) groups.packs.push(file);
    else groups.other.push(file);
  }
  return groups;
}

/** Sends each dropped file to the room that understands it. */
async function routeFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  const groups = classify(list);
  if (groups.saves.length) {
    showView("save");
    saveReaderApi.handleFiles(groups.saves);
  }
  if (groups.packs.length) {
    showView("textures");
    await studioApi.openFiles(groups.packs);
  }
  if (groups.levels.length) {
    showView("convert");
    converterApi.addFiles(groups.levels);
  }
  if (groups.other.length && !groups.levels.length && !groups.packs.length && !groups.saves.length) {
    const [first] = groups.other;
    toast(`${first?.name || "That file"} is not something this workspace opens yet — try a level (.gmd/.txt), a texture pack (.zip/.png/.plist) or a save (.dat).`, true);
  }
}

function highlightDropZone(value) {
  for (const id of Object.values(DROP_ZONES)) document.getElementById(id)?.classList.toggle("is-over", value);
  root.dataset.dragging = value ? "yes" : "no";
}

function bindIntake() {
  let depth = 0;
  for (const type of ["dragenter", "dragover"]) {
    window.addEventListener(type, event => {
      if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
      event.preventDefault();
      if (type === "dragenter") depth++;
      highlightDropZone(true);
    });
  }
  window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) highlightDropZone(false); });
  window.addEventListener("dragover", event => event.preventDefault());
  window.addEventListener("drop", event => {
    // A room's own drop zone (a replacement image, a save file) handled it first.
    if (event.defaultPrevented || !event.dataTransfer?.files?.length) return;
    event.preventDefault();
    depth = 0;
    highlightDropZone(false);
    routeFiles(event.dataTransfer.files);
  });

  // Pasting level text anywhere is another way into the converter.
  window.addEventListener("paste", event => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const text = event.clipboardData?.getData("text");
    if (!text || text.length < 24) return;
    showView("convert");
    converterApi.addPastedText(text);
  });
}

function bindKeyboard() {
  window.addEventListener("keydown", event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    if (event.key === "Escape" && state.view !== "home" && !converterApi.isPlaying()) {
      location.hash = "#home";
      return;
    }
    const view = ROOM_KEYS[event.key];
    if (!view) return;
    event.preventDefault();
    location.hash = `#${view}`;
  });
}

/* ---------------------------------------------------------------- storage */

async function showStorageSummary() {
  if (!statusBox) return;
  let levels = 0, packs = 0, sprites = 0;
  try {
    const [levelRows, packRows] = await Promise.all([
      getLibrarySummaries().catch(() => []),
      getTextureWorkspaceSummaries().catch(() => [])
    ]);
    levels = (levelRows || []).length;
    packs = (packRows || []).length;
    sprites = (packRows || []).reduce((total, pack) => total + (pack.spriteCount || 0), 0);
  } catch (_) {
    statusBox.textContent = "Storage is unavailable in this browser, but every tool still works on the files you open.";
    ledBox?.classList.add("is-empty");
    return;
  }

  const parts = [];
  if (levels) parts.push(`${levels} level file${levels === 1 ? "" : "s"} saved`);
  if (packs) parts.push(`${packs} texture pack${packs === 1 ? "" : "s"} (${sprites} sprite${sprites === 1 ? "" : "s"})`);
  if (parts.length) {
    statusBox.innerHTML = `On this device: ${parts.join(" · ")}. ` +
      `<a href="#saved">Open saved files</a> or <a href="#textures">open the sprite studio</a>.`;
    ledBox?.classList.remove("is-empty");
    if (savedHint && levels) savedHint.textContent = `${levels} conversion${levels === 1 ? "" : "s"} ready to download again on this device.`;
  } else {
    statusBox.innerHTML = "Nothing saved yet on this device. Start by dropping a <code>.gmd</code> or <code>.txt</code> above — results are kept right here in the browser.";
    ledBox?.classList.add("is-empty");
  }
}

/* ------------------------------------------------------------- play room */

function buildLevels() {
  if (!levelGrid || levelGrid.dataset.built === "yes") return;
  const songs = Array.isArray(globalThis.allLevels) ? globalThis.allLevels : [];
  levelGrid.innerHTML = songs.map((song, index) => {
    const name = song?.[1] || `Level ${index + 1}`;
    const author = song?.[3]?.[0] || "";
    const artist = song?.[3]?.[1] || "";
    return `<button class="level" type="button" role="listitem" data-level="${index}">
      <span class="level-key" aria-hidden="true">${index + 1}</span>
      <span class="level-body">
        <strong>${name.replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]))}</strong>
        <small>${[author, artist].filter(Boolean).join(" · ")}</small>
      </span>
      <span class="level-play" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#w-play"></use></svg></span>
    </button>`;
  }).join("");
  levelGrid.dataset.built = "yes";
  levelGrid.addEventListener("click", async event => {
    const button = event.target.closest("[data-level]");
    if (!button || button.dataset.busy === "yes") return;
    button.dataset.busy = "yes";
    button.classList.add("is-loading");
    try {
      await converterApi.playLevel(Number(button.dataset.level));
    } finally {
      delete button.dataset.busy;
      button.classList.remove("is-loading");
    }
  });
}

function warmPlayRoom() {
  buildLevels();
  // Start the runtime now, so pressing a level does not wait for the engine.
  converterApi.warmUp();
}

/* --------------------------------------------------------------- plumbing */

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  const script = new URL("../sw.js", location.href);
  const scope = new URL("../", location.href);
  navigator.serviceWorker.register(script, { scope }).catch(() => {
    /* Offline support is a bonus; the workspace works without it. */
  });
}

function bindInstallHint() {
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    toast("Tip: install this workspace so it opens offline like an app.");
  });
}

function start() {
  showView(viewFromHash(), { scroll: false });
  window.addEventListener("hashchange", () => showView(viewFromHash()));
  bindIntake();
  bindKeyboard();
  bindInstallHint();
  buildLevels();
  showStorageSummary();
  registerServiceWorker();
  versionBox && window.GMDPLAYER_META && (versionBox.textContent = `${window.GMDPLAYER_META.name} ${window.GMDPLAYER_META.version}`);
  root.dataset.ready = "yes";
}

start();

// Exposed for the browser test harness.
window.__gmdWorkspace = { state, showView, routeFiles, toast };
