import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installLegacyIndexedDB } from "./fake-indexeddb.js";
import { normalizeRecentActivity, normalizeSavedSearches, normalizeViewPreference, resolveActiveProject } from "../core/startup/release-state.js";
import { PLAYER_RUNTIME_URL } from "../core/runtime/player-adapter.js";
import { filterResources } from "../core/workbench/search.js";
import { resolveKeyboardShortcut } from "../core/workbench/keyboard-shortcuts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("v1 database migrates additively to current schema and keeps original level rows", async () => {
  const original = { id:"old-level", document:{ id:"old-level", metadata:{ name:"Keep me" }, content:{ raw:"original" } }, applicationMetadata:{ tags:["kept"] }, updatedAt:10 };
  const legacy = installLegacyIndexedDB([original], { version:1 });
  const { openLibraryDatabase, getLevels, DATABASE_SCHEMA_VERSION } = await import("../core/storage/database.js");
  await openLibraryDatabase();
  assert.equal(DATABASE_SCHEMA_VERSION, 6);
  assert.equal(legacy.version, 6);
  for (const store of ["levels","saveSnapshots","textureWorkspaces","audioAssets","projects","projectPreferences","workbenchData"]) assert.ok(legacy.stores.has(store), `missing ${store}`);
  const records = await getLevels();
  assert.equal(records.length,1);
  assert.equal(records[0].document.content.raw,"original");
  assert.deepEqual(records[0].applicationMetadata.tags,["kept"]);
  await openLibraryDatabase();
  assert.equal(legacy.version,6);
});

test("stale active projects and malformed UI preferences recover to safe defaults", () => {
  const projects=[{id:"active",name:"Current"},{id:"archived",name:"Archived",archivedAt:123}];
  assert.equal(resolveActiveProject(projects,"active").project.name,"Current");
  assert.deepEqual(resolveActiveProject(projects,"archived"),{project:null,activeId:null,stale:true});
  assert.equal(resolveActiveProject(projects,{id:"bad"}).activeId,null);
  assert.deepEqual(normalizeViewPreference(null),{});
  assert.deepEqual(normalizeViewPreference({view:"bogus",filters:{favorite:"yes",tags:"x",tagMode:"any",projectId:"p"}}),{filters:{tags:"x",tagMode:"any",projectId:"p"}});
  assert.deepEqual(normalizeRecentActivity({unexpected:true}),[]);
  assert.equal(normalizeSavedSearches([{id:"bad",name:"x",scope:"bogus",definition:{}}]).length,0);
  assert.deepEqual(normalizeSavedSearches([{id:"ok",name:"Filter",scope:"library",definition:{tags:"green",favorite:true,fromDate:"2025-01-01",extra:"ignored"}}])[0].definition,{tags:"green",favorite:true,fromDate:"2025-01-01"});
});

test("keyboard shortcuts support Ctrl and Cmd while preserving editable/native contexts", () => {
  assert.equal(resolveKeyboardShortcut({key:"k",ctrlKey:true}),"command-palette");
  assert.equal(resolveKeyboardShortcut({key:"P",metaKey:true}),"quick-open");
  assert.equal(resolveKeyboardShortcut({key:"f",ctrlKey:true},{searchAvailable:false}),null);
  assert.equal(resolveKeyboardShortcut({key:"a",metaKey:true},{selectable:false}),null);
  assert.equal(resolveKeyboardShortcut({key:"a",metaKey:true},{selectable:true}),"select-visible");
  assert.equal(resolveKeyboardShortcut({key:"z",ctrlKey:true},{editing:true,textureWorkspace:true}),null);
  assert.equal(resolveKeyboardShortcut({key:"z",ctrlKey:true,shiftKey:true},{textureWorkspace:true}),"texture-redo");
  assert.equal(resolveKeyboardShortcut({key:"y",metaKey:true}),"redo");
});

test("search remains responsive over a synthetic 5,000-record library", () => {
  const records=Array.from({length:5000},(_,index)=>({id:`level-${index}`,kind:"level",name:index%125===0?`Target ${index}`:`Level ${index}`,tags:index%2?["practice"]:[],date:index}));
  const start=performance.now(),matches=filterResources(records,{query:"target",type:"level"}),elapsed=performance.now()-start;
  assert.equal(matches.length,40);
  assert.ok(elapsed<2000,`synthetic local filter took ${elapsed.toFixed(1)}ms`);
});

