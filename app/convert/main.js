/**
 * gmd2txt — the converter UI.
 *
 * The page does exactly one job: turn a dropped `.gmd` file into a `.txt` level
 * string, or a `.txt` level string into a `.gmd` file — then let people copy or
 * download the result. All of the level-file knowledge lives in
 * `core/convert/level-file.js`; this file only deals with people.
 */

import {
  convertLevelText,
  buildGmdText,
  buildLevelDocument,
  decodedFileName,
  sanitizeFileName,
  songLabel,
  uniqueFileName,
  LEVEL_FILE_LIMIT_BYTES
} from "../../core/convert/level-file.js";
import { writeZipBlob } from "../../core/textures/zip.js";
import { createLevel, deleteLevel, getLevel, getLibrarySummaries } from "../../core/storage/database.js";
import { PlayerAdapter, playerRuntimeUrl } from "../../core/runtime/player-adapter.js";
import { takeHandoffFiles } from "../../core/storage/handoff.js";

const meta = globalThis.GMDPLAYER_META || {};
const officialSongs = Array.isArray(globalThis.allLevels) ? globalThis.allLevels : null;
const HISTORY_LIMIT = 12;

const dom = {
  root: document.querySelector("#app-root"),
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#file-input"),
  sampleSelect: document.querySelector("#sample-select"),
  steps: document.querySelector("#steps"),
  results: document.querySelector("#results"),
  resultsTitle: document.querySelector("#results-title"),
  resultList: document.querySelector("#result-list"),
  downloadAll: document.querySelector("#download-all"),
  clearResults: document.querySelector("#clear-results"),
  savedCount: document.querySelector("#saved-count"),
  savedList: document.querySelector("#saved-list"),
  savedSize: document.querySelector("#saved-size"),
  clearSaved: document.querySelector("#clear-saved"),
  version: document.querySelector("#version-label"),
  pasteDialog: document.querySelector("#paste-dialog"),
  pasteForm: document.querySelector("#paste-form"),
  pasteText: document.querySelector("#paste-text"),
  pasteStatus: document.querySelector("#paste-status"),
  pasteOpen: document.querySelector("#paste-open"),
  playerOverlay: document.querySelector("#player-overlay"),
  playerStage: document.querySelector("#player-stage"),
  playerLoading: document.querySelector("#player-loading"),
  playerLoadingHint: document.querySelector("#player-loading-hint"),
  playerTitle: document.querySelector("#player-title"),
  playerStatus: document.querySelector("#player-status"),
  playerClose: document.querySelector("#player-close"),
  toasts: document.querySelector("#toasts")
};

const state = {
  entries: [],
  history: [],
  usedNames: new Set(),
  nextId: 1,
  player: null,
  playingKey: null
};

/* ------------------------------------------------------------------ *
 * Tiny helpers
 * ------------------------------------------------------------------ */

const esc = value => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const number = value => Number(value || 0).toLocaleString();

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp || 0)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function truncate(text, limit = 240) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function icon(name, className = "icon") {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function toast(message, type = "") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.innerHTML = `${icon(type === "error" ? "alert" : "check")}<span>${esc(message)}</span>`;
  dom.toasts.append(node);
  setTimeout(() => node.remove(), type === "error" ? 6000 : 3600);
}

function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  document.body.classList.add("has-overlay");
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
  if (!document.querySelector("dialog[open]")) document.body.classList.remove("has-overlay");
}

/* ------------------------------------------------------------------ *
 * Copying and downloading
 * ------------------------------------------------------------------ */

async function copyText(text, successMessage) {
  const value = String(text ?? "");
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else throw new Error("clipboard unavailable");
    toast(successMessage || "Copied to the clipboard.");
    return true;
  } catch (_) {
    // Fallback for browsers without the async clipboard API (or a denied permission).
    try {
      const scratch = document.createElement("textarea");
      scratch.value = value;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.append(scratch);
      scratch.select();
      const copied = document.execCommand("copy");
      scratch.remove();
      if (copied) { toast(successMessage || "Copied to the clipboard."); return true; }
    } catch (_) { /* fall through to the manual hint */ }
    toast("Your browser blocked copying. Open Details and select the text instead.", "error");
    return false;
  }
}

function downloadText(text, filename, mime = "text/plain;charset=utf-8") {
  return downloadBlob(new Blob([text], { type: mime }), filename);
}

function downloadBlob(blob, filename) {
  if (!globalThis.URL?.createObjectURL) { toast("This browser cannot save files.", "error"); return false; }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
  toast(`Saved ${filename}`);
  return true;
}

/* ------------------------------------------------------------------ *
 * Converting
 * ------------------------------------------------------------------ */

function findEntry(id) {
  return state.entries.find(entry => entry.id === String(id));
}

async function readFileText(file) {
  if (Number(file.size) > LEVEL_FILE_LIMIT_BYTES) {
    throw Object.assign(new Error("too-large"), { friendly: "This file is too big to be a Geometry Dash level." });
  }
  return file.text();
}

