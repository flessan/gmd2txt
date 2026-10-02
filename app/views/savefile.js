/**
 * Save file reader — the room that opens CCGameManager.dat / CCLocalLevels.dat.
 *
 * Everything is read-only: the file is decoded in this tab (a real XML plist
 * behind Geometry Dash's obfuscation), summarised in plain language, and never
 * written back. Sensitive fields (player ids) are masked before they are shown.
 */
import { decodeSaveFile, maskSensitiveFields } from "../../core/saves/save-decoder.js";

const root = document.getElementById("workspace-root");
const drop = document.getElementById("save-drop");
const input = document.getElementById("save-input");
const choose = document.getElementById("save-choose");
const report = document.getElementById("save-report");

const SAVE_TITLES = {
  "game-manager": "CCGameManager.dat — player save",
  "local-levels": "CCLocalLevels.dat — local levels save"
};

const number = value => (value === null || value === undefined || value === "" ? "—" : Number(value).toLocaleString());
const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

function fact(label, value) {
  return `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

function showError(message, detail = "") {
  report.hidden = false;
  report.innerHTML = `
    <div class="save-error">
      <h2>That file could not be read</h2>
      <p>${esc(message)}</p>
      ${detail ? `<p class="muted small">${esc(detail)}</p>` : ""}
      <p class="muted small">Save files are XML plists inside. If this is a different <code>.dat</code>, it may belong to another game.</p>
    </div>`;
}

/** Renders one decoded save file as a plain-language, read-only summary. */
function renderReport(file, decoded) {
  const normalized = decoded.normalized || {};
  const stats = Object.entries(normalized.stats || {});
  const levels = (normalized.levels || []).filter(level => level.name);
  const groups = normalized.collections || [];
  const safe = maskSensitiveFields({ ...normalized.player, ...(normalized.misc || {}) });
  const version = decoded.gameVersion || normalized.binaryVersion;

  report.hidden = false;
  report.innerHTML = `
    <div class="save-file-head">
      <div>
        <h2>${esc(file.name)}</h2>
        <p class="muted small">
          ${esc(SAVE_TITLES[decoded.saveType] || "Geometry Dash save file")}
          · ${number(decoded.diagnostics?.inputBytes)} bytes read
          · ${esc(decoded.encoding || "text")} encoding
          ${version ? `· game version <code>${esc(version)}</code>` : ""}
        </p>
      </div>
      <span class="chip"><svg class="icon"><use href="#i-check"></use></svg>Read-only</span>
    </div>

    <div class="save-columns">
      <section class="save-card">
        <h3>Player</h3>
        <dl class="facts">
          ${normalized.player?.name ? fact("Name", esc(normalized.player.name)) : ""}
          ${fact("Level records", number(levels.length))}
          ${fact("Saved value groups", number(groups.length))}
          ${fact("Top-level keys", number(decoded.diagnostics?.topLevelKeys))}
        </dl>
      </section>

      <section class="save-card">
        <h3>Stats</h3>
        ${stats.length
          ? `<dl class="facts">${stats.map(([label, value]) => fact(label, number(value))).join("")}</dl>`
          : `<p class="muted small">This save has no stat block — that is normal for CCLocalLevels.dat.</p>`}
      </section>
    </div>

    <section class="save-card">
      <h3>Level progress</h3>
      ${levels.length
        ? `<ul class="save-levels">${levels.slice(0, 60).map(level => {
            const attempts = level.fields?.k18 ?? level.fields?.k19;
            const normal = level.fields?.k71;
            return `<li>
              <span class="name"><strong>${esc(level.name)}</strong><small>${attempts !== undefined ? `${number(attempts)} attempts` : "no attempts recorded"}</small></span>
              ${normal !== undefined ? `<span class="progress">${esc(String(normal))}%</span>` : ""}
            </li>`;
          }).join("")}</ul>
          ${levels.length > 60 ? `<p class="muted small">Showing the first 60 of ${number(levels.length)} levels.</p>` : ""}`
        : `<p class="muted small">No official level records in this file.</p>`}
    </section>

    <details class="save-extra">
      <summary>Hidden identifiers and raw fields</summary>
      <p class="muted small">Player ids and other private keys are masked before they are shown — the reader never displays them in full.</p>
      <pre>${esc(JSON.stringify(safe, null, 2).slice(0, 4000))}${JSON.stringify(safe).length > 4000 ? "\n…" : ""}</pre>
    </details>

    <p class="save-note">
      <svg class="icon"><use href="#i-lock"></use></svg>
      Nothing was written or uploaded. To change a save you would edit it in the game itself — this room only reads.
    </p>`;
}

async function openSaveFile(file) {
  if (!file) return;
  report.hidden = false;
  report.innerHTML = `<p class="muted">Reading ${esc(file.name)}…</p>`;
  root.dataset.busy = "yes";
  try {
    const decoded = await decodeSaveFile(file);
    renderReport(file, decoded);
  } catch (error) {
    showError(error?.message || "This file is not a Geometry Dash save.", error?.hint || "");
  } finally {
    delete root.dataset.busy;
  }
}

function handleFiles(files) {
  const file = [...(files || [])].find(item => /\.dat$/i.test(item.name) || item.type === "application/octet-stream") || files?.[0];
  if (!file) return false;
  openSaveFile(file);
  return true;
}

choose?.addEventListener("click", () => { input.value = ""; input.click(); });
input?.addEventListener("change", () => handleFiles(input.files));
drop?.addEventListener("click", event => {
  if (event.target.closest("button")) return;
  input.value = "";
  input.click();
});
for (const type of ["dragenter", "dragover"]) {
  drop?.addEventListener(type, event => { event.preventDefault(); drop.classList.add("is-over"); });
}
drop?.addEventListener("dragleave", () => drop.classList.remove("is-over"));
drop?.addEventListener("drop", event => {
  event.preventDefault();
  drop.classList.remove("is-over");
  handleFiles(event.dataTransfer?.files);
});

export const saveReaderApi = { handleFiles, open: openSaveFile };
window.__gmdSaveReader = saveReaderApi;
