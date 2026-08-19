// Optional backup: mirrors each document's notes (ink + memorization
// masks) as a plain JSON file in a folder the user picks, so notes exist
// as a real, tangible, backupable file — not just invisible browser
// storage. The original PDF is never written here, only note data.
import { getSetting, setSetting, getAllNotesForDoc } from "./db.js";

export const supportsDirectoryPicker = typeof window.showDirectoryPicker === "function";

export async function pickNotesFolder() {
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await setSetting("notesDir", handle);
  return handle;
}

// Returns the stored folder handle if permission is (or can be) granted,
// otherwise null. Never prompts without a stored handle.
export async function getNotesFolder() {
  const handle = await getSetting("notesDir");
  if (!handle) return null;
  try {
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" });
    return perm === "granted" ? handle : null;
  } catch {
    return null;
  }
}

export async function clearNotesFolder() {
  await setSetting("notesDir", null);
}

function safeFileName(doc) {
  const base = doc.name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  return `${base}__${doc.id.slice(0, 10)}.json`;
}

export async function writeNotesSnapshot(dirHandle, doc) {
  const pages = await getAllNotesForDoc(doc.id);
  const payload = {
    app: "pdf-note",
    docName: doc.name,
    docId: doc.id,
    savedAt: new Date().toISOString(),
    pages,
  };
  const fileHandle = await dirHandle.getFileHandle(safeFileName(doc), { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(payload, null, 2));
  await writable.close();
}