test("PWA manifest icons, service worker shell URLs, and player adapter target exist", async () => {
  const manifest=JSON.parse(await readFile(path.join(root,"app/manifest.webmanifest"),"utf8"));
  assert.equal(manifest.display,"standalone");
  assert.equal(manifest.start_url,"./", "the workspace hub is the installed app");
  assert.match(manifest.name,/Workspace/);
  for(const icon of manifest.icons){const file=path.join(root,"app",icon.src.replace(/^\.\//,""));assert.ok(existsSync(file),`missing ${icon.src}`);const bytes=await readFile(file);assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");}
  const sw=await readFile(path.join(root,"sw.js"),"utf8");
  assert.match(sw,/addAll\(SHELL_ASSETS/);assert.doesNotMatch(sw,/skipWaiting/);assert.match(sw,/clients\.claim/);assert.match(sw,/request\.mode === "navigate"/);
  const section=sw.match(/const SHELL_ASSETS = \[([\s\S]*?)\n\];/)[1];
  for(const [,url] of section.matchAll(/"([^"]+)"/g))assert.ok(existsSync(path.resolve(root,"app",url)),`missing cached resource ${url}`);
  const player=new URL(PLAYER_RUNTIME_URL);
  assert.ok(player.pathname.endsWith("/app/play/index.html"),`unexpected player URL ${player.href}`);
});

test("the workspace is a single page with a single stylesheet, and every room lives in it", async () => {
  // One page, one stylesheet. `app/play/` is the bundled game runtime (it is
  // the engine the preview runs in), not a page of the workspace UI.
  const { readdir } = await import("node:fs/promises");
  const pages = (await readdir(path.join(root, "app"), { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".html")).map(entry => entry.name);
  assert.deepEqual(pages, ["index.html"], `the workspace must be one page, found ${pages.join(", ")}`);
  for (const gone of ["app/convert", "app/textures", "app/workbench", "app/converter", "app/assets/gmd2txt.css", "app/textures/textures.css"]) {
    assert.ok(!existsSync(path.join(root, gone)), `${gone} should be gone — it was a separate page or stylesheet`);
  }
  const stylesheets = (await readdir(path.join(root, "app/assets"))).filter(name => name.endsWith(".css"));
  assert.deepEqual(stylesheets, ["workspace.css"], `the workspace must be one stylesheet, found ${stylesheets.join(", ")}`);

  const page = await readFile(path.join(root, "app/index.html"), "utf8");
  assert.match(page, /type="module" src="\.\/workspace\.js"/);
  assert.match(page, /<link rel="stylesheet" href="\.\/assets\/workspace\.css">/, "the page links the one stylesheet");
  assert.equal((page.match(/rel="stylesheet"/g) || []).length, 1, "exactly one stylesheet link");
  assert.equal((page.match(/<html/g) || []).length, 1, "one document");
  for (const room of ["home", "convert", "textures", "play", "saved", "save"]) {
    assert.match(page, new RegExp(`id="view-${room}"`), `missing the ${room} room`);
  }
  // The rooms keep the feature ids their modules drive.
  for (const id of ["intake", "dropzone", "result-list", "sprite-grid", "detail", "level-grid", "saved-list", "save-drop", "player-overlay", "paste-dialog", "toasts"]) {
    assert.match(page, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  const rooms = page.match(/class="room[ "]/g) || [];
  assert.ok(rooms.length >= 5, `the landing view should be a collection of rooms (found ${rooms.length})`);
  for (const [, src] of page.matchAll(/src="(\.\/[^"]+)"/g)) assert.ok(existsSync(path.resolve(root, "app", src)), `page asset missing: ${src}`);

  // The shell routes dropped files to the room that understands them.
  const shell = await readFile(path.join(root, "app/workspace.js"), "utf8");
  assert.match(shell, /from "\.\/views\/convert\.js"/, "the shell mounts the converter room");
  assert.match(shell, /from "\.\/views\/textures\.js"/, "the shell mounts the sprite studio");
  assert.match(shell, /from "\.\/views\/savefile\.js"/, "the shell mounts the save reader");
  assert.match(shell, /function routeFiles/, "dropped files are routed by type");
  assert.doesNotMatch(shell, /location\.assign\("\.\/convert/, "no room navigates away any more");

  // The converter room still uses the shared conversion core.
  const converter = await readFile(path.join(root, "app/views/convert.js"), "utf8");
  assert.match(converter, /from "\.\.\/\.\.\/core\/convert\/level-file\.js"/, "the converter UI must use the shared conversion core");
  assert.match(converter, /export const converterApi/);
  assert.doesNotMatch(converter, /takeHandoffFiles/, "there is no cross-page drop box to drain");

  // The studio keeps the sprite-first contract: cut out, size it, replace it.
  const studio = await readFile(path.join(root, "app/views/textures.js"), "utf8");
  assert.match(studio, /extractSprite/, "each sprite is cut out as its own image");
  assert.match(studio, /createSpriteReplacement/, "replacement images are fitted to the sprite slot");
  assert.match(studio, /saveTextureWorkspace/, "texture workspaces are saved from the studio");
  assert.match(studio, /export const studioApi/);

  // The save reader reads Geometry Dash saves with the shared decoder.
  const saveReader = await readFile(path.join(root, "app/views/savefile.js"), "utf8");
  assert.match(saveReader, /from "\.\.\/\.\.\/core\/saves\/save-decoder\.js"/);
  assert.match(saveReader, /maskSensitiveFields/);
});
