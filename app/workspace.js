/**
 * The workspace landing page: a wall of rooms, plus one useful shortcut — drop
 * a level file (or paste a level string) anywhere and it is parked for the
 * converter, which opens straight away with the file already converting.
 *
 * Nothing here uploads anything: the hand-off is a small IndexedDB store that
 * the converter drains and clears.
 */
import { putHandoffFiles } from "../core/storage/handoff.js";
import { getLibrarySummaries } from "../core/storage/database.js";
import { getTextureWorkspaceSummaries } from "../core/storage/texture-database.js";

const root = document.getElementById("hub-root");
const intake = document.getElementById("intake");
const toastBox = document.getElementById("hub-toast");
const statusBox = document.getElementById("hub-status");
const ledBox = document.getElementById("hub-led");
const savedHint = document.getElementById("saved-hint");
const versionBox = document.getElementById("hub-version");

const ROOMS = [...document.querySelectorAll("[data-room]")];

let toastTimer = null;
function toast(message, isError = false) {
  if (!toastBox) return;
  toastBox.textContent = message;
  toastBox.classList.toggle("is-error", isError);
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastBox.hidden = true; }, 4000);
}

async function handOver(files, { message, errorMessage }) {
  try {
    const count = await putHandoffFiles(files);
    if (!count) {
      toast(errorMessage || "That file type is not supported here.", true);
      return;
    }
    toast(message || `Opening the converter with ${count} file${count === 1 ? "" : "s"}…`);
    // The converter drains the hand-off on load.
    location.assign("./convert/?incoming=1");
  } catch (error) {
    toast(error?.message || errorMessage || "Those files could not be handed over.", true);
  }
}

function fileListFromDataTransfer(transfer) {
  const items = transfer?.files ? [...transfer.files] : [];
  return items.filter(file => /\.(gmd|txt)$/i.test(file.name) || /^text\/plain$/i.test(file.type));
}

function bindDropTarget() {
  let depth = 0;
  const setOver = value => intake?.classList.toggle("is-over", value);
  for (const type of ["dragenter", "dragover"]) {
    window.addEventListener(type, event => {
      if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
      event.preventDefault();
      if (type === "dragenter") depth++;
      setOver(true);
    });
  }
  window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) setOver(false); });
  window.addEventListener("dragover", event => event.preventDefault());
  window.addEventListener("drop", event => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    depth = 0;
    setOver(false);
    const files = fileListFromDataTransfer(event.dataTransfer);
    if (!files.length) {
      toast("That is not a Geometry Dash level file — try a .gmd or .txt export.", true);
      return;
    }
    const read = files.map(file => file.arrayBuffer().then(data => ({ name: file.name, type: file.type, size: file.size, data })));
    Promise.all(read).then(entries => handOver(entries, {
      message: `Opening the converter with ${entries.length} file${entries.length === 1 ? "" : "s"}…`
    }));
  });

  // Pasting level text anywhere on the hub is another way in.
  window.addEventListener("paste", event => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const text = event.clipboardData?.getData("text");
    if (!text || text.length < 24) return;
    const data = new TextEncoder().encode(text).buffer;
    handOver([{ name: "pasted-level.txt", type: "text/plain", size: data.byteLength, data }], {
      message: "Opening the converter with the level text from your clipboard…"
    });
  });
}

function bindKeyboard() {
  window.addEventListener("keydown", event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const room = ROOMS.find(item => item.dataset.room === event.key);
    if (!room) return;
    event.preventDefault();
    location.assign(room.getAttribute("href"));
  });
}

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
      `<a href="./convert/#saved">Open saved files</a> or <a href="./textures/">open the sprite studio</a>.`;
    ledBox?.classList.remove("is-empty");
    if (savedHint && levels) savedHint.textContent = `${levels} conversion${levels === 1 ? "" : "s"} ready to download again on this device.`;
  } else {
    statusBox.innerHTML = "Nothing saved yet on this device. Start by dropping a <code>.gmd</code> or <code>.txt</code> above — results are kept right here in the browser.";
    ledBox?.classList.add("is-empty");
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return;
  const script = new URL("../sw.js", location.href);
  const scope = new URL("../", location.href);
  navigator.serviceWorker.register(script, { scope }).catch(() => {
    /* Offline support is a bonus; the workspace works without it. */
  });
}

function bindInstallHint() {
  // A small nudge only when the browser actually offers installation.
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    toast("Tip: install this workspace so it opens offline like an app.");
  });
}

root?.setAttribute("data-ready", "yes");
versionBox && window.GMDPLAYER_META && (versionBox.textContent = `${window.GMDPLAYER_META.name} ${window.GMDPLAYER_META.version}`);
bindDropTarget();
bindKeyboard();
bindInstallHint();
registerServiceWorker();
showStorageSummary();