async function addFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  hideSteps();
  const startedAt = performance.now();
  for (const file of files) {
    const entry = { id: String(state.nextId++), status: "busy", file, name: file.name };
    state.entries.unshift(entry);
    render();
    await processEntry(entry, () => readFileText(file), { filename: file.name, size: file.size, mimeType: file.type });
  }
  const ready = state.entries.filter(item => item.status === "ready").length;
  if (files.length === 1 && ready) toast(`Converted in ${Math.max(1, Math.round(performance.now() - startedAt))} ms`);
  revealResults();
}

/** Picks up files dropped on the workspace landing page (it parks them for us). */
async function convertHandoffFiles() {
  let parked = [];
  try {
    parked = await takeHandoffFiles();
  } catch (_) {
    return false;
  }
  if (!parked.length) return false;
  hideSteps();
  for (const file of parked) {
    const blob = new Blob([file.data], { type: file.type || "application/octet-stream" });
    const entry = { id: String(state.nextId++), status: "busy", file: blob, name: file.name };
    state.entries.unshift(entry);
    render();
    await processEntry(entry, () => blob.text(), { filename: file.name, size: blob.size, mimeType: blob.type });
  }
  toast(`Converted ${parked.length} file${parked.length === 1 ? "" : "s"} you dropped on the workspace.`);
  revealResults();
  return true;
}

async function processEntry(entry, readText, fileInfo) {
  try {
    const text = await readText();
    const conversion = await convertLevelText({
      text,
      filename: fileInfo.filename,
      size: fileInfo.size ?? null,
      fieldsHint: fileInfo.fieldsHint || {},
      officialSongs
    });
    if (!conversion.ok) {
      entry.status = "error";
      entry.error = conversion;
      render();
      return;
    }
    entry.conversion = conversion;
    entry.outputName = uniqueFileName(conversion.output.filename, state.usedNames);
    entry.status = "ready";
    render();
    revealResults();
    // Boot the preview runtime in the background and pre-load this level, so
    // "Play preview" opens straight into gameplay.
    scheduleWarmRuntime(900, entry);
    rememberConversion(entry, fileInfo);
  } catch (error) {
    entry.status = "error";
    entry.error = {
      code: error?.friendly === "too-large" ? "too-large" : "reading",
      message: error?.friendly || "This file could not be read.",
      hint: error?.message && error.message !== "too-large" ? error.message : "Try again, or convert a different file."
    };
    render();
  }
}

async function loadSample(index) {
  const entry = { id: String(state.nextId++), status: "busy", file: null, name: "sample" };
  state.entries.unshift(entry);
  hideSteps();
  render();
  const song = officialSongs?.[index];
  const levelName = song?.[1] || `Sample level ${index + 1}`;
  entry.name = `${levelName} (sample)`;
  const url = `../play/assets/levels/${index + 1}.txt`;
  await processEntry(entry, async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("The bundled sample level could not be loaded.");
    return response.text();
  }, {
    filename: `${sanitizeFileName(levelName, "sample")}.txt`,
    mimeType: "text/plain",
    fieldsHint: { name: levelName, author: song?.[3]?.[0] || "", officialSongIndex: index }
  });
}

/** Fields remembered for a level so the .gmd can be rebuilt from storage. */
function fieldsFromMetadata(metadata, song) {
  return {
    name: metadata?.name || "",
    author: metadata?.author && metadata.author !== "Unknown creator" ? metadata.author : "",
    description: metadata?.description || "",
    levelId: metadata?.levelId ?? null,
    customSongId: song?.type === "custom" ? song.id : null,
    officialSongIndex: song?.type === "official" ? song.id : null
  };
}

