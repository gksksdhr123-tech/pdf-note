const DB_NAME = "pdf-note";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("documents")) {
        db.createObjectStore("documents", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("strokes")) {
        db.createObjectStore("strokes", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function getDB() {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

function tx(storeName, mode) {
  return getDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function hashFile(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function putDocument(doc) {
  const store = await tx("documents", "readwrite");
  return reqToPromise(store.put(doc));
}

export async function getDocument(id) {
  const store = await tx("documents", "readonly");
  return reqToPromise(store.get(id));
}

export async function getAllDocuments() {
  const store = await tx("documents", "readonly");
  const all = await reqToPromise(store.getAll());
  return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function deleteDocument(id) {
  const db = await getDB();
  const t = db.transaction(["documents", "strokes"], "readwrite");
  t.objectStore("documents").delete(id);
  // Stroke keys are `${docId}:${page}`; ":" (0x3A) sorts right after any
  // digit/letter docId char, so this range covers exactly this doc's pages.
  const range = IDBKeyRange.bound(`${id}:`, `${id}:￿`);
  t.objectStore("strokes").delete(range);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getStrokes(docId, page) {
  const store = await tx("strokes", "readonly");
  const rec = await reqToPromise(store.get(`${docId}:${page}`));
  return rec ? rec.strokes : [];
}

export async function saveStrokes(docId, page, strokes) {
  const store = await tx("strokes", "readwrite");
  return reqToPromise(
    store.put({ key: `${docId}:${page}`, docId, page, strokes })
  );
}
