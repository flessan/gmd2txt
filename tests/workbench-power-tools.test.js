import test from "node:test";
import assert from "node:assert/strict";
import { SelectionModel } from "../core/workbench/selection-model.js";
import { createSavedSearch, filterResources, sortResources } from "../core/workbench/search.js";
import { hashFileContent } from "../core/workbench/content-hash.js";
import { mergeTags, normalizeTags } from "../core/documents/tags.js";
import { applyProjectMembership } from "../core/workbench/bulk-operations.js";
import { installLegacyIndexedDB } from "./fake-indexeddb.js";

test("selection supports toggle, additive selection, shift ranges, select all, reconciliation and clearing", () => {
  const model = new SelectionModel(["a", "b", "c", "d"]);
  model.select("b"); model.select("d", { range: true });
  assert.deepEqual(new Set(model.values()), new Set(["b", "c", "d"]));
  model.select("c", { toggle: true });
  assert.deepEqual(new Set(model.values()), new Set(["b", "d"]));
  model.setVisible(["a", "d"]); model.toggleAll(); assert.equal(model.size, 2);
  assert.deepEqual(new Set(model.values()), new Set(["a", "d"]));
  model.clear(); assert.equal(model.size, 0);
});

test("search combines text, resource type, all/any tags, project, favorite and dates; sort is stable by field", () => {
  const records = [
    { id:"1", kind:"level", name:"Sky Platformer", tags:["favorite","unfinished"], projectIds:["p1"], favorite:true, date:100 },
    { id:"2", kind:"level", name:"Sky Sprint", tags:["favorite"], projectIds:["p2"], favorite:false, date:200 },
    { id:"3", kind:"audio", name:"Platform Theme", tags:["music"], projectIds:["p1"], favorite:true, date:300 }
  ];
  assert.deepEqual(filterResources(records, { query:"sky", type:"level", tags:["favorite","unfinished"], projectId:"p1", favorite:true, from:50, to:150 }).map(item => item.id), ["1"]);
  assert.deepEqual(filterResources(records, { tags:["favorite","unfinished"], tagMode:"any" }).map(item => item.id), ["1","2"]);
  assert.deepEqual(sortResources(records, "date", "desc").map(item => item.id), ["3","2","1"]);
  assert.deepEqual(sortResources(records, "name", "asc").map(item => item.id), ["3","1","2"]);
});

test("saved search definitions are named snapshots, normalized tags merge without duplicates", () => {
  const search = createSavedSearch({ name:"  Favorites  ", scope:"levels", definition:{ favorite:true, tags:["Favorite"] } });
  assert.equal(search.name, "Favorites");
  assert.deepEqual(search.definition.tags, ["Favorite"]);
  assert.deepEqual(normalizeTags([" Work  in progress ", "work in progress", "", "music"]), ["Work in progress", "music"]);
  assert.deepEqual(mergeTags(["favorite","old"], ["new","FAVORITE"], ["old"]), ["favorite","new"]);
});

test("batch project assignment is idempotent and reports partial failures without losing successful links", async () => {
  const project={id:"p",resources:{levels:["existing"],audioAssets:[],textureWorkspaces:[],saveSnapshots:[]}};
  const added=[];
  const result=await applyProjectMembership([{id:"existing",kind:"level"},{id:"new",kind:"level"},{id:"fail",kind:"audio"}],{
    projectId:"p",getProject:async()=>project,typeFor:item=>item.kind==="level"?"levels":"audioAssets",
    addResource:async(_project,type,id)=>{if(id==="fail")throw new Error("synthetic failure");added.push([type,id]);project.resources[type].push(id);},
    removeResource:async()=>{}
  });
  assert.deepEqual(result.operations.map(item=>item.id),["new"]);
  assert.equal(result.skipped.length,1);
  assert.equal(result.failed.length,1);
  assert.deepEqual(added,[["levels","new"]]);
});

test("workbench v5-to-v6 storage persists searches, view preferences, and bounded recent activity", async () => {
  const legacy=installLegacyIndexedDB([], {version:5});
  const {openLibraryDatabase}=await import("../core/storage/database.js");
  const {getWorkbenchValue,setWorkbenchValue,saveViewPreferences,getViewPreferences,saveSavedSearch,listSavedSearches,recordActivity,getRecentActivity}=await import("../core/storage/workbench-database.js");
  await openLibraryDatabase();assert.equal(legacy.version,6);assert.ok(legacy.stores.has("workbenchData"));
  await setWorkbenchValue("savedSearches",[]);await saveViewPreferences("library",{view:"list",filters:{favorite:true}});
  assert.deepEqual(await getViewPreferences("library"),{view:"list",filters:{favorite:true},updatedAt:(await getWorkbenchValue("view:library")).updatedAt});
  const saved=createSavedSearch({name:"Starred levels",scope:"library",definition:{favorite:true}});await saveSavedSearch(saved);
  assert.equal((await listSavedSearches())[0].id,saved.id);
  for(let index=0;index<105;index++)await recordActivity({kind:"level",resourceId:`level-${index}`,name:`Level ${index}`,action:"opened"});
  assert.equal((await getRecentActivity(100)).length,100);
  assert.equal((await getRecentActivity(5))[0].resourceId,"level-104");
});

test("chunked content hashes are content-sensitive, repeatable, and bounded by slices", async () => {
  const makeFile = bytes => ({ size:bytes.length, slice(start,end) { return new Blob([bytes.slice(start,end)]); } });
  const a = await hashFileContent(makeFile(Uint8Array.from([1,2,3,4,5])), { cache:false, chunkBytes:2 });
  const b = await hashFileContent(makeFile(Uint8Array.from([1,2,3,4,5])), { cache:false, chunkBytes:2 });
  const c = await hashFileContent(makeFile(Uint8Array.from([1,2,3,4,6])), { cache:false, chunkBytes:2 });
  const typed=await hashFileContent(Uint8Array.from([1,2,3,4,5]),{cache:false,chunkBytes:2});
  assert.equal(a,b); assert.equal(a,typed); assert.notEqual(a,c); assert.match(a,/^sha256-chunked-v1:5:/);
});