async function rememberConversion(entry, fileInfo) {
  try {
    const document_ = await buildLevelDocument(entry.conversion, {
      filename: fileInfo.filename,
      size: fileInfo.size ?? null,
      mimeType: fileInfo.mimeType || ""
    });
    entry.document = document_;
    await createLevel(document_, { duplicateMode: "update" });
    await refreshHistory();
  } catch (_) {
    // Storage is a convenience; the conversion itself already succeeded.
    entry.document = entry.document || null;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function hideSteps() {
  if (dom.steps) dom.steps.hidden = true;
}

/** Bring the freshly converted file into view without yanking the page around. */
function revealResults() {
  if (!dom.results || dom.results.hidden) return;
  const box = dom.results.getBoundingClientRect();
  if (box.top > window.innerHeight * 0.75 || box.bottom < 0) {
    dom.results.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function fact(label, value) {
  return value === "" || value === null || value === undefined
    ? ""
    : `<li><span>${esc(label)}</span><strong>${esc(value)}</strong></li>`;
}

function insideLabel(scan) {
  const parts = [];
  if (scan.portalCount) parts.push(`${number(scan.portalCount)} ${scan.portalCount === 1 ? "portal" : "portals"}`);
  if (scan.triggerCount) parts.push(`${number(scan.triggerCount)} ${scan.triggerCount === 1 ? "trigger" : "triggers"}`);
  if (!parts.length) parts.push(`${number(scan.objectCount)} objects`);
  return parts.join(" · ");
}

function cardFacts(conversion) {
  const scan = conversion.scan;
  return [
    fact("Objects", number(scan.objectCount)),
    fact("Song", conversion.song.type === "unknown" ? "" : conversion.song.name),
    fact("Creator", conversion.fields.author || ""),
    fact("Inside", insideLabel(scan)),
    fact("Level ID", conversion.fields.levelId ? number(conversion.fields.levelId) : "")
  ].join("");
}

function conversionLine(entry) {
  const conversion = entry.conversion;
  const sourceName = entry.file?.name || entry.name || "pasted text";
  const size = formatBytes(entry.file?.size);
  const from = `${sourceName}${size ? ` (${size})` : ""}`;
  return `${from} → ${entry.outputName || conversion.output.filename}`;
}

function outputPreview(entry) {
  return truncate(String(entry.conversion.output.text).replace(/\s+/g, " "), 150);
}

function detailsMarkup(entry) {
  const conversion = entry.conversion;
  const scan = conversion.scan;
  const readable = conversion.decodedText;
  // A .gmd result is rebuilt from the stored payload when the input already was a .gmd.
  const gmd = conversion.targetKind === "gmd"
    ? conversion.output.text
    : buildGmdText({ levelString: conversion.levelString, ...conversion.fields });
  const startPosition = scan.startPositions[0];
  const contentRows = [
    fact("Objects", `${number(scan.objectCount)} (${number(scan.uniqueObjectTypes)} different kinds)`),
    fact("Portals", number(scan.portalCount)),
    fact("Triggers", number(scan.triggerCount)),
    fact("Game modes", scan.gameModes.join(", ")),
    fact("Start position", startPosition ? `x ${number(startPosition.x)}, y ${number(startPosition.y)}` : "none"),
    fact("Level ID", conversion.fields.levelId ? number(conversion.fields.levelId) : "not stated in the file"),
    fact("Creator", conversion.fields.author || "not stated in the file"),
    fact("Song", conversion.song.type === "unknown" ? "not stated in the file" : songLabel(conversion.song, { detailed: true })),
    fact("Description", conversion.fields.description || ""),
    fact("Compressed level string", conversion.compressed ? "yes" : "no (plain text)")
  ].join("");

  const topObjects = scan.topObjectTypes.length
    ? scan.topObjectTypes.map(item => `<li><code>${esc(item.id)}</code> × ${number(item.count)}</li>`).join("")
    : "<li>No objects found.</li>";

  const stringBlock = conversion.targetKind === "txt"
    ? `<div class="output-row"><pre class="preview">${esc(truncate(conversion.output.text, 400))}</pre>
         <div class="card-actions-inline">
           <button type="button" class="btn ghost small" data-action="copy-output" data-id="${esc(entry.id)}">${icon("copy")}Copy</button>
         </div></div>`
    : "";

  return `
    <div class="details-block">
      <h4>What is inside</h4>
      <ul class="facts">${contentRows}</ul>
      <details>
        <summary>Most common objects</summary>
        <ul class="facts">${topObjects}</ul>
      </details>
    </div>
    <div class="details-block">
      <h4>What you get</h4>
      ${stringBlock}
      <div class="output-row">
        <pre class="preview">${esc(truncate(conversion.levelString, 200))}</pre>
        <div class="output-buttons">
          <button type="button" class="btn ghost small" data-action="copy-level-string" data-id="${esc(entry.id)}">${icon("copy")}Copy level string</button>
          <button type="button" class="btn ghost small" data-action="download-level-string" data-id="${esc(entry.id)}">${icon("download")}Download .txt</button>
        </div>
      </div>
      <div class="output-row">
        <pre class="preview">${esc(truncate(gmd, 200))}</pre>
        <div class="output-buttons">
          <button type="button" class="btn ghost small" data-action="download-gmd" data-id="${esc(entry.id)}">${icon("download")}Download .gmd</button>
        </div>
      </div>
      ${readable ? `<div class="output-row">
        <pre class="preview">${esc(truncate(readable, 200))}</pre>
        <div class="output-buttons">
          <button type="button" class="btn ghost small" data-action="copy-readable" data-id="${esc(entry.id)}">${icon("copy")}Copy readable</button>
          <button type="button" class="btn ghost small" data-action="download-readable" data-id="${esc(entry.id)}">${icon("download")}Download</button>
        </div>
      </div>` : ""}
    </div>
    <div class="details-block">
      <h4>Source</h4>
      <ul class="facts">
        ${fact("Original file", conversion.original && conversion.sourceKind === "gmd" ? "yes, kept in the saved copy" : "yes")}
        ${fact("Saved in this browser", entry.document ? "yes" : "no (storage unavailable)")}
      </ul>
    </div>`;
}

function cardMarkup(entry) {
  if (entry.status === "busy") {
    return `<article class="card is-busy">
      <div class="card-body">
        <div class="card-head">
          <span class="chip plain">${icon("file")}Reading</span>
          <div class="card-heading"><h3>${esc(entry.file?.name || entry.name || "Working…")}</h3>
          <p class="card-meta">Converting…</p></div>
        </div>
      </div>
    </article>`;
  }

  if (entry.status === "error") {
    const error = entry.error || {};
    const extra = error.code === "save-file"
      ? `<a class="btn ghost small" href="./workbench/">Open the advanced workshop</a>`
      : "";
    return `<article class="card is-error">
      <div class="card-body">
        <div class="card-head">
          <span class="chip">${icon("alert")}Needs attention</span>
          <div class="card-heading">
            <h3>${esc(entry.file?.name || entry.name || "That file")}</h3>
            <p class="card-meta">${esc(error.message || "This file could not be converted.")}</p>
          </div>
        </div>
        <p class="notice">${icon("info")}<span>${esc(error.hint || "Try a .gmd or .txt level file.")}</span></p>
      </div>
      <div class="card-actions">
        ${extra}
        <span class="grow"></span>
        <button type="button" class="btn ghost small" data-action="remove" data-id="${esc(entry.id)}" aria-label="Remove this file">${icon("close")}Remove</button>
      </div>
    </article>`;
  }

  const conversion = entry.conversion;
  const target = entry.outputName || conversion.output.filename;
  const detailsOpen = entry.detailsOpen ? " open" : "";
  return `<article class="card">
    <div class="card-body">
      <div class="card-head">
        <span class="chip">${icon("check")}Converted to ${esc(conversion.targetKind === "txt" ? ".txt" : ".gmd")}</span>
        <div class="card-heading">
          <h3 title="${esc(conversion.displayName)}">${esc(conversion.displayName)}</h3>
          <p class="card-meta">${esc(conversionLine(entry))}</p>
        </div>
        <button type="button" class="btn icon ghost" data-action="remove" data-id="${esc(entry.id)}" aria-label="Remove ${esc(conversion.displayName)}">${icon("close")}</button>
      </div>
      <ul class="facts">${cardFacts(conversion)}</ul>
      <pre class="preview" aria-label="First characters of the converted file">${esc(outputPreview(entry))}</pre>
      ${conversion.warnings.length ? `<p class="notice">${icon("alert")}<span>${esc(conversion.warnings.join(" "))}</span></p>` : ""}
      <details class="card-details"${detailsOpen} data-details="${esc(entry.id)}">
        <summary>Details — what is inside, readable text and downloads</summary>
        ${detailsMarkup(entry)}
      </details>
    </div>
    <div class="card-actions">
      <button type="button" class="btn primary" data-action="copy-output" data-id="${esc(entry.id)}">${icon("copy")}${conversion.targetKind === "txt" ? "Copy level string" : "Copy .gmd text"}</button>
      <button type="button" class="btn" data-action="download-output" data-id="${esc(entry.id)}" title="${esc(target)}">${icon("download")}Download ${esc(conversion.targetKind)}</button>
      <button type="button" class="btn ghost" data-action="play" data-id="${esc(entry.id)}" title="Preview this level in the bundled Geometry Dash runtime">${icon("play")}Play preview</button>
      <span class="grow"></span>
    </div>
  </article>`;
}

function render() {
  const showResults = state.entries.length > 0;
  const ready = state.entries.filter(entry => entry.status === "ready").length;
  const busy = state.entries.some(entry => entry.status === "busy");
  dom.results.hidden = !showResults;
  dom.resultsTitle.textContent = ready
    ? `${ready} ${ready === 1 ? "file" : "files"} converted${busy ? "…" : ""}`
    : "Your files";
  dom.downloadAll.hidden = ready < 2;
  dom.resultList.innerHTML = showResults ? state.entries.map(cardMarkup).join("") : "";
  renderHistory();
}

function renderHistory() {
  const items = state.history.slice(0, HISTORY_LIMIT);
  dom.savedCount.textContent = String(items.length);
  dom.savedList.innerHTML = items.length === 0
    ? `<li class="saved-empty">Nothing saved yet. Files you convert appear here so you can download them again later.</li>`
    : items.map(item => `
    <li>
      <span class="name">
        <strong>${esc(item.document.metadata?.name || item.document.source.filename || "Level")}</strong>
        <small>${esc(item.document.source.filename || "no file name")} · ${esc(relativeTime(item.updatedAt || item.createdAt))} · ${number(item.document.content?.parsed?.objectCount || 0)} objects</small>
      </span>
      <button type="button" class="btn ghost small" data-action="saved-download" data-id="${esc(item.id)}">${icon("download")}Download</button>
      <button type="button" class="btn ghost small" data-action="saved-play" data-id="${esc(item.id)}">${icon("play")}Preview</button>
      <button type="button" class="btn icon ghost" data-action="saved-copy" data-id="${esc(item.id)}" aria-label="Copy the level string for ${esc(item.document.metadata?.name || "this level")}">${icon("copy")}</button>
      <button type="button" class="btn icon ghost" data-action="saved-delete" data-id="${esc(item.id)}" aria-label="Delete ${esc(item.document.metadata?.name || "this level")} from this browser">${icon("trash")}</button>
    </li>`).join("");
}

async function refreshHistory() {
  try {
    state.history = await getLibrarySummaries();
    renderHistory();
    updateStorageEstimate();
  } catch (_) {
    dom.saved.hidden = true;
  }
}

async function updateStorageEstimate() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate?.usage) { dom.savedSize.textContent = ""; return; }
    dom.savedSize.textContent = `Using about ${formatBytes(estimate.usage)} of this browser's storage.`;
  } catch (_) {
    dom.savedSize.textContent = "";
  }
}

/* ------------------------------------------------------------------ *
 * Entry actions
 * ------------------------------------------------------------------ */

function downloadOutput(entry) {
  const conversion = entry.conversion;
  const filename = entry.outputName || conversion.output.filename;
  downloadBlob(new Blob([conversion.output.text], { type: conversion.targetKind === "gmd" ? "application/xml" : "text/plain" }), filename);
}

function downloadLevelString(entry) {
  const name = sanitizeFileName(entry.conversion.displayName, "level");
  downloadText(entry.conversion.levelString, `${name}.txt`);
}

function downloadGmd(entry) {
  const name = sanitizeFileName(entry.conversion.displayName, "level");
  const gmd = entry.conversion.targetKind === "gmd"
    ? entry.conversion.output.text
    : buildGmdText({ levelString: entry.conversion.levelString, ...entry.conversion.fields });
  downloadText(gmd, `${name}.gmd`, "application/xml");
}

function downloadReadable(entry) {
  if (!entry.conversion.decodedText) return;
  downloadText(entry.conversion.decodedText, decodedFileName(entry.conversion));
}

async function downloadAll() {
  const ready = state.entries.filter(entry => entry.status === "ready");
  if (!ready.length) return;
  const entries = new Map();
  for (const entry of ready) {
    let name = entry.outputName || entry.conversion.output.filename;
    if (entries.has(name)) name = uniqueFileName(name, new Set(entries.keys()));
    entries.set(name, new Blob([entry.conversion.output.text], { type: "text/plain" }));
  }
  try {
    const archive = await writeZipBlob(entries, { label: "gmd2txt" });
    downloadBlob(archive, `gmd2txt-${new Date().toISOString().slice(0, 10)}.zip`);
  } catch (error) {
    toast(error.message || "The ZIP file could not be created.", "error");
  }
}

async function savedConversion(id) {
  const record = await getLevel(id);
  if (!record) throw new Error("This saved file is no longer available.");
  const document_ = record.document;
  const filename = /\.(gmd|txt)$/i.test(document_.source?.filename || "")
    ? document_.source.filename
    : `${sanitizeFileName(document_.metadata?.name, "level")}.${document_.source?.type === "gmd" ? "gmd" : "txt"}`;
  return {
    conversion: await convertLevelText({
      text: document_.content.raw,
      filename,
      fieldsHint: fieldsFromMetadata(document_.metadata, document_.metadata?.song),
      officialSongs
    }),
    document: document_
  };
}

const RUNTIME_CHANNEL = "gmdplayer-runtime";

function playerIsOpen() {
  return Boolean(dom.playerOverlay) && !dom.playerOverlay.classList.contains("is-parked");
}

function openPlayerOverlay() {
  dom.playerOverlay.classList.remove("is-parked");
  document.body.classList.add("has-player");
  try { dom.playerOverlay.focus({ preventScroll: true }); } catch (_) {}
}

function closePlayerOverlay() {
  dom.playerOverlay.classList.add("is-parked");
  document.body.classList.remove("has-player");
}

/* ------------------------------------------------------------------ *
 * Player preview
 *
 * The bundled Geometry Dash runtime needs a few seconds to boot its assets, so
 * it is started in the background as soon as a level has been converted. By the
 * time someone presses "Play preview", the level can be handed over and starts
 * almost immediately.
 * ------------------------------------------------------------------ */

const warmRuntime = {
  frame: null,
  expiry: 0,
  ready: false,
  pendingEntry: null,   // newest level waiting for the runtime to boot
  loadedKey: null,      // level the parked runtime is holding, ready to resume
  loadingKey: null      // level currently being handed to the parked runtime
};

const playKey = entry => entry?.document?.id || entry?.id || null;

/** The exact document handed to the runtime when a level is previewed. */
function playDocumentFor(entry) {
  return { ...entry.document, content: { ...entry.document.content, raw: entry.conversion.levelString } };
}

function runtimeFrameMessage(event) {
  if (!warmRuntime.frame || event.source !== warmRuntime.frame.contentWindow) return;
  const data = event.data;
  if (data?.channel !== RUNTIME_CHANNEL) return;
  if (data.type === "ready") {
    warmRuntime.ready = true;
    if (warmRuntime.pendingEntry) {
      const entry = warmRuntime.pendingEntry;
      warmRuntime.pendingEntry = null;
      stageWarmLevel(entry);
    }
  } else if (data.type === "level-loaded" && warmRuntime.loadingKey) {
    warmRuntime.loadedKey = warmRuntime.loadingKey;
    warmRuntime.loadingKey = null;
    parkWarmRuntime();
  }
}

/** Silences the hidden runtime so nothing is heard while it waits off-screen. */
function muteWarmRuntime(muted) {
  try {
    const game = warmRuntime.frame?.contentWindow?.gmdRuntimeGame;
    if (game?.sound) game.sound.mute = muted;
  } catch (_) { /* the runtime is mid-boot; it will be muted when it is parked */ }
}

function parkWarmRuntime() {
  const frame = warmRuntime.frame;
  if (!frame) return;
  muteWarmRuntime(true);
  frame.contentWindow.postMessage({ channel: RUNTIME_CHANNEL, type: "park" }, window.location.origin);
}

/**
 * Hands a level to the parked runtime ahead of time, so "Play preview" only has
 * to show the frame. Nothing is audible: the runtime is muted and paused while
 * it sits off-screen, and the level is reset to its first obstacle.
 */
function stageWarmLevel(entry) {
  if (!entry?.conversion || !entry?.document) return;
  const key = playKey(entry);
  if (!key || warmRuntime.loadedKey === key || warmRuntime.loadingKey === key) return;
  if (!warmRuntime.frame) return;
  if (!warmRuntime.ready) {
    warmRuntime.pendingEntry = entry;
    return;
  }
  warmRuntime.loadingKey = key;
  warmRuntime.frame.contentWindow.postMessage(
    { channel: RUNTIME_CHANNEL, type: "load-level", document: playDocumentFor(entry), localAudio: null },
    window.location.origin
  );
}

function warmPlayerRuntime() {
  if (warmRuntime.frame || !dom.playerStage) return warmRuntime.frame;
  const frame = document.createElement("iframe");
  frame.className = "player-frame";
  frame.title = "Geometry Dash preview (starting in the background)";
  frame.setAttribute("aria-hidden", "true");
  frame.allow = "autoplay; fullscreen; gamepad";
  frame.allowFullscreen = true;
  frame.src = `${playerRuntimeUrl()}&hold=1`;
  frame.addEventListener("load", () => setTimeout(() => stageWarmLevel(warmRuntime.pendingEntry), 0));
  // The frame is created here and never moved afterwards: re-parenting an iframe
  // makes the browser throw away the runtime and boot it from scratch again.
  dom.playerStage.replaceChildren(frame);
  warmRuntime.frame = frame;
  warmRuntime.ready = false;
  warmRuntime.loadedKey = null;
  warmRuntime.loadingKey = null;
  // Do not keep a hidden runtime alive forever.
  clearTimeout(warmRuntime.expiry);
  warmRuntime.expiry = setTimeout(releaseWarmRuntime, 10 * 60 * 1000);
  return frame;
}

function releaseWarmRuntime() {
  clearTimeout(warmRuntime.expiry);
  warmRuntime.expiry = 0;
  warmRuntime.frame?.remove();
  warmRuntime.frame = null;
  warmRuntime.ready = false;
  warmRuntime.loadedKey = null;
  warmRuntime.loadingKey = null;
}

/**
 * Boots the runtime in the background (and pre-loads the newest level once it
 * is up) while the person is still reading the conversion result.
 */
function scheduleWarmRuntime(delay = 900, entry = null) {
  if (entry) warmRuntime.pendingEntry = entry;
  if (warmRuntime.frame) {
    if (warmRuntime.ready) stageWarmLevel(warmRuntime.pendingEntry);
    return;
  }
  const start = () => setTimeout(() => {
    warmPlayerRuntime();
    if (warmRuntime.ready) stageWarmLevel(warmRuntime.pendingEntry);
  }, delay);
  if (typeof requestIdleCallback === "function") requestIdleCallback(start, { timeout: 2500 });
  else start();
}

function takeWarmRuntime(entry) {
  const frame = warmRuntime.frame || warmPlayerRuntime();
  if (!frame) return { frame: null, staged: false };
  clearTimeout(warmRuntime.expiry);
  warmRuntime.expiry = 0;
  warmRuntime.frame = null;
  const key = playKey(entry);
  const staged = Boolean(key) && warmRuntime.loadedKey === key;
  warmRuntime.loadedKey = null;
  warmRuntime.loadingKey = null;
  warmRuntime.pendingEntry = null;
  return { frame, staged };
}

async function playEntry(entry) {
  if (!entry?.document || !entry?.conversion) {
    toast("This level is still being saved — try the preview again in a moment.", "error");
    return;
  }
  const conversion = entry.conversion;
  dom.playerTitle.textContent = conversion.displayName;
  dom.playerStatus.textContent = "";
  dom.playerLoading.hidden = false;
  openPlayerOverlay();

  // Loading hint for slow devices: the runtime pulls its own assets on first run.
  if (dom.playerLoadingHint) dom.playerLoadingHint.textContent = "This can take a few seconds the first time.";
  const slowTimer = setTimeout(() => {
    if (dom.playerLoadingHint && !dom.playerLoading.hidden) {
      dom.playerLoadingHint.textContent = "Still starting — the runtime is loading its own assets. Close this window to skip the preview.";
    }
  }, 9000);

  const warm = takeWarmRuntime(entry);
  // A frame that is already running needs no loading screen of ours.
  if (warm.frame) {
    dom.playerLoading.hidden = true;
    dom.playerStatus.textContent = warm.staged ? "Starting your level…" : "Preparing your level…";
  }
  const adapter = new PlayerAdapter({
    onExit: () => closePlayer(),
    onError: message => { dom.playerStatus.textContent = message; },
    onWarning: message => toast(message, "error"),
    onProgress: progress => {
      if (!progress) return;
      const percent = Number(progress.normal || 0);
      dom.playerStatus.textContent = percent > 0 ? `Best on this device: ${Math.round(percent)}%` : "";
    }
  });
  state.player = adapter;
  state.playingKey = playKey(entry);
  try {
    await adapter.load(playDocumentFor(entry), dom.playerStage, {
      frame: warm.frame,
      staged: warm.staged,
      keepAlive: true,
      localAudio: null,
      allowUnconfirmedStart: true,
      // The runtime paints its own loading screen: show it instead of our spinner.
      onMounted: () => setTimeout(() => {
        if (!playerIsOpen()) return;
        dom.playerLoading.hidden = true;
        dom.playerStatus.textContent = "Preparing your level…";
      }, 450)
    });
    dom.playerLoading.hidden = true;
    dom.playerStatus.textContent = warm.staged
      ? "Playing — Space or click to jump, Esc or Close to leave."
      : "Loaded — press Space or click to play, Esc or Close to leave.";
  } catch (error) {
    dom.playerLoading.hidden = true;
    dom.playerStatus.textContent = "This preview could not start.";
    toast(error.message || "The level preview could not start.", "error");
  } finally {
    clearTimeout(slowTimer);
  }
}

function closePlayer() {
  const adapter = state.player;
  state.player = null;
  const playingKey = state.playingKey;
  state.playingKey = null;
  try {
    // "park" pauses the runtime, winds the level back to the start and mutes it,
    // so replaying the same level is instant even hours later.
    adapter?.park();
    adapter?.stop(false);
    // The runtime keeps running in place (it is parked off-screen by CSS, never
    // moved) and still holds this level, so replaying it is instant.
    const frame = dom.playerStage?.querySelector("iframe");
    if (frame) {
      warmRuntime.frame = frame;
      warmRuntime.loadedKey = playingKey;
      warmRuntime.ready = true;
      clearTimeout(warmRuntime.expiry);
      warmRuntime.expiry = setTimeout(releaseWarmRuntime, 10 * 60 * 1000);
    }
  } catch (_) { /* the runtime was already gone */ }
  closePlayerOverlay();
  dom.playerLoading.hidden = false;
  dom.playerStatus.textContent = "";
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

function bindEvents() {
  const choose = () => { dom.fileInput.value = ""; dom.fileInput.click(); };
  dom.fileInput.addEventListener("change", () => addFiles(dom.fileInput.files));

  // Clicking anywhere in the drop area opens the picker; the buttons stay the
  // accessible controls, so nothing interactive is nested inside anything else.
  dom.dropzone.addEventListener("click", event => {
    if (event.target.closest("button, select, label, a")) return;
    choose();
  });
  dom.dropzone.querySelector("[data-role=choose]").addEventListener("click", choose);

  let dragDepth = 0;
  const setOver = value => dom.dropzone.classList.toggle("is-over", value);
  for (const type of ["dragenter", "dragover"]) {
    window.addEventListener(type, event => {
      if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
      event.preventDefault();
      if (type === "dragenter") dragDepth++;
      setOver(true);
    });
  }
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setOver(false); });
  window.addEventListener("dragover", event => event.preventDefault());
  window.addEventListener("drop", event => {
    if (!event.dataTransfer?.files?.length) return;
    if (document.querySelector("dialog[open]") || playerIsOpen()) return;
    event.preventDefault();
    dragDepth = 0;
    setOver(false);
    addFiles(event.dataTransfer.files);
  });

  // Pasting level text anywhere on the page converts it straight away.
  window.addEventListener("paste", event => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const text = event.clipboardData?.getData("text");
    if (!text || text.length < 24) return;
    const entry = { id: String(state.nextId++), status: "busy", file: null, name: "Pasted level text" };
    state.entries.unshift(entry);
    hideSteps();
    render();
    processEntry(entry, async () => text, { filename: "pasted-level.txt", mimeType: "text/plain" });
    toast("Converted the level text from your clipboard.");
  });

  dom.resultList.addEventListener("click", async event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const entry = findEntry(button.dataset.id);
    if (!entry) return;
    const conversion = entry.conversion;
    switch (button.dataset.action) {
      case "remove":
        state.entries = state.entries.filter(item => item !== entry);
        render();
        break;
      case "copy-output":
        await copyText(conversion.targetKind === "txt" ? conversion.levelString : conversion.output.text);
        break;
      case "copy-level-string":
        await copyText(conversion.levelString);
        break;
      case "copy-readable":
        await copyText(conversion.decodedText || conversion.levelString);
        break;
      case "download-output":
        downloadOutput(entry);
        break;
      case "download-level-string":
        downloadLevelString(entry);
        break;
      case "download-gmd":
        downloadGmd(entry);
        break;
      case "download-readable":
        downloadReadable(entry);
        break;
      case "play":
        playEntry(entry);
        break;
      default:
        break;
    }
  });

  // Hovering or focusing a play button is a strong hint a preview is next.
  const warmOnIntent = event => {
    if (event.target.closest("[data-action=play], [data-action=saved-play]")) scheduleWarmRuntime(0);
  };
  dom.resultList.addEventListener("mouseover", warmOnIntent);
  dom.resultList.addEventListener("focusin", warmOnIntent);
  dom.savedList.addEventListener("mouseover", warmOnIntent);
  dom.savedList.addEventListener("focusin", warmOnIntent);

  dom.resultList.addEventListener("toggle", event => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.dataset.details) return;
    const entry = findEntry(details.dataset.details);
    if (entry) entry.detailsOpen = details.open;
  }, true);

  dom.downloadAll.addEventListener("click", downloadAll);
  dom.clearResults.addEventListener("click", () => {
    state.entries = [];
    state.usedNames = new Set();
    dom.steps.hidden = false;
    render();
  });

  dom.pasteOpen.addEventListener("click", () => {
    dom.pasteText.value = "";
    dom.pasteStatus.textContent = "";
    openDialog(dom.pasteDialog);
    setTimeout(() => dom.pasteText.focus(), 30);
  });
  dom.pasteDialog.addEventListener("click", event => {
    if (event.target.closest("[data-close]")) closeDialog(dom.pasteDialog);
  });
  dom.pasteForm.addEventListener("submit", event => {
    event.preventDefault();
    const text = dom.pasteText.value.trim();
    if (!text) { dom.pasteStatus.textContent = "Paste a level string first."; return; }
    closeDialog(dom.pasteDialog);
    const entry = { id: String(state.nextId++), status: "busy", file: null, name: "Pasted level text" };
    state.entries.unshift(entry);
    hideSteps();
    render();
    processEntry(entry, async () => text, { filename: "pasted-level.txt", mimeType: "text/plain" });
  });

  dom.sampleSelect.addEventListener("change", () => {
    const index = Number(dom.sampleSelect.value);
    dom.sampleSelect.value = "";
    if (Number.isInteger(index) && index >= 0) loadSample(index);
  });

  dom.playerClose.addEventListener("click", closePlayer);
  window.addEventListener("message", runtimeFrameMessage);
  dom.playerOverlay.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closePlayer();
  });

  dom.savedList.addEventListener("click", async event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const id = button.dataset.id;
    try {
      if (button.dataset.action === "saved-delete") {
        await deleteLevel(id);
        await refreshHistory();
        toast("Deleted from this browser. Your original files are untouched.");
        return;
      }
      const { conversion, document: savedDocument } = await savedConversion(id);
      if (!conversion.ok) { toast(conversion.message, "error"); return; }
      if (button.dataset.action === "saved-copy") await copyText(conversion.levelString);
      else if (button.dataset.action === "saved-play") await playEntry({ document: savedDocument, conversion });
      else downloadBlob(new Blob([conversion.output.text], { type: "text/plain" }), conversion.output.filename);
    } catch (error) {
      toast(error.message || "This saved file could not be read.", "error");
    }
  });

  dom.clearSaved.addEventListener("click", async () => {
    if (!state.history.length) return;
    const count = state.history.length;
    for (const item of state.history) await deleteLevel(item.id).catch(() => {});
    await refreshHistory();
    toast(`Deleted ${count} saved ${count === 1 ? "file" : "files"} from this browser.`);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && dom.pasteDialog.open) closeDialog(dom.pasteDialog);
  });
}

/* ------------------------------------------------------------------ *
 * Start-up
 * ------------------------------------------------------------------ */

function fillSamples() {
  if (!officialSongs?.length || !dom.sampleSelect) return;
  const options = officialSongs
    .map((song, index) => ({ index, name: song?.[1] }))
    .filter(item => item.name)
    .map(item => `<option value="${item.index}">${esc(item.name)}</option>`)
    .join("");
  dom.sampleSelect.insertAdjacentHTML("beforeend", options);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const script = new URL("../../sw.js", location.href);
    const scope = new URL("../../", location.href);
    await navigator.serviceWorker.register(script.href, { scope: scope.pathname });
  } catch (_) {
    // Offline support is a bonus; the converter works without it.
  }
}

async function start() {
  dom.version.textContent = `gmd2txt ${meta.version || ""}`.trim();
  dom.root.dataset.ready = "yes";
  fillSamples();
  bindEvents();
  render();
  refreshHistory();
  registerServiceWorker();
  await convertHandoffFiles();
}

start();
