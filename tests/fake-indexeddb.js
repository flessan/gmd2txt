const copy = value => value === undefined ? undefined : structuredClone(value);
class FakeRequest {}
class FakeStoreState {
  constructor(name, keyPath, values = []) {
    this.name = name; this.keyPath = keyPath; this.rows = new Map(); this.indexes = new Map();
    for (const value of values) this.rows.set(value[keyPath], copy(value));
  }
}
class FakeTransaction {
  constructor(db) { this.db = db; this.pending = 0; this.scheduled = false; this.finished = false; }
  objectStore(name) {
    const store = this.db.stores.get(name);
    if (!store) throw new Error(`Missing fake object store: ${name}`);
    return new FakeObjectStore(this, store);
  }
  request(operation) {
    const request = new FakeRequest(); this.pending++;
    queueMicrotask(() => {
      try { request.result = copy(operation()); request.onsuccess?.({ target: request }); }
      catch (error) { request.error = error; request.onerror?.({ target: request }); }
      this.pending--; this.maybeComplete();
    });
    return request;
  }
  maybeComplete() {
    if (this.pending || this.scheduled || this.finished) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.pending || this.finished) return this.maybeComplete();
      this.finished = true; this.oncomplete?.({ target: this });
    });
  }
}
class FakeObjectStore {
  constructor(transaction, state) { this.transaction = transaction; this.state = state; }
  createIndex(name, keyPath) { this.state.indexes.set(name, keyPath); return this; }
  index(name) {
    const keyPath = this.state.indexes.get(name);
    if (!keyPath) throw new Error(`Missing fake index: ${name}`);
    return { get: key => this.transaction.request(() => [...this.state.rows.values()].find(row => readPath(row, keyPath) === key)) };
  }
  get(key) { return this.transaction.request(() => this.state.rows.get(key)); }
  getAll() { return this.transaction.request(() => [...this.state.rows.values()]); }
  openCursor() { const request=new FakeRequest(),rows=[...this.state.rows.values()];let index=0;const step=()=>queueMicrotask(()=>{request.result=index<rows.length?{value:copy(rows[index]),continue:()=>{index++;step();}}:null;request.onsuccess?.({target:request});});step();return request; }
  put(value) { return this.transaction.request(() => { this.state.rows.set(value[this.state.keyPath], copy(value)); return value[this.state.keyPath]; }); }
  add(value) { return this.transaction.request(() => { if (this.state.rows.has(value[this.state.keyPath])) throw new Error("ConstraintError"); this.state.rows.set(value[this.state.keyPath], copy(value)); return value[this.state.keyPath]; }); }
  delete(key) { return this.transaction.request(() => this.state.rows.delete(key)); }
}
function readPath(value, path) { return String(path).split(".").reduce((current, part) => current?.[part], value); }
class FakeDatabase {
  constructor(name, version, seeded = {}) {
    this.name = name; this.version = version; this.stores = new Map();
    this.objectStoreNames = { contains: name => this.stores.has(name) };
    for (const [storeName, seed] of Object.entries(seeded)) {
      const store = new FakeStoreState(storeName, seed.keyPath || "id", seed.rows || []);
      for (const [indexName, keyPath] of Object.entries(seed.indexes || {})) store.indexes.set(indexName, keyPath);
      this.stores.set(storeName, store);
    }
  }
  createObjectStore(name, options = {}) {
    const store = new FakeStoreState(name, options.keyPath || "id"); this.stores.set(name, store); return new FakeObjectStore({ request: fn => ({}) }, store);
  }
  transaction() { return new FakeTransaction(this); }
}
export function installLegacyIndexedDB(seedLevels = [], options = {}) {
  const version = options.version || 3;
  const stores = { levels: { keyPath: "id", rows: seedLevels, indexes: { updatedAt: "updatedAt", contentHash: "document.source.contentHash" } } };
  if (version >= 2) stores.saveSnapshots = { keyPath: "id", rows: options.saveRows || [], indexes: { importedAt: "importedAt" } };
  if (version >= 3) stores.textureWorkspaces = { keyPath: "id", rows: options.textureRows || [], indexes: { updatedAt: "updatedAt" } };
  if (version >= 4) stores.audioAssets = { keyPath: "id", rows: options.audioRows || [], indexes: { importedAt: "importedAt", displayName: "displayName", mimeType: "mimeType" } };
  if (version >= 5) { stores.projects = { keyPath: "id", rows: options.projectRows || [], indexes: { updatedAt: "updatedAt" } }; stores.projectPreferences = { keyPath: "key", rows: options.projectPreferences || [] }; }
  if (version >= 6) stores.workbenchData = { keyPath: "key", rows: options.workbenchRows || [] };
  const db = new FakeDatabase("gmdplayer-library", version, stores);
  globalThis.indexedDB = {
    open(name, version) {
      const request = new FakeRequest();
      queueMicrotask(() => {
        if(version<db.version){request.error=Object.assign(new Error("A newer IndexedDB schema is already installed."),{name:"VersionError"});request.onerror?.({target:request});return;}
        request.result = db;
        if (version > db.version) {
          const oldVersion = db.version; db.version = version;
          request.onupgradeneeded?.({ oldVersion, newVersion: version, target: request });
        }
        queueMicrotask(() => request.onsuccess?.({ target: request }));
      });
      return request;
    }
  };
  return db;
}
