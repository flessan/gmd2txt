import test from "node:test";
import assert from "node:assert/strict";
import { installLegacyIndexedDB } from "./fake-indexeddb.js";
import { openLibraryDatabase } from "../core/storage/database.js";

test("future database schema is refused without deleting it and a compatible retry works", async () => {
  const future=installLegacyIndexedDB([], {version:7});
  await assert.rejects(openLibraryDatabase(),error=>error.name==="VersionError");
  assert.equal(future.version,7);
  const current=installLegacyIndexedDB([], {version:6});
  await openLibraryDatabase();
  assert.equal(current.version,6);
});
