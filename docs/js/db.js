const DB_NAME = "pdf-note";
const DB_VERSION = 3;

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
      if (!db.objectStoreNames.contains("masks")) {
        db.createObjectStore("masks", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("pageplans")) {
        db.createObjectStore("pageplans", { keyPath: "docId" });
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
  const t = db.transaction(["documents", "strokes", "masks", "pageplans"], "readwrite");
  t.objectStore("documents").delete(id);
  // Stroke/mask keys are `${docId}:${page}`; ":" (0x3A) sorts right after
  // any digit/letter docId char, so this range covers exactly this doc's
  // pages.
  const range = IDBKeyRange.bound(`${id}:`, `${id}:￿`);
  t.objectStore("strokes").delete(range);
  t.objectStore("masks").delete(range);
  t.objectStore("pageplans").delete(id);
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

// All (docId, page) pairs that have at least one memorization mask, with
// the owning document's name — used to build the home-screen flashcard
// list without opening every document.
export async function getAllMaskedPages() {
  const maskStore = await tx("masks", "readonly");
  const allMasks = await reqToPromise(maskStore.getAll());
  const docStore = await tx("documents", "readonly");
  const allDocs = await reqToPromise(docStore.getAll());
  const docsById = new Map(allDocs.map((d) => [d.id, d]));

  return allMasks
    .filter((rec) => rec.masks && rec.masks.length > 0 && docsById.has(rec.docId))
    .map((rec) => ({
      docId: rec.docId,
      docName: docsById.get(rec.docId).name,
      page: rec.page,
      count: rec.masks.length,
    }))
    .sort((a, b) => a.docName.localeCompare(b.docName) || a.page - b.page);
}

export async function getMasks(docId, page) {
  const store = await tx("masks", "readonly");
  const rec = await reqToPromise(store.get(`${docId}:${page}`));
  return rec ? rec.masks : [];
}

export async function saveMasks(docId, page, masks) {
  const store = await tx("masks", "readwrite");
  return reqToPromise(
    store.put({ key: `${docId}:${page}`, docId, page, masks })
  );
}

// Every stroke/mask record for a document, grouped by page key — used to
// write a full JSON snapshot of a document's notes to the backup folder.
export async function getAllNotesForDoc(docId) {
  // Issue+await each store's request before opening the next transaction —
  // leaving a transaction idle across an extra await (e.g. opening both
  // transactions up front) risks it auto-committing before its request is
  // ever issued.
  const strokeStore = await tx("strokes", "readonly");
  const allStrokes = await reqToPromise(strokeStore.getAll());
  const maskStore = await tx("masks", "readonly");
  const allMasks = await reqToPromise(maskStore.getAll());
  const pages = {};
  for (const rec of allStrokes) {
    if (rec.docId !== docId || rec.strokes.length === 0) continue;
    (pages[rec.page] ||= {}).strokes = rec.strokes;
  }
  for (const rec of allMasks) {
    if (rec.docId !== docId || rec.masks.length === 0) continue;
    (pages[rec.page] ||= {}).masks = rec.masks;
  }
  return pages;
}

export async function getSetting(key) {
  const store = await tx("settings", "readonly");
  const rec = await reqToPromise(store.get(key));
  return rec ? rec.value : undefined;
}

export async function setSetting(key, value) {
  const store = await tx("settings", "readwrite");
  return reqToPromise(store.put({ key, value }));
}

export async function getPagePlan(docId) {
  const store = await tx("pageplans", "readonly");
  const rec = await reqToPromise(store.get(docId));
  return rec ? rec.order : null;
}

export async function savePagePlan(docId, order) {
  const store = await tx("pageplans", "readwrite");
  return reqToPromise(store.put({ docId, order }));
}
