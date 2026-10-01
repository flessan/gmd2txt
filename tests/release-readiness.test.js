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
  assert.equal(manifest.start_url,"./", "the converter is the installed app, not the advanced workshop");
  for(const icon of manifest.icons){const file=path.join(root,"app",icon.src.replace(/^\.\//,""));assert.ok(existsSync(file),`missing ${icon.src}`);const bytes=await readFile(file);assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");}
  const sw=await readFile(path.join(root,"sw.js"),"utf8");
  assert.match(sw,/addAll\(SHELL_ASSETS/);assert.doesNotMatch(sw,/skipWaiting/);assert.match(sw,/clients\.claim/);assert.match(sw,/request\.mode === "navigate"/);
  const section=sw.match(/const SHELL_ASSETS = \[([\s\S]*?)\n\];/)[1];
  for(const [,url] of section.matchAll(/"([^"]+)"/g))assert.ok(existsSync(path.resolve(root,"app",url)),`missing cached resource ${url}`);
  const player=new URL(PLAYER_RUNTIME_URL);
  assert.ok(player.pathname.endsWith("/app/play/index.html"),`unexpected player URL ${player.href}`);
});

test("the converter entry points exist and the old routes still land somewhere useful", async () => {
  // The single-job converter is the app root: index.html + main.js + its stylesheet,
  // and the flow reads only from the shared core (no duplicated string handling).
  for (const file of ["app/index.html","app/main.js","app/assets/gmd2txt.css","app/workbench/index.html","app/workbench/main.js","core/convert/level-file.js"]) {
    assert.ok(existsSync(path.join(root,file)),`missing ${file}`);
  }
  const shell=await readFile(path.join(root,"app/index.html"),"utf8");
  assert.match(shell,/type="module" src="\.\/main\.js"/);
  assert.match(shell,/id="dropzone"/);
  assert.match(shell,/id="result-list"/);
  const main=await readFile(path.join(root,"app/main.js"),"utf8");
  assert.match(main,/from "\.\.\/core\/convert\/level-file\.js"/, "the UI must use the shared conversion core");
  const redirect=await readFile(path.join(root,"app/converter/index.html"),"utf8");
  assert.match(redirect,/location\.replace\("\.\.\/"\)/);
  const workbench=await readFile(path.join(root,"app/workbench/index.html"),"utf8");
  assert.match(workbench,/href="\.\.\/"/, "the workshop links back to the converter");
  for (const [,src] of shell.matchAll(/src="(\.\/[^"]+)"/g)) assert.ok(existsSync(path.resolve(root,"app",src)),`missing ${src}`);
});
