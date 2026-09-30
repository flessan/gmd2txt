import { ImportSession } from "../../core/import/import-session.js";
import { importLevel } from "../../core/import/handlers/level-importer.js";
import { importSave } from "../../core/import/handlers/save-importer.js";
import { createLevel, deleteLevel, getLevel, getLibrarySummaries, updateLevel, updateLevelApplicationMetadata, openLibraryDatabase, DATABASE_SCHEMA_VERSION } from "../../core/storage/database.js";
import { createAudioAssetRecord, deleteAudioAsset, getAudioAsset, getAudioAssets, saveAudioAssetMetadata } from "../../core/storage/audio-database.js";
import { SongResolver } from "../../core/audio/song-resolver.js";
import { inspectLevelDocument, filterFrequency } from "../../core/inspector/level-inspector.js";
import { searchAudioAssets, searchLevelRecords } from "../../core/search/local-search.js";
import { createSaveSnapshot, deleteSaveSnapshot, getSaveSnapshot, getSaveSnapshots } from "../../core/storage/save-database.js";
import { maskSensitiveFields, serializeSaveXml } from "../../core/saves/save-decoder.js";
import { PlayerAdapter } from "../../core/runtime/player-adapter.js";
import { importTextureFiles, getSpriteEntries, getPngDimensions, applySpriteModification, resetSprite, resetAllSprites, undoTexture, redoTexture } from "../../core/textures/texture-pack.js";
import { decodePng, extractSprite, createSpriteReplacement, canvasToPngBytes } from "../../core/textures/sprites.js";
import { exportTexturePack, exportTextureSheet, exportSplitSprites, exportRepackedTexturePack } from "../../core/textures/texture-export.js";
import { mergeTextureSheets } from "../../core/textures/texture-merge.js";
import { saveTextureWorkspace, getTextureWorkspace, getTextureWorkspaceSummaries, deleteTextureWorkspace } from "../../core/storage/texture-database.js";
import { createProjectRecord, getProject, getProjects, updateProjectRecord, addProjectResource, removeProjectResource, deleteProjectRecord, duplicateProjectRecord, getActiveProjectId, setActiveProjectId } from "../../core/storage/project-database.js";
import { exportProjectBackup, inspectProjectBackup, restoreProjectBackup, PROJECT_BACKUP_EXTENSION, PROJECT_BACKUP_VERSION } from "../../core/projects/project-backup.js";
import { PROJECT_RESOURCE_TYPES } from "../../core/projects/project-model.js";
import { SelectionModel } from "../../core/workbench/selection-model.js";
import { resolveKeyboardShortcut } from "../../core/workbench/keyboard-shortcuts.js";
import { applyProjectMembership } from "../../core/workbench/bulk-operations.js";
import { filterResources, sortResources, createSavedSearch } from "../../core/workbench/search.js";
import { hashFileContent } from "../../core/workbench/content-hash.js";
import { normalizeTags, mergeTags } from "../../core/documents/tags.js";
import { getWorkbenchValue, setWorkbenchValue, saveViewPreferences, listSavedSearches, saveSavedSearch, deleteSavedSearch, recordActivity, getViewPreferences } from "../../core/storage/workbench-database.js";
import { writeZipBlob } from "../../core/textures/zip.js";
import { normalizeViewPreference, resolveActiveProject, normalizeRecentActivity, normalizeSavedSearches } from "../../core/startup/release-state.js";

const app = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");
const spritePreviewCache = new Map();
const atlasPreviewCache = new Map();
const songResolver = new SongResolver({ getAudioAsset });
let membershipIndexCache=null;
const state = { route: parseRoute(), booting:true, storageError:null, resourceWarnings:[], serviceWorkerStatus:"checking", installPrompt:null, installDismissed:false, onboardingDismissed:false, levels:[], saves: [], textures: [], audioAssets: [], projects: [], activeProjectId: null, activeProject: null, projectMemberQuery: "", restorePreview: null, restoreFile: null, restoreResourceKeys: new Set(), projectProgress: null, projectAbortController: null, search: "", globalQuery: "", libraryView: "grid", libraryFilter: "all", libraryLimit:100, audioLimit:100, assetLimit:100, projectLimit:100, textureLimit:100, saveLimit:100, saveLevelLimit:200, importing: false, importStatus: "", imported: [], player: null, returnTo: "#/library", saveTab: "overview", saveQuery: "", selectedSaveLevels: new Set(), showAllSensitive: false, rawView: "json", rawFile: "gameManager", activeSaveId: null, activeTexture: null, activeSheetId: null, textureQuery: "", selectedSprite: null, replacementMode: "exact", spriteLimit:200, audioQuery: "", audioFilter: "all", audioSort: "name", audioSelectedId: null, audioEditingId: null, assetQuery: "", assetFilter: "all", assetSort: "date", projectQuery: "", inspectorTab: "summary", inspectorQuery: "", inspectorSort: "count", inspectorLimit: 80, audioPreviewUrl: null, audioPreviewId: null, selections: Object.create(null), selectionContexts: Object.create(null), palette: null, paletteQuery: "", savedSearches: [], currentSavedSearch: Object.create(null), searchFilters: { library: { tags: "", projectId: "", favorite: false, fromDate:"", toDate:"", tagMode:"all" }, audio: { tags: "", projectId: "", favorite: false, fromDate:"", toDate:"", tagMode:"all" }, assets: { tags: "", projectId: "", favorite: false, fromDate:"", toDate:"", tagMode:"all" }, textures: { tags: "", projectId: "", favorite: false, fromDate:"", toDate:"", tagMode:"all" }, projects: { tags: "", favorite: false, fromDate:"", toDate:"", tagMode:"all" } }, viewPreferences: {}, batchSummary: null, batchResults: [], cancelImport: false, ignoredImportFiles: [], undoStack:[],redoStack:[] };

