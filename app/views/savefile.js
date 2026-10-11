/**
 * Save file reader — the room that opens CCGameManager.dat / CCLocalLevels.dat.
 *
 * Everything is read-only: the file is decoded in this tab (a real XML plist
 * behind Geometry Dash's obfuscation), summarised in plain language, and never
 * written back. Sensitive fields (player ids) are masked before they are shown.
 */
import { decodeSaveFile, maskSensitiveFields, serializeSaveXml } from "../../core/saves/save-decoder.js";
import { importSave } from "../../core/import/handlers/save-importer.js";
import { createLevel } from "../../core/storage/database.js";

const root = document.getElementById("workspace-root");
const drop = document.getElementById("save-drop");
const input = document.getElementById("save-input");
const choose = document.getElementById("save-choose");
const report = document.getElementById("save-report");
let activeSaveFile = null;
let activeDecoded = null;

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
  const safeTree = maskSensitiveFields(decoded.tree);
  const statValues = normalized.statValues || [];
  const questsAndAchievements = maskSensitiveFields({ quests: normalized.quests, achievements: normalized.achievements });
  const collections = maskSensitiveFields(normalized.collections || []);
  const localGroups = Object.entries(decoded.tree || {}).filter(([key]) => /^LLM_\d+$/i.test(key));
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

    <div class="save-actions" aria-label="Export save data">
      ${decoded.saveType === "local-levels" ? '<button type="button" class="btn primary small" data-save-action="import-local-levels">Import embedded levels</button>' : ""}
      <button type="button" class="btn ghost small" data-save-action="download-original">Download original .dat</button>
      <button type="button" class="btn ghost small" data-save-action="download-xml">Download masked XML</button>
      <button type="button" class="btn ghost small" data-save-action="download-json">Download masked JSON</button>
    </div>

    <details class="save-extra">
      <summary>Stats breakdown · ${number(statValues.length)} values</summary>
      ${statValues.length
        ? `<pre>${esc(JSON.stringify(maskSensitiveFields(statValues), null, 2).slice(0, 10000))}${JSON.stringify(statValues).length > 10000 ? "\n…" : ""}</pre>`
        : '<p class="muted small">No GS_value stat entries were found in this save.</p>'}
    </details>

    <details class="save-extra">
      <summary>Quests and achievements</summary>
      <pre>${esc(JSON.stringify(questsAndAchievements, null, 2).slice(0, 8000))}${JSON.stringify(questsAndAchievements).length > 8000 ? "\n…" : ""}</pre>
    </details>

    <details class="save-extra">
      <summary>Game-state collections · ${number(collections.length)} groups</summary>
      <pre>${esc(JSON.stringify(collections, null, 2).slice(0, 10000))}${JSON.stringify(collections).length > 10000 ? "\n…" : ""}</pre>
    </details>

    ${localGroups.length ? `<details class="save-extra">
      <summary>Local-level groups · ${number(localGroups.length)} groups detected</summary>
      <p class="muted small">These fields are shown as masked source data. The current reader does not yet convert each LLM record into a separate importable level.</p>
      <pre>${esc(JSON.stringify(maskSensitiveFields(Object.fromEntries(localGroups)), null, 2).slice(0, 10000))}${JSON.stringify(localGroups).length > 10000 ? "\n…" : ""}</pre>
    </details>` : ""}

    <details class="save-extra">
      <summary>Other fields and full plist tree (masked)</summary>
      <p class="muted small">Sensitive keys such as player IDs, UDIDs, tokens and account details are masked in the displayed tree and exported XML/JSON.</p>
      <pre>${esc(JSON.stringify(safeTree, null, 2).slice(0, 10000))}${JSON.stringify(safeTree).length > 10000 ? "\n…" : ""}</pre>
    </details>

    <p class="save-note">
      <svg class="icon"><use href="#i-lock"></use></svg>
      The source .dat is never modified or uploaded. If you choose Import embedded levels, decoded copies are added to this browser’s Library; existing levels are skipped rather than overwritten.
    </p>`;
}


function toastMessage(message) {
  const host = document.getElementById("toasts");
  if (!host) {
    const note = document.createElement("p");
    note.className = "muted small";
    note.textContent = message;
    report.prepend(note);
    return;
  }
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), 4200);
}
function downloadSaveExport(blobOrText, filename, mime = "application/octet-stream") {
  const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type: mime });
  if (!globalThis.URL?.createObjectURL) return false;
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; link.style.display = "none";
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return true;
}
report.addEventListener("click", async event => {
  const button = event.target.closest("[data-save-action]");
  if (!button || !activeSaveFile || !activeDecoded) return;
  const action = button.dataset.saveAction;
  try {
    if (action === "download-original") {
      downloadSaveExport(activeSaveFile, activeSaveFile.name || "GeometryDash.dat");
    } else if (action === "download-xml") {
      const xml = serializeSaveXml(maskSensitiveFields(activeDecoded.tree));
      downloadSaveExport(xml, (activeSaveFile.name || "GeometryDash.dat").replace(/\.dat$/i, "") + "-masked.xml", "application/xml;charset=utf-8");
    } else if (action === "download-json") {
      const payload = {
        sourceFile: activeSaveFile.name || "GeometryDash.dat",
        saveType: activeDecoded.saveType,
        gameVersion: activeDecoded.gameVersion,
        encoding: activeDecoded.encoding,
        diagnostics: activeDecoded.diagnostics,
        normalized: maskSensitiveFields(activeDecoded.normalized),
        tree: maskSensitiveFields(activeDecoded.tree)
      };
      downloadSaveExport(JSON.stringify(payload, null, 2), (activeSaveFile.name || "GeometryDash.dat").replace(/\.dat$/i, "") + "-masked.json", "application/json;charset=utf-8");
    } else if (action === "import-local-levels") {
      button.disabled = true;
      button.textContent = "Extracting…";
      const snapshot = await importSave([activeSaveFile]);
      const levels = snapshot.normalized?.localLevels || [];
      let added = 0, duplicates = 0;
      for (const item of levels) {
        const result = await createLevel(item.document, { duplicateMode: "skip" });
        if (result?.duplicate) duplicates++;
        else added++;
      }
      const errors = snapshot.normalized?.localLevelErrors?.length || 0;
      toastMessage(added + " local level(s) added" + (duplicates ? " · " + duplicates + " duplicate(s)" : "") + (errors ? " · " + errors + " record(s) skipped" : "") + ".");
      button.disabled = false;
      button.textContent = "Import embedded levels";
    }
  } catch (error) {
    const extractButton = report.querySelector('[data-save-action="import-local-levels"]');
    if (extractButton) { extractButton.disabled = false; extractButton.textContent = "Import embedded levels"; }
    toastMessage(error?.message || "This save export could not be prepared.");
  }
});
async function openSaveFile(file) {
  if (!file) return;
  report.hidden = false;
  report.innerHTML = `<p class="muted">Reading ${esc(file.name)}…</p>`;
  root.dataset.busy = "yes";
  try {
    const decoded = await decodeSaveFile(file);
    activeSaveFile = file;
    activeDecoded = decoded;
    renderReport(file, decoded);
  } catch (error) {
    activeSaveFile = null;
    activeDecoded = null;
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