function parseRoute() {
  const raw = (location.hash.replace(/^#/, "") || "/home");
  const path = (raw.split("?")[0] || "/home").replace(/\/$/, "") || "/home";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "about") return { name: "about" };
  if (parts[0] === "projects" && parts[1] === "restore") return { name: "project-restore" };
  if (parts[0] === "projects" && parts[1]) return { name: "project-detail", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "projects") return { name: "projects" };
  if (parts[0] === "play" && parts[1]) return { name: "play", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "library" && parts[1] === "inspect" && parts[2]) return { name: "inspect", id: decodeURIComponent(parts[2]) };
  if (parts[0] === "library" && parts[1]) return { name: "details", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "library") return { name: "library" };
  if (parts[0] === "tools" && parts[1] === "save") return { name: "save", id: parts[2] ? decodeURIComponent(parts[2]) : null };
  if (parts[0] === "tools" && parts[1] === "textures") return { name: "textures", id: parts[2] ? decodeURIComponent(parts[2]) : null };
  if (parts[0] === "tools" && parts[1] === "audio") return { name: "audio" };
  if (parts[0] === "tools" && parts[1] === "assets") return { name: "assets" };
  if (parts[0] === "tools") return { name: "tools" };
  return { name: "home" };
}

function syncLibrarySearchUrl() { const params=new URLSearchParams(),filter=state.searchFilters.library; if(state.search)params.set("query",state.search); if(filter.tags)params.set("tag",filter.tags); if(filter.projectId)params.set("project",filter.projectId); if(filter.favorite)params.set("favorite","1");if(filter.fromDate)params.set("from",filter.fromDate);if(filter.toDate)params.set("to",filter.toDate); const suffix=params.toString(); history.replaceState(history.state,"",`${location.pathname}${location.search}#${location.hash.split("?")[0].replace(/^#/,"")}${suffix?`?${suffix}`:""}`); }
function restoreUrlSearch() { const [path,query]=location.hash.replace(/^#/,"").split("?"); if(path!=="/library"||!query)return; const params=new URLSearchParams(query),filter=state.searchFilters.library; state.search=params.get("query")||""; filter.tags=params.get("tag")||""; filter.projectId=params.get("project")||""; filter.favorite=params.get("favorite")==="1";filter.fromDate=params.get("from")||"";filter.toDate=params.get("to")||""; }
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function route(path) { location.hash = path; }
function supportsDirectorySelection(){const input=document.querySelector("#folder-input");return Boolean(input&&("webkitdirectory" in input||"directory" in input));}
function openImportPicker(kind="all"){state.importKind=kind;const input=document.querySelector("#file-input");if(!input)return;input.accept=kind==="level"?".gmd,.txt,text/plain":kind==="texture"?".png,.plist,.zip,image/png,application/zip":kind==="save"?".dat,application/octet-stream":".gmd,.txt,.dat,.png,.plist,.zip,.gmdproject,.mp3,.ogg,.opus,.wav,.m4a,.mp4,.aac,.flac,.webm,audio/*";input.value="";input.click();}
function setOperationStatus(message="",current=0,total=0){const region=document.querySelector("#operation-region");if(!region)return;if(!message){region.replaceChildren();return;}region.innerHTML=`<div class="operation-status" role="status"><strong>${esc(message)}</strong>${total?`<span>${current} / ${total}</span><progress max="${total}" value="${current}"></progress>`:""}</div>`;}
function showToast(message, type = "") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastRegion.append(toast);
  setTimeout(() => toast.remove(), 4300);
}
function renderBootScreen(){app.innerHTML=`<main class="boot-screen" role="status" aria-live="polite"><span class="brand-mark">G</span><h1>GMDPlayer</h1><p>Opening your local workspace…</p></main>`;}
function startupMessage(error){if(!globalThis.indexedDB)return "This browser does not provide IndexedDB, which GMDPlayer uses for local resources.";if(error?.name==="VersionError")return "This database was created by a newer GMDPlayer build. Update the application before opening this workspace.";if(/blocked/i.test(error?.message||""))return "Another tab is keeping the local database open. Close other GMDPlayer tabs, then retry.";if(/quota/i.test(error?.name||"")||/quota/i.test(error?.message||""))return "The browser is low on storage space. Free device storage, then retry.";return "GMDPlayer could not open its local database. Your existing files have not been intentionally deleted.";}
function renderStorageRecovery(error){app.innerHTML=`<main class="recovery-screen"><span class="brand-mark">G</span><div class="eyebrow">Local workspace unavailable</div><h1>GMDPlayer could not open its local database.</h1><p>Your existing files have not been intentionally deleted.</p><p class="recovery-reason">${esc(startupMessage(error))}</p><div class="recovery-actions"><button class="btn primary" data-action="retry-startup">Retry</button><a class="btn" href="#/about">Diagnostics</a></div><details><summary>Diagnostic detail</summary><code>${esc(`${error?.name||"Error"}: ${error?.message||"Unknown database error"}`.slice(0,400))}</code></details></main>`;}
function renderRouteFailure(error){const labels={inspect:"Inspector",details:"Level details",textures:"Texture workspace",save:"Save Explorer","project-detail":"Project"};app.innerHTML=`<div class="shell">${header(state.route.name)}<main class="main-content route-recovery"><div class="eyebrow">${esc(labels[state.route.name]||"Workspace")} could not be opened</div><h1>This local item could not be displayed.</h1><p>Your stored source has not been changed. You can retry or return to the related workspace.</p><div class="recovery-actions"><button class="btn primary" data-action="retry-route">Retry</button><a class="btn" href="${state.route.name.startsWith("project")?"#/projects":state.route.name==="textures"?"#/tools/textures":state.route.name==="save"?"#/tools/save":"#/library"}">Back to workspace</a></div><details><summary>Diagnostic detail</summary><code>${esc(`${error?.name||"Error"}: ${error?.message||"Could not render this item"}`.slice(0,400))}</code></details></main></div>`;}
function isStandalone(){return Boolean(globalThis.matchMedia?.("(display-mode: standalone)")?.matches||navigator.standalone);}
function renderAbout(){const meta=window.GMDPLAYER_META||{};app.innerHTML=`<div class="shell">${header("about")}<main class="main-content about-page"><a class="back-link" href="#/home">← Home</a><div class="page-heading"><div><div class="eyebrow">Local application</div><h1>About & diagnostics</h1><p>Release and local-storage information for troubleshooting. Diagnostics are not uploaded.</p></div><button class="btn primary" data-action="copy-diagnostics">Copy diagnostics</button></div><section class="about-grid"><div class="workbench-section"><h2>Application</h2><dl><div><dt>Version</dt><dd>${esc(meta.version||"Unknown")}</dd></div><div><dt>Database schema</dt><dd>${DATABASE_SCHEMA_VERSION}</dd></div><div><dt>Project backup format</dt><dd>Version ${PROJECT_BACKUP_VERSION}</dd></div><div><dt>Service worker</dt><dd id="diagnostic-sw-status">${esc(state.serviceWorkerStatus)}</dd></div><div><dt>Connection</dt><dd>${navigator.onLine?"Online":"Offline · local resources remain available"}</dd></div><div><dt>Display mode</dt><dd>${isStandalone()?"Installed app":"Browser tab"}</dd></div></dl></div><div class="workbench-section"><h2>Local resources</h2><dl><div><dt>Levels</dt><dd>${state.levels.length}</dd></div><div><dt>Songs</dt><dd>${state.audioAssets.length}</dd></div><div><dt>Texture workspaces</dt><dd>${state.textures.length}</dd></div><div><dt>Save snapshots</dt><dd>${state.saves.length}</dd></div><div><dt>Projects</dt><dd>${state.projects.length}</dd></div><div><dt>Active project</dt><dd>${esc(state.activeProject?.name||"None")}</dd></div><div><dt>Browser storage estimate</dt><dd>${state.storageEstimate?`${fmtBytes(state.storageEstimate.usage)} used · ${fmtBytes(state.storageEstimate.quota)} quota`:"Not available"}</dd></div></dl></div></section><section class="workbench-section"><h2>Keyboard shortcuts</h2><p><kbd>Ctrl/Cmd+K</kbd> Command palette · <kbd>Ctrl/Cmd+P</kbd> Quick Open · <kbd>Ctrl/Cmd+F</kbd> workspace search · <kbd>Ctrl/Cmd+A</kbd> select visible · <kbd>Ctrl/Cmd+Z</kbd> undo · <kbd>Ctrl/Cmd+Shift+Z</kbd> / <kbd>Ctrl/Cmd+Y</kbd> redo · <kbd>Escape</kbd> close or clear.</p><p>Imported content and preferences are kept in this browser's IndexedDB. The service worker caches application code and static first-party resources only; user audio, saves, levels, and project archives stay in IndexedDB or are exported by your action.</p><p>Online fonts and Geometry Dash services may be unavailable offline. Audio support depends on the browser's codecs. Actual Geometry Dash file compatibility depends on the source format and is not guaranteed.</p><p class="diagnostic-agent">Browser: ${esc(navigator.userAgent)}</p></section></main></div>`;}
function diagnosticText(){const meta=window.GMDPLAYER_META||{};return [`${meta.name||"GMDPlayer"} ${meta.version||"unknown"}`,`Database schema: ${DATABASE_SCHEMA_VERSION}`,`Backup format: ${PROJECT_BACKUP_VERSION}`,`Service worker: ${state.serviceWorkerStatus}`,`Online: ${navigator.onLine}`,`Standalone: ${isStandalone()||false}`,`Resources: levels=${state.levels.length}, audio=${state.audioAssets.length}, textures=${state.textures.length}, saves=${state.saves.length}, projects=${state.projects.length}`,`Active project: ${state.activeProject?.name||"none"}`,`Browser: ${navigator.userAgent}`].join("\n");}
function renderInstallAffordance(){document.querySelector(".install-affordance")?.remove();if(!state.installPrompt||state.installDismissed)return;document.querySelector(".privacy-label")?.insertAdjacentHTML("beforebegin",`<span class="install-affordance"><button class="btn small" data-action="install-app">Install GMDPlayer</button><button class="btn small icon-only" data-action="dismiss-install" aria-label="Dismiss install suggestion" title="Dismiss">×</button></span>`);}
function updateNetworkAffordance(){document.querySelector(".offline-indicator")?.remove();if(!navigator.onLine)document.querySelector(".privacy-label")?.insertAdjacentHTML("beforebegin",`<span class="offline-indicator" role="status">Offline · local resources are available</span>`);}
function setServiceWorkerStatus(value){state.serviceWorkerStatus=value;const node=document.querySelector("#diagnostic-sw-status");if(node)node.textContent=value;}
async function registerPwa(){if(!("serviceWorker" in navigator)){setServiceWorkerStatus("Unavailable in this browser or context");return;}try{const script=new URL("../sw.js",location.href),scope=new URL("../",location.href);const registration=await navigator.serviceWorker.register(script.href,{scope:scope.pathname});setServiceWorkerStatus(registration.active?"Ready · offline shell cached":"Registered · preparing offline shell");registration.addEventListener("updatefound",()=>{setServiceWorkerStatus("Updating application resources");registration.installing?.addEventListener("statechange",()=>{if(registration.installing?.state==="activated")setServiceWorkerStatus("Ready · offline shell cached");});});navigator.serviceWorker.addEventListener("controllerchange",()=>setServiceWorkerStatus("Ready · offline shell cached"));}catch(_){setServiceWorkerStatus("Unavailable · app still works online");}}
function getSelectionModel(scope, ids = []) {
  if (!state.selections[scope]) state.selections[scope] = new SelectionModel(ids);
  else state.selections[scope].setVisible(ids);
  return state.selections[scope];
}
function resourceTagSet(record, kind) { return kind === "level" ? record.applicationMetadata?.tags || [] : record.tags || []; }
function selectionToolbar(scope, ids, { type = "resources", projectId = null, resourceType = null } = {}) {
  const selection = getSelectionModel(scope, ids), count = selection.size;
  if (!count) return `<button class="btn small selection-all" data-action="select-all-visible" data-scope="${esc(scope)}">Select visible</button>`;
  const projects = state.projects.filter(project => !project.archivedAt), pickedMap=new Map(selectionRecords(scope).map(item=>[item.id,item]));
  const projectSelect = !["projects","membership"].includes(type) && projects.length ? `<select class="bulk-project-select" data-bulk-project-select="${esc(scope)}" aria-label="Choose a project"><option value="">Choose project…</option>${projects.map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join("")}</select><button class="btn small" data-action="bulk-project-add" data-scope="${esc(scope)}" data-resource-type="${esc(resourceType || "")}">Add to project</button>` : "";
  const tagActions = type === "projects" || type === "saves" || resourceType === "saveSnapshots" ? "" : `<button class="btn small" data-action="bulk-tags" data-scope="${esc(scope)}">Edit tags</button><button class="btn small" data-action="bulk-favorite" data-scope="${esc(scope)}">${selection.values().every(id => pickedMap.get(id)?.favorite) ? "Unstar" : "Star"}</button>`;
  const exportButton = ["projects", "library", "audio", "assets", "textures", "saves"].includes(type) ? `<button class="btn small" data-action="bulk-export" data-scope="${esc(scope)}">Export ZIP</button>` : "";
  const deleteButton = ["library", "audio", "assets", "textures"].includes(type) ? `<button class="btn small danger ghost" data-action="bulk-delete" data-scope="${esc(scope)}">Delete</button>` : "";
  const membershipRemove = projectId && resourceType ? `<button class="btn small" data-action="bulk-project-remove" data-scope="${esc(scope)}" data-project="${esc(projectId)}" data-resource-type="${esc(resourceType)}">Remove from project</button>` : "";
  const projectActions = type === "projects" ? `<button class="btn small" data-action="bulk-project-archive" data-scope="${esc(scope)}">Archive / restore</button><button class="btn small" data-action="bulk-export" data-scope="${esc(scope)}">Export projects</button>` : "";
  return `<div class="selection-toolbar" role="toolbar" aria-label="Bulk actions"><strong>${count} ${count === 1 ? "item" : "items"} selected</strong><button class="btn small" data-action="select-all-visible" data-scope="${esc(scope)}">Select all visible</button>${tagActions}${projectSelect}${membershipRemove}${exportButton}${deleteButton}${projectActions}<button class="btn small" data-action="clear-selection" data-scope="${esc(scope)}">Clear</button></div>`;
}
function selectionRecords(scope) {
  const context=state.selectionContexts[scope];
  if(context){ const records=context.type==="levels"?state.levels:context.type==="audioAssets"?state.audioAssets:context.type==="textureWorkspaces"?state.textures:state.saves; return records.filter(record=>(state.selections[scope]?.visible||[]).includes(record.id)).map(record=>({id:record.id,kind:context.type==="levels"?"level":context.type==="audioAssets"?"audio":context.type==="textureWorkspaces"?"texture":"save",record,favorite:record.applicationMetadata?.favorite??record.favorite})); }
  if (scope === "library") return state.levels.map(record => ({ id: record.id, kind: "level", record, favorite: record.applicationMetadata?.favorite }));
  if (scope === "audio") return state.audioAssets.map(record => ({ id: record.id, kind: "audio", record, favorite: record.favorite }));
  if (scope === "assets") return getAssetRecords().map(item => ({ id: item.id, kind: item.kind, record: item.record || item.asset || item.pack, favorite: item.record?.applicationMetadata?.favorite ?? item.asset?.favorite ?? item.pack?.favorite }));
  if (scope === "projects") return state.projects.map(record => ({ id: record.id, kind: "project", record, favorite: record.favorite }));
  if (scope === "textures") return state.textures.map(record => ({ id: record.id, kind: "texture", record, favorite: record.favorite }));
  if (scope === "saves") return state.saves.map(record => ({ id: record.id, kind: "save", record, favorite: false }));
  return [];
}
function searchDefinition(scope, query = "", type = "all") { const filter=state.searchFilters[scope]||{}; return { query, type, tags: normalizeTags(String(filter.tags||"").split(",")), tagMode:filter.tagMode||"all", projectId:filter.projectId||"", favorite:!!filter.favorite, from:filter.fromDate?Date.parse(`${filter.fromDate}T00:00:00`):0, to:filter.toDate?Date.parse(`${filter.toDate}T23:59:59`):0, minSize:filter.minSize, maxSize:filter.maxSize, minObjects:filter.minObjects, maxObjects:filter.maxObjects }; }
function advancedSearchMarkup(scope) {
  const filters = state.searchFilters[scope]||{}, tags = filters.tags || "", projects = state.projects.filter(project => !project.archivedAt);
  const projectFilter=["projects"].includes(scope)?"":`<label>Project<select data-filter-project="${scope}"><option value="">All projects</option>${projects.map(project => `<option value="${esc(project.id)}" ${filters.projectId === project.id ? "selected" : ""}>${esc(project.name)}</option>`).join("")}</select></label>`;
  const metricFilters=scope==="library"?`<label>Minimum objects<input type="number" min="0" data-filter-min-objects="${scope}" value="${esc(filters.minObjects||"")}"></label><label>Maximum objects<input type="number" min="0" data-filter-max-objects="${scope}" value="${esc(filters.maxObjects||"")}"></label>`:["audio","assets"].includes(scope)?`<label>Minimum size (bytes)<input type="number" min="0" data-filter-min-size="${scope}" value="${esc(filters.minSize||"")}"></label><label>Maximum size (bytes)<input type="number" min="0" data-filter-max-size="${scope}" value="${esc(filters.maxSize||"")}"></label>`:"";
  return `<details class="advanced-search-tools"><summary>Filters and saved searches</summary><div class="advanced-search-controls"><label>Tags, comma-separated<input data-filter-tags="${scope}" value="${esc(tags)}" placeholder="favorite, unfinished"></label><label>Match tags<select data-filter-tag-mode="${scope}"><option value="all" ${filters.tagMode!=="any"?"selected":""}>All tags</option><option value="any" ${filters.tagMode==="any"?"selected":""}>Any tag</option></select></label>${projectFilter}${metricFilters}<label>Imported after<input type="date" data-filter-from="${scope}" value="${esc(filters.fromDate||"")}"></label><label>Imported before<input type="date" data-filter-to="${scope}" value="${esc(filters.toDate||"")}"></label><label class="favorite-filter"><input type="checkbox" data-filter-favorite="${scope}" ${filters.favorite ? "checked" : ""}> Starred only</label><label>Saved filter<select data-saved-search="${scope}"><option value="">Choose saved search…</option>${state.savedSearches.filter(item => item.scope === scope || item.scope === "all").map(item => `<option value="${esc(item.id)}" ${state.currentSavedSearch[scope]===item.id?"selected":""}>${esc(item.name)}</option>`).join("")}</select></label><button class="btn small" data-action="save-search-definition" data-scope="${scope}">Save current filter</button><button class="btn small" data-action="rename-saved-search" data-scope="${scope}">Rename</button><button class="btn small danger ghost" data-action="delete-saved-search" data-scope="${scope}">Delete saved filter</button></div></details>`;
}
function searchableRecords() {
  if(state.quickOpenIndex)return state.quickOpenIndex;
  const projectsFor = (type, id) => linkedProjects(type, id);
  return state.quickOpenIndex=[
    ...state.levels.map(record => ({ kind:"level", id:record.id, name:record.document.metadata.name, author:record.document.metadata.author, filename:record.document.source?.filename, song:record.document.metadata.song?.name, tags:record.applicationMetadata?.tags, favorite:record.applicationMetadata?.favorite, date:record.document.timestamps?.importedAt, projectIds:projectsFor("levels",record.id).map(item=>item.id), projectNames:projectsFor("levels",record.id).map(item=>item.name), href:`#/library/${encodeURIComponent(record.id)}` })),
    ...state.audioAssets.map(record => ({ kind:"audio", id:record.id, name:record.displayName, filename:record.filename, format:record.mimeType, tags:record.tags, favorite:record.favorite, date:record.importedAt, projectIds:projectsFor("audioAssets",record.id).map(item=>item.id), projectNames:projectsFor("audioAssets",record.id).map(item=>item.name), href:"#/tools/audio" })),
    ...state.textures.map(record => ({ kind:"texture", id:record.id, name:record.name, filename:record.sourceFiles?.map(file=>file.name).join(" "), tags:record.tags, favorite:record.favorite, date:record.createdAt, projectIds:projectsFor("textureWorkspaces",record.id).map(item=>item.id), projectNames:projectsFor("textureWorkspaces",record.id).map(item=>item.name), href:`#/tools/textures/${encodeURIComponent(record.id)}` })),
    ...state.projects.filter(record => !record.archivedAt).map(record => ({ kind:"project", id:record.id, name:record.name, author:record.description, tags:record.tags, favorite:record.favorite, date:record.updatedAt, href:`#/projects/${encodeURIComponent(record.id)}` }))
  ];
}
async function quickCreateProject(){try{const project=await createProjectRecord({name:"New Geometry Dash Project"});await setActiveProjectId(project.id);await recordActivity({kind:"project",resourceId:project.id,name:project.name,action:"created"});await refresh();route(`/projects/${encodeURIComponent(project.id)}`);await refresh();}catch(error){showToast(error.message||"Could not create project.","error");}}
const commandDefinitions = () => [
  ["home","Go to Home","G",()=>route("/home")],["library","Open Library","L",()=>route("/library")],["audio","Open Songs & Audio","A",()=>route("/tools/audio")],["assets","Open Assets","",()=>route("/tools/assets")],["save","Open Save Explorer","",()=>route("/tools/save")],["textures","Open Texture Packs","",()=>route("/tools/textures")],["projects","Open Projects","",()=>route("/projects")],
  ["import-level","Import levels","",()=>openImportPicker("level")],["import-audio","Import audio","",()=>document.querySelector("#audio-input")?.click()],["import-texture","Import texture pack","",()=>openImportPicker("texture")],...(supportsDirectorySelection()?[ ["import-folder","Import a folder","",()=>document.querySelector("#folder-input")?.click()] ]:[]), ["create-project","Create project","",()=>quickCreateProject()],
  ["active-project","Open active project","",()=>state.activeProject ? route(`/projects/${encodeURIComponent(state.activeProject.id)}`) : route("/projects")],["export-project","Export active project","",()=>state.activeProject ? beginProjectExport(state.activeProject.id) : route("/projects")],["inspector","Open Inspector","",()=>{const selected=state.selections.library?.values()?.[0];const id=state.route.id&&["details","play"].includes(state.route.name)?state.route.id:selected;if(id)route(`/library/inspect/${encodeURIComponent(id)}`);else route("/library");}],["search-library","Search Library","Ctrl/Cmd+F",()=>{route("/library");setTimeout(()=>document.querySelector("#search")?.focus(),0);}],["toggle-view","Toggle grid/list view","",()=>{state.libraryView=state.libraryView==="grid"?"list":"grid";persistView("library",{view:state.libraryView});route("/library");renderLibrary();}],["select-all","Select all visible","Ctrl/Cmd+A",()=>selectVisibleCurrent()],["refresh","Refresh workspace","",()=>refresh()],["undo","Undo organization change","Ctrl/Cmd+Z",()=>runHistory("undo")],["redo","Redo organization change","Ctrl/Cmd+Shift+Z",()=>runHistory("redo")]
].map(([id,label,shortcut,run])=>({id,label,shortcut,run}));
function quickOpenItems(query = "") { const needle=query.toLocaleLowerCase().trim(); return searchableRecords().filter(item => !needle || `${item.name} ${item.filename||""} ${item.author||""} ${item.tags||[]}`.toLocaleLowerCase().includes(needle)).slice(0,40); }
function closePalette() { document.querySelector(".command-backdrop")?.remove(); state.palette=null; state.paletteQuery=""; state.paletteIndex=0; }
function prepareQuickItem(item){if(item?.kind==="audio")state.audioSelectedId=item.id;}
function renderPalette() {
  const old = document.querySelector(".command-backdrop"); if (old) old.remove(); if (!state.palette) return;
  const quick = state.palette === "quick", query = state.paletteQuery;
  const items = quick ? quickOpenItems(query).map(item=>({id:item.id,kind:item.kind,label:item.name,meta:item.kind+(item.filename?` · ${item.filename}`:""),href:item.href})) : commandDefinitions().filter(item=>`${item.label} ${item.id}`.toLowerCase().includes(query.toLowerCase())).map(item=>({ ...item, meta:item.shortcut }));
  state.paletteItems=items; state.paletteIndex=Math.min(state.paletteIndex||0,Math.max(0,items.length-1));
  document.body.insertAdjacentHTML("beforeend",`<div class="command-backdrop" role="presentation"><section class="command-dialog" role="dialog" aria-modal="true" aria-labelledby="command-title"><h2 id="command-title" class="sr-only">${quick?"Quick Open":"Command palette"}</h2><label class="command-search"><span aria-hidden="true">⌕</span><input id="command-search" type="search" autocomplete="off" aria-controls="command-results" ${items.length?`aria-activedescendant="command-result-${state.paletteIndex}"`:""} placeholder="${quick?"Find a level, song, project, or texture…":"Type a command…"}" aria-label="${quick?"Quick Open search":"Command search"}"><kbd>Esc</kbd></label><div class="command-results" id="command-results" role="listbox">${items.map((item,index)=>quick?`<a id="command-result-${index}" class="command-result ${index===state.paletteIndex?"active":""}" role="option" aria-selected="${index===state.paletteIndex}" href="${item.href}" data-quick-index="${index}"><span><strong>${esc(item.label)}</strong><small>${esc(item.meta)}</small></span><kbd>↵</kbd></a>`:`<button id="command-result-${index}" class="command-result ${index===state.paletteIndex?"active":""}" role="option" aria-selected="${index===state.paletteIndex}" data-action="palette-command" data-command="${item.id}"><span><strong>${esc(item.label)}</strong></span>${item.meta?`<kbd>${esc(item.meta)}</kbd>`:""}</button>`).join("")||`<p class="command-empty">No matching ${quick?"resources":"commands"}.</p>`}</div><footer>${quick?"Quick Open":"Commands"} <span>↑ ↓ to navigate · Enter to open · Esc to close</span></footer></section></div>`);
  const input=document.querySelector("#command-search"); input.value=query; input.focus(); input.setSelectionRange(query.length,query.length);
}
function openPalette(mode="commands") { state.palette=mode; state.paletteIndex=0; state.paletteQuery=""; renderPalette(); }
function selectVisibleCurrent() { const scope={library:"library",audio:"audio",assets:"assets",projects:"projects",textures:state.route.id?null:"textures",save:"saves",tools:"saves"}[state.route.name]; if(!scope)return; const selection=state.selections[scope];selection?.selectAll();renderScope(scope); }
function scheduleSearchRender(scope,inputId,render) { clearTimeout(state.searchTimers?.[scope]);state.searchTimers||=Object.create(null);state.searchTimers[scope]=setTimeout(()=>{const input=document.getElementById(inputId),cursor=input?.selectionStart;render();const next=document.getElementById(inputId);next?.focus();if(cursor!=null)next?.setSelectionRange(cursor,cursor);},120); }
async function persistView(scope,patch={}) { state.viewPreferences[scope]={...(state.viewPreferences[scope]||{}),...patch}; try{await saveViewPreferences(scope,state.viewPreferences[scope]);}catch(error){showToast(error.message||"View preference could not be saved.","error");} }
function searchScopeQuery(scope){ return scope==="library"?state.search:scope==="audio"?state.audioQuery:scope==="assets"?state.assetQuery:scope==="textures"?state.textureQuery:scope==="projects"?state.projectQuery:state.saveQuery; }
function setSearchScopeQuery(scope,value){ if(scope==="library")state.search=value; else if(scope==="audio")state.audioQuery=value; else if(scope==="assets")state.assetQuery=value; else if(scope==="textures")state.textureQuery=value; else if(scope==="projects")state.projectQuery=value; else if(scope==="saves")state.saveQuery=value; }
function renderScope(scope) { const target={library:renderLibrary,audio:renderAudioWorkspace,assets:renderAssetsWorkspace,projects:renderProjects,"projects-archived":renderProjects,textures:renderTextureWorkspace,saves:renderTools}[scope]; if(target) target(); }
function bulkItems(scope) { const selected=new Set(state.selections[scope]?.values()||[]); return selectionRecords(scope).filter(item=>selected.has(item.id)); }
function downloadBlob(blob,filename) { if(!globalThis.URL?.createObjectURL){showToast("This browser cannot download generated files.","error");return false;}const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=filename;link.style.display="none";document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);return true; }
function safeFilename(value) { return String(value||"item").replace(/[\\/:*?"<>|\u0000-\u001f]+/g,"_").replace(/^\.+/,"").slice(0,160)||"item"; }
function uniqueArchivePath(map,path) { let candidate=path,index=2; const dot=path.lastIndexOf("."),stem=dot>path.lastIndexOf("/")?path.slice(0,dot):path,ext=dot>path.lastIndexOf("/")?path.slice(dot):""; while(map.has(candidate)) candidate=`${stem} (${index++})${ext}`; return candidate; }
function pushUndo(label,undo,redo){state.undoStack.push({label,undo,redo});if(state.undoStack.length>30)state.undoStack.shift();state.redoStack=[];}
async function runHistory(direction="undo"){const from=direction==="undo"?state.undoStack:state.redoStack,to=direction==="undo"?state.redoStack:state.undoStack,item=from.pop();if(!item){showToast(direction==="undo"?"Nothing to undo.":"Nothing to redo.");return;}try{await item[direction]();to.push(item);await refresh();showToast(`${direction==="undo"?"Undid":"Redid"}: ${item.label}`);}catch(error){from.push(item);showToast(error.message||`Could not ${direction} this action.`,"error");}}
async function applyMetadataSnapshot(items,key,values){for(let i=0;i<items.length;i++){const item=items[i],value=values[i];if(item.kind==="level")await updateLevelApplicationMetadata(item.id,{[key]:value});else if(item.kind==="audio")await saveAudioAssetMetadata(item.id,{[key]:value});else if(item.kind==="texture"){const record=await getTextureWorkspace(item.id);if(record)await saveTextureWorkspace({...record,[key]:value});}else if(item.kind==="project")await updateProjectRecord(item.id,{[key]:value});}}
async function bulkExport(scope) {
  const items=bulkItems(scope); if(!items.length)return;
  const files=new Map(); let completed=0;
  for(const item of items){
    const {kind,record}=item;
    if(kind==="project"){ const archive=await exportProjectBackup(record.id,{createdWith:window.GMDPLAYER_META}); files.set(uniqueArchivePath(files,`projects/${safeFilename(record.name)}.gmdproject`),archive); }
    else if(kind==="level"){ const full=await getLevel(item.id);if(!full)throw new Error(`Selected level is no longer available: ${item.id}`);const doc=full.document, name=safeFilename(doc?.source?.filename||`${doc?.metadata?.name||"level"}.txt`); files.set(uniqueArchivePath(files,`levels/${name}`),doc?.source?.originalPayload||doc?.content?.raw||""); }
    else if(kind==="audio") files.set(uniqueArchivePath(files,`audio/${safeFilename(record.filename||record.displayName)}`),record.blob);
    else if(kind==="texture"){ const full=await getTextureWorkspace(item.id);if(!full)throw new Error(`Selected texture workspace is no longer available: ${item.id}`);const {buildTextureFiles}=await import("../../core/textures/texture-export.js"); const inner=await buildTextureFiles(full); for(const [name,bytes] of inner) files.set(uniqueArchivePath(files,`textures/${safeFilename(record.name)}/${name}`),bytes); }
    else if(kind==="save"){ for(const [slot,file] of Object.entries(record.document?.files||{})){ if(!file)continue; const filename=safeFilename(file.filename||`${slot}.dat`); files.set(uniqueArchivePath(files,`saves/${safeFilename(record.id)}/${filename}`),file.blob||file.bytes||file); } }
    completed++; state.batchProgress={current:completed,total:items.length};setOperationStatus("Preparing selected items for export",completed,items.length);
  }
  if(!files.size) throw new Error("No selected records had exportable source files.");
  const blob=await writeZipBlob(files,{maxTotalBytes:1024*1024*1024,onProgress:info=>{state.batchProgress={current:info.current,total:info.total};setOperationStatus("Writing export archive",info.current,info.total);}});
  downloadBlob(blob,`gmdplayer-${scope}-${new Date().toISOString().slice(0,10)}.zip`); state.batchProgress=null;
  await recordActivity({kind:scope,resourceId:items.map(item=>item.id).join(",").slice(0,180),name:`${items.length} selected items`,action:"exported"});
  showToast(`Exported ${items.length} selected item${items.length===1?"":"s"} to a ZIP download.`);
}
async function bulkTags(scope) {
  const items=bulkItems(scope); if(!items.length)return;
  const additions=prompt("Add tags to selected items (comma-separated). Leave blank to keep existing tags:"); if(additions===null)return;
  const removals=prompt("Remove tags from selected items (comma-separated):"); if(removals===null)return;
  const add=normalizeTags(additions.split(",")), remove=normalizeTags(removals.split(",")),before=items.map(item=>resourceTagSet(item.record,item.kind));
  for(const item of items){ const tags=mergeTags(resourceTagSet(item.record,item.kind),add,remove);
    if(item.kind==="level") await updateLevelApplicationMetadata(item.id,{tags});
    else if(item.kind==="audio") await saveAudioAssetMetadata(item.id,{tags});
    else if(item.kind==="texture"){const full=await getTextureWorkspace(item.id);if(full)await saveTextureWorkspace({...full,tags});}
    else if(item.kind==="project") await updateProjectRecord(item.id,{tags});
  }
  const after=items.map(item=>mergeTags(resourceTagSet(item.record,item.kind),add,remove));pushUndo("Bulk tag changes",()=>applyMetadataSnapshot(items,"tags",before),()=>applyMetadataSnapshot(items,"tags",after));
  await refresh(); showToast(`Updated tags on ${items.length} selected item${items.length===1?"":"s"}.`);
}
async function bulkFavorite(scope) {
  const items=bulkItems(scope); if(!items.length)return; const before=items.map(item=>item.favorite===true),favorite=!before.every(Boolean);
  for(const item of items){ if(item.kind==="level") await updateLevelApplicationMetadata(item.id,{favorite}); else if(item.kind==="audio") await saveAudioAssetMetadata(item.id,{favorite}); else if(item.kind==="texture"){const full=await getTextureWorkspace(item.id);if(full)await saveTextureWorkspace({...full,favorite});} else if(item.kind==="project") await updateProjectRecord(item.id,{favorite}); }
  pushUndo("Bulk favorite changes",()=>applyMetadataSnapshot(items,"favorite",before),()=>applyMetadataSnapshot(items,"favorite",items.map(()=>favorite)));
  await refresh(); showToast(`${favorite?"Starred":"Unstarred"} ${items.length} selected item${items.length===1?"":"s"}.`);
}
async function bulkAssignProject(scope, projectId, remove=false, typeHint="") {
  if(!projectId) throw new Error("Choose a project first.");
  const items=bulkItems(scope);
  const typeFor=item=>typeHint&&typeHint!=="mixed"?typeHint:({level:"levels",audio:"audioAssets",texture:"textureWorkspaces",save:"saveSnapshots"})[item.kind];
  const result=await applyProjectMembership(items,{projectId,remove,getProject,addResource:addProjectResource,removeResource:removeProjectResource,typeFor});
  if(result.operations.length){const operations=result.operations,apply=async field=>{for(const op of operations){if(op[field])await addProjectResource(projectId,op.type,op.id);else await removeProjectResource(projectId,op.type,op.id);}};pushUndo("Project membership changes",()=>apply("before"),()=>apply("after"));}
  await refresh();const failed=result.failed.length;showToast(`${result.operations.length} membership link${result.operations.length===1?"":"s"} ${remove?"removed":"added"}${failed?` · ${failed} failed`:""}. Global assets remain available.`,failed?"error":"");
  if(failed)showToast(result.failed.slice(0,3).map(item=>`${item.item.id}: ${item.error.message||"membership update failed"}`).join(" | "),"error");
}
async function bulkDelete(scope) {
  const items=bulkItems(scope); if(!items.length)return;
  const count=items.length; if(!confirm(`Remove ${count} selected global resource${count===1?"":"s"}? Project memberships and level links may show these resources as unavailable; unrelated global records will not be removed.`))return;
  for(const item of items){ if(item.kind==="level") await deleteLevel(item.id); else if(item.kind==="audio") await deleteAudioAsset(item.id); else if(item.kind==="texture") await deleteTextureWorkspace(item.id); }
  for(const id of state.selections[scope]?.values()||[]) state.selections[scope].selected.delete(id);
  await refresh(); showToast(`Removed ${count} selected resource${count===1?"":"s"}.`);
}
async function bulkProjectArchive(scope) {
  const items=bulkItems(scope); if(!items.length)return; const archived=scope==="projects";
  if(!confirm(`${archived?"Archive":"Restore"} ${items.length} selected project${items.length===1?"":"s"}?`))return;
  const previous=items.map(item=>item.record.archivedAt||null),next=items.map(()=>archived?Date.now():null);for(let index=0;index<items.length;index++)await updateProjectRecord(items[index].id,{archivedAt:next[index]});
  const apply=async values=>{for(let index=0;index<items.length;index++)await updateProjectRecord(items[index].id,{archivedAt:values[index]});};pushUndo("Project archive changes",()=>apply(previous),()=>apply(next));
  await refresh(); showToast(`${items.length} project${items.length===1?"":"s"} ${archived?"archived":"restored"}.`);
}
function fmtDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(value);
}
function fmtBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? "KB" : bytes < 1024 ** 3 ? "MB" : "GB";
  const divisor = unit === "KB" ? 1024 : unit === "MB" ? 1024 ** 2 : 1024 ** 3;
  return `${(bytes / divisor).toFixed(bytes >= 1024 ** 3 ? 2 : 1)} ${unit}`;
}
function fmtDuration(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "—";
  const seconds = Math.floor(Number(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function levelApplication(record) { return record?.applicationMetadata || { schemaVersion: 1, audioOverride: null, textureWorkspaceId: null, tags: [], notes: "" }; }
function releaseAudioPreview() {
  const audio = document.querySelector("#audio-preview, #details-audio-preview");
  if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
  if (state.audioPreviewUrl) globalThis.URL?.revokeObjectURL?.(state.audioPreviewUrl);
  state.audioPreviewUrl = null; state.audioPreviewId = null;
}
function attachAudioPreview(element, asset) {
  if (!element || !asset?.blob) return;
  releaseAudioPreview();
  if(!globalThis.URL?.createObjectURL){showToast("Local audio preview is unsupported in this browser.","error");return;}
  state.audioPreviewUrl = URL.createObjectURL(asset.blob); state.audioPreviewId = asset.id;
  element.src = state.audioPreviewUrl;
  element.addEventListener("loadedmetadata", async () => {
    if (Number.isFinite(element.duration) && element.duration > 0 && Math.abs((asset.duration || 0) - element.duration) > 0.5) {
      try {
        const saved = await saveAudioAssetMetadata(asset.id, { duration: element.duration });
        state.audioAssets = state.audioAssets.map(item => item.id === saved.id ? saved : item);
        document.querySelectorAll("[data-audio-duration]").forEach(cell => { if (cell.dataset.audioDuration === saved.id) cell.textContent = fmtDuration(saved.duration); });
        const selectedDuration = document.querySelector("#audio-preview")?.closest(".audio-inspector")?.querySelector(".audio-metadata > div:nth-child(4) dd");
        if (selectedDuration && state.audioSelectedId === saved.id) selectedDuration.textContent = fmtDuration(saved.duration);
      } catch (_) { /* Metadata discovery must not interrupt preview playback. */ }
    }
  }, { once: true });
}
function icon(name) {
  const paths = {
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    library: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 1 4 17.5z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20M8 6h8"/>',
    tools: '<path d="M14.5 6.5a4 4 0 0 0-5.7 5.7l-5.3 5.3a2 2 0 0 0 2.8 2.8l5.3-5.3a4 4 0 0 0 5.7-5.7L14 12.5 11.5 10z"/>',
    save: '<path d="M4 3h14l3 3v15H4z"/><path d="M8 3v6h8V3M8 21v-8h9v8"/>',
    texture: '<path d="M4 4h7v7H4zM14 4h6v4h-6zM14 11h6v9h-6zM4 14h7v6H4z"/>',
    inspect: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M8 10.5h5M10.5 8v5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    import: '<path d="M12 15V3m0 0L7 8m5-5 5 5M4 14v6h16v-6"/>',
    play: '<path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/>',
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
}
function header(active) {
  return `<header class="topbar"><button class="nav-toggle" data-action="toggle-nav" aria-label="Toggle navigation" aria-expanded="false">${icon("menu")}</button>
    <a class="brand" href="#/home"><span class="brand-mark">G</span><span>GMDPlayer</span><img class="brand-runtime-sprite" src="./play/assets/sprites/GJ_square01.png" alt="" aria-hidden="true"></a>
    <div class="topbar-tools"><label class="global-search">${icon("search")}<input id="global-search" type="search" placeholder="Search this workspace" value="${esc(state.globalQuery)}" aria-label="Search this workspace"><kbd>${navigator.platform?.toLowerCase().includes("mac")?"⌘":"Ctrl"} K</kbd></label><button class="btn primary import-top" data-action="browse">${icon("import")}<span>Import files</span></button><a class="current-project-link" href="${state.activeProject ? `#/projects/${encodeURIComponent(state.activeProject.id)}` : "#/projects"}">${state.activeProject ? `Project · ${esc(state.activeProject.name)}` : "Projects"}</a>${navigator.onLine?"":`<span class="offline-indicator" role="status">Offline · your local library is available; online content may not be.</span>`}${state.installPrompt&&!state.installDismissed?`<span class="install-affordance"><button class="btn small" data-action="install-app">Install GMDPlayer</button><button class="btn small icon-only" data-action="dismiss-install" aria-label="Dismiss install suggestion" title="Dismiss">×</button></span>`:""}<span class="privacy-label"><span class="status-dot"></span>On this device</span></div>
  </header>
  <aside class="sidebar" aria-label="Main navigation"><div class="sidebar-section"><div class="sidebar-label">Workspace</div><a href="#/home" class="side-link ${active === "home" ? "active" : ""}">${icon("home")}<span>Home</span></a><a href="#/library" class="side-link ${["library", "details", "inspect"].includes(active) ? "active" : ""}">${icon("library")}<span>Library</span><span class="side-count">${state.levels.length}</span></a><a href="#/projects" class="side-link ${active === "projects" ? "active" : ""}">${icon("library")}<span>Projects</span><span class="side-count">${state.projects.filter(project => !project.archivedAt).length}</span></a></div>
    <div class="sidebar-section"><div class="sidebar-label">Tools</div><a href="#/tools" class="side-link ${active === "tools" ? "active" : ""}">${icon("tools")}<span>All tools</span></a><a href="#/tools/assets" class="side-link ${active === "assets" ? "active" : ""}">${icon("library")}<span>Assets</span></a><a href="#/tools/audio" class="side-link ${active === "audio" ? "active" : ""}">${icon("play")}<span>Songs & Audio</span></a><a href="#/tools/save" class="side-link ${active === "save" ? "active" : ""}">${icon("save")}<span>Save Explorer</span></a><a href="#/tools/textures" class="side-link ${active === "textures" ? "active" : ""}">${icon("texture")}<span>Textures</span></a><button class="side-link" data-action="inspect-latest">${icon("inspect")}<span>Level inspector</span></button></div><div class="sidebar-spacer"></div><a href="#/about" class="side-link about-link ${active === "about" ? "active" : ""}">${icon("inspect")}<span>About & diagnostics</span></a><div class="sidebar-local"><span class="status-dot"></span><div><strong>Local workspace</strong><small>Resources stored in IndexedDB</small></div></div></aside>`;
}
function levelCard(document, applicationMetadata = null) {
  const m = document.metadata || {}, played = document.timestamps?.lastPlayedAt ? fmtDate(document.timestamps.lastPlayedAt) : "Not played yet";
  const override = applicationMetadata?.audioOverride;
  const localAudio = override ? state.audioAssets.find(asset => asset.id === override.assetId) : null;
  const songName = override ? (localAudio?.displayName || "Song unavailable") : (m.song?.name || "Unknown song");
  const selectable = state.route.name === "library", selected = selectable && state.selections.library?.has(document.id);
  return `<article class="level-card ${selected ? "selection-selected" : ""}" ${selectable ? `data-selectable="library" data-id="${esc(document.id)}" tabindex="0" role="option" aria-selected="${selected}"` : ""}><div class="level-card-main">${selectable ? `<input class="item-selection" type="checkbox" data-select-item="library" data-id="${esc(document.id)}" aria-label="Select ${esc(m.name || "level")}" ${selected?"checked":""}>` : ""}<span class="level-file-icon">${icon("library")}</span><div class="level-card-title"><h3 class="level-name" title="${esc(m.name)}">${esc(m.name || "Untitled level")}</h3><p class="level-by">by ${esc(m.author || "Unknown creator")}</p></div><span class="level-badge">${Number(m.difficulty?.stars) > 0 ? `${esc(m.difficulty.stars)} stars` : "Unrated"}</span></div>
    <div class="level-card-info"><div><span>Song</span><strong>${esc(songName)}</strong></div><div><span>Progress</span><strong>${esc(document.progress?.normal || 0)}%</strong></div><div><span>Last played</span><strong>${esc(played)}</strong></div></div>
    <div class="card-actions"><button class="btn primary play-action" data-action="play" data-id="${esc(document.id)}">${icon("play")}<span>Play level</span></button><button class="btn" data-action="details" data-id="${esc(document.id)}">Details</button><button class="btn danger ghost" data-action="delete" data-id="${esc(document.id)}" aria-label="Delete ${esc(m.name || "level")}">Delete</button></div></article>`;
}
function batchImportStatusMarkup() {
  if(state.importing){const done=state.batchResults.filter(item=>["imported","ready","duplicate","ignored","failed","cancelled"].includes(item.status)).length;return `<section class="batch-import-panel" role="status"><div><strong>${esc(state.importStatus||"Processing import queue…")}</strong><small>${done} of ${state.batchResults.length} files completed</small></div><progress max="${Math.max(1,state.batchResults.length)}" value="${done}"></progress><button class="btn small" data-action="cancel-import">Cancel remaining</button><details><summary>Queue (${state.batchResults.length})</summary><ul>${state.batchResults.map(item=>`<li><span>${esc(item.name)}</span><strong>${esc(item.status)}</strong>${item.error?`<small>${esc(item.error)}</small>`:""}</li>`).join("")}</ul></details></section>`;}
  if(!state.batchSummary)return "";const {counts,items}=state.batchSummary;return `<section class="batch-import-panel"><div><strong>Last import</strong><small>${counts.success} succeeded · ${counts.duplicates} duplicates · ${counts.ignored} ignored · ${counts.failed} failed${counts.cancelled?` · ${counts.cancelled} cancelled`:""}</small></div><details><summary>Review file results</summary><ul>${items.map(item=>`<li><span>${esc(item.name)}</span><strong>${esc(item.status)}</strong>${item.error?`<small>${esc(item.error)}</small>`:""}</li>`).join("")}</ul>${counts.failed?`<button class="btn small" data-action="retry-import-failures">Retry failures</button>`:""}${items.some(item=>item.status==="ignored"&&item.name.toLowerCase().endsWith(".gmdproject"))?`<button class="btn small" data-action="process-next-backup">Inspect next backup</button>`:""}${state.ignoredImportFiles?.length?`<p>Ignored extensions: ${[...new Set(state.ignoredImportFiles.map(file=>file.name.split(".").pop().toUpperCase()))].map(esc).join(", ")||"none"}</p>`:""}</details></section>`;
}
function uploadZone() {
  return `<section class="upload-zone" id="upload-zone" aria-label="Drop Geometry Dash files here"><div class="upload-symbol">${icon("import")}</div><h2>Drop a Geometry Dash file here</h2><p>Import levels, saves, texture packs, or local audio to build your workspace.</p><button class="btn primary browse-large" data-action="browse">${icon("import")}<span>Browse files</span></button><span class="upload-formats">GMD · TXT · DAT · PNG · PLIST · ZIP · MP3 · OGG · WAV</span>${batchImportStatusMarkup()}
  ${state.importing ? `<div class="import-progress">${esc(state.importStatus || "Reading local files…")}<div class="progress-track"><div class="progress-fill"></div></div></div>` : ""}
  ${state.imported.length ? `<div class="success-card"><div class="success-head">${state.imported.length === 1 ? "Level imported" : `${state.imported.length} levels imported`}</div><p>${state.imported.map(doc => esc(doc.metadata.name)).join(" · ")}</p>${state.imported.length === 1 ? `<button class="btn primary" data-action="play" data-id="${esc(state.imported[0].id)}">Play now</button>` : `<button class="btn" data-action="library">View Library</button>`}</div>` : ""}</section>`;
}
function activityHref(item){if(item.kind==="level")return `#/library/${encodeURIComponent(item.resourceId)}`;if(item.kind==="project")return `#/projects/${encodeURIComponent(item.resourceId)}`;if(item.kind==="audio")return "#/tools/audio";if(item.kind==="texture")return `#/tools/textures/${encodeURIComponent(item.resourceId)}`;if(item.kind==="save")return `#/tools/save/${encodeURIComponent(item.resourceId)}`;return "#/tools/assets";}
function renderHome() {
  const recent = state.levels.slice(0, 6);
  const featured = recent[0];
  const asset = (path, className = "", alt = "") => '<img class="' + className + '" src="./play/assets/' + path + '" alt="' + esc(alt) + '">';
  const runtimeBg = "./play/assets/game-bg/game_bg_01_001-hd.png";
  app.innerHTML = '<div class="shell">' + header("home") + '<main class="main-content home-content gd-home">' +
    '<section class="gd-home-hero" style="--runtime-bg:url("' + runtimeBg + '")">' +
      '<div class="gd-home-hero-copy"><div class="eyebrow">GMDPlayer · local Geometry Dash workspace</div>' +
      '<h1>' + (featured ? esc(featured.document.metadata?.name || "Ready to play") : "Your Geometry Dash workspace") + '</h1>' +
      '<p>' + (featured ? 'Your latest level is ready. Press Play and the existing Geometry Dash runtime will open it directly.' : 'Import a level, save, texture pack, or song and keep the whole workspace on this device.') + '</p>' +
      '<div class="gd-home-actions">' +
        (featured ? '<button class="gd-runtime-button gd-runtime-button-primary" data-action="play" data-id="' + esc(featured.id) + '">' + asset("sprites/GJ_button_01.png","gd-button-art","") + '<span>Play latest level</span></button>' : '<button class="gd-runtime-button gd-runtime-button-primary" data-action="browse-level">' + asset("sprites/GJ_button_01.png","gd-button-art","") + '<span>Import a level</span></button>') +
        '<button class="gd-runtime-button" data-action="browse">' + asset("sprites/GJ_button_02.png","gd-button-art","") + '<span>Import files</span></button>' +
        '<a class="gd-home-text-action" href="#/library">Open Library</a>' +
      '</div></div>' +
      '<div class="gd-home-hero-art">' + asset("sprites/GJ_MenuBeta.png","gd-menu-art","Geometry Dash artwork") + '</div>' +
    '</section>' +
    '<section class="gd-section"><div class="gd-section-heading"><div><div class="eyebrow">What do you want to do?</div><h2>Choose a workspace</h2></div><p>Each tool has one clear job. Your files stay connected across the workbench.</p></div>' +
      '<div class="gd-workspace-grid">' +
        '<a class="gd-workspace-card gd-workspace-play" href="#/library"><div class="gd-workspace-art" style="background-image:url("' + runtimeBg + '")"></div><div class="gd-workspace-card-body"><span class="gd-card-label">Play</span><h3>Play levels</h3><p>Open an imported level directly in the existing Geometry Dash runtime.</p><span class="gd-card-link">Go to Library →</span></div></a>' +
        '<a class="gd-workspace-card" href="#/tools/save"><div class="gd-workspace-art gd-save-art">' + asset("sprites/GJ_square01.png","gd-square-art","") + '</div><div class="gd-workspace-card-body"><span class="gd-card-label">Explore</span><h3>Save Explorer</h3><p>Inspect CCGameManager.dat and CCLocalLevels.dat without uploading them.</p><span class="gd-card-link">Open Save Explorer →</span></div></a>' +
        '<a class="gd-workspace-card" href="#/tools/textures"><div class="gd-workspace-art gd-menu-art-bg">' + asset("sprites/GJ_MenuBeta.png","gd-menu-art-small","") + '</div><div class="gd-workspace-card-body"><span class="gd-card-label">Create</span><h3>Texture packs</h3><p>Inspect atlases, replace sprites, and export packs while keeping originals intact.</p><span class="gd-card-link">Open Textures →</span></div></a>' +
        '<a class="gd-workspace-card" href="#/tools/audio"><div class="gd-workspace-art gd-audio-art">' + asset("sprites/GJ_button_03.png","gd-button-art-large","") + '</div><div class="gd-workspace-card-body"><span class="gd-card-label">Manage</span><h3>Songs & audio</h3><p>Keep local songs available for level playback and assign overrides per level.</p><span class="gd-card-link">Open Songs →</span></div></a>' +
      '</div></section>' +
    '<section class="gd-section"><div class="gd-section-heading"><div><div class="eyebrow">Recently imported</div><h2>' + esc(state.levels.length) + ' ' + (state.levels.length === 1 ? "level" : "levels") + '</h2></div><a class="gd-card-link" href="#/library">See everything →</a></div>' +
      (recent.length ? '<div class="gd-level-strip">' + recent.map(level => '<article class="gd-mini-level"><div><span class="gd-mini-icon">' + asset("sprites/GJ_square01.png","gd-square-art","") + '</span><div><strong>' + esc(level.document.metadata?.name || "Untitled level") + '</strong><small>' + esc(level.document.metadata?.author || "Unknown creator") + '</small></div></div><button class="gd-mini-play" data-action="play" data-id="' + esc(level.id) + '" aria-label="Play ' + esc(level.document.metadata?.name || "level") + '">' + icon("play") + '</button></article>').join("") + '</div>' : '<div class="gd-empty-panel"><h3>Nothing here yet.</h3><p>Drop a .gmd or .txt level into the page or import one to start.</p><button class="gd-runtime-button gd-runtime-button-primary" data-action="browse-level"><span>Import your first level</span></button></div>') +
    '</section>' +
    '<footer class="footer-note">GMDPlayer uses the existing Geometry Dash runtime and its local assets from <code>/app/play</code>.</footer>' +
  '</main></div>';
}

function renderLibrary() {
  const query = state.search.trim().toLowerCase();
  const candidates = state.levels.map(record => ({ ...record, kind:"level", id:record.id, name:record.document.metadata?.name, author:record.document.metadata?.author, filename:record.document.source?.filename, song:record.document.metadata?.song?.name, tags:record.applicationMetadata?.tags, favorite:record.applicationMetadata?.favorite, date:record.document.timestamps?.importedAt, objectCount:record.document.content.parsed?.objectCount||record.document.content.parsed?.objects?.length||0, projectIds:linkedProjects("levels",record.id).map(item=>item.id) }));
  const filtered = new Set(filterResources(candidates, searchDefinition("library", query, "level")).map(item=>item.id));
  const entries = state.levels.filter(record => filtered.has(record.id)).filter(({ document: doc }) => {
    const played = Boolean(doc.timestamps?.lastPlayedAt || Number(doc.progress?.attempts || 0));
    return state.libraryFilter === "all" || (state.libraryFilter === "played" ? played : !played);
  });
  const shownEntries=entries.slice(0,state.libraryLimit),selectedIds=shownEntries.map(item=>item.id); getSelectionModel("library",selectedIds);
  app.innerHTML = `<div class="shell">${header("library")}<main class="main-content"><div class="page-heading"><div><div class="eyebrow">Your collection</div><h1>Library</h1><p>Levels you have imported and can play from this device.</p></div><div class="library-actions"><button class="btn primary" data-action="browse">${icon("import")}<span>Import files</span></button>${supportsDirectorySelection()?`<button class="btn" data-action="browse-folder">Import folder</button>`:""}</div></div>${batchImportStatusMarkup()}
    <div class="library-toolbar"><label class="search-wrap">${icon("search")}<input class="search" id="search" type="search" placeholder="Search levels, creators, songs" value="${esc(state.search)}" aria-label="Search levels"></label><div class="filter-row" aria-label="Filter levels"><button class="filter ${state.libraryFilter === "all" ? "selected" : ""}" data-action="library-filter" data-filter="all">All levels</button><button class="filter ${state.libraryFilter === "played" ? "selected" : ""}" data-action="library-filter" data-filter="played">Played</button><button class="filter ${state.libraryFilter === "new" ? "selected" : ""}" data-action="library-filter" data-filter="new">Not played</button></div><div class="view-switch"><button class="view-button ${state.libraryView === "grid" ? "selected" : ""}" data-action="library-view" data-view="grid" aria-label="Grid view">▦</button><button class="view-button ${state.libraryView === "list" ? "selected" : ""}" data-action="library-view" data-view="list" aria-label="List view">☷</button></div>${selectionToolbar("library",selectedIds,{resourceType:"levels"})}</div>${advancedSearchMarkup("library")}
    ${entries.length ? `<div class="section-head"><div><h2>${entries.length} ${entries.length === 1 ? "level" : "levels"}</h2><p>Showing ${shownEntries.length} · Sorted by recently added</p></div></div><div class="level-grid ${state.libraryView === "list" ? "list-view" : ""}">${shownEntries.map(entry => levelCard(entry.document, entry.applicationMetadata)).join("")}</div>${shownEntries.length<entries.length?`<button class="btn load-more" data-action="load-more" data-scope="library">Show next ${Math.min(100,entries.length-shownEntries.length)} levels</button>`:""}` : `<div class="empty-state"><h3>${query || state.libraryFilter !== "all" ? "No matching levels" : "No levels yet"}</h3><p>${query || state.libraryFilter !== "all" ? "Try another search or filter." : "Import a .gmd or .txt file to start your collection."}</p><button class="btn" data-action="browse">Browse files</button></div>`}</main></div>`;
}
async function renderDetails() {
  const entry = await getLevel(state.route.id);
  if (!entry) { renderRouteFailure(new Error("This level is no longer in your Library.")); return; }
  const d = entry.document, m = d.metadata, difficulty = m.difficulty || {}, appMeta = levelApplication(entry);
  const originalSong = m.song || {}, override = appMeta.audioOverride;
  const localAudio = override ? state.audioAssets.find(asset => asset.id === override.assetId) : null;
  const texture = appMeta.textureWorkspaceId ? state.textures.find(pack => pack.id === appMeta.textureWorkspaceId) : null;
  const objectCount = Array.isArray(d.content.parsed?.objects) ? d.content.parsed.objects.length : null;
  app.innerHTML = `<div class="shell">${header("details")}<main class="main-content level-workbench"><a class="back-link" href="#/library">← Library</a>
    <section class="detail-header"><div><div class="eyebrow">Level Workbench</div><h1>${esc(m.name)}</h1><div class="detail-author">by ${esc(m.author || "Unknown")}${m.levelId ? ` · ID ${esc(m.levelId)}` : ""}</div></div><div class="detail-actions"><button class="btn primary" data-action="play" data-id="${esc(d.id)}">${icon("play")}<span>Play level</span></button><a class="btn" href="#/library/inspect/${encodeURIComponent(d.id)}">Inspect level</a></div></section>
    <section class="workbench-section"><div class="workbench-section-heading"><div><div class="eyebrow">Overview</div><h2>Level information</h2></div><span class="workbench-source">${esc(d.source?.type || "level")} file</span></div><div class="details-grid"><div class="detail-cell"><label>Description</label><div class="description">${esc(m.description || "No description available.")}</div></div><div class="detail-cell"><label>Difficulty / Stars</label><strong>${difficulty.demon ? "Demon" : difficulty.rating ? `${esc(difficulty.rating)} rating` : "Unrated"} · ${esc(difficulty.stars || 0)} stars</strong></div><div class="detail-cell"><label>Original Geometry Dash song</label><strong>${esc(originalSong.name || "Unknown song")}${originalSong.artist ? ` · ${esc(originalSong.artist)}` : ""} · ID ${esc(originalSong.id ?? "Not present")}</strong></div><div class="detail-cell"><label>Level data</label><strong>${objectCount == null ? "Object count not parsed" : `${objectCount.toLocaleString()} objects`} · ${esc(m.version ?? "Version not present")}</strong></div><div class="detail-cell"><label>Progress</label><strong>Normal ${esc(d.progress?.normal || 0)}% · Practice ${esc(d.progress?.practice || 0)}% · ${esc(d.progress?.attempts || 0)} attempts</strong></div><div class="detail-cell"><label>Provenance</label><strong>${esc(d.source?.filename || "Unknown source")}${d.source?.fileSize ? ` · ${fmtBytes(d.source.fileSize)}` : ""} · Imported ${esc(fmtDate(d.timestamps?.importedAt))}</strong><small>Source: local file${d.timestamps?.updatedAt ? ` · Updated ${esc(fmtDate(d.timestamps.updatedAt))}` : ""}</small></div><div class="detail-cell"><label>Last played</label><strong>${esc(fmtDate(d.timestamps?.lastPlayedAt))}</strong></div></div></section>
    <section class="workbench-section"><div class="workbench-section-heading"><div><div class="eyebrow">Playback</div><h2>Song source</h2></div></div><div class="song-override-row"><div><strong>${override ? esc(localAudio?.displayName || "Song unavailable") : esc(originalSong.name || "Unknown song")}</strong><p>${override ? localAudio ? `Local file · ${esc(localAudio.filename)}` : "The linked local audio file has been deleted. Original game song behavior remains available." : "Using the song reference stored in the original Geometry Dash data."}</p></div><div class="song-assignment-controls"><label for="level-audio-select">Local override</label><select id="level-audio-select" data-level-id="${esc(d.id)}"><option value="">Use original song</option>${state.audioAssets.map(asset => `<option value="${esc(asset.id)}" ${asset.id === override?.assetId ? "selected" : ""}>${esc(asset.displayName)} · ${esc(asset.filename)}</option>`).join("")}</select><a class="text-link" href="#/tools/audio">Manage local songs →</a></div></div>${localAudio ? `<audio class="workbench-audio" id="details-audio-preview" controls preload="none" aria-label="Preview ${esc(localAudio.displayName)}"></audio>` : ""}</section>
    <section class="workbench-section"><div class="workbench-section-heading"><div><div class="eyebrow">Assets</div><h2>Linked resources</h2></div></div><div class="linked-assets"><div class="linked-asset-row"><span class="linked-asset-type">Texture workspace</span>${appMeta.textureWorkspaceId ? texture ? `<a href="#/tools/textures/${encodeURIComponent(texture.id)}">${esc(texture.name)} →</a>` : `<span class="asset-unavailable">Texture workspace unavailable</span>` : `<span>No texture workspace linked</span>`}<select class="link-select" id="level-texture-select" data-level-id="${esc(d.id)}" aria-label="Link a texture workspace"><option value="">No texture workspace</option>${state.textures.map(pack => `<option value="${esc(pack.id)}" ${pack.id === appMeta.textureWorkspaceId ? "selected" : ""}>${esc(pack.name)}</option>`).join("")}</select></div><div class="linked-asset-row"><span class="linked-asset-type">Imported source</span><span>${esc(d.source?.filename || "Unknown file")}${d.source?.fileSize ? ` · ${fmtBytes(d.source.fileSize)}` : ""}</span><span>Original level payload is kept separately.</span></div></div></section>
    <section class="workbench-section"><div class="workbench-section-heading"><div><div class="eyebrow">Application metadata</div><h2>Tags and notes</h2></div></div><div class="level-app-fields"><label>Tags <input id="level-tags" data-level-id="${esc(d.id)}" value="${esc((appMeta.tags || []).join(", "))}" placeholder="comma-separated tags"></label><label>Notes <textarea id="level-notes" data-level-id="${esc(d.id)}" rows="3" placeholder="Private notes stored in this browser">${esc(appMeta.notes || "")}</textarea></label><button class="btn" data-action="save-level-app-meta" data-id="${esc(d.id)}">Save notes and tags</button><span>These fields are GMDPlayer metadata and never modify the source level string.</span></div></section>
  </main></div>`;
  if (localAudio) attachAudioPreview(document.querySelector("#details-audio-preview"), localAudio);
}
async function renderInspect() {
  const entry = await getLevel(state.route.id);
  if (!entry) { renderRouteFailure(new Error("This level is no longer in your Library.")); return; }
  const d = entry.document, stats = inspectLevelDocument(d);
  const ordered = rows => {
    const filtered = filterFrequency(rows, state.inspectorQuery);
    if (state.inspectorSort === "id") filtered.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    else filtered.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id, undefined, { numeric: true }));
    return filtered.slice(0, state.inspectorLimit);
  };
  const objectRows = ordered(stats.objectFrequency);
  const triggerRows = ordered(stats.triggerFrequency);
  const portalRows = ordered(stats.portalFrequency);
  const active = state.inspectorTab;
  app.innerHTML = `<div class="shell">${header("inspect")}<main class="main-content level-inspector"><a class="back-link" href="#/library/${encodeURIComponent(d.id)}">← ${esc(d.metadata.name)}</a><div class="page-heading"><div><div class="eyebrow">Read-only analysis</div><h1>${esc(d.metadata.name)}</h1><p>Statistics are derived from the cached parse. The source string is unchanged.</p></div><a class="btn" href="#/library/${encodeURIComponent(d.id)}">Level details</a></div>
    <nav class="inspector-tabs" aria-label="Inspector views"><button class="save-tab ${active === "summary" ? "selected" : ""}" data-action="inspector-tab" data-tab="summary">Human-readable</button><button class="save-tab ${active === "raw" ? "selected" : ""}" data-action="inspector-tab" data-tab="raw">Raw & decoded</button></nav>
    ${active === "summary" ? `<section class="inspector-summary"><div><span>Objects</span><strong>${stats.objectCount.toLocaleString()}</strong></div><div><span>Unique object IDs</span><strong>${stats.uniqueObjectIds.toLocaleString()}</strong></div><div><span>Recognized triggers</span><strong>${stats.recognizedTriggerCount.toLocaleString()}</strong><small>Partial known-ID mapping</small></div><div><span>Recognized portals</span><strong>${stats.portalCount.toLocaleString()}</strong><small>Partial known-ID mapping</small></div></section><section class="workbench-section"><div class="workbench-section-heading"><div><div class="eyebrow">Metadata</div><h2>Level and source</h2></div></div><div class="inspector-metadata-grid"><div><span>Name</span><strong>${esc(d.metadata.name)}</strong></div><div><span>Author</span><strong>${esc(d.metadata.author)}</strong></div><div><span>Level ID</span><strong>${esc(d.metadata.levelId ?? "Not present")}</strong></div><div><span>Original song</span><strong>${esc(d.metadata.song?.name || "Unknown song")} · ID ${esc(d.metadata.song?.id ?? "Not present")}</strong></div><div><span>Source file</span><strong>${esc(d.source?.filename || "Unknown")}</strong></div><div><span>Imported</span><strong>${esc(fmtDate(d.timestamps?.importedAt))}</strong></div>${stats.startPosition.map((position, index) => `<div><span>Start position ${index + 1}</span><strong>${esc(position.x)}, ${esc(position.y)} · ${esc(position.type)}</strong></div>`).join("") || `<div><span>Start position</span><strong>Not found in recognized IDs</strong></div>`}</div></section><section class="workbench-section"><div class="workbench-section-heading"><div><div class="eyebrow">Object inventory</div><h2>Object IDs</h2></div><div class="inspector-table-tools"><label class="inspector-filter">Filter <input id="inspector-search" value="${esc(state.inspectorQuery)}" placeholder="ID or trigger type"></label><label class="inspector-filter">Sort <select id="inspector-sort"><option value="count" ${state.inspectorSort === "count" ? "selected" : ""}>Most common</option><option value="id" ${state.inspectorSort === "id" ? "selected" : ""}>Object ID</option></select></label></div></div><div class="inspector-table-wrap"><table class="workbench-table"><thead><tr><th>Object ID</th><th>Count</th></tr></thead><tbody>${objectRows.map(row => `<tr><td>${esc(row.id)}</td><td>${row.count.toLocaleString()}</td></tr>`).join("") || `<tr><td colspan="2">No object IDs match this filter.</td></tr>`}</tbody></table></div>${stats.objectFrequency.length > objectRows.length ? `<button class="btn" data-action="inspector-more">Show more (${Math.min(100, stats.objectFrequency.length - objectRows.length)})</button>` : ""}</section><div class="inspector-paired-tables"><section class="workbench-section"><div class="eyebrow">Known mapping subset</div><h2>Trigger frequency</h2><div class="inspector-table-wrap"><table class="workbench-table"><thead><tr><th>Trigger</th><th>ID</th><th>Count</th></tr></thead><tbody>${triggerRows.map(row => `<tr><td>${esc(row.name)}</td><td>${esc(row.id)}</td><td>${row.count.toLocaleString()}</td></tr>`).join("") || `<tr><td colspan="3">No recognized trigger IDs found.</td></tr>`}</tbody></table></div></section><section class="workbench-section"><div class="eyebrow">Known mapping subset</div><h2>Portal frequency</h2><div class="inspector-table-wrap"><table class="workbench-table"><thead><tr><th>Portal</th><th>ID</th><th>Count</th></tr></thead><tbody>${portalRows.map(row => `<tr><td>${esc(row.name)}</td><td>${esc(row.id)}</td><td>${row.count.toLocaleString()}</td></tr>`).join("") || `<tr><td colspan="3">No recognized portal IDs found.</td></tr>`}</tbody></table></div></section></div><section class="workbench-section"><div class="workbench-section-heading"><div><div class="eyebrow">Parsed header</div><h2>Raw settings fields</h2></div></div><div class="inspector-settings">${stats.settings.map(item => `<div><code>${esc(item.key)}</code><span>${esc(item.value)}</span></div>`).join("") || `<p>No header fields were parsed.</p>`}</div></section>` : `<section class="workbench-section"><div class="eyebrow">Preserved source</div><h2>Original level string</h2><p>This is the imported Geometry Dash payload. GMDPlayer metadata and local audio links are stored separately.</p><pre class="save-raw inspector-raw">${esc(d.content.raw || "No source string available.")}</pre><details class="inspector-decoded"><summary>Decoded structured representation</summary><pre class="save-raw">${esc(JSON.stringify(d.content.parsed || {}, null, 2))}</pre></details></section>`}
  </main></div>`;
}
function projectResourceEntries(project) {
  const groups = [
    { type: "levels", label: "Levels", records: state.levels, id: item => item.id, name: item => item.document?.metadata?.name || "Untitled level", detail: item => item.document?.source?.filename || "Imported level", href: item => `#/library/${encodeURIComponent(item.id)}` },
    { type: "audioAssets", label: "Songs", records: state.audioAssets, id: item => item.id, name: item => item.displayName || item.filename, detail: item => item.filename || "Local audio", href: () => "#/tools/audio" },
    { type: "textureWorkspaces", label: "Texture workspaces", records: state.textures, id: item => item.id, name: item => item.name || "Texture workspace", detail: item => `${item.sheetCount||0} sheets`, href: item => `#/tools/textures/${encodeURIComponent(item.id)}` },
    { type: "saveSnapshots", label: "Save snapshots", records: state.saves, id: item => item.id, name: item => item.sourceFilenames?.join(" + ") || "Geometry Dash save", detail: item => `${item.document?.normalized?.localLevels?.length || 0} local levels`, href: item => `#/tools/save/${encodeURIComponent(item.id)}` }
  ];
  return groups.map(group => {
    const membership = project.resources?.[group.type] || [];
    const items = membership.map(resourceId => {
      const record = group.records.find(item => group.id(item) === resourceId);
      return record ? { id: resourceId, name: group.name(record), detail: group.detail(record), href: group.href(record), record, missing: false } : { id: resourceId, name: "Resource unavailable", detail: `Missing ${group.label.toLowerCase()} reference`, href: "", record: null, missing: true };
    });
    return { ...group, membership, items };
  });
}
function projectTaskStatus() {
  const progress = state.projectProgress;
  if (!progress) return "";
  const percent = progress.total ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  return `<div class="project-task-status" role="status"><div><strong>${esc(progress.message || "Working with project archive…")}</strong><span>${progress.total ? `${progress.current} / ${progress.total}` : "Preparing"}</span></div><div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>${state.projectAbortController && state.projectProgress?.stage !== "commit" ? `<button class="btn small" data-action="project-cancel">Cancel</button>` : ""}</div>`;
}
function renderProjects() {
  const projectQuery=state.projectQuery||"";
  const visible = filterResources(state.projects.filter(project => !project.archivedAt).map(project=>({...project,kind:"project",author:project.description,date:project.updatedAt})),{query:projectQuery,tags:normalizeTags(String(state.searchFilters.projects.tags||"").split(",")),favorite:state.searchFilters.projects.favorite});
  const archived = state.projects.filter(project => project.archivedAt), visibleProjects=visible.slice(0,state.projectLimit), archivedVisible=archived.slice(0,state.projectLimit);
  getSelectionModel("projects",visibleProjects.map(item=>item.id)); getSelectionModel("projects-archived",archivedVisible.map(item=>item.id));
  const projectRow = (project,scope) => {
    const counts = Object.values(project.resources || {}).map(ids => ids?.length || 0);
    const countText = `${counts[0]} levels · ${counts[1]} songs · ${counts[2]} texture packs · ${counts[3]} saves`;
    const picked=state.selections[scope]?.has(project.id); return `<article class="project-list-row ${project.archivedAt ? "archived" : ""} ${picked?"selection-selected":""}" data-selectable="${scope}" data-id="${esc(project.id)}" tabindex="0" role="option" aria-selected="${!!picked}"><input class="item-selection" type="checkbox" data-select-item="${scope}" data-id="${esc(project.id)}" aria-label="Select ${esc(project.name)}" ${picked?"checked":""}><a class="project-row-main" href="#/projects/${encodeURIComponent(project.id)}" data-action="project-open" data-id="${esc(project.id)}"><span class="project-folder-mark">▱</span><span class="project-row-copy"><strong>${esc(project.name)}</strong><small>${esc(project.description || "No description")}</small><small>${countText} · Updated ${esc(fmtDate(project.updatedAt))}</small></span></a><div class="project-row-actions">${project.archivedAt ? `<a class="btn small" href="#/projects/${encodeURIComponent(project.id)}">View</a>` : `<button class="btn small" data-action="project-open" data-id="${esc(project.id)}">Open</button>`}${project.archivedAt ? `<button class="btn small" data-action="project-unarchive" data-id="${esc(project.id)}">Restore</button>` : `<button class="btn small" data-action="project-duplicate" data-id="${esc(project.id)}">Duplicate</button>`}</div></article>`;
  };
  app.innerHTML = `<div class="shell">${header("projects")}<main class="main-content project-browser"><div class="page-heading"><div><div class="eyebrow">Local workspaces</div><h1>Projects</h1><p>Group global levels, songs, texture workspaces, and save snapshots without moving or duplicating their original records.</p></div><div class="project-page-actions"><button class="btn primary" data-action="project-create">New project</button><button class="btn" data-action="project-import-open">Import / restore</button></div></div>${state.activeProject ? `<div class="active-project-banner"><span>Current project</span><a href="#/projects/${encodeURIComponent(state.activeProject.id)}"><strong>${esc(state.activeProject.name)}</strong> →</a><button class="btn small" data-action="project-deactivate">Clear active project</button></div>` : ""}<section class="project-list-section"><div class="workbench-section-heading"><div><div class="eyebrow">Your workspaces</div><h2>${visible.length} ${visible.length === 1 ? "project" : "projects"}</h2></div></div><div class="project-toolbar"><input id="project-search" type="search" value="${esc(projectQuery)}" placeholder="Search projects" aria-label="Search projects">${selectionToolbar("projects",visibleProjects.map(item=>item.id),{type:"projects"})}</div>${advancedSearchMarkup("projects")}<div class="project-list">${visibleProjects.map(project=>projectRow(project,"projects")).join("") || `<div class="empty-state"><h3>No projects yet</h3><p>Create a project to group your existing global resources. Assets stay in the Library and can belong to multiple projects.</p><button class="btn primary" data-action="project-create">Create project</button></div>`}</div>${visibleProjects.length<visible.length?`<button class="btn load-more" data-action="load-more" data-scope="projects">Show next projects</button>`:""}</section>${archived.length ? `<section class="project-list-section"><div class="workbench-section-heading"><div><div class="eyebrow">Archived</div><h2>Archived projects</h2></div></div>${selectionToolbar("projects-archived",archivedVisible.map(item=>item.id),{type:"projects"})}<div class="project-list">${archivedVisible.map(project=>projectRow(project,"projects-archived")).join("")}</div>${archivedVisible.length<archived.length?`<button class="btn load-more" data-action="load-more" data-scope="projects-archived">Show next archived projects</button>`:""}</section>` : ""}<section class="project-footer-actions"><p>Global Library resources remain available whether or not they belong to a project.</p><a class="text-link" href="#/library">Open global Library →</a></section></main></div>`;
}
async function renderProjectDetail() {
  const project = await getProject(state.route.id);
  if (!project) { renderRouteFailure(new Error("This project is no longer available.")); return; }
  const groups = projectResourceEntries(project);
  const query = state.projectMemberQuery.trim().toLowerCase();
  const already = new Set(PROJECT_RESOURCE_TYPES.flatMap(type => project.resources?.[type] || []).map(id => `${id}`));
  const candidates = [
    ...state.levels.map(record => ({ type: "levels", id: record.id, name: record.document?.metadata?.name || "Untitled level", detail: record.document?.source?.filename || "Level file" })),
    ...state.audioAssets.map(record => ({ type: "audioAssets", id: record.id, name: record.displayName || record.filename, detail: record.filename || "Audio file" })),
    ...state.textures.map(record => ({ type: "textureWorkspaces", id: record.id, name: record.name || "Texture workspace", detail: `${record.sheetCount||0} sheets` })),
    ...state.saves.map(record => ({ type: "saveSnapshots", id: record.id, name: record.sourceFilenames?.join(" + ") || "Save snapshot", detail: "Save Explorer snapshot" }))
  ].filter(item => !already.has(item.id) && (!query || `${item.name} ${item.detail} ${item.type} ${item.id}`.toLowerCase().includes(query))).slice(0, 30);
  const recent = groups.flatMap(group => group.items.filter(item => item.record).map(item => ({ ...item, type: group.type, updatedAt: item.record.updatedAt || item.record.importedAt || item.record.document?.timestamps?.updatedAt || item.record.document?.metadata?.importedAt || 0 }))).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const counts = groups.map(group => `${group.items.length} ${group.label.toLowerCase()}`).join(" · ");
  app.innerHTML = `<div class="shell">${header("projects")}<main class="main-content project-detail-page"><a class="back-link" href="#/projects">← Projects</a><div class="project-title-line"><div><div class="eyebrow">${state.activeProjectId === project.id ? "Active project" : "GMDPlayer project"}</div><h1>${esc(project.name)}</h1><p>${esc(project.description || "No project description yet.")}</p><small>Created ${esc(fmtDate(project.createdAt))} · Updated ${esc(fmtDate(project.updatedAt))} · ID ${esc(project.id)}</small></div><div class="project-detail-actions">${state.activeProjectId === project.id ? `<span class="active-project-tag">Current project</span>` : project.archivedAt ? `<span class="active-project-tag">Archived · restore to open</span>` : `<button class="btn primary" data-action="project-activate" data-id="${esc(project.id)}">Open project</button>`}<button class="btn" data-action="project-export" data-id="${esc(project.id)}">Export .gmdproject</button><button class="btn" data-action="project-import-open">Import / restore</button><button class="btn" data-action="project-duplicate" data-id="${esc(project.id)}">Duplicate</button></div></div>${projectTaskStatus()}<div class="project-summary-line"><strong>${counts}</strong><span>Membership references global resources; it does not own or move them.</span></div><div class="project-overview-columns"><section class="project-content-panel"><div class="workbench-section-heading"><div><div class="eyebrow">Project contents</div><h2>Resources</h2></div></div>${groups.map(group => { const scope=`project-members-${project.id}-${group.type}`,memberIds=group.items.filter(item=>!item.missing).map(item=>item.id);state.selectionContexts[scope]={type:group.type};getSelectionModel(scope,memberIds);return `<section class="project-resource-group"><div class="project-resource-heading"><strong>${esc(group.label)}</strong><span>${group.items.length}</span><a href="${group.type === "levels" ? "#/library" : group.type === "audioAssets" ? "#/tools/audio" : group.type === "textureWorkspaces" ? "#/tools/textures" : "#/tools/save"}">Open global view →</a></div>${selectionToolbar(scope,memberIds,{type:"membership",projectId:project.id,resourceType:group.type})}<div class="project-resource-list">${group.items.map(item => {const picked=state.selections[scope]?.has(item.id);return `<div class="project-resource-row ${picked?"selection-selected":""}" ${!item.missing?`data-selectable="${esc(scope)}" data-id="${esc(item.id)}" tabindex="0" role="option" aria-selected="${!!picked}"`:""}>${!item.missing?`<input class="item-selection" type="checkbox" data-select-item="${esc(scope)}" data-id="${esc(item.id)}" aria-label="Select ${esc(item.name)}" ${picked?"checked":""}>`:""}<span class="project-resource-status ${item.missing ? "missing" : ""}">${item.missing ? "Unavailable" : "Included"}</span><div>${item.href ? `<a href="${item.href}"><strong>${esc(item.name)}</strong></a>` : `<strong>${esc(item.name)}</strong>`}<small>${esc(item.detail)}</small></div><button class="btn small" data-action="project-remove-member" data-project="${esc(project.id)}" data-type="${esc(group.type)}" data-resource-id="${esc(item.id)}">Remove</button></div>`;}).join("") || `<p class="project-no-resources">No ${group.label.toLowerCase()} in this project.</p>`}</div></section>`;}).join("")}</section><aside class="project-side-panel"><section class="workbench-section project-settings"><div class="eyebrow">Project settings</div><h2>Details</h2><label>Name<input id="project-name" value="${esc(project.name)}" maxlength="180"></label><label>Description<textarea id="project-description" rows="4" maxlength="4000">${esc(project.description)}</textarea></label><button class="btn" data-action="project-save" data-id="${esc(project.id)}">Save details</button><div class="project-settings-actions"><button class="btn" data-action="project-archive" data-id="${esc(project.id)}">${project.archivedAt ? "Unarchive project" : "Archive project"}</button><button class="btn danger ghost" data-action="project-delete" data-id="${esc(project.id)}">Remove project</button></div></section><section class="workbench-section project-member-add"><div class="eyebrow">Membership</div><h2>Add existing resources</h2><p>Search global assets to add them here. A resource can belong to multiple projects.</p><label class="search-wrap">${icon("search")}<input id="project-member-search" type="search" value="${esc(state.projectMemberQuery)}" placeholder="Find levels, songs, packs, saves" aria-label="Search global resources"></label><div class="project-candidate-list">${candidates.map(item => `<div class="project-candidate-row"><div><strong>${esc(item.name)}</strong><small>${esc(item.detail)} · ${esc(item.type.replace(/([A-Z])/g, " $1"))}</small></div><button class="btn small" data-action="project-add-member" data-project="${esc(project.id)}" data-type="${esc(item.type)}" data-resource-id="${esc(item.id)}">Add</button></div>`).join("") || `<p class="project-no-resources">${query ? "No matching unassigned resources." : "All available resources are already included."}</p>`}</div></section><section class="workbench-section project-activity"><div class="eyebrow">Recent activity</div><h2>Recently updated</h2>${recent.map(item => `<a class="project-activity-row" href="${item.href}"><strong>${esc(item.name)}</strong><small>${esc(fmtDate(item.updatedAt))} · ${esc(item.type)}</small></a>`).join("") || `<p class="project-no-resources">Project activity will appear as resources are added or updated.</p>`}</section></aside></div><p class="project-delete-note">Removing this project only removes its project record. Its ${counts} remain in global storage.</p></main></div>`;
}
function renderProjectRestore() {
  const preview = state.restorePreview;
  app.innerHTML = `<div class="shell">${header("projects")}<main class="main-content project-restore-page"><a class="back-link" href="#/projects">← Projects</a><div class="page-heading"><div><div class="eyebrow">Portable workspace</div><h1>Import or restore project</h1><p>Backups are validated before any records are written. Restore is additive; existing resources are never replaced.</p></div><button class="btn primary" data-action="project-import-open">Choose .gmdproject</button></div>${projectTaskStatus()}${preview ? `<section class="workbench-section restore-preview"><div class="eyebrow">Backup preview</div><h2>${esc(preview.project.name)}</h2><p>${esc(preview.project.description || "No description")} · Created ${esc(fmtDate(preview.project.createdAt))} · Backup contents ${fmtBytes(preview.totalBytes)}</p><div class="restore-category-options">${PROJECT_RESOURCE_TYPES.map(type => { const labels = { levels: "Levels", audioAssets: "Songs", textureWorkspaces: "Texture workspaces", saveSnapshots: "Save snapshots" }; const resources = preview.manifest.resources.filter(item => item.type === type); const selectedCount = resources.filter(item => state.restoreResourceKeys.has(`${type}:${item.originalId}`)).length; return `<section class="restore-category"><label><input type="checkbox" data-restore-category="${type}" ${resources.length && selectedCount === resources.length ? "checked" : ""}><strong>${labels[type]}</strong><span>${selectedCount} / ${resources.length} selected</span></label><div class="restore-resource-list">${resources.map(item => { const key = `${type}:${item.originalId}`; return `<label><input type="checkbox" data-restore-resource="${esc(key)}" ${state.restoreResourceKeys.has(key) ? "checked" : ""}><span><strong>${esc(item.filename || item.provenance?.filename || item.originalId)}</strong><small>Original ID ${esc(item.originalId)}${item.provenance?.origin ? ` · ${esc(item.provenance.origin)}` : ""}</small></span></label>`; }).join("") || `<small class="muted">None included</small>`}</div></section>`; }).join("")}</div>${preview.missingReferences?.length ? `<p class="restore-warning">${preview.missingReferences.length} references were already missing in the source project; they will remain marked unavailable.</p>` : ""}<div class="restore-actions"><button class="btn" data-action="project-restore-cancel">Cancel</button><button class="btn primary" data-action="project-restore">Restore selected resources</button></div></section>` : `<section class="restore-dropzone"><div class="restore-file-symbol">↥</div><h2>Select a GMDPlayer project backup</h2><p>Choose a .gmdproject archive to validate its manifest and inspect its contents. Your Library is not changed during preview.</p><button class="btn primary" data-action="project-import-open">Choose backup file</button></section>`}<div class="restore-safety-note">Archives are checked for safe paths, resource IDs, file sizes, and CRC-32 checksums before restore. Imported records receive new local IDs.</div></main></div>`;
}

function renderTools() {
  const visibleSaves=state.saves.slice(0,state.saveLimit);getSelectionModel("saves",visibleSaves.map(save=>save.id));
  app.innerHTML = `<div class="shell">${header("tools")}<main class="main-content"><div class="page-heading"><div><div class="eyebrow">Workspace</div><h1>Tools</h1><p>Explore your Geometry Dash files locally.</p></div></div>
    <div class="workspace-tool-grid"><a class="workspace-tool-link" href="#/tools/assets"><span class="tool-link-icon">${icon("library")}</span><div><strong>Asset Browser</strong><small>${state.levels.length} levels · ${state.audioAssets.length} songs · ${state.textures.length} texture packs</small></div><span>Open →</span></a><a class="workspace-tool-link" href="#/tools/audio"><span class="tool-link-icon">${icon("play")}</span><div><strong>Songs & Audio</strong><small>Local audio library and song overrides</small></div><span>Open →</span></a></div>
    <section class="save-tool-card"><div><div class="eyebrow">On this device</div><h2>Save Explorer</h2><p>Inspect CCGameManager.dat and CCLocalLevels.dat, then pull created levels into your Library.</p><button class="btn primary" data-action="browse">Import save files</button> <button class="btn" data-action="open-save">Open Save Explorer</button></div><span class="local-badge"><i></i>Local only</span></section>
    ${state.saves.length ? `<div class="section-head tools-section-head"><div><h2>Recent saves</h2></div></div>${selectionToolbar("saves",visibleSaves.map(save=>save.id),{type:"saves",resourceType:"saveSnapshots"})}<div class="save-recent-list">${visibleSaves.map(save => {const picked=state.selections.saves?.has(save.id);return `<div class="selectable-recent ${picked?"selection-selected":""}" data-selectable="saves" data-id="${esc(save.id)}" tabindex="0" role="option" aria-selected="${!!picked}"><input class="item-selection" type="checkbox" data-select-item="saves" data-id="${esc(save.id)}" aria-label="Select snapshot ${esc(save.sourceFilenames?.join(" + ")||"save")}" ${picked?"checked":""}><button class="save-recent" data-action="open-save" data-id="${esc(save.id)}"><span><strong>${esc(save.sourceFilenames?.join(" + ") || "Geometry Dash save")}</strong><small>Imported ${esc(fmtDate(save.importedAt))} · ${esc(save.document?.normalized?.localLevels?.length || 0)} local levels</small></span><span>Open →</span></button></div>`}).join("")}</div>${visibleSaves.length<state.saves.length?`<button class="btn load-more" data-action="load-more" data-scope="saves">Show next save snapshots</button>`:""}` : `<div class="empty-state"><h3>No save snapshots yet</h3><p>Choose one or both Geometry Dash .dat files to explore a local snapshot.</p></div>`}
    <section class="save-tool-card texture-tool-card"><div><div class="eyebrow">Creative workspace</div><h2>Texture Pack Editor</h2><p>Browse atlas sprites, inspect XML PLIST metadata, replace exact slots, split or repack sheets, and export ZIP packs.</p><button class="btn primary" data-action="browse">Import PNG / PLIST / ZIP</button> <button class="btn" data-action="open-textures">Open Texture Workspace</button></div><span class="local-badge"><i></i>Originals preserved</span></section>
    ${state.textures.length ? `<div class="section-head tools-section-head"><div><h2>Texture workspaces</h2></div></div><div class="save-recent-list">${state.textures.map(pack => `<button class="save-recent" data-action="open-texture" data-id="${esc(pack.id)}"><span><strong>${esc(pack.name)}</strong><small>${pack.sheetCount||0} sheets · Updated ${esc(fmtDate(pack.updatedAt))}</small></span><span>Open →</span></button>`).join("")}</div>` : ""}</main></div>`;
}
function audioUsageCount(assetId) {
  return state.levels.filter(record => record.applicationMetadata?.audioOverride?.assetId === assetId).length;
}
function renderAudioWorkspace() {
  if (!state.audioAssets.some(asset => asset.id === state.audioSelectedId)) state.audioSelectedId = state.audioAssets[0]?.id || null;
  let assets = searchAudioAssets(state.audioAssets, state.audioQuery);
  assets = filterResources(assets.map(asset=>({ ...asset, id:asset.id, kind:"audio", name:asset.displayName, filename:asset.filename, format:asset.mimeType, author:[asset.artist,asset.album,asset.notes,asset.gdSongId], size:asset.fileSize,duration:asset.duration,tags:asset.tags, favorite:asset.favorite, date:asset.importedAt, projectIds:linkedProjects("audioAssets",asset.id).map(item=>item.id) })), searchDefinition("audio",state.audioQuery,"audio"));
  const filteredAudioIds = new Set(assets.map(item=>item.id)); assets=state.audioAssets.filter(item=>filteredAudioIds.has(item.id));
  if (state.audioFilter !== "all") assets = assets.filter(asset => `.${asset.filename.split(".").pop().toLowerCase()}` === state.audioFilter);
  assets = [...assets].sort((a, b) => {
    if (state.audioSort === "date") return b.importedAt - a.importedAt;
    if (state.audioSort === "size") return b.fileSize - a.fileSize;
    if (state.audioSort === "duration") return (b.duration || 0) - (a.duration || 0);
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  });
  const totalAudioResults=assets.length, visibleAssets=assets.slice(0,state.audioLimit);getSelectionModel("audio",visibleAssets.map(item=>item.id));
  const selected = state.audioAssets.find(asset => asset.id === state.audioSelectedId);
  const usages = selected ? state.levels.filter(record => record.applicationMetadata?.audioOverride?.assetId === selected.id) : [];
  app.innerHTML = `<div class="shell">${header("audio")}<main class="main-content audio-workspace"><a class="back-link" href="#/tools">← Tools</a><div class="page-heading"><div><div class="eyebrow">Local asset library</div><h1>Songs & Audio</h1><p>Audio files stay in this browser. Original files are retained as imported.</p></div><div class="library-actions"><button class="btn primary" data-action="browse-audio">${icon("import")}<span>Import audio</span></button>${supportsDirectorySelection()?`<button class="btn" data-action="browse-folder">Import folder</button>`:""}</div></div>${batchImportStatusMarkup()}<div class="audio-library-toolbar"><label class="search-wrap">${icon("search")}<input id="audio-search" class="search" type="search" value="${esc(state.audioQuery)}" placeholder="Search name, filename, artist, metadata" aria-label="Search local audio"></label><label class="audio-select-filter">Format<select id="audio-filter"><option value="all">All formats</option>${[...new Set(state.audioAssets.map(asset => `.${asset.filename.split(".").pop().toLowerCase()}`))].sort().map(ext => `<option value="${esc(ext)}" ${state.audioFilter === ext ? "selected" : ""}>${esc(ext.toUpperCase())}</option>`).join("")}</select></label><label class="audio-select-filter">Sort<select id="audio-sort"><option value="name" ${state.audioSort === "name" ? "selected" : ""}>Name</option><option value="date" ${state.audioSort === "date" ? "selected" : ""}>Recently imported</option><option value="size" ${state.audioSort === "size" ? "selected" : ""}>File size</option><option value="duration" ${state.audioSort === "duration" ? "selected" : ""}>Duration</option></select></label><span class="audio-count">${totalAudioResults} results · showing ${visibleAssets.length} of ${state.audioAssets.length}</span>${selectionToolbar("audio",visibleAssets.map(item=>item.id),{resourceType:"audioAssets"})}</div>${advancedSearchMarkup("audio")}
    <div class="audio-browser-layout"><section class="audio-table-panel"><div class="audio-table-scroll"><table class="workbench-table audio-table"><thead><tr><th>Name</th><th>Duration</th><th>Format</th><th>Size</th><th>Used by</th><th>Imported</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${visibleAssets.map(asset => {
      const active = asset.id === state.audioSelectedId, uses = audioUsageCount(asset.id);
      const isSelected=state.selections.audio?.has(asset.id); return `<tr class="${active ? "selected" : ""} ${isSelected ? "selection-selected" : ""}" data-selectable="audio" data-id="${esc(asset.id)}" tabindex="0" role="option" aria-selected="${!!isSelected}"><td><input class="item-selection" type="checkbox" data-select-item="audio" data-id="${esc(asset.id)}" aria-label="Select ${esc(asset.displayName)}" ${isSelected?"checked":""}> <button class="audio-name-button" data-action="audio-select" data-id="${esc(asset.id)}"><strong>${esc(asset.displayName)}</strong><small>${esc(asset.filename)}</small></button></td><td data-audio-duration="${esc(asset.id)}">${fmtDuration(asset.duration)}</td><td>${esc(asset.filename.split(".").pop().toUpperCase())}</td><td>${fmtBytes(asset.fileSize)}</td><td>${uses}</td><td>${esc(fmtDate(asset.importedAt))}</td><td><button class="btn small" data-action="audio-play" data-id="${esc(asset.id)}">Preview</button></td></tr>`;
    }).join("") || `<tr><td colspan="7" class="table-empty">${state.audioAssets.length ? "No local songs match the current search/filter." : "No audio files yet. Import MP3, OGG, WAV, M4A, AAC, FLAC, or WebM files from your device."}</td></tr>`}</tbody></table></div>${visibleAssets.length<totalAudioResults?`<button class="btn load-more" data-action="load-more" data-scope="audio">Show next ${Math.min(100,totalAudioResults-visibleAssets.length)} songs</button>`:""}</section>
    <aside class="audio-inspector">${selected ? `<div class="eyebrow">Audio details</div>${state.audioEditingId === selected.id ? `<label class="field-label" for="audio-display-name">Display name</label><input id="audio-display-name" class="wide-control" value="${esc(selected.displayName)}" maxlength="180"><div class="inspector-button-row"><button class="btn primary" data-action="audio-rename-save" data-id="${esc(selected.id)}">Save name</button><button class="btn" data-action="audio-rename-cancel">Cancel</button></div>` : `<h2>${esc(selected.displayName)}</h2><button class="btn small" data-action="audio-rename" data-id="${esc(selected.id)}">Rename display label</button>`}<dl class="audio-metadata"><div><dt>Original filename</dt><dd>${esc(selected.filename)}</dd></div><div><dt>Format / MIME</dt><dd>${esc(selected.mimeType)}</dd></div><div><dt>File size</dt><dd>${fmtBytes(selected.fileSize)}</dd></div><div><dt>Duration</dt><dd>${fmtDuration(selected.duration)}</dd></div><div><dt>Source</dt><dd>Local file</dd></div><div><dt>Imported</dt><dd>${esc(fmtDate(selected.importedAt))}</dd></div><div><dt>GD song ID</dt><dd>${esc(selected.gdSongId || "Not linked")}</dd></div><div><dt>Artist / album</dt><dd>${esc([selected.artist, selected.album].filter(Boolean).join(" · ") || "Not provided")}</dd></div><div><dt>Notes</dt><dd>${esc(selected.notes || "No notes")}</dd></div></dl><details class="audio-edit-metadata"><summary>Edit song metadata</summary><label class="field-label" for="audio-gd-song-id">Geometry Dash song ID</label><input id="audio-gd-song-id" class="wide-control" value="${esc(selected.gdSongId || "")}" maxlength="64"><label class="field-label" for="audio-artist">Artist</label><input id="audio-artist" class="wide-control" value="${esc(selected.artist || "")}" maxlength="180"><label class="field-label" for="audio-album">Album</label><input id="audio-album" class="wide-control" value="${esc(selected.album || "")}" maxlength="180"><label class="field-label" for="audio-notes">Notes</label><textarea id="audio-notes" class="wide-control" rows="3" maxlength="2000">${esc(selected.notes || "")}</textarea><button class="btn" data-action="audio-metadata-save" data-id="${esc(selected.id)}">Save metadata</button></details><audio id="audio-preview" class="workbench-audio" controls preload="none" aria-label="Preview ${esc(selected.displayName)}"></audio><div class="audio-usage-list"><h3>Used by ${usages.length} ${usages.length === 1 ? "level" : "levels"}</h3>${usages.map(record => `<a href="#/library/${encodeURIComponent(record.id)}">${esc(record.document.metadata.name)} →</a>`).join("") || `<p>Not assigned to a level yet.</p>`}</div><button class="btn danger ghost" data-action="audio-delete" data-id="${esc(selected.id)}">Remove audio asset</button>` : `<div class="empty-state compact-empty"><h3>Select a song</h3><p>Choose a row to inspect metadata and level usage.</p></div>`}</aside></div>
    <p class="audio-privacy-note"><span class="status-dot"></span>Local audio is stored in IndexedDB. No music provider or external download service is used.</p></main></div>`;
  if (selected) attachAudioPreview(document.querySelector("#audio-preview"), selected);
}
function linkedProjects(type, id) { if(!membershipIndexCache){membershipIndexCache=Object.fromEntries(PROJECT_RESOURCE_TYPES.map(resourceType=>[resourceType,new Map()]));for(const project of state.projects)for(const resourceType of PROJECT_RESOURCE_TYPES)for(const resourceId of project.resources?.[resourceType]||[]){const map=membershipIndexCache[resourceType];if(!map.has(resourceId))map.set(resourceId,[]);map.get(resourceId).push({id:project.id,name:project.name});}}return membershipIndexCache[type]?.get(id)||[]; }
function getAssetRecords() {
  const result = [];
  for (const record of state.levels) result.push({ kind: "level", id: record.id, name: record.document.metadata.name, filename: record.document.source?.filename || "Unknown source", source: record.document.source?.type || "local file", size: record.document.source?.fileSize || 0, importedAt: record.document.timestamps?.importedAt, tags:record.applicationMetadata?.tags||[], favorite:record.applicationMetadata?.favorite, href: `#/library/${encodeURIComponent(record.id)}`, usage: record.document.metadata.author || "", projects: linkedProjects("levels", record.id), record });
  for (const asset of state.audioAssets) result.push({ kind: "audio", id: asset.id, name: asset.displayName, filename: asset.filename, source: asset.source, size: asset.fileSize, importedAt: asset.importedAt, tags:asset.tags||[], favorite:asset.favorite, href: "#/tools/audio", usage: `${audioUsageCount(asset.id)} linked levels`, projects: linkedProjects("audioAssets", asset.id), asset });
  for (const pack of state.textures) {
    const sourceBytes = Number(pack.sourceBytes)||0;
    result.push({ kind: "texture", id: pack.id, name: pack.name, filename: pack.sourceFiles?.map(file => file.name).join(" + ") || "Texture pack", source: pack.sourceType || "local import", size: sourceBytes, importedAt: pack.createdAt, tags:pack.tags||[], favorite:pack.favorite, href: `#/tools/textures/${encodeURIComponent(pack.id)}`, usage: state.levels.filter(record => record.applicationMetadata?.textureWorkspaceId === pack.id).length + " linked levels", projects: linkedProjects("textureWorkspaces", pack.id), pack });
  }
  return result;
}
function renderAssetsWorkspace() {
  const query = state.assetQuery.trim().toLowerCase();
  const all = getAssetRecords();
  const rows = sortResources(filterResources(all.map(item=>({ ...item, type:item.kind, author:item.source, song:item.usage, date:item.importedAt, projectIds:item.projects.map(project=>project.id), projectNames:item.projects.map(project=>project.name) })),searchDefinition("assets",query,state.assetFilter)),state.assetSort==="name"?"name":state.assetSort==="size"?"size":"date",state.assetSort==="name"?"asc":"desc");
  const visibleRows=rows.slice(0,state.assetLimit);getSelectionModel("assets",visibleRows.map(item=>item.id));
  app.innerHTML = `<div class="shell">${header("assets")}<main class="main-content assets-workspace"><a class="back-link" href="#/tools">← Tools</a><div class="page-heading"><div><div class="eyebrow">Local asset catalog</div><h1>Assets</h1><p>Levels, songs, and texture workspaces managed by GMDPlayer.</p></div><div class="library-actions"><button class="btn primary" data-action="browse">${icon("import")}<span>Import files</span></button>${supportsDirectorySelection()?`<button class="btn" data-action="browse-folder">Import folder</button>`:""}</div></div>${batchImportStatusMarkup()}<div class="asset-library-toolbar"><label class="search-wrap">${icon("search")}<input id="asset-search" class="search" type="search" value="${esc(state.assetQuery)}" placeholder="Search assets and linked usage"></label><label class="audio-select-filter">Category<select id="asset-filter"><option value="all">All assets</option><option value="level" ${state.assetFilter === "level" ? "selected" : ""}>Level files</option><option value="audio" ${state.assetFilter === "audio" ? "selected" : ""}>Songs</option><option value="texture" ${state.assetFilter === "texture" ? "selected" : ""}>Texture workspaces</option></select></label><label class="audio-select-filter">Sort<select id="asset-sort"><option value="date" ${state.assetSort === "date" ? "selected" : ""}>Recently imported</option><option value="name" ${state.assetSort === "name" ? "selected" : ""}>Name</option><option value="size" ${state.assetSort === "size" ? "selected" : ""}>File size</option></select></label><span class="audio-count">${rows.length} assets · showing ${visibleRows.length}</span>${selectionToolbar("assets",visibleRows.map(item=>item.id),{resourceType:"mixed"})}</div>${advancedSearchMarkup("assets")}<section class="audio-table-panel asset-table-panel"><div class="audio-table-scroll"><table class="workbench-table asset-table"><thead><tr><th>Asset</th><th>Category</th><th>Source</th><th>Size</th><th>Linked usage</th><th>Projects</th><th>Imported</th><th></th></tr></thead><tbody>${visibleRows.map(item => { const picked=state.selections.assets?.has(item.id); return `<tr class="${picked?"selection-selected":""}" data-selectable="assets" data-id="${esc(item.id)}" tabindex="0" role="option" aria-selected="${!!picked}"><td><input class="item-selection" type="checkbox" data-select-item="assets" data-id="${esc(item.id)}" aria-label="Select ${esc(item.name)}" ${picked?"checked":""}> <a class="asset-name-link" href="${item.href}"><strong>${esc(item.name)}</strong><small>${esc(item.filename)}</small></a></td><td>${item.kind === "level" ? "Level file" : item.kind === "audio" ? "Song / audio" : "Texture workspace"}</td><td>${esc(item.source)}</td><td>${item.size ? fmtBytes(item.size) : "—"}</td><td>${esc(item.usage || "—")}</td><td>${item.projects.map(project => `<a class="asset-project-link" href="#/projects/${encodeURIComponent(project.id)}">${esc(project.name)}</a>`).join(", ") || "—"}</td><td>${esc(fmtDate(item.importedAt))}</td><td>${item.kind === "audio" ? `<button class="btn small danger ghost" data-action="audio-delete" data-id="${esc(item.id)}">Remove</button>` : item.kind === "texture" ? `<button class="btn small danger ghost" data-action="asset-delete-texture" data-id="${esc(item.id)}">Remove</button>` : `<button class="btn small" data-action="details" data-id="${esc(item.id)}">Open</button>`}</td></tr>`; }).join("") || `<tr><td colspan="8" class="table-empty">No assets match this view. Import supported files to populate the catalog.</td></tr>`}</tbody></table></div>${visibleRows.length<rows.length?`<button class="btn load-more" data-action="load-more" data-scope="assets">Show next ${Math.min(100,rows.length-visibleRows.length)} assets</button>`:""}</section></main></div>`;
}
async function renderTextureWorkspace() {
  if (!state.route.id) {
    const textureRows=filterResources(state.textures.map(pack=>({...pack,kind:"texture",name:pack.name,filename:pack.sourceFiles?.map(file=>file.name).join(" "),date:pack.updatedAt||pack.createdAt,projectIds:linkedProjects("textureWorkspaces",pack.id).map(item=>item.id)})),searchDefinition("textures",state.textureQuery,"texture"));
    const visibleTextureRows=textureRows.slice(0,state.textureLimit);getSelectionModel("textures",visibleTextureRows.map(pack=>pack.id));
    const textureCards=visibleTextureRows.map(pack=>{
      const picked=state.selections.textures?.has(pack.id);
      return `<article class="texture-pack-card ${picked ? "selection-selected" : ""}" data-selectable="textures" data-id="${esc(pack.id)}" tabindex="0" role="option" aria-selected="${!!picked}"><input class="item-selection" type="checkbox" data-select-item="textures" data-id="${esc(pack.id)}" aria-label="Select ${esc(pack.name)}" ${picked ? "checked" : ""}><div><h3>${esc(pack.name)}</h3><p>${pack.sheetCount||0} sheets · ${pack.spriteCount||0} sprites</p></div><button class="btn primary" data-action="open-texture" data-id="${esc(pack.id)}">Open workspace</button></article>`;
    }).join("");
    const showMore=visibleTextureRows.length<textureRows.length?`<button class="btn load-more" data-action="load-more" data-scope="textures">Show next ${Math.min(100,textureRows.length-visibleTextureRows.length)} workspaces</button>`:"";
    app.innerHTML = `<div class="shell">${header("textures")}<main class="main-content"><a class="back-link" href="#/tools">← Tools</a><div class="page-heading"><div><div class="eyebrow">Creative workspace</div><h1>Texture workspaces</h1><p>Import PNG + XML PLIST sheets or ZIP packs. Originals stay unchanged.</p></div><button class="btn primary" data-action="browse">${icon("import")}<span>Import texture files</span></button></div>${selectionToolbar("textures",textureRows.map(pack=>pack.id),{resourceType:"textureWorkspaces"})}${advancedSearchMarkup("textures")}${textureCards?`<div class="texture-pack-list">${textureCards}${showMore}</div>`:`<div class="empty-state"><h3>${state.textures.length?"No matching texture workspaces":"No texture workspace yet"}</h3><p>Choose PNG and PLIST files or a ZIP pack to get started.</p></div>`}</main></div>`;
    return;
  }
  const pack = await getTextureWorkspace(state.route.id);
  if (!pack) { renderRouteFailure(new Error("This texture workspace is no longer available.")); return; }
  state.activeTexture = pack;
  const sheets = Object.values(pack.sheets || {}), sheet = pack.sheets[state.activeSheetId] || pack.sheets[state.selectedSprite?.sheetId] || sheets[0];
  if (sheet && (!state.selectedSprite || state.selectedSprite.sheetId !== sheet.id || !sheet.parsed.frames[state.selectedSprite.name])) {
    const first = Object.keys(sheet.parsed.frames)[0]; state.selectedSprite = first ? { sheetId: sheet.id, name: first } : null;
  }
  if (sheet) state.activeSheetId = sheet.id;
  const frame = state.selectedSprite && pack.sheets[state.selectedSprite.sheetId]?.parsed.frames[state.selectedSprite.name];
  const query = state.textureQuery.trim().toLowerCase();
  const matchingSprites=getSpriteEntries(pack).filter(item => item.sheetId === sheet?.id && `${item.frame.name} ${item.sheetName}`.toLowerCase().includes(query)),entries=matchingSprites.slice(0,state.spriteLimit);
  const modification = frame ? pack.modifications?.[state.selectedSprite.sheetId]?.[frame.name] : null;
  app.innerHTML = `<div class="shell">${header("textures")}<main class="main-content texture-editor"><a class="back-link" href="#/tools/textures">← All workspaces</a><div class="texture-title"><div><div class="eyebrow">Texture pack editor</div><h1>${esc(pack.name)}</h1><p class="section-meta">${sheets.length} sheets · ${getSpriteEntries(pack).length} sprites · Originals preserved</p></div><div class="texture-actions">${sheets.length > 1 ? `<button class="btn" data-action="texture-merge">Merge sheets…</button>` : ""}<button class="btn" data-action="texture-reset-all">Reset changes</button><button class="btn danger ghost" data-action="texture-delete">Remove workspace</button></div></div>
    <div class="texture-layout"><aside class="texture-browser"><div class="texture-browser-section"><div class="panel-heading"><span>Sheets</span><span>${sheets.length}</span></div><div class="texture-sheet-list">${sheets.map(item => `<button class="texture-sheet-row ${item.id === sheet?.id ? "selected" : ""}" data-action="texture-choose-sheet" data-sheet="${esc(item.id)}" aria-pressed="${item.id === sheet?.id}"><span class="texture-sheet-icon">${icon("texture")}</span><span class="texture-sheet-row-copy"><strong>${esc(item.name)}</strong><small>${item.parsed.width || "?"} × ${item.parsed.height || "?"} · ${Object.keys(item.parsed.frames || {}).length} sprites</small></span></button>`).join("")}</div></div>
      <div class="texture-browser-section sprite-browser-section"><div class="panel-heading"><span>Sprites</span><span>${matchingSprites.length}</span></div><label class="texture-search-wrap">${icon("search")}<input class="search" id="texture-search" placeholder="Search sprites" value="${esc(state.textureQuery)}" aria-label="Search sprites"></label><div class="texture-sprite-list">${entries.map(item => `<button class="texture-sprite ${item.sheetId === state.selectedSprite?.sheetId && item.frame.name === state.selectedSprite?.name ? "selected" : ""}" data-action="texture-select" data-sheet="${esc(item.sheetId)}" data-sprite="${esc(item.frame.name)}"><span>${esc(item.frame.name)}</span><small>${Math.round(item.frame.frame.width)} × ${Math.round(item.frame.frame.height)}${item.frame.rotated ? " · rotated" : ""}</small></button>`).join("") || `<div class="texture-empty">${query ? "No sprites match." : "No parsed sprites on this sheet."}</div>`}${entries.length<matchingSprites.length?`<button class="btn small load-more" data-action="load-more-sprites">Show next ${Math.min(200,matchingSprites.length-entries.length)} sprites</button>`:""}</div></div></aside>
    <section class="texture-detail">${sheet?.errors.length ? `<div class="texture-warning">${sheet.errors.map(esc).join(" · ")}</div>` : ""}<div class="texture-source-meta"><span>PNG · ${esc(sheet?.source.pngPath || "missing")}</span><span>PLIST · ${esc(sheet?.source.plistPath || "missing")}</span></div>
    <div class="texture-workspace-columns"><div class="texture-atlas-stage"><div class="atlas-stage-heading"><div><div class="eyebrow">Atlas canvas</div><h2>${esc(sheet?.name || "Texture sheet")}</h2></div><span>${sheet?.parsed.width || "?"} × ${sheet?.parsed.height || "?"} px</span></div><div class="atlas-viewport">${sheet?.source.png ? `<canvas id="atlas-preview" aria-label="Texture atlas with selected sprite highlighted"></canvas>` : `<div class="atlas-empty">PNG atlas not available</div>`}</div><p class="canvas-caption">Select a sprite to highlight its exact atlas slot.</p></div>
    <aside class="texture-inspector">${frame ? `<div class="inspector-heading"><div class="eyebrow">Selected sprite</div><h2>${esc(frame.name)}</h2><p>${modification ? "Modified pixels" : "Original sprite"}</p></div><div class="sprite-preview-panel"><canvas id="sprite-preview" aria-label="Selected sprite preview"></canvas></div>
      <section class="inspector-section"><h3>Sprite information</h3><div class="texture-metadata"><div><span>Position</span><strong>${frame.frame.x}, ${frame.frame.y}</strong></div><div><span>Atlas size</span><strong>${frame.frame.width} × ${frame.frame.height}</strong></div><div><span>Source size</span><strong>${frame.sourceSize.width} × ${frame.sourceSize.height}</strong></div><div><span>Offset</span><strong>${frame.offset.x}, ${frame.offset.y}</strong></div><div><span>Rotated</span><strong>${frame.rotated ? "Yes" : "No"}</strong></div><div><span>Modified</span><strong>${modification ? "Yes" : "No"}</strong></div></div><details class="texture-raw-metadata"><summary>Additional PLIST metadata</summary><pre>${esc(JSON.stringify(frame.raw, null, 2))}</pre></details></section>
      <section class="inspector-section"><h3>Sprite</h3><p class="control-description">Exact dimensions preserve atlas metadata. Fit to slot explicitly resizes pixels.</p><label class="field-label" for="replacement-mode">Replacement mode</label><select class="wide-control" id="replacement-mode"><option value="exact" ${state.replacementMode === "exact" ? "selected" : ""}>Exact dimensions</option><option value="fit" ${state.replacementMode === "fit" ? "selected" : ""}>Fit to slot</option></select><button class="btn primary full-button" data-action="texture-replace">Replace sprite…</button><button class="btn full-button" data-action="texture-reset-one" ${modification ? "" : "disabled"}>Reset sprite</button></section>
      <section class="inspector-section"><h3>Sheet</h3><button class="btn full-button" data-action="texture-split">Split sprites to ZIP</button><button class="btn full-button" data-action="texture-repack">Repack sheet…</button></section>
      <section class="inspector-section"><h3>Workspace</h3><div class="inspector-button-row"><button class="btn" data-action="texture-undo" ${pack.historyIndex ? "" : "disabled"}>Undo</button><button class="btn" data-action="texture-redo" ${pack.historyIndex < pack.history.length ? "" : "disabled"}>Redo</button></div></section>
      <section class="inspector-section"><h3>Export</h3><button class="btn full-button" data-action="texture-export-sheet">Export sheet</button><button class="btn full-button primary" data-action="texture-export">Export pack</button></section>` : `<div class="empty-state"><h3>No valid sprite selected</h3><p>Check that a matching PNG and PLIST are available.</p><button class="btn primary" data-action="browse">Import texture files</button></div>`}</aside></div>
    <p class="texture-footnote">Texture editing is independent of the legacy gameplay renderer. ZIP files are treated as untrusted data and are never executed.</p></section></div></main></div>`;
  await drawTexturePreviews(pack.id, sheet, frame, modification);
}
function cacheCanvas(cache, key, canvas, limit) {
  cache.delete(key); cache.set(key, canvas);
  while (cache.size > limit) {
    const [oldKey, oldCanvas] = cache.entries().next().value;
    cache.delete(oldKey); oldCanvas.width = oldCanvas.height = 1;
  }
}
async function drawTexturePreviews(packId, sheet, frame, modification) {
  if (!sheet?.source.png) return;
  const loadingTimer=setTimeout(()=>{const viewport=document.querySelector(".atlas-viewport");if(viewport&&!document.querySelector("#texture-preview-status"))viewport.insertAdjacentHTML("afterbegin",`<div class="preview-loading" id="texture-preview-status" role="status">Preparing atlas preview…</div>`);},160);
  try {
    const spriteCanvas = document.querySelector("#sprite-preview"), atlasCanvas = document.querySelector("#atlas-preview");
    if (!atlasCanvas) return;
    const atlasKey = `${packId}:${sheet.id}`;
    let atlasPreview = atlasPreviewCache.get(atlasKey);
    if (!atlasPreview) {
      const dimensions=getPngDimensions(sheet.source.png),scale=Math.min(1,2400/dimensions.width,1800/dimensions.height),width=Math.max(1,Math.floor(dimensions.width*scale)),height=Math.max(1,Math.floor(dimensions.height*scale));
      let atlas;
      if(typeof globalThis.createImageBitmap==="function"){
        try{atlas=await globalThis.createImageBitmap(new Blob([sheet.source.png],{type:"image/png"}),{resizeWidth:width,resizeHeight:height,resizeQuality:"medium"});}
        catch(_){atlas=await decodePng(sheet.source.png);}
      }else atlas=await decodePng(sheet.source.png);
      atlasPreview = document.createElement("canvas");
      atlasPreview.width = width; atlasPreview.height = height;
      atlasPreview.getContext("2d").drawImage(atlas, 0, 0, width, height);
      atlas.close?.(); cacheCanvas(atlasPreviewCache, atlasKey, atlasPreview, 2);
    } else { atlasPreviewCache.delete(atlasKey); atlasPreviewCache.set(atlasKey, atlasPreview); }
    atlasCanvas.width = atlasPreview.width; atlasCanvas.height = atlasPreview.height;
    const atlasContext = atlasCanvas.getContext("2d"); atlasContext.drawImage(atlasPreview, 0, 0);
    if (frame) {
      const scale = atlasPreview.width / (sheet.parsed.width || atlasPreview.width);
      atlasContext.strokeStyle = "#23745e"; atlasContext.lineWidth = Math.max(2, 3 / scale);
      atlasContext.strokeRect(frame.frame.x * scale, frame.frame.y * scale, frame.frame.width * scale, frame.frame.height * scale);
    }
    if (!spriteCanvas || !frame) return;
    const cacheKey = `${packId}:${sheet.id}:${frame.name}:${modification?.updatedAt || "original"}`;
    let spritePreview = spritePreviewCache.get(cacheKey);
    if (!spritePreview) {
      let source, closeSource = false;
      if (modification?.png) { source = await decodePng(modification.png); closeSource = true; }
      else source = await extractSprite(sheet.source.png, frame, { maxDimension: 512 });
      spritePreview = document.createElement("canvas");
      const ratio = Math.min(1, 512 / Math.max(source.width, source.height));
      spritePreview.width = Math.max(1, Math.round(source.width * ratio)); spritePreview.height = Math.max(1, Math.round(source.height * ratio));
      spritePreview.getContext("2d").drawImage(source, 0, 0, spritePreview.width, spritePreview.height);
      if (closeSource) source.close?.();
      cacheCanvas(spritePreviewCache, cacheKey, spritePreview, 16);
    } else { spritePreviewCache.delete(cacheKey); spritePreviewCache.set(cacheKey, spritePreview); }
    spriteCanvas.width = spritePreview.width; spriteCanvas.height = spritePreview.height;
    spriteCanvas.getContext("2d").drawImage(spritePreview, 0, 0);
  } catch (error) { showToast(error.message || "Could not render sprite preview.", "error"); }
  finally { clearTimeout(loadingTimer);document.querySelector("#texture-preview-status")?.remove(); }
}

function saveTabs(document) {
  const n = document.normalized || {};
  const tabs = [{ id: "overview", title: "Overview" }];
  if (n.gameManager) {
    tabs.push({ id: "basic", title: "Basic Stats" });
    if (n.gameManager.statValues?.length) tabs.push({ id: "breakdown", title: "Stats Breakdown" });
    if (n.gameManager.levels?.length) tabs.push({ id: "all-levels", title: "All Levels" });
    if (n.gameManager.collections?.length) tabs.push({ id: "collections", title: "Collections" });
    if (n.gameManager.quests) tabs.push({ id: "quests", title: "Quests" });
    if (n.gameManager.achievements) tabs.push({ id: "achievements", title: "Achievements" });
    tabs.push({ id: "misc", title: "Misc Info" });
  }
  if (document.files.localLevels) tabs.push({ id: "created-levels", title: "Created Levels" });
  tabs.push({ id: "download", title: "Download" }, { id: "raw", title: "Raw Data" });
  return tabs;
}
function saveMetricGrid(stats, empty) {
  const entries = Object.entries(stats || {});
  if (!entries.length) return '<div class="save-empty-note">' + esc(empty || "No named stats are present in this save.") + "</div>";
  return '<div class="save-stat-grid">' + entries.map(([label, value]) =>
    '<div class="save-stat"><small>' + esc(label) + "</small><strong>" + esc(value) + "</strong></div>"
  ).join("") + "</div>";
}
function saveStatCards(document) {
  const gm = document.normalized?.gameManager;
  const summary = gm?.summary || {};
  const cards = [
    ["Official levels", summary.officialLevelRecords || 0],
    ["GS values", summary.statValueEntries || 0],
    ["Top-level keys", summary.topLevelKeys || 0],
    ["State groups", summary.nonEmptyGameStateGroups || 0]
  ];
  return '<div class="save-stat-grid">' + cards.map(([label, value]) =>
    '<div class="save-stat save-stat-accent"><small>' + esc(label) + "</small><strong>" + esc(value) + "</strong></div>"
  ).join("") + "</div>";
}
function renderSaveOverview(document) {
  const n = document.normalized || {}, gm = n.gameManager;
  const files = [
    ["CCGameManager.dat", document.files.gameManager, "Player and progress data"],
    ["CCLocalLevels.dat", document.files.localLevels, "Created level data"]
  ].filter((entry) => entry[1]);
  let html = '<div class="save-section"><div class="save-hero"><div><div class="eyebrow">Geometry Dash Save Explorer</div><h2>' +
    esc(gm?.player?.name || "Local save workspace") +
    '</h2><p>Decoded locally. Original save binaries remain unchanged.</p></div>';
  html += '<div class="save-decode-badge"><span class="status-dot"></span><strong>' +
    esc(document.metadata.gameVersion ? "GD " + document.metadata.gameVersion : "GD save") +
    '</strong><small>' + esc(document.metadata.encoding || "decoded") + "</small></div></div>";
  html += '<div class="save-file-grid">' + files.map(([label, file, description]) =>
    '<div class="save-file-card save-source-card"><span class="save-file-icon">' + icon("save") + '</span><div><strong>' +
    esc(label) + "</strong><small>" + esc(description) + " · " + Math.ceil(file.size / 1024) + ' KB</small></div><span class="saved-dot">●</span></div>'
  ).join("") + "</div>";
  if (gm) {
    html += '<div class="save-summary-row"><span>Game version <strong>' + esc(document.metadata.gameVersion ?? "Not present") +
      '</strong></span><span>Binary version <strong>' + esc(document.metadata.binaryVersion ?? "Not present") +
      '</strong></span><span>Official records <strong>' + esc(gm.summary?.officialLevelRecords || 0) +
      '</strong></span><span>GS values <strong>' + esc(gm.summary?.statValueEntries || 0) + "</strong></span></div>";
    html += saveStatCards(document);
  }
  if (document.files.localLevels) {
    html += '<div class="save-local-summary"><strong>' + esc((n.localLevels || []).length) + ' created levels</strong><span>' +
      (n.localLevelErrors?.length ? esc(n.localLevelErrors.length + " entry could not be converted to a Library level.") : "The original CCLocalLevels.dat is preserved unchanged.") +
      '</span><button class="btn primary small" data-action="save-tab" data-tab="created-levels">Open Created Levels →</button></div>';
  }
  return html + "</div>";
}
function renderSaveBasic(document) {
  const gm = document.normalized?.gameManager;
  if (!gm) return '<div class="save-section"><h2>Basic Stats</h2><div class="save-empty-note">CCGameManager.dat was not included in this snapshot.</div></div>';
  let html = '<div class="save-section"><div class="eyebrow">Player information</div><h2>Basic Stats</h2><div class="save-identity-grid">';
  const items = [
    ["Player", gm.player?.name || "Unknown"],
    ["Geometry Dash version", document.metadata.gameVersion || "Unknown"],
    ["Binary version", document.metadata.binaryVersion ?? "Unknown"],
    ["Encoding", document.metadata.encoding || "Unknown"]
  ];
  html += items.map(([label, value]) => '<div><span>' + esc(label) + "</span><strong>" + esc(value) + "</strong></div>").join("");
  html += "</div>" + saveStatCards(document) + saveMetricGrid(gm.stats);
  if (gm.player?.udid) html += '<details class="save-sensitive-box"><summary>Player identifier</summary><code>' + esc(gm.player.udid) + "</code><p>Hidden from exports by default.</p></details>";
  return html + "</div>";
}
function renderSaveBreakdown(document) {
  const values = document.normalized?.gameManager?.statValues || [];
  let html = '<div class="save-section"><div class="eyebrow">Geometry Dash internal state</div><h2>Stats Breakdown</h2><p class="section-meta">Raw ' +
    esc(values.length) + ' entries from <code>GS_value</code>. The numeric keys are preserved instead of being guessed.</p>';
  if (!values.length) return html + '<div class="save-empty-note">No GS_value entries are present.</div></div>';
  html += '<div class="save-data-table-wrap"><table class="save-data-table"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>';
  html += values.map(item => '<tr><td><code>' + esc(item.key) + "</code></td><td>" +
    esc(typeof item.value === "object" ? JSON.stringify(maskSensitiveFields(item.value, true)) : item.value) +
    "</td></tr>").join("");
  return html + "</tbody></table></div></div>";
}
function renderSaveAllLevels(document) {
  const levels = document.normalized?.gameManager?.levels || [];
  const query = state.saveQuery.toLowerCase().trim();
  const shown = levels.filter(level => (String(level.name) + " " + String(level.id)).toLowerCase().includes(query));
  let html = '<div class="save-section"><div class="eyebrow">Official level records</div><h2>All Levels</h2><div class="save-level-toolbar"><span><strong>' +
    esc(levels.length) + '</strong> records</span><input class="search save-search" id="save-search" placeholder="Search level name or ID…" value="' + esc(state.saveQuery) + '" aria-label="Search official levels"></div>';
  if (!shown.length) return html + '<div class="save-empty-note">No official level records match the search.</div></div>';
  html += '<div class="save-data-table-wrap"><table class="save-data-table"><thead><tr><th>ID</th><th>Name</th><th>GD fields</th></tr></thead><tbody>';
  html += shown.map(level => '<tr><td>' + esc(level.id) + '</td><td class="save-level-name">' + esc(level.name) +
    '</td><td><code>' + esc(Object.entries(level.fields || {}).map(([k,v]) => k + "=" + (typeof v === "boolean" ? "true" : v)).join(" · ")) +
    "</code></td></tr>").join("");
  return html + "</tbody></table></div></div>";
}
function renderSaveCollections(document) {
  const groups = document.normalized?.gameManager?.collections || [];
  let html = '<div class="save-section"><div class="eyebrow">Internal save collections</div><h2>Collections</h2><p class="section-meta">Non-empty <code>GS_*</code> groups discovered in this save. Original keys are preserved.</p><div class="save-collection-grid">';
  html += groups.map(group => '<div class="save-collection-card"><strong>' + esc(group.key) + '</strong><span>' + esc(group.entries.length) +
    ' entries</span><code>' + esc(group.entries.slice(0, 8).map(([key]) => key).join(", ") || "scalar") + "</code></div>").join("");
  return html + "</div></div>";
}
function renderSaveCreatedLevels(document) {
  const local = document.normalized?.localLevels || [];
  const query = state.saveQuery.toLowerCase().trim();
  const matching = local.filter(item => (String(item.name) + " " + String(item.levelId ?? "")).toLowerCase().includes(query));
  const shown = matching.slice(0, state.saveLevelLimit);
  let html = '<div class="save-section"><div class="eyebrow">Custom levels</div><h2>Created Levels</h2><p class="section-meta">Decoded from CCLocalLevels.dat. Adding a level to Library never writes to the original save.</p>';
  html += '<div class="save-level-toolbar"><span><strong>' + esc(local.length) + '</strong> levels · showing ' + esc(shown.length) + ' · <strong>' + esc(state.selectedSaveLevels.size) +
    '</strong> selected</span><div><button class="btn small" data-action="save-select-all">Select all</button><button class="btn small" data-action="save-clear">Clear</button><button class="btn small" data-action="save-import-all">Import All</button><button class="btn primary small" data-action="save-import-selected" ' +
    (state.selectedSaveLevels.size ? "" : "disabled") + '>Import selected</button></div></div>';
  html += '<input class="search save-search" id="save-search" placeholder="Search created levels…" value="' + esc(state.saveQuery) + '" aria-label="Search created levels">';
  if (!shown.length) return html + '<div class="save-empty-note">' + (local.length ? "No created levels match the search." : "CCLocalLevels.dat contains no created levels.") + "</div></div>";
  html += '<div class="save-data-table-wrap"><table class="save-data-table"><thead><tr><th></th><th>Name</th><th>ID</th><th>Song</th><th>Action</th></tr></thead><tbody>';
  html += shown.map(item => '<tr><td><input type="checkbox" data-save-level="' + esc(item.id) + '" aria-label="Select ' + esc(item.name) + '" ' +
    (state.selectedSaveLevels.has(item.id) ? "checked" : "") + '></td><td class="save-level-name">' + esc(item.name) + '</td><td>' +
    esc(item.levelId == null ? "Local" : item.levelId) + '</td><td>' + esc(item.document.metadata.song?.name || "Unknown") +
    '</td><td><button class="btn small" type="button" data-action="save-import-one" data-id="' + esc(item.id) + '">Add to Library</button></td></tr>'
  ).join("");
  html += "</tbody></table></div>";
  if (shown.length < matching.length) html += '<button class="btn load-more" data-action="load-more-save-levels">Show next ' + Math.min(200, matching.length - shown.length) + " levels</button>";
  if (document.normalized?.localLevelErrors?.length) html += '<p class="save-warning">' + esc(document.normalized.localLevelErrors.length) + " created level record(s) could not be decoded.</p>";
  return html + "</div>";
}
function renderSaveObjectSection(title, value, description) {
  const empty = value == null || (typeof value === "object" && Object.keys(value || {}).length === 0);
  return '<div class="save-section"><div class="eyebrow">Player data</div><h2>' + esc(title) + '</h2><p class="section-meta">' + esc(description) +
    "</p>" + (empty ? '<div class="save-empty-note">No data was present.</div>' : '<pre class="save-raw">' + esc(JSON.stringify(maskSensitiveFields(value, true), null, 2)) + "</pre>") + "</div>";
}
function renderSaveDownload(document) {
  const files = Object.entries({ gameManager: document.files.gameManager, localLevels: document.files.localLevels }).filter(([, file]) => file);
  let html = '<div class="save-section"><div class="eyebrow">Takeout</div><h2>Download your data</h2><p class="section-meta">Export the exact original binary or a masked decoded view.</p><div class="save-download-grid">';
  html += files.map(([slot, file]) => '<div class="save-download-card"><strong>' + esc(file.filename) + '</strong><small>' + Math.ceil(file.size / 1024) +
    ' KB · original bytes preserved</small><button class="btn primary small" data-action="save-download-original" data-slot="' + esc(slot) + '">Download original</button></div>').join("");
  html += '</div><div class="save-download-grid"><div class="save-download-card"><strong>Decoded JSON</strong><small>Masked by default</small><div class="save-download-actions"><button class="btn small" data-action="raw-view" data-view="json">Open JSON</button><button class="btn small" data-action="download-raw">Export JSON</button></div></div><div class="save-download-card"><strong>Decoded XML</strong><small>Masked by default</small><div class="save-download-actions"><button class="btn small" data-action="raw-view" data-view="xml">Open XML</button><button class="btn small" data-action="download-raw">Export XML</button></div></div></div></div>';
  return html;
}

function currentRawContent(document) {
  const slot = document.decoded?.[state.rawFile] ? state.rawFile : document.decoded?.gameManager ? "gameManager" : "localLevels";
  const tree = document.decoded?.[slot]?.tree;
  if (!tree) return { slot, content: "No decoded representation is available." };
  const safeTree = maskSensitiveFields(tree, !state.showAllSensitive);
  const xml = state.showAllSensitive ? document.decoded[slot].xml : serializeSaveXml(safeTree);
  return { slot, content: state.rawView === "xml" ? xml : JSON.stringify(safeTree, null, 2) };
}
function renderSaveRaw(document) {
  const slots = ["gameManager", "localLevels"].filter(slot => document.decoded?.[slot]);
  const current = currentRawContent(document);
  return `<div class="save-section"><div class="eyebrow">Read only</div><h2>Raw Data</h2><p class="section-meta">Sensitive fields are hidden in the viewer and exports by default.</p>
    <div class="raw-toolbar"><select id="raw-file-select" aria-label="Save file">${slots.map(slot => `<option value="${slot}" ${slot === current.slot ? "selected" : ""}>${slot === "gameManager" ? "CCGameManager.dat" : "CCLocalLevels.dat"}</option>`).join("")}</select><div class="filter-row"><button class="filter ${state.rawView === "json" ? "selected" : ""}" data-action="raw-view" data-view="json">JSON</button><button class="filter ${state.rawView === "xml" ? "selected" : ""}" data-action="raw-view" data-view="xml">XML</button></div><label class="sensitive-toggle"><input type="checkbox" id="hide-sensitive" ${state.showAllSensitive ? "" : "checked"}> Hide sensitive fields</label><button class="btn small" data-action="copy-raw">Copy</button><button class="btn small" data-action="download-raw">Export ${state.rawView.toUpperCase()}</button></div>
    <pre class="save-raw" id="save-raw">${esc(current.content)}</pre><p class="hint">This is a normalized readable view. The original decoded XML and original binary are preserved separately in the snapshot.</p>
  </div>`;
}
async function renderSaveExplorer() {
  let record = state.route.id ? await getSaveSnapshot(state.route.id) : state.saves[0] || null;
  if (!record && state.route.id) { renderRouteFailure(new Error("This save snapshot is no longer available.")); return; }
  if (!record) {
    app.innerHTML = '<div class="shell">' + header("tools") + '<main class="main-content save-explorer save-landing"><a class="back-link" href="#/tools">← Tools</a>' +
      '<section class="save-landing-hero"><div class="eyebrow">Local Geometry Dash tool</div><h1>Geometry Dash Save Explorer</h1>' +
      '<p>Open <strong>CCGameManager.dat</strong> for player and progress data or <strong>CCLocalLevels.dat</strong> for created levels. Everything is decoded in this browser.</p>' +
      '<button class="btn primary" data-action="browse-save">' + icon("import") + ' Choose save files</button></section>' +
      '<section class="save-drop-grid"><div class="save-drop-card"><div class="save-drop-icon">' + icon("save") + '</div><h2>CCGameManager.dat</h2>' +
      '<p>Player name, version, internal stats, official level records and other account-local state.</p><button class="btn" data-action="browse-save">Choose .dat file</button></div>' +
      '<div class="save-drop-card"><div class="save-drop-icon">' + icon("texture") + '</div><h2>CCLocalLevels.dat</h2>' +
      '<p>Created level storage. An empty file is valid and will simply show an empty Created Levels view.</p><button class="btn" data-action="browse-save">Choose .dat file</button></div></section>' +
      '<div class="save-offline-note"><span class="status-dot"></span><span>100% local parsing · original files are not uploaded</span></div></main></div>';
    return;
  }
  if (state.activeSaveId !== record.id) {
    state.activeSaveId = record.id;
    state.showAllSensitive = false;
    state.rawView = "json";
    state.rawFile = "gameManager";
    state.saveTab = "overview";
    state.selectedSaveLevels.clear();
    state.saveQuery = "";
  }
  const document = record.document;
  const tabs = saveTabs(document);
  if (!tabs.some(tab => tab.id === state.saveTab)) state.saveTab = "overview";
  let panel;
  if (state.saveTab === "basic") panel = renderSaveBasic(document);
  else if (state.saveTab === "breakdown") panel = renderSaveBreakdown(document);
  else if (state.saveTab === "all-levels") panel = renderSaveAllLevels(document);
  else if (state.saveTab === "collections") panel = renderSaveCollections(document);
  else if (state.saveTab === "created-levels") panel = renderSaveCreatedLevels(document);
  else if (state.saveTab === "quests") panel = renderSaveObjectSection("Quests", document.normalized?.gameManager?.quests, "Quest data is preserved with its original keys.");
  else if (state.saveTab === "achievements") panel = renderSaveObjectSection("Achievements", document.normalized?.gameManager?.achievements, "Achievement data is preserved with its original keys.");
  else if (state.saveTab === "misc") panel = renderSaveObjectSection("Misc Info", document.normalized?.gameManager?.misc, "Top-level data not assigned to a specialized viewer.");
  else if (state.saveTab === "download") panel = renderSaveDownload(document);
  else if (state.saveTab === "raw") panel = renderSaveRaw(document);
  else panel = renderSaveOverview(document);
  app.innerHTML = '<div class="shell">' + header("tools") + '<main class="main-content save-explorer"><a class="back-link" href="#/tools">← Tools</a>' +
    (state.importing ? '<div class="import-progress">' + esc(state.importStatus) + '<div class="progress-track"><div class="progress-fill"></div></div></div>' : '') +
    '<div class="save-title-line"><div><div class="eyebrow">Geometry Dash Save Explorer</div><h1>' + esc(record.sourceFilenames?.join(" + ") || "Geometry Dash Save") +
    '</h1><p class="section-meta">Parsed locally · original binaries retained · no network upload</p></div><button class="btn small" data-action="delete-save" data-id="' + esc(record.id) + '">Remove snapshot</button></div>' +
    '<div class="save-workspace"><nav class="save-tabs save-category-tabs" aria-label="Save data sections">' +
    tabs.map(tab => '<button class="save-tab ' + (state.saveTab === tab.id ? "selected" : "") + '" data-action="save-tab" data-tab="' + esc(tab.id) + '">' + esc(tab.title) + "</button>").join("") +
    '</nav><section class="save-panel">' + panel + '</section></div><div class="save-privacy-note"><span class="status-dot"></span>Save parsing runs in this browser. No save data or decoded content is sent to a server.</div></main></div>';
}

async function importSnapshotLevels(ids) {
  const record = await getSaveSnapshot(state.route.id);
  const documents = record?.document?.normalized?.localLevels || [];
  const selected = documents.filter(item => ids.includes(item.id));
  let added = 0, duplicates = 0;
  for (const item of selected) {
    const result = await createLevel(item.document);
    if (result.duplicate) duplicates++; else added++;
  }
  state.selectedSaveLevels.clear();
  await refresh();
  showToast(`${added} level${added === 1 ? "" : "s"} added to Library${duplicates ? ` · ${duplicates} already present` : ""}.`);
}

function renderPlayer() {
  app.innerHTML = `<div class="player-shell"><button class="btn player-exit" data-action="exit">← Back to Library <kbd style="font:10px 'DM Mono',monospace;color:#aab5c4">ESC</kbd></button><span class="player-status">LEGACY PLAYER · GMDPLAYER ADAPTER</span><div id="player-mount" style="width:100%;height:100%"></div></div>`;
  state.player = new PlayerAdapter({
    onExit: () => route(state.returnTo || "#/library"),
    onError: message => showToast(message, "error"),
    onWarning: message => showToast(message, "error"),
    onProgress: async progress => {
      if (!progress?.id) return;
      try {
        const entry = await getLevel(progress.id);
        if (!entry) return;
        const doc = entry.document;
        doc.progress = {
          normal: Math.max(Number(doc.progress?.normal || 0), Number(progress.normal || 0)),
          practice: Math.max(Number(doc.progress?.practice || 0), Number(progress.practice || 0)),
          attempts: Math.max(Number(doc.progress?.attempts || 0), Number(progress.attempts || 0))
        };
        await updateLevel(doc.id, doc);
      } catch (error) { console.warn("Could not save level progress", error); }
    }
  });
  (async () => {
    try {
      const entry = await getLevel(state.route.id);
      if (!entry) throw new Error("This level is no longer in your Library.");
      const doc = entry.document;
      doc.timestamps = { ...doc.timestamps, lastPlayedAt: Date.now() };
      await updateLevel(doc.id, doc);
      const resolvedSong = await songResolver.resolve(entry);
      const localAudio = resolvedSong.type === "local" ? { blob: resolvedSong.asset.blob, displayName: resolvedSong.asset.displayName } : null;
      if (resolvedSong.type === "missing-local") showToast("The linked song is no longer available; the original song behavior will be used.", "error");
      const mount = document.querySelector("#player-mount");
      if (mount && state.route.name === "play") await state.player.load(doc, mount, { localAudio });
    } catch (error) {
      showToast(error.message || "The player could not open this level.", "error");
      route(state.returnTo || "#/library");
    }
  })();
}
async function refresh() {
  releaseAudioPreview();
  state.storageError = null; state.resourceWarnings = [];
  try {
    await openLibraryDatabase();
    const results = await Promise.allSettled([getLibrarySummaries(),getSaveSnapshots(),getTextureWorkspaceSummaries(),getAudioAssets(),getProjects(),getActiveProjectId()]);
    if (results[0].status === "rejected") throw results[0].reason;
    state.levels = Array.isArray(results[0].value) ? results[0].value : [];
    state.saves = results[1].status === "fulfilled" && Array.isArray(results[1].value) ? results[1].value : [];
    state.textures = results[2].status === "fulfilled" && Array.isArray(results[2].value) ? results[2].value : [];
    state.audioAssets = results[3].status === "fulfilled" && Array.isArray(results[3].value) ? results[3].value : [];
    state.projects = results[4].status === "fulfilled" && Array.isArray(results[4].value) ? results[4].value : [];
    for (let index=1;index<results.length-1;index++) if(results[index].status==="rejected") state.resourceWarnings.push(["save snapshots","texture workspaces","audio library","projects"][index-1]);
    membershipIndexCache=null;state.quickOpenIndex=null;
    const active=resolveActiveProject(state.projects,results[5].status==="fulfilled"?results[5].value:null);
    state.activeProject=active.project;state.activeProjectId=active.activeId;
    if(results[5].status==="rejected")state.resourceWarnings.push("active project preference");
    else if(active.stale)await setActiveProjectId(null).catch(()=>state.resourceWarnings.push("active project preference"));
    const preferenceKeys=["savedSearches","recentActivity",... ["library","audio","assets","projects","textures","saves"].map(scope=>`view:${scope}`),"onboardingDismissed","installDismissed"];
    const preferenceResults=await Promise.all(preferenceKeys.map(key=>getWorkbenchValue(key,null).then(value=>({status:"fulfilled",value})).catch(()=>({status:"rejected",value:null}))));
    const preferenceValues=preferenceResults.map(result=>result.value);if(preferenceResults.some(result=>result.status==="rejected"))state.resourceWarnings.push("workspace preferences");
    state.savedSearches=normalizeSavedSearches(preferenceValues[0]);state.recentActivity=normalizeRecentActivity(preferenceValues[1]);
    const scopes=["library","audio","assets","projects","textures","saves"];
    scopes.forEach((scope,index)=>{const view=normalizeViewPreference(preferenceValues[index+2]);state.viewPreferences[scope]=view;if(view.filters)state.searchFilters[scope]={...state.searchFilters[scope],...view.filters};});
    state.onboardingDismissed=preferenceValues[8]===true;state.installDismissed=preferenceValues[9]===true;
    state.libraryView=state.viewPreferences.library?.view||state.libraryView;state.audioSort=state.viewPreferences.audio?.sort||state.audioSort;state.assetSort=state.viewPreferences.assets?.sort||state.assetSort;state.libraryFilter=state.viewPreferences.library?.filter||state.libraryFilter;state.audioFilter=state.viewPreferences.audio?.filter||state.audioFilter;state.assetFilter=state.viewPreferences.assets?.filter||state.assetFilter;state.audioQuery=state.viewPreferences.audio?.query||state.audioQuery;state.assetQuery=state.viewPreferences.assets?.query||state.assetQuery;
    try{state.storageEstimate=await navigator.storage?.estimate?.()||null;}catch(_){state.storageEstimate=null;}
  } catch (error) {
    state.levels=[];state.saves=[];state.textures=[];state.audioAssets=[];state.projects=[];state.activeProject=null;state.activeProjectId=null;state.storageError=error;
  }
  state.route = parseRoute(); restoreUrlSearch();
  const routeKey=`${state.route.name}:${state.route.id||""}`;if(routeKey!==state.activityRouteKey){state.activityRouteKey=routeKey;let activity=null;if(["details","inspect","play"].includes(state.route.name)){const level=state.levels.find(item=>item.id===state.route.id);if(level)activity={kind:"level",resourceId:level.id,name:level.document.metadata.name,action:state.route.name==="play"?"played":"opened"};}else if(state.route.name==="project-detail"){const project=state.projects.find(item=>item.id===state.route.id);if(project)activity={kind:"project",resourceId:project.id,name:project.name,action:"opened"};}else if(state.route.name==="audio"){const audio=state.audioAssets.find(item=>item.id===state.audioSelectedId)||state.audioAssets[0];if(audio)activity={kind:"audio",resourceId:audio.id,name:audio.displayName,action:"opened"};}else if(state.route.name==="textures"&&state.route.id){const pack=state.textures.find(item=>item.id===state.route.id);if(pack)activity={kind:"texture",resourceId:pack.id,name:pack.name,action:"opened"};}else if(state.route.name==="save"){const save=state.saves.find(item=>item.id===state.route.id)||state.saves[0];if(save)activity={kind:"save",resourceId:save.id,name:save.sourceFilenames?.join(" + ")||"Save snapshot",action:"opened"};}if(activity)recordActivity(activity).then(entry=>{state.recentActivity=[entry,...(state.recentActivity||[]).filter(item=>item.resourceId!==entry.resourceId||item.action!==entry.action)].slice(0,100);}).catch(()=>{});}
  state.booting=false;
  if(state.storageError){if(state.route.name==="about")renderAbout();else renderStorageRecovery(state.storageError);return;}
  if(state.resourceWarnings.length&&state.resourceWarningKey!==state.resourceWarnings.join(",")){state.resourceWarningKey=state.resourceWarnings.join(",");showToast(`Some optional local data could not be loaded: ${state.resourceWarnings.join(", ")}.`,"error");}
  renderInstallAffordance();updateNetworkAffordance();
  document.body.classList.remove("nav-open");
  document.body.classList.toggle("texture-mode", state.route.name === "textures");
  try {
    if (state.route.name === "play") renderPlayer();
    else {
      if (state.player) { state.player.stop(false); state.player = null; }
      if (state.route.name === "projects") renderProjects();
      else if (state.route.name === "project-detail") await renderProjectDetail();
      else if (state.route.name === "project-restore") renderProjectRestore();
      else if (state.route.name === "library") renderLibrary();
      else if (state.route.name === "details") await renderDetails();
      else if (state.route.name === "inspect") await renderInspect();
      else if (state.route.name === "save") await renderSaveExplorer();
      else if (state.route.name === "textures") await renderTextureWorkspace();
      else if (state.route.name === "audio") renderAudioWorkspace();
      else if (state.route.name === "assets") renderAssetsWorkspace();
      else if (state.route.name === "tools") renderTools();
      else if (state.route.name === "about") renderAbout();
      else renderHome();
    }
  } catch(error){
    console.error("Route rendering failed",error);
    if(state.route.name==="about")showToast("Diagnostics could not be refreshed; try reloading the page.","error");
    else renderRouteFailure(error);
  }
}

function repaintForImport() {
  if (state.route.name === "home") renderHome();
  else if (state.route.name === "library") renderLibrary();
  else if (state.route.name === "tools") renderTools();
  else if (state.route.name === "save") renderSaveExplorer();
  else if (state.route.name === "textures") renderTextureWorkspace();
  else if (state.route.name === "audio") renderAudioWorkspace();
  else if (state.route.name === "assets") renderAssetsWorkspace();
}

function updateBatchFile(file,status,error="") { const item=state.batchResults.find(result=>result.file===file); if(item){item.status=status;item.error=error;} }
async function handleFiles(inputFiles) {
  if (!inputFiles?.length || state.importing) return;
  const files = Array.from(inputFiles), importKind=state.importKind||"all"; state.importKind="all";
  state.importing = true; state.cancelImport=false; state.imported=[]; state.batchProgress=null;
  state.batchResults=files.map(file=>({file,name:file.webkitRelativePath||file.name,status:"queued",error:""}));
  state.importStatus = `Classifying ${files.length} file${files.length === 1 ? "" : "s"}…`;
  repaintForImport();
  let openedSaveId=null,openedTextureId=null,openedProjectBackup=null,importedAudioCount=0;
  const imported=new Map(), errors=[];
  try {
    const session=await ImportSession.inspect(files); state.ignoredImportFiles=session.ignored.map(entry=>entry.file);
    for(const {file} of session.ignored) updateBatchFile(file,"ignored","Unsupported file type or invalid file signature");
    const wanted={level:"level",audio:"audio",texture:"texture"}[importKind];
    const acceptedItems=session.items.filter(item=>!wanted||item.kind===wanted);
    for(const item of session.items) if(wanted&&item.kind!==wanted) for(const file of item.files)updateBatchFile(file,"ignored",`Not selected for ${importKind} import`);
    const stop=()=>state.cancelImport;
    const setStatus=(file,status,message="")=>{updateBatchFile(file,status,message);state.importStatus=message||`${status}: ${file.name}`;repaintForImport();};
    let index=0;
    const projectBackupItems=acceptedItems.filter(entry=>entry.kind==="project-backup");
    if(projectBackupItems.length&&!stop()){const file=projectBackupItems[0].files[0];setStatus(file,"validating",`Validating ${file.name}…`);openedProjectBackup=file;for(const item of projectBackupItems.slice(1))for(const extra of item.files)setStatus(extra,"ignored","Project previews are handled one at a time; inspect the next backup after this preview.");}
    for(const item of acceptedItems.filter(entry=>entry.kind==="texture")){
      if(stop())break; item.files.forEach(file=>setStatus(file,"processing",`Validating texture files ${item.files.map(entry=>entry.name).join(" + ")}…`));
      try{const workspace=await importTextureFiles(item.files),hashes=workspace.sourceFiles.map(file=>file.contentHash).filter(Boolean).sort(),duplicate=hashes.length===workspace.sourceFiles.length&&state.textures.find(pack=>{const prior=(pack.sourceFiles||[]).map(file=>file.contentHash).filter(Boolean).sort();return prior.length===hashes.length&&prior.every((hash,index)=>hash===hashes[index]);});if(duplicate&&!confirm(`This texture source matches “${duplicate.name}”.\n\nOK: import as another workspace\nCancel: skip duplicate`)){item.files.forEach(file=>setStatus(file,"duplicate",`Matches ${duplicate.name}; skipped by choice`));continue;}const stored=await saveTextureWorkspace(workspace);openedTextureId=stored.id;item.files.forEach(file=>setStatus(file,"imported",duplicate?"Imported as another workspace":"Texture workspace saved"));await recordActivity({kind:"texture",resourceId:stored.id,name:stored.name,action:"imported"});}
      catch(error){const message=error.message||"Unable to import texture files.";errors.push(`${item.files.map(file=>file.name).join(" + ")}: ${message}`);item.files.forEach(file=>setStatus(file,"failed",message));}
    }
    const seenAudioHashes=new Set(state.audioAssets.map(asset=>asset.contentHash).filter(Boolean));
    for(const item of acceptedItems.filter(entry=>entry.kind==="audio"))for(const file of item.files){
      if(stop())break; setStatus(file,"processing",`Hashing ${file.name} in bounded chunks…`);
      try{
        let contentHash="";try{contentHash=await hashFileContent(file,{onProgress:progress=>{state.importStatus=`Hashing ${file.name} · ${fmtBytes(progress.current)} / ${fmtBytes(progress.total)}`;repaintForImport();}});}catch(_){/* The file remains importable when Web Crypto is unavailable. */}
        if(contentHash){for(const prior of state.audioAssets.filter(asset=>!asset.contentHash&&asset.fileSize===file.size&&asset.blob)){try{const priorHash=await hashFileContent(prior.blob);const saved=await saveAudioAssetMetadata(prior.id,{contentHash:priorHash});state.audioAssets=state.audioAssets.map(asset=>asset.id===saved.id?saved:asset);seenAudioHashes.add(priorHash);}catch(_){/* One legacy asset failing to hash does not stop the batch. */}}}
        if(contentHash&&seenAudioHashes.has(contentHash)){
          const match=state.audioAssets.find(asset=>asset.contentHash===contentHash);
          const copy=confirm(`This file has the same content as “${match?.displayName||file.name}”.\n\nOK: import as a separate copy\nCancel: skip this duplicate`);
          if(!copy){setStatus(file,"duplicate",`Matches ${match?.filename||"an item already imported"}; skipped by choice`);continue;}
        }
        const created=await createAudioAssetRecord(file,{contentHash});if(contentHash)seenAudioHashes.add(contentHash);importedAudioCount++;setStatus(file,"imported","Audio asset saved");await recordActivity({kind:"audio",resourceId:created.id,name:created.displayName,action:"imported"});
      }catch(error){const message=error.message||"This audio file could not be read.";errors.push(`${file.name}: ${message}`);setStatus(file,"failed",message);}
    }
    for(const item of acceptedItems.filter(entry=>entry.kind==="save")){
      if(stop())break;item.files.forEach(file=>setStatus(file,"processing",`Decoding save snapshot ${item.files.map(entry=>entry.name).join(" + ")}…`));
      try{const document=await importSave(item.files);const record=await createSaveSnapshot(document);openedSaveId=record.id;item.files.forEach(file=>setStatus(file,"imported","Save snapshot stored"));await recordActivity({kind:"save",resourceId:record.id,name:item.files.map(file=>file.name).join(" + "),action:"imported"});}
      catch(error){const message=error.message||"Unable to decode save file.";errors.push(`${item.files.map(file=>file.name).join(" + ")}: ${message}`);item.files.forEach(file=>setStatus(file,"failed",message));}
    }
    const levelFiles=acceptedItems.filter(item=>item.kind==="level").flatMap(item=>item.files);
    for(const file of levelFiles){
      if(stop())break;index++;setStatus(file,"processing",`Parsing ${file.name} (${index} of ${levelFiles.length})…`);
      try{
        const doc=await importLevel(file),duplicate=state.levels.find(record=>record.document.source?.contentHash&&record.document.source.contentHash===doc.source.contentHash)||(()=>{const match=[...imported.values()].find(candidate=>candidate.source?.contentHash===doc.source.contentHash);return match?{document:match}:null;})();
        let record;
        if(duplicate){const copy=confirm(`Already exists: “${duplicate.document.metadata.name}” matches ${file.name}.\n\nOK: import as a separate copy\nCancel: skip this duplicate`);if(!copy){setStatus(file,"duplicate",`Matches ${duplicate.document.metadata.name}; skipped by choice`);continue;}record=await createLevel(doc,{duplicateMode:"copy"});}
        else record=await createLevel(doc);
        if(record.skipped){setStatus(file,"duplicate","Duplicate skipped");continue;}
        imported.set(record.document.id,record.document);setStatus(file,"imported",record.duplicate?"Imported as a separate copy":"Level added to Library");await recordActivity({kind:"level",resourceId:record.id,name:record.document.metadata.name,action:"imported"});
      }catch(error){const message=error.message||"Could not parse level.";errors.push(`${file.name}: ${message}`);setStatus(file,"failed",message);}
    }
    state.imported=[...imported.values()];
    if(stop())for(const item of state.batchResults)if(item.status==="queued")item.status="cancelled";
    if(openedProjectBackup){updateBatchFile(openedProjectBackup,"ready","Backup ready for preview and selective restore");}
    const counts={success:state.batchResults.filter(item=>["imported","ready"].includes(item.status)).length,ignored:state.batchResults.filter(item=>item.status==="ignored").length,duplicates:state.batchResults.filter(item=>item.status==="duplicate").length,failed:state.batchResults.filter(item=>item.status==="failed").length,cancelled:state.batchResults.filter(item=>item.status==="cancelled").length};
    state.batchSummary={counts,items:state.batchResults.map(({name,status,error})=>({name,status,error})),at:Date.now()};
    state.importing=false;state.importStatus="";await refresh();
    if(openedProjectBackup) await handleProjectBackupFile(openedProjectBackup);
    else if(openedTextureId){state.activeSheetId=null;state.selectedSprite=null;state.textureQuery="";route(`/tools/textures/${encodeURIComponent(openedTextureId)}`);await refresh();}
    else if(openedSaveId){state.saveTab="overview";route(`/tools/save/${encodeURIComponent(openedSaveId)}`);await refresh();}
    else if(importedAudioCount)route("/tools/audio");
    const report=`Import complete · ${counts.success} succeeded · ${counts.duplicates} duplicates skipped · ${counts.ignored} ignored · ${counts.failed} failed${counts.cancelled?` · ${counts.cancelled} cancelled`:""}`;
    showToast(report,counts.failed?"error":""); if(errors.length)showToast(errors.slice(0,3).join(" | "),"error");
  } catch(error){
    state.importing=false;state.importStatus="";for(const item of state.batchResults)if(item.status==="queued"||item.status==="processing")updateBatchFile(item.file,"failed",error.message||"Import failed");
    state.batchSummary={counts:{success:0,ignored:0,duplicates:0,failed:state.batchResults.length,cancelled:0},items:state.batchResults.map(({name,status,error})=>({name,status,error})),at:Date.now()};
    await refresh();showToast(error.message||"Batch import failed.","error");
  }
}

function updateProjectProgressUI() {
  const current = document.querySelector(".project-task-status");
  const markup = projectTaskStatus();
  if (current) current.outerHTML = markup;
  else if (markup) document.querySelector(".project-title-line, .page-heading")?.insertAdjacentHTML("afterend", markup);
}
function progressCallback(stage, info = {}) {
  const labels = { collect: "Collecting project resources", checksums: "Verifying backup files", archive: "Building project archive", validate: "Validating archive", prepare: "Preparing safe restore", commit: "Committing the restore transaction" };
  state.projectProgress = { stage, message: `${labels[stage] || "Working"}${info.label ? ` · ${info.label}` : ""}`, current: info.current || 0, total: info.total || 0 };
  updateProjectProgressUI();
}
async function handleProjectBackupFile(file) {
  if (!file) return;
  state.restoreFile = file; state.restorePreview = null; state.restoreResourceKeys = new Set();
  state.projectProgress = { message: "Checking archive and verifying checksums", current: 0, total: 0 };
  state.projectAbortController = new AbortController();
  state.route = { name: "project-restore" }; route("/projects/restore"); renderProjectRestore(); updateProjectProgressUI();
  try {
    const preview = await inspectProjectBackup(file, { signal: state.projectAbortController.signal, onProgress: info => progressCallback(info.stage, info) });
    state.restorePreview = preview;
    state.restoreResourceKeys = new Set(preview.manifest.resources.map(item => `${item.type}:${item.originalId}`));
    state.projectProgress = null; state.projectAbortController = null; renderProjectRestore();
  } catch (error) {
    state.projectProgress = null; state.projectAbortController = null; state.restorePreview = null; state.restoreFile = null;
    if (error.name !== "AbortError") showToast(error.message || "The project backup could not be validated.", "error");
    renderProjectRestore();
  }
}
async function beginProjectExport(projectId) {
  state.projectAbortController = new AbortController();
  state.projectProgress = { message: "Preparing project backup", current: 0, total: 0 };
  updateProjectProgressUI();
  try {
    const blob = await exportProjectBackup(projectId, { createdWith:window.GMDPLAYER_META, signal: state.projectAbortController.signal, onProgress: info => progressCallback(info.stage, info) });
    const project = await getProject(projectId);if(project)await recordActivity({kind:"project",resourceId:project.id,name:project.name,action:"exported"});
    const safeName = String(project?.name || "gmdplayer-project").replace(/[\\/:*?"<>|]+/g, "-").trim().slice(0, 100) || "gmdplayer-project";
    downloadBlob(blob,`${safeName}${PROJECT_BACKUP_EXTENSION}`);
    showToast("Project backup exported. Source records remain unchanged.");
  } catch (error) {
    if (error.name !== "AbortError") showToast(error.message || "The project could not be exported.", "error");
    else showToast("Project export cancelled. No data was changed.");
  } finally { state.projectProgress = null; state.projectAbortController = null; updateProjectProgressUI(); }
}
async function beginProjectRestore() {
  if (!state.restoreFile || !state.restorePreview) return;
  state.projectAbortController = new AbortController();
  state.projectProgress = { message: "Preparing selected resources", current: 0, total: 0 }; updateProjectProgressUI();
  try {
    const result = await restoreProjectBackup(state.restoreFile, { resourceKeys: [...state.restoreResourceKeys], signal: state.projectAbortController.signal, onProgress: info => progressCallback(info.stage, info) });
    await recordActivity({kind:"project",resourceId:result.project.id,name:result.project.name,action:"restored"});
    state.restoreFile = null; state.restorePreview = null; state.projectProgress = null; state.projectAbortController = null;
    await refresh(); route(`/projects/${encodeURIComponent(result.project.id)}`); await refresh();
    const total = Object.values(result.importedCounts).reduce((sum, count) => sum + count, 0);
    showToast(`Project restored with ${total} selected resource${total === 1 ? "" : "s"}. Existing data was not replaced.`);
  } catch (error) {
    state.projectProgress = null; state.projectAbortController = null;
    if (error.name !== "AbortError") showToast(error.message || "Project restore failed. Existing data was not modified.", "error");
    else showToast("Restore cancelled. Existing data was not changed.");
    renderProjectRestore();
  }
}

app.addEventListener("click", async event => {
  const selectable=event.target.closest("[data-selectable]");
  if(selectable&&!event.target.closest("button,a,input,select,textarea,[data-action]")){
    const scope=selectable.dataset.selectable,id=selectable.dataset.id,model=state.selections[scope];
    if(model){model.select(id,{additive:event.metaKey||event.ctrlKey,range:event.shiftKey,toggle:event.metaKey||event.ctrlKey});renderScope(scope);return;}
  }
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const { action, id } = control.dataset;
  if(action==="retry-startup"){await refresh();return;}
  if(action==="retry-route"){await refresh();return;}
  if(action==="dismiss-onboarding"){state.onboardingDismissed=true;setWorkbenchValue("onboardingDismissed",true).catch(()=>{});renderHome();return;}
  if(action==="browse-level"){openImportPicker("level");return;}
  if(action==="dismiss-install"){state.installDismissed=true;setWorkbenchValue("installDismissed",true).catch(()=>{});renderInstallAffordance();return;}
  if(action==="install-app"){const promptEvent=state.installPrompt;if(!promptEvent)return;try{await promptEvent.prompt();const choice=await promptEvent.userChoice;state.installPrompt=null;if(choice?.outcome==="dismissed"){state.installDismissed=true;await setWorkbenchValue("installDismissed",true).catch(()=>{});}renderInstallAffordance();}catch(_){showToast("Use your browser menu to install GMDPlayer.");}return;}
  if(action==="copy-diagnostics"){const content=diagnosticText();try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(content);else{const area=document.createElement("textarea");area.value=content;area.style.position="fixed";area.style.opacity="0";document.body.append(area);area.select();if(!document.execCommand("copy"))throw new Error("Clipboard access unavailable");area.remove();}showToast("Diagnostic summary copied. It contains counts and browser details, not resource contents.");}catch(_){showToast("Clipboard access is unavailable. Select the browser and version details above instead.","error");}return;}
  if(action==="load-more-sprites"){state.spriteLimit+=200;renderTextureWorkspace();return;}
  if(action==="load-more-save-levels"){state.saveLevelLimit+=200;renderSaveExplorer();return;}
  if(action==="load-more"){ const scope=control.dataset.scope;if(scope==="library")state.libraryLimit+=100;else if(scope==="audio")state.audioLimit+=100;else if(scope==="assets")state.assetLimit+=100;else if(scope==="projects"||scope==="projects-archived")state.projectLimit+=100;else if(scope==="textures")state.textureLimit+=100;else if(scope==="saves")state.saveLimit+=100;renderScope(scope);return;}
  if (action === "select-all-visible") { state.selections[control.dataset.scope]?.selectAll(); renderScope(control.dataset.scope); return; }
  if (action === "clear-selection") { state.selections[control.dataset.scope]?.clear(); renderScope(control.dataset.scope); return; }
  if (action === "bulk-tags") { try { await bulkTags(control.dataset.scope); } catch(error){showToast(error.message||"Bulk tagging failed.","error");} return; }
  if (action === "bulk-favorite") { try { await bulkFavorite(control.dataset.scope); } catch(error){showToast(error.message||"Could not update favorites.","error");} return; }
  if (action === "bulk-project-add") { try { const select=[...document.querySelectorAll("[data-bulk-project-select]")].find(item=>item.dataset.bulkProjectSelect===control.dataset.scope); await bulkAssignProject(control.dataset.scope,select?.value,false,control.dataset.resourceType); } catch(error){showToast(error.message||"Could not assign selected resources.","error");} return; }
  if (action === "bulk-project-remove") { try { await bulkAssignProject(control.dataset.scope,control.dataset.project,true,control.dataset.resourceType); } catch(error){showToast(error.message||"Could not remove selected membership.","error");} return; }
  if (action === "bulk-export") { const count=bulkItems(control.dataset.scope).length;setOperationStatus("Preparing selected items for export",0,count);try { await bulkExport(control.dataset.scope); } catch(error){showToast(error.message||"Bulk export failed.","error");} finally{setOperationStatus();} return; }
  if (action === "bulk-delete") { try { await bulkDelete(control.dataset.scope); } catch(error){showToast(error.message||"Bulk delete failed.","error");} return; }
  if (action === "bulk-project-archive") { try { await bulkProjectArchive(control.dataset.scope); } catch(error){showToast(error.message||"Project batch update failed.","error");} return; }
  if(action==="save-search-definition"){const scope=control.dataset.scope,name=prompt("Name this saved filter:");if(name){const saved=createSavedSearch({name,scope,definition:{...state.searchFilters[scope],query:searchScopeQuery(scope),libraryFilter:state.libraryFilter,audioFilter:state.audioFilter,assetFilter:state.assetFilter}});await saveSavedSearch(saved);state.savedSearches=await listSavedSearches();state.currentSavedSearch[scope]=saved.id;renderScope(scope);showToast(`Saved filter “${saved.name}”.`);}return;}
  if(action==="rename-saved-search"){const scope=control.dataset.scope,item=state.savedSearches.find(search=>search.id===state.currentSavedSearch[scope]);if(!item){showToast("Choose a saved filter first.");return;}const name=prompt("Rename saved filter:",item.name);if(name){const updated={...item,name:name.trim(),updatedAt:Date.now()};await saveSavedSearch(updated);state.savedSearches=await listSavedSearches();renderScope(scope);}return;}
  if(action==="delete-saved-search"){const scope=control.dataset.scope,item=state.savedSearches.find(search=>search.id===state.currentSavedSearch[scope]);if(!item){showToast("Choose a saved filter first.");return;}if(confirm(`Delete saved filter “${item.name}”?`)){await deleteSavedSearch(item.id);state.savedSearches=await listSavedSearches();state.currentSavedSearch[scope]="";renderScope(scope);}return;}
  if(action==="cancel-import"){state.cancelImport=true;state.importStatus="Cancelling after the current file…";repaintForImport();return;}
  if(action==="retry-import-failures"){const files=state.batchResults.filter(item=>item.status==="failed").map(item=>item.file);state.batchSummary=null;await handleFiles(files);return;}
  if(action==="process-next-backup"){const file=state.batchResults.find(item=>item.status==="ignored"&&item.name.toLowerCase().endsWith(".gmdproject"))?.file;if(file){state.batchSummary=null;await handleFiles([file]);}return;}
  if(action==="browse-folder"){if(supportsDirectorySelection())document.querySelector("#folder-input")?.click();else showToast("This browser cannot select folders here. Use Import files and choose multiple files instead.");return;}
  if (action === "project-create") {
    try { const project = await createProjectRecord({ name: "New Geometry Dash Project" }); await setActiveProjectId(project.id);await recordActivity({kind:"project",resourceId:project.id,name:project.name,action:"created"}); state.projectMemberQuery = ""; await refresh(); route(`/projects/${encodeURIComponent(project.id)}`); await refresh(); }
    catch (error) { showToast(error.message || "Could not create project.", "error"); }
    return;
  }
  if (action === "project-import-open") { const input = document.querySelector("#project-input"); if (input) { input.value = ""; input.click(); } return; }
  if (action === "project-cancel") { state.projectAbortController?.abort(); return; }
  if (action === "project-restore-cancel") { state.restoreFile = null; state.restorePreview = null; state.restoreResourceKeys.clear(); route("/projects"); return; }
  if (action === "project-restore") { await beginProjectRestore(); return; }
  if (action === "project-export") { await beginProjectExport(id); return; }
  if (action === "project-open") {
    event.preventDefault();
    try { await setActiveProjectId(id); state.projectMemberQuery = ""; route(`/projects/${encodeURIComponent(id)}`); await refresh(); showToast(`“${state.activeProject?.name || "Project"}” is now the active workspace.`); }
    catch (error) { showToast(error.message || "Could not open project.", "error"); }
    return;
  }
  if (action === "project-activate") {
    try { await setActiveProjectId(id); await refresh(); showToast(`“${state.activeProject?.name || "Project"}” is now the active workspace.`); }
    catch (error) { showToast(error.message || "Could not open project.", "error"); }
    return;
  }
  if (action === "project-deactivate") { await setActiveProjectId(null); await refresh(); showToast("No project is active. Global resources remain available."); return; }
  if (action === "project-save") {
    try { const previous=await getProject(id),patch={ name: document.querySelector("#project-name")?.value, description: document.querySelector("#project-description")?.value },updated=await updateProjectRecord(id,patch);if(previous){pushUndo("Edit project details",()=>updateProjectRecord(id,{name:previous.name,description:previous.description}),()=>updateProjectRecord(id,{name:updated.name,description:updated.description}));await recordActivity({kind:"project",resourceId:id,name:updated.name,action:"edited"});} state.projectMemberQuery = ""; await refresh(); showToast("Project details saved."); }
    catch (error) { showToast(error.message || "Could not save project details.", "error"); }
    return;
  }
  if (action === "project-add-member" || action === "project-remove-member") {
    try {
      const projectId=control.dataset.project,type=control.dataset.type,resourceId=control.dataset.resourceId,project=await getProject(projectId),was=Boolean(project?.resources?.[type]?.includes(resourceId));
      if (action === "project-add-member") await addProjectResource(projectId,type,resourceId);
      else await removeProjectResource(projectId,type,resourceId);
      const now=action==="project-add-member";if(was!==now)pushUndo("Project membership change",async()=>was?addProjectResource(projectId,type,resourceId):removeProjectResource(projectId,type,resourceId),async()=>now?addProjectResource(projectId,type,resourceId):removeProjectResource(projectId,type,resourceId));
      await recordActivity({kind:"project",resourceId:projectId,name:project?.name||"Project",action:"edited"});await refresh();
      showToast(action === "project-add-member" ? "Resource added to project. The global asset remains unchanged." : "Resource removed from project. The global asset remains available.");
    } catch (error) { showToast(error.message || "Could not update project membership.", "error"); }
    return;
  }
  if (action === "project-duplicate") {
    try { const duplicate = await duplicateProjectRecord(id); await refresh(); route(`/projects/${encodeURIComponent(duplicate.id)}`); await refresh(); showToast("Project duplicated with independent resource records."); }
    catch (error) { showToast(error.message || "Could not duplicate this project.", "error"); }
    return;
  }
  if (action === "project-archive" || action === "project-unarchive") {
    try {
      const current = await getProject(id),previous=current?.archivedAt||null,archivedAt = current?.archivedAt ? null : Date.now();
      await updateProjectRecord(id, { archivedAt });pushUndo(archivedAt?"Archive project":"Restore project",()=>updateProjectRecord(id,{archivedAt:previous}),()=>updateProjectRecord(id,{archivedAt}));
      if (archivedAt && state.activeProjectId === id) await setActiveProjectId(null);
      await recordActivity({kind:"project",resourceId:id,name:current?.name||"Project",action:archivedAt?"archived":"restored"});await refresh(); showToast(archivedAt ? "Project archived. Its resources remain in global storage." : "Project restored from archive.");
    } catch (error) { showToast(error.message || "Could not update project status.", "error"); }
    return;
  }
  if (action === "project-delete") {
    const project = await getProject(id); if (!project) return;
    const counts = Object.values(project.resources || {}).map(ids => ids?.length || 0);
    if (!confirm(`Remove project “${project.name}”? This deletes only the project record. Its ${counts[0]} levels, ${counts[1]} songs, ${counts[2]} texture workspaces, and ${counts[3]} save snapshots remain in global storage.`)) return;
    try { await deleteProjectRecord(id); await refresh(); route("/projects"); await refresh(); showToast(`Project removed. ${counts.reduce((a, b) => a + b, 0)} referenced resources remain available globally.`); }
    catch (error) { showToast(error.message || "Could not remove project.", "error"); }
    return;
  }
  if (action === "browse") openImportPicker();
  if (action === "library") route("/library");
  if (action === "open-audio") route("/tools/audio");
  if (action === "open-assets") route("/tools/assets");
  if (action === "browse-audio") { const input = document.querySelector("#audio-input"); if (input) { input.value = ""; input.click(); } }
  if (action === "audio-select" || action === "audio-play") {
    state.audioSelectedId = id; renderAudioWorkspace();
    const preview = document.querySelector("#audio-preview");
    if (action === "audio-play") preview?.play().catch(() => showToast("This browser could not play this audio format.", "error"));
  }
  if (action === "audio-rename") { state.audioEditingId = id; renderAudioWorkspace(); document.querySelector("#audio-display-name")?.focus(); }
  if (action === "audio-rename-cancel") { state.audioEditingId = null; renderAudioWorkspace(); }
  if (action === "audio-rename-save") {
    try {
      const previous=state.audioAssets.find(asset=>asset.id===id),updated = await saveAudioAssetMetadata(id, { displayName: document.querySelector("#audio-display-name")?.value });
      if(previous)pushUndo("Rename audio display label",()=>saveAudioAssetMetadata(id,{displayName:previous.displayName}),()=>saveAudioAssetMetadata(id,{displayName:updated.displayName}));await recordActivity({kind:"audio",resourceId:id,name:updated.displayName,action:"edited"});
      state.audioAssets = state.audioAssets.map(asset => asset.id === id ? updated : asset); state.audioEditingId = null; renderAudioWorkspace(); showToast("Display name updated. Original filename is unchanged.");
    } catch (error) { showToast(error.message || "Could not save audio metadata.", "error"); }
  }
  if (action === "audio-metadata-save") {
    try {
      const previous=state.audioAssets.find(asset=>asset.id===id);
      const updated = await saveAudioAssetMetadata(id, {
        gdSongId: document.querySelector("#audio-gd-song-id")?.value || null,
        artist: document.querySelector("#audio-artist")?.value || "",
        album: document.querySelector("#audio-album")?.value || "",
        notes: document.querySelector("#audio-notes")?.value || ""
      });
      if(previous){const fields=["gdSongId","artist","album","notes"],before=Object.fromEntries(fields.map(key=>[key,previous[key]])),after=Object.fromEntries(fields.map(key=>[key,updated[key]]));pushUndo("Edit song metadata",()=>saveAudioAssetMetadata(id,before),()=>saveAudioAssetMetadata(id,after));await recordActivity({kind:"audio",resourceId:id,name:updated.displayName,action:"edited"});}
      state.audioAssets = state.audioAssets.map(asset => asset.id === id ? updated : asset);
      renderAudioWorkspace(); showToast("Song metadata saved locally.");
    } catch (error) { showToast(error.message || "Could not save audio metadata.", "error"); }
  }
  if (action === "audio-delete") {
    const uses = audioUsageCount(id), asset = state.audioAssets.find(item => item.id === id);
    if (!asset || !confirm(`Remove “${asset.displayName}” from the local audio library?${uses ? ` ${uses} level link(s) will show Song unavailable; their original song data stays unchanged.` : ""}`)) return;
    if (state.audioPreviewId === id) releaseAudioPreview();
    await deleteAudioAsset(id); state.audioAssets = state.audioAssets.filter(item => item.id !== id); if (state.audioSelectedId === id) state.audioSelectedId = null;
    await refresh(); showToast("Local audio removed. Level links were preserved.");
  }
  if (action === "asset-delete-texture") {
    const pack = state.textures.find(item => item.id === id);
    if (!pack || !confirm(`Remove texture workspace “${pack.name}”? Any level links will show Texture workspace unavailable.`)) return;
    await deleteTextureWorkspace(id); await refresh(); showToast("Texture workspace removed. Level metadata was preserved.");
  }
  if (action === "inspector-tab") { state.inspectorTab = control.dataset.tab; renderInspect(); }
  if (action === "inspector-more") { state.inspectorLimit += 100; renderInspect(); }
  if (action === "save-level-app-meta") {
    try {
      const entry=await getLevel(id),before={tags:entry?.applicationMetadata?.tags||[],notes:entry?.applicationMetadata?.notes||""},tags = (document.querySelector("#level-tags")?.value || "").split(",").map(tag => tag.trim()).filter(Boolean),notes = document.querySelector("#level-notes")?.value || "";
      await updateLevelApplicationMetadata(id, { tags, notes });pushUndo("Edit level notes and tags",()=>updateLevelApplicationMetadata(id,before),()=>updateLevelApplicationMetadata(id,{tags,notes}));await recordActivity({kind:"level",resourceId:id,name:entry?.document?.metadata?.name||"Level",action:"edited"});await refresh(); showToast("GMDPlayer notes and tags saved separately from the original level.");
    } catch (error) { showToast(error.message || "Could not save level metadata.", "error"); }
  }
  if (action === "library-view") { state.libraryView = control.dataset.view; persistView("library",{view:state.libraryView}); renderLibrary(); }
  if (action === "library-filter") { state.libraryFilter = control.dataset.filter; persistView("library",{filter:state.libraryFilter}); renderLibrary(); }
  if (action === "inspect-latest") { if (state.levels[0]) route(`/library/inspect/${encodeURIComponent(state.levels[0].document.id)}`); else showToast("Import a level to inspect it."); }
  if (action === "open-save") route(`/tools/save/${encodeURIComponent(id || state.saves[0]?.id || "")}`);
  if (action === "open-textures") route("/tools/textures");
  if (action === "open-texture") { state.activeSheetId = null; state.selectedSprite = null; state.textureQuery = ""; route(`/tools/textures/${encodeURIComponent(id)}`); }
  if (action === "texture-choose-sheet") { state.activeSheetId = control.dataset.sheet; state.selectedSprite = null; await renderTextureWorkspace(); }
  if (action === "texture-select") { state.activeSheetId = control.dataset.sheet; state.selectedSprite = { sheetId: control.dataset.sheet, name: control.dataset.sprite }; await renderTextureWorkspace(); }
  if (action === "texture-replace") { const input = document.querySelector("#replacement-input"); if (input) { input.value = ""; input.click(); } }
  if (action === "texture-reset-one" || action === "texture-reset-all" || action === "texture-undo" || action === "texture-redo") {
    const pack = await getTextureWorkspace(state.route.id); if (!pack) return;
    if (action === "texture-reset-one") resetSprite(pack, state.selectedSprite?.sheetId, state.selectedSprite?.name);
    if (action === "texture-reset-all") { if (!confirm("Reset every modified sprite in this workspace? This cannot be undone after leaving the workspace.")) return; resetAllSprites(pack); }
    if (action === "texture-undo") undoTexture(pack);
    if (action === "texture-redo") redoTexture(pack);
    await saveTextureWorkspace(pack); await renderTextureWorkspace();
  }
  if (action === "texture-delete") {
    if (confirm("Remove this texture workspace from this browser? Your original files on disk will not be changed.")) {
      await deleteTextureWorkspace(state.route.id); state.activeTexture = null; route("/tools/textures"); showToast("Texture workspace removed.");
    }
  }
  if (action === "texture-export" || action === "texture-export-sheet" || action === "texture-split" || action === "texture-repack" || action === "texture-merge") {
    try {
      const pack = await getTextureWorkspace(state.route.id); if (!pack) return;
      if (action === "texture-export") await exportTexturePack(pack, `${pack.name.replace(/[^\\w.-]+/g, "_")}.zip`);
      if (action === "texture-export-sheet") await exportTextureSheet(pack, state.activeSheetId);
      if (action === "texture-split") await exportSplitSprites(pack, state.activeSheetId);
      if (action === "texture-repack") await exportRepackedTexturePack(pack, state.activeSheetId);
      if (action === "texture-merge") await mergeTextureSheets(pack);
      showToast(action === "texture-repack" ? "Repacked texture ZIP exported." : action === "texture-merge" ? "Merged sheets exported as a new ZIP." : "Texture export is ready.");
    } catch (error) { showToast(error.message || "Texture export failed.", "error"); }
  }
  if (action === "toggle-nav") { document.body.classList.toggle("nav-open"); control.setAttribute("aria-expanded", String(document.body.classList.contains("nav-open"))); }
  if (action === "browse-save") { openImportPicker("save"); return; }
  if (action === "save-tab") { state.saveTab = control.dataset.tab; await renderSaveExplorer(); }
  if (action === "save-file-tab") { state.rawFile = control.dataset.tab; state.saveTab = "raw"; await renderSaveExplorer(); }
  if (action === "save-open-raw") { state.rawView = control.dataset.view || "json"; state.saveTab = "raw"; await renderSaveExplorer(); return; }
  if (action === "raw-view") { state.rawView = control.dataset.view; await renderSaveExplorer(); }
  if (action === "save-select-all" || action === "save-clear") {
    const record = await getSaveSnapshot(state.route.id);
    if (action === "save-select-all") (record?.document?.normalized?.localLevels || []).forEach(item => state.selectedSaveLevels.add(item.id));
    else state.selectedSaveLevels.clear();
    await renderSaveExplorer();
  }
  if (action === "save-import-all") {
    const record = await getSaveSnapshot(state.route.id);
    await importSnapshotLevels((record?.document?.normalized?.localLevels || []).map(item => item.id));
  }
  if (action === "save-import-selected") await importSnapshotLevels([...state.selectedSaveLevels]);
  if (action === "save-import-one") await importSnapshotLevels([id]);
  if (action === "delete-save" && confirm("Remove this saved snapshot from GMDPlayer? The original save file on your device will not be changed.")) {
    await deleteSaveSnapshot(id); state.selectedSaveLevels.clear(); route("/tools"); showToast("Save snapshot removed. Your original file is unchanged.");
  }
  if (action === "save-download-original") {
    const snapshot = await getSaveSnapshot(state.route.id);
    const original = snapshot?.document?.files?.[control.dataset.slot]?.original;
    const filename = snapshot?.document?.files?.[control.dataset.slot]?.filename || (control.dataset.slot === "gameManager" ? "CCGameManager.dat" : "CCLocalLevels.dat");
    if (!original) { showToast("The original save binary is not available in this snapshot.", "error"); return; }
    downloadBlob(original, safeFilename(filename));
    showToast("Original save file exported unchanged.");
    return;
  }
  if (action === "copy-raw" || action === "download-raw") {
    const record = await getSaveSnapshot(state.route.id);
    if (!record) return;
    if (control.dataset.view) state.rawView = control.dataset.view;
    const raw = currentRawContent(record.document);
    if (action === "copy-raw") {
      try { await navigator.clipboard.writeText(raw.content); showToast("Masked data copied to clipboard."); }
      catch (_) { showToast("Clipboard access is unavailable in this browser.", "error"); }
    } else {
      const blob = new Blob([raw.content], { type: state.rawView === "xml" ? "application/xml" : "application/json" });
      downloadBlob(blob,`${raw.slot === "gameManager" ? "CCGameManager" : "CCLocalLevels"}-decoded.${state.rawView}`);
      showToast("Decoded representation exported. Original .dat files were not changed.");
    }
  }
  if (action === "details") route(`/library/${encodeURIComponent(id)}`);
  if (action === "play") {
    state.returnTo = state.route.name === "details" ? `#/library/${encodeURIComponent(state.route.id)}` : "#/library";
    route(`/play/${encodeURIComponent(id)}`);
  }
  if (action === "exit") { if (state.player) state.player.exit(); else route(state.returnTo || "#/library"); }
  if (action === "delete") {
    const entry = await getLevel(id);
    if (entry && confirm(`Delete “${entry.document.metadata.name}” from your local Library?`)) {
      await deleteLevel(id);
      if (state.route.name === "details") route("/library"); else await refresh();
      showToast("Level deleted from your Library.");
    }
  }
});
app.addEventListener("input", event => {
  const target=event.target;
  if(target.id==="search"){state.search=target.value;state.libraryLimit=100;syncLibrarySearchUrl();scheduleSearchRender("library","search",renderLibrary);persistView("library",{filters:state.searchFilters.library}).catch(()=>{});}
  if(target.id==="save-search"){state.saveQuery=target.value;state.saveLevelLimit=200;scheduleSearchRender("saves","save-search",renderSaveExplorer);}
  if(target.id==="texture-search"){state.textureQuery=target.value;state.spriteLimit=200;scheduleSearchRender("textures","texture-search",renderTextureWorkspace);}
  if(target.id==="project-member-search"){state.projectMemberQuery=target.value;scheduleSearchRender("project-members","project-member-search",renderProjectDetail);}
  if(target.id==="audio-search"){state.audioQuery=target.value;scheduleSearchRender("audio","audio-search",renderAudioWorkspace);persistView("audio",{query:state.audioQuery});}
  if(target.id==="asset-search"){state.assetQuery=target.value;scheduleSearchRender("assets","asset-search",renderAssetsWorkspace);persistView("assets",{query:state.assetQuery});}
  if(target.id==="project-search"){state.projectQuery=target.value;scheduleSearchRender("projects","project-search",renderProjects);}
  if(target.id==="inspector-search"){state.inspectorQuery=target.value;scheduleSearchRender("inspector","inspector-search",renderInspect);}
  if(target.id==="global-search"){state.globalQuery=target.value;}
  const tagScope=target.dataset.filterTags;if(tagScope){state.searchFilters[tagScope].tags=target.value;clearTimeout(state.searchTimers?.[`filter-${tagScope}`]);state.searchTimers||=Object.create(null);state.searchTimers[`filter-${tagScope}`]=setTimeout(()=>{if(tagScope==="library")syncLibrarySearchUrl();persistView(tagScope,{filters:state.searchFilters[tagScope]});renderScope(tagScope);},250);}
});
app.addEventListener("keydown", event => {
  if (event.target.id === "global-search" && event.key === "Enter") { state.globalQuery = event.target.value; state.search = state.globalQuery; route("/library"); }
});
document.addEventListener("click",event=>{
  const command=event.target.closest("[data-action='palette-command']");if(command){const item=commandDefinitions().find(entry=>entry.id===command.dataset.command);closePalette();item?.run();return;}
  const quick=event.target.closest("[data-quick-index]");if(quick){prepareQuickItem(state.paletteItems?.[Number(quick.dataset.quickIndex)]);closePalette();return;}
  if(event.target.classList?.contains("command-backdrop")){closePalette();state.paletteReturnFocus?.focus?.();}
});
document.addEventListener("input",event=>{if(event.target.id==="command-search"){state.paletteQuery=event.target.value;state.paletteIndex=0;renderPalette();}});
document.addEventListener("keydown", event => {
  if(state.palette){
    const dialog=document.querySelector(".command-dialog");
    if(event.key==="Escape"){event.preventDefault();closePalette();state.paletteReturnFocus?.focus?.();return;}
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();const length=state.paletteItems?.length||0;if(length){state.paletteIndex=(state.paletteIndex+(event.key==="ArrowDown"?1:-1)+length)%length;renderPalette();}return;}
    if(event.key==="Enter"){event.preventDefault();const item=state.paletteItems?.[state.paletteIndex];if(!item)return;if(state.palette==="quick"){prepareQuickItem(item);closePalette();route(item.href.replace(/^#/,""));}else{closePalette();item.run();}return;}
    if(event.key==="Tab"&&dialog){const focusable=[...dialog.querySelectorAll("input,button,a[href]")].filter(item=>!item.disabled);if(!focusable.length)return;const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}return;}
    return;
  }
  const typing=Boolean(event.target?.isContentEditable||event.target?.matches?.("input,textarea,select,audio,video,[role='textbox']")||event.target?.closest?.("pre,code,[data-native-shortcuts]"));
  const searchSelector={library:"#search",audio:"#audio-search",assets:"#asset-search",projects:"#project-search",textures:"#texture-search",save:"#save-search"}[state.route.name]||"#global-search";
  const selectionScope={library:"library",audio:"audio",assets:"assets",projects:"projects",textures:state.route.id?null:"textures",save:"saves",tools:"saves"}[state.route.name];
  const shortcut=resolveKeyboardShortcut(event,{editing:typing,searchAvailable:Boolean(document.querySelector(searchSelector)),selectable:Boolean(selectionScope),textureWorkspace:state.route.name==="textures"&&Boolean(state.route.id)});
  if(shortcut){
    event.preventDefault();
    if(shortcut==="command-palette"){state.paletteReturnFocus=document.activeElement;openPalette("commands");}
    else if(shortcut==="quick-open"){state.paletteReturnFocus=document.activeElement;openPalette("quick");}
    else if(shortcut==="workspace-search")document.querySelector(searchSelector)?.focus();
    else if(shortcut==="select-visible"){state.selections[selectionScope]?.selectAll();renderScope(selectionScope);}
    else if(shortcut==="texture-undo"||shortcut==="texture-redo"){getTextureWorkspace(state.route.id).then(pack=>{if(!pack)return;if(shortcut==="texture-redo")redoTexture(pack);else undoTexture(pack);return saveTextureWorkspace(pack).then(()=>renderTextureWorkspace());}).catch(error=>showToast(error.message||"Texture history action failed.","error"));}
    else runHistory(shortcut);
    return;
  }
  const row=!typing&&event.target.matches?.("[data-selectable]")?event.target:null;
  if(row&&["ArrowDown","ArrowUp"].includes(event.key)){event.preventDefault();const model=state.selections[row.dataset.selectable];model?.move(row.dataset.id,event.key==="ArrowDown"?1:-1,{additive:event.shiftKey});const id=model?.values().at(-1);renderScope(row.dataset.selectable);[...document.querySelectorAll(`[data-selectable="${row.dataset.selectable}"]`)].find(item=>item.dataset.id===id)?.focus();return;}
  if(row&&(event.key===" "||event.key==="Spacebar")){event.preventDefault();const model=state.selections[row.dataset.selectable];model?.select(row.dataset.id,{toggle:true});renderScope(row.dataset.selectable);return;}
  if(row&&event.key==="Enter"){event.preventDefault();const scope=row.dataset.selectable,id=row.dataset.id,record=selectionRecords(scope).find(item=>item.id===id);if(scope==="library")route(`/library/${encodeURIComponent(id)}`);else if(scope==="audio"){state.audioSelectedId=id;renderAudioWorkspace();}else if(scope==="projects"||scope==="projects-archived")route(`/projects/${encodeURIComponent(id)}`);else if(scope==="textures")route(`/tools/textures/${encodeURIComponent(id)}`);else if(scope==="saves")route(`/tools/save/${encodeURIComponent(id)}`);else if(scope==="assets"){const item=getAssetRecords().find(entry=>entry.id===id);if(item)route(item.href.replace(/^#/,""));}return;}
  if(event.key==="Escape"&&!typing){
    const selected=Object.entries(state.selections).find(([,model])=>model?.size);
    if(selected){event.preventDefault();selected[1].clear();renderScope(selected[0]);return;}
    if(document.body.classList.contains("nav-open")){document.body.classList.remove("nav-open");document.querySelector(".nav-toggle")?.setAttribute("aria-expanded","false");}
  }
  if(event.key==="Delete"&&!typing){const scope={library:"library",audio:"audio",assets:"assets",textures:"textures"}[state.route.name];if(scope&&state.selections[scope]?.size){event.preventDefault();bulkDelete(scope).catch(error=>showToast(error.message||"Could not remove selected resources.","error"));}}
});

app.addEventListener("change", async event => {
  const target=event.target,scope=target.dataset.filterProject||target.dataset.filterFavorite||target.dataset.filterTagMode||target.dataset.filterFrom||target.dataset.filterTo||target.dataset.filterMinSize||target.dataset.filterMaxSize||target.dataset.filterMinObjects||target.dataset.filterMaxObjects;
  if(scope){const filter=state.searchFilters[scope];if(target.dataset.filterProject)filter.projectId=target.value;if(target.dataset.filterFavorite)filter.favorite=target.checked;if(target.dataset.filterTagMode)filter.tagMode=target.value;if(target.dataset.filterFrom)filter.fromDate=target.value;if(target.dataset.filterTo)filter.toDate=target.value;if(target.dataset.filterMinSize)filter.minSize=target.value;if(target.dataset.filterMaxSize)filter.maxSize=target.value;if(target.dataset.filterMinObjects)filter.minObjects=target.value;if(target.dataset.filterMaxObjects)filter.maxObjects=target.value;if(scope==="library")syncLibrarySearchUrl();await persistView(scope,{filters:filter});renderScope(scope);return;}
  if(target.matches("[data-saved-search]")){const search=state.savedSearches.find(item=>item.id===target.value);if(search){state.currentSavedSearch[search.scope]=search.id;state.searchFilters[search.scope]={...state.searchFilters[search.scope],...search.definition};if(search.definition.query!=null)setSearchScopeQuery(search.scope,search.definition.query);if(search.definition.libraryFilter)state.libraryFilter=search.definition.libraryFilter;if(search.definition.audioFilter)state.audioFilter=search.definition.audioFilter;if(search.definition.assetFilter)state.assetFilter=search.definition.assetFilter;await persistView(search.scope,{filters:state.searchFilters[search.scope]});if(search.scope==="library")syncLibrarySearchUrl();renderScope(search.scope);}return;}
  if(event.target.matches("[data-select-item]")){const {selectItem:scope,id}=event.target.dataset,model=state.selections[scope];if(model){if(event.target.checked)model.select(id,{additive:event.shiftKey||event.metaKey||event.ctrlKey,range:event.shiftKey});else{model.selected.delete(id);model.anchor=id;}renderScope(scope);[...document.querySelectorAll("[data-select-item]")].find(item=>item.dataset.selectItem===scope&&item.dataset.id===id)?.focus();}return;}
  if (event.target.matches("[data-save-level]")) {
    if (event.target.checked) state.selectedSaveLevels.add(event.target.dataset.saveLevel);
    else state.selectedSaveLevels.delete(event.target.dataset.saveLevel);
    renderSaveExplorer();
  }
  if (event.target.id === "hide-sensitive") { state.showAllSensitive = !event.target.checked; renderSaveExplorer(); }
  if (event.target.id === "raw-file-select") { state.rawFile = event.target.value; renderSaveExplorer(); }
  if (event.target.id === "audio-filter") { state.audioFilter = event.target.value; renderAudioWorkspace(); }
  if (event.target.id === "audio-sort") { state.audioSort = event.target.value; persistView("audio",{sort:state.audioSort}); renderAudioWorkspace(); }
  if (event.target.id === "asset-filter") { state.assetFilter = event.target.value; renderAssetsWorkspace(); }
  if (event.target.id === "asset-sort") { state.assetSort = event.target.value; persistView("assets",{sort:state.assetSort}); renderAssetsWorkspace(); }
  if (event.target.matches("[data-restore-resource]")) {
    const key = event.target.dataset.restoreResource;
    if (event.target.checked) state.restoreResourceKeys.add(key); else state.restoreResourceKeys.delete(key);
    renderProjectRestore();
  }
  if (event.target.matches("[data-restore-category]")) {
    const type = event.target.dataset.restoreCategory;
    for (const item of state.restorePreview?.manifest.resources || []) if (item.type === type) {
      const key = `${type}:${item.originalId}`;
      if (event.target.checked) state.restoreResourceKeys.add(key); else state.restoreResourceKeys.delete(key);
    }
    renderProjectRestore();
  }
  if (event.target.id === "inspector-sort") { state.inspectorSort = event.target.value; renderInspect(); }
  if (event.target.id === "level-audio-select") {
    const assetId = event.target.value || null, id = event.target.dataset.levelId;
    try { await updateLevelApplicationMetadata(id, { audioOverride: assetId ? { source: "local", assetId } : null }); await refresh(); showToast(assetId ? "Local song override saved for this level." : "Local song override removed. Original level data is unchanged."); }
    catch (error) { showToast(error.message || "Could not update this level's song.", "error"); }
  }
  if (event.target.id === "level-texture-select") {
    const workspaceId = event.target.value || null, id = event.target.dataset.levelId;
    try { await updateLevelApplicationMetadata(id, { textureWorkspaceId: workspaceId }); await refresh(); showToast(workspaceId ? "Texture workspace linked to this level." : "Texture workspace link removed."); }
    catch (error) { showToast(error.message || "Could not update the texture link.", "error"); }
  }
});
document.addEventListener("change", async event => {
  if (event.target.id === "project-input" && event.target.files?.[0]) handleProjectBackupFile(event.target.files[0]);
  if (event.target.id === "file-input" || event.target.id === "audio-input" || event.target.id === "folder-input") { const files=Array.from(event.target.files||[]);event.target.value="";handleFiles(files); }
  if (event.target.id === "replacement-mode") { state.replacementMode = event.target.value; }
  if (event.target.id === "replacement-input" && event.target.files?.[0]) {
    try {
      const pack = await getTextureWorkspace(state.route.id), sheet = pack?.sheets?.[state.selectedSprite?.sheetId], frame = sheet?.parsed?.frames?.[state.selectedSprite?.name];
      if (!pack || !sheet || !frame) throw new Error("Select a valid sprite before replacing it.");
      const canvas = await createSpriteReplacement(sheet.source.png, frame, event.target.files[0], state.replacementMode);
      const bytes = await canvasToPngBytes(canvas); canvas.close?.();
      applySpriteModification(pack, sheet.id, frame.name, bytes, { mode: state.replacementMode });
      await saveTextureWorkspace(pack); await renderTextureWorkspace(); showToast(`${frame.name} replaced. Original atlas and PLIST are preserved.`);
    } catch (error) { showToast(error.message || "Sprite replacement failed.", "error"); }
    event.target.value = "";
  }
});
window.addEventListener("hashchange", () => { state.route = parseRoute(); refresh(); });

let dragCounter = 0;
window.addEventListener("dragenter", event => {
  if (state.route.name === "play" || !event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault(); dragCounter++;
  if (!document.querySelector(".drop-curtain")) { const labels={library:"Drop GMD / TXT levels and supported assets",audio:"Drop local audio files to import",assets:"Drop supported levels, audio, textures, or saves",textures:"Drop PNG + PLIST pairs or texture ZIPs",projects:"Drop a .gmdproject backup to restore", "project-restore":"Drop a .gmdproject backup to inspect",save:"Drop a Geometry Dash save file"};document.body.insertAdjacentHTML("beforeend",`<div class="drop-curtain"><span>${esc(labels[state.route.name]||"Drop supported Geometry Dash files to import")}</span></div>`); }
});
window.addEventListener("dragover", event => { if (state.route.name !== "play" && event.dataTransfer?.types?.includes("Files")) event.preventDefault(); });
window.addEventListener("dragleave", event => { if (state.route.name === "play") return; dragCounter = Math.max(0, dragCounter - 1); if (!dragCounter) document.querySelector(".drop-curtain")?.remove(); });
window.addEventListener("drop", event => {
  if (state.route.name === "play" || !event.dataTransfer?.files?.length) return;
  event.preventDefault(); dragCounter = 0; document.querySelector(".drop-curtain")?.remove(); handleFiles(event.dataTransfer.files);
});

renderBootScreen();
registerPwa();
window.addEventListener("offline",updateNetworkAffordance);
window.addEventListener("online",updateNetworkAffordance);
window.addEventListener("beforeinstallprompt",event=>{if(state.installDismissed)return;event.preventDefault();state.installPrompt=event;renderInstallAffordance();});
window.addEventListener("appinstalled",()=>{state.installPrompt=null;state.installDismissed=true;setWorkbenchValue("installDismissed",true).catch(()=>{});renderInstallAffordance();});
refresh();
