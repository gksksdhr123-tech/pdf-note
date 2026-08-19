import {
  hashFile,
  putDocument,
  getDocument,
  getAllDocuments,
  deleteDocument,
  getStrokes,
  saveStrokes,
  getMasks,
  saveMasks,
  getAllMaskedPages,
  getPagePlan,
  savePagePlan,
} from "./db.js";
import { loadPdf, getPage, getUnscaledSize, renderPage, renderSyntheticPage } from "./pdf-engine.js";
import { AnnotationLayer } from "./annotate.js";
import { exportAnnotatedPdf } from "./export.js";
import {
  supportsDirectoryPicker,
  pickNotesFolder,
  getNotesFolder,
  clearNotesFolder,
  writeNotesSnapshot,
} from "./notesfile.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const homeView = $("#home-view");
const viewerView = $("#viewer-view");
const cardsView = $("#cards-view");
const studyView = $("#study-view");
const settingsView = $("#settings-view");
const pagesView = $("#pages-view");

const docList = $("#doc-list");
const emptyHint = $("#empty-hint");
const addBtn = $("#add-btn");
const cardsBtn = $("#cards-btn");
const fileInput = $("#file-input");
const backBtn = $("#back-btn");
const docTitle = $("#doc-title");
const exportBtn = $("#export-btn");
const pdfCanvas = $("#pdf-canvas");
const inkCanvas = $("#ink-canvas");
const pageWrap = $("#page-wrap");
const pageStage = $("#page-stage");
const pageLabel = $("#page-label");
const zoomLabel = $("#zoom-label");
const toast = $("#toast");

const toolPen = $("#tool-pen");
const toolEraser = $("#tool-eraser");
const toolMask = $("#tool-mask");
const toolPan = $("#tool-pan");
const penControls = $("#pen-controls");
const maskControls = $("#mask-controls");
const undoBtn = $("#undo-btn");
const redoBtn = $("#redo-btn");
const prevPageBtn = $("#prev-page");
const nextPageBtn = $("#next-page");
const zoomInBtn = $("#zoom-in");
const zoomOutBtn = $("#zoom-out");
const memorizeToggle = $("#memorize-toggle");
const revealAllBtn = $("#reveal-all-btn");
const hideAllBtn = $("#hide-all-btn");
const autoAdvanceToggle = $("#auto-advance-toggle");

const cardsBackBtn = $("#cards-back-btn");
const cardListEl = $("#card-list");
const cardsEmptyHint = $("#cards-empty-hint");
const studyCloseBtn = $("#study-close-btn");
const studyTitle = $("#study-title");
const studyStage = $("#study-stage");
const studyCanvas = $("#study-canvas");
const studyPrevBtn = $("#study-prev-btn");
const studyNextBtn = $("#study-next-btn");
const studyIndexLabel = $("#study-index-label");
const studyRevealBtn = $("#study-reveal-btn");
const studyBaseCanvas = document.createElement("canvas"); // offscreen: pristine page render

const settingsBtn = $("#settings-btn");
const settingsBackBtn = $("#settings-back-btn");
const notesFolderStatus = $("#notes-folder-status");
const pickFolderBtn = $("#pick-folder-btn");
const syncAllBtn = $("#sync-all-btn");
const clearFolderBtn = $("#clear-folder-btn");
const settingsUnsupportedHint = $("#settings-unsupported-hint");

const pagesViewBtn = $("#pages-view-btn");
const pagesBackBtn = $("#pages-back-btn");
const pagesGrid = $("#pages-grid");
const insertModal = $("#insert-modal");
const insertCancelBtn = $("#insert-cancel-btn");
const imageInput = $("#image-input");

const state = {
  docRecord: null,
  currentFile: null, // the File/Blob actually backing the open document
  pdfDoc: null,
  page: null, // current pdf.js page proxy (null for inserted pages)
  order: [], // reading-order page entries for the open document
  syntheticSize: null, // default {pageWidth, pageHeight} for new inserted pages
  currentPage: 1, // 1-based index into `order`
  totalPages: 1, // = order.length
  baseScale: 1,
  zoom: 1,
  history: new Map(), // logical page index -> { undo: [], redo: [] }
  cardPages: [],
  studyIndex: 0,
  studyRevealed: false,
  studyDraw: null,
  studyPdfCache: new Map(), // docId -> pdf.js document proxy
  studyOrderCache: new Map(), // docId -> order array
};

let ink = null;
let autoAdvance = localStorage.getItem("pdf-note:auto-advance") !== "off"; // default on
let insertAfterIndex = null; // position in state.order to insert after (-1 = before first)

// File System Access API lets us keep a lightweight, reusable reference to
// a file on disk instead of copying the whole PDF into IndexedDB — avoids
// storing every PDF twice. Falls back to caching the file's bytes (the old
// behavior) on browsers that don't support it.
const supportsFilePicker = typeof window.showOpenFilePicker === "function";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 1800);
}

function hideAllViews() {
  homeView.classList.add("hidden");
  viewerView.classList.add("hidden");
  cardsView.classList.add("hidden");
  studyView.classList.add("hidden");
  settingsView.classList.add("hidden");
  pagesView.classList.add("hidden");
}

// ---------- Notes folder backup ----------

let notesDirHandle = null;
let notesDirName = null;
let notesSyncTimer = null;

async function initNotesFolder() {
  notesDirHandle = await getNotesFolder();
  notesDirName = notesDirHandle ? notesDirHandle.name : null;
}

function scheduleNotesSync() {
  if (!notesDirHandle || !state.docRecord) return;
  clearTimeout(notesSyncTimer);
  notesSyncTimer = setTimeout(() => {
    writeNotesSnapshot(notesDirHandle, state.docRecord).catch((err) => console.warn("notes sync failed", err));
  }, 900);
}

function renderNotesFolderStatus() {
  notesFolderStatus.textContent = notesDirName
    ? `현재 폴더: ${notesDirName}`
    : "폴더가 설정되지 않았습니다.";
  clearFolderBtn.disabled = !notesDirName;
  syncAllBtn.disabled = !notesDirName;
}

settingsUnsupportedHint.classList.toggle("hidden", supportsDirectoryPicker);
pickFolderBtn.disabled = !supportsDirectoryPicker;

settingsBtn.addEventListener("click", () => {
  hideAllViews();
  settingsView.classList.remove("hidden");
  renderNotesFolderStatus();
});

settingsBackBtn.addEventListener("click", () => {
  hideAllViews();
  homeView.classList.remove("hidden");
});

pickFolderBtn.addEventListener("click", async () => {
  try {
    const handle = await pickNotesFolder();
    notesDirHandle = handle;
    notesDirName = handle.name;
    renderNotesFolderStatus();
    showToast("폴더가 연결됐습니다");
  } catch (err) {
    if (err && err.name !== "AbortError") console.warn("pick notes folder failed", err);
  }
});

clearFolderBtn.addEventListener("click", async () => {
  await clearNotesFolder();
  notesDirHandle = null;
  notesDirName = null;
  renderNotesFolderStatus();
  showToast("폴더 연결이 해제됐습니다");
});

syncAllBtn.addEventListener("click", async () => {
  if (!notesDirHandle) return;
  showToast("내보내는 중...");
  const docs = await getAllDocuments();
  let count = 0;
  for (const doc of docs) {
    try {
      await writeNotesSnapshot(notesDirHandle, doc);
      count++;
    } catch (err) {
      console.warn("sync failed for", doc.name, err);
    }
  }
  showToast(`${count}개 문서 내보냄`);
});

// ---------- Home view ----------

async function renderHome() {
  const docs = await getAllDocuments();
  docList.innerHTML = "";
  emptyHint.classList.toggle("hidden", docs.length > 0);
  for (const doc of docs) {
    const li = document.createElement("li");
    li.className = "doc-item";
    li.innerHTML = `
      <div class="doc-icon">PDF</div>
      <div class="doc-info">
        <div class="doc-name"></div>
        <div class="doc-meta"></div>
      </div>
      <button class="doc-delete" title="삭제">✕</button>
    `;
    li.querySelector(".doc-name").textContent = doc.name;
    li.querySelector(".doc-meta").textContent = `${formatSize(doc.size)} · ${formatDate(doc.lastOpenedAt)}`;
    li.addEventListener("click", () => openDocument(doc.id));
    li.querySelector(".doc-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm(`"${doc.name}"을(를) 삭제할까요? 필기 내용도 함께 삭제됩니다.`)) {
        await deleteDocument(doc.id);
        renderHome();
      }
    });
    docList.appendChild(li);
  }
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// Opens the native file picker. Prefers the File System Access API, which
// hands back a reusable handle we can silently re-read from next time
// instead of copying the whole PDF into IndexedDB; falls back to a classic
// <input type=file> (one-shot File, no handle) where that API isn't
// available. Resolves to null if the user cancels.
async function pickPdfFile() {
  if (supportsFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
      return { file: await handle.getFile(), handle };
    } catch (err) {
      if (err && err.name === "AbortError") return null;
      // Some other failure (e.g. policy-blocked) — fall through to the
      // classic picker below instead of leaving the user stuck.
    }
  }
  return new Promise((resolve) => {
    const onChange = () => {
      fileInput.removeEventListener("change", onChange);
      const file = fileInput.files[0];
      fileInput.value = "";
      resolve(file ? { file, handle: null } : null);
    };
    fileInput.addEventListener("change", onChange);
    fileInput.click();
  });
}

// Gets the actual bytes for a saved document: from its file handle
// (re-checking/re-requesting permission), or its cached blob (documents
// saved before this device supported file handles), or — if neither works
// anymore — by asking the user to re-locate the file.
async function resolveFile(doc) {
  if (doc.handle) {
    try {
      let perm = await doc.handle.queryPermission({ mode: "read" });
      if (perm !== "granted") perm = await doc.handle.requestPermission({ mode: "read" });
      if (perm === "granted") return await doc.handle.getFile();
    } catch (err) {
      console.warn("file handle access failed", err);
    }
  }
  if (doc.blob) return doc.blob;

  showToast("파일을 다시 선택해주세요");
  const picked = await pickPdfFile();
  if (!picked) return null;
  const pickedId = await hashFile(picked.file);
  if (pickedId !== doc.id) {
    showToast("선택한 파일이 이 항목과 달라요");
    return null;
  }
  if (picked.handle) {
    doc.handle = picked.handle;
    await putDocument(doc);
  }
  return picked.file;
}

addBtn.addEventListener("click", async () => {
  const picked = await pickPdfFile();
  if (!picked) return;
  showToast("불러오는 중...");
  const id = await hashFile(picked.file);
  let doc = await getDocument(id);
  if (!doc) {
    doc = { id, name: picked.file.name, size: picked.file.size, addedAt: Date.now(), lastOpenedAt: Date.now() };
    if (picked.handle) doc.handle = picked.handle;
    else doc.blob = picked.file; // no File System Access support: only way to remember it
    await putDocument(doc);
  } else if (picked.handle && !doc.handle) {
    doc.handle = picked.handle; // upgrade a handle-less record now that we have one
    await putDocument(doc);
  }
  openDocument(id, picked.file);
});

// ---------- Page order (original PDF pages + any inserted pages) ----------

// Original-page entry ids are just the plain PDF page number as a string
// ("3"), matching the key format strokes/masks already used before this
// feature existed — so existing notes need no migration. Inserted pages
// get a distinct "ins-..." id.
async function loadPageOrder(docId, pdfDoc) {
  const saved = await getPagePlan(docId);
  if (saved && saved.length > 0) return saved;
  return Array.from({ length: pdfDoc.numPages }, (_, i) => ({ id: String(i + 1), kind: "original", pdfPage: i + 1 }));
}

function newInsertedPageId() {
  return `ins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Renders one order entry (original PDF page or an inserted page) onto
// `canvas` at `scale` CSS px/pt, returning the resulting viewport (a real
// pdf.js viewport for original pages, a flat look-alike for inserted ones
// — AnnotationLayer treats them identically).
async function renderEntry(pdfDoc, entry, canvas, scale, fallbackSize) {
  if (entry.kind === "original") {
    const page = await getPage(pdfDoc, entry.pdfPage);
    const viewport = await renderPage(page, canvas, scale);
    return { viewport, page };
  }
  const size = entry.size || fallbackSize;
  let bitmap = null;
  if (entry.kind === "image" && entry.imageBlob) bitmap = await createImageBitmap(entry.imageBlob);
  const viewport = renderSyntheticPage(canvas, entry.kind, size.pageWidth, size.pageHeight, scale, bitmap);
  return { viewport, page: null };
}

async function entryUnscaledWidth(pdfDoc, entry, fallbackSize) {
  if (entry.kind === "original") {
    return getUnscaledSize(await getPage(pdfDoc, entry.pdfPage)).pageWidth;
  }
  return (entry.size || fallbackSize).pageWidth;
}

// ---------- Viewer view ----------

async function openDocument(id, preFetchedFile) {
  const doc = await getDocument(id);
  if (!doc) return;

  const file = preFetchedFile || (await resolveFile(doc));
  if (!file) return;

  doc.lastOpenedAt = Date.now();
  doc.size = file.size;
  await putDocument(doc);

  state.docRecord = doc;
  state.currentFile = file;
  state.currentPage = 1;
  state.zoom = 1;
  state.history = new Map();

  const buf = await file.arrayBuffer();
  state.pdfDoc = await loadPdf(buf);
  state.order = await loadPageOrder(doc.id, state.pdfDoc);
  state.totalPages = state.order.length;

  const firstPage = await getPage(state.pdfDoc, 1);
  const firstSize = getUnscaledSize(firstPage);
  state.syntheticSize = { pageWidth: firstSize.pageWidth, pageHeight: firstSize.pageHeight };

  docTitle.textContent = doc.name;
  hideAllViews();
  viewerView.classList.remove("hidden");

  if (!ink) {
    ink = new AnnotationLayer(inkCanvas, {
      onChange: onInkChange,
      scrollContainer: pageStage,
      onReachBottom: goToNextPageAuto,
      onReachTop: goToPrevPageAuto,
      onPinchStart: onPinchStart,
      onPinch: onPinchMove,
      onPinchEnd: onPinchEnd,
    });
    ink.setAutoAdvance(autoAdvance);
    window.__ink = ink; // debug handle
  }
  ink.resetGroups();
  selectTool("pen");
  syncGroupSelectChips();
  syncVisibilityChips();
  memorizeToggle.classList.remove("active");

  await renderCurrentPage(true);
}

async function goToNextPageAuto() {
  if (state.currentPage >= state.totalPages) return;
  state.currentPage++;
  await renderCurrentPage(false);
  pageStage.scrollTop = 0;
}

async function goToPrevPageAuto() {
  if (state.currentPage <= 1) return;
  state.currentPage--;
  await renderCurrentPage(false);
  pageStage.scrollTop = pageStage.scrollHeight;
}

// Pinch-to-zoom: for smooth live feedback we scale the page visually with a
// cheap CSS transform during the gesture (re-rendering the PDF on every
// touchmove would be too slow) and only commit a crisp real re-render at
// the new zoom level once the fingers lift.
function onPinchStart(midClientX, midClientY) {
  const rect = pageWrap.getBoundingClientRect();
  pageWrap.style.transformOrigin = `${midClientX - rect.left}px ${midClientY - rect.top}px`;
  pageWrap.style.willChange = "transform";
}

function onPinchMove(scaleFactor) {
  pageWrap.style.transform = `scale(${clamp(scaleFactor, 0.4, 2.5)})`;
}

async function onPinchEnd(scaleFactor) {
  pageWrap.style.transform = "";
  pageWrap.style.transformOrigin = "";
  pageWrap.style.willChange = "";
  const factor = clamp(scaleFactor, 0.4, 2.5);
  if (Math.abs(factor - 1) < 0.02) return;
  state.zoom = clamp(state.zoom * factor, 0.5, 3);
  await renderCurrentPage(false);
}

function currentEntry() {
  return state.order[state.currentPage - 1];
}

// pdf.js cancels an in-progress page.render() call if another render()
// starts on the same canvas before it finishes (e.g. a pinch-zoom commit
// landing right after the initial open-render, or two auto-advances back
// to back) — the cancelled one's promise then never resolves the way its
// caller expects. Queuing renders one-at-a-time avoids that race entirely.
let renderQueue = Promise.resolve();

function renderCurrentPage(fitToWidth) {
  renderQueue = renderQueue.then(() => renderCurrentPageImpl(fitToWidth)).catch((err) => {
    console.error("render failed", err);
  });
  return renderQueue;
}

async function renderCurrentPageImpl(fitToWidth) {
  const entry = currentEntry();
  if (fitToWidth) {
    const width = await entryUnscaledWidth(state.pdfDoc, entry, state.syntheticSize);
    const available = pageStage.clientWidth - 24;
    state.baseScale = Math.min(2, available / width);
  }
  const scale = state.baseScale * state.zoom;

  const { viewport, page } = await renderEntry(state.pdfDoc, entry, pdfCanvas, scale, state.syntheticSize);
  state.page = page;
  ink.setViewport(viewport);

  const [strokes, masks] = await Promise.all([
    getStrokes(state.docRecord.id, entry.id),
    getMasks(state.docRecord.id, entry.id),
  ]);
  ink.setStrokes(strokes);
  ink.setMasks(masks);

  pageWrap.style.width = pdfCanvas.style.width;
  pageWrap.style.height = pdfCanvas.style.height;

  pageLabel.textContent = `${state.currentPage} / ${state.totalPages}`;
  zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  prevPageBtn.disabled = state.currentPage <= 1;
  nextPageBtn.disabled = state.currentPage >= state.totalPages;
  updateUndoRedoButtons();
}

function getHistory() {
  const p = state.currentPage;
  if (!state.history.has(p)) state.history.set(p, { undo: [], redo: [] });
  return state.history.get(p);
}

function updateUndoRedoButtons() {
  const h = getHistory();
  undoBtn.disabled = h.undo.length === 0;
  redoBtn.disabled = h.redo.length === 0;
}

async function persistAfterAction(action) {
  const entry = currentEntry();
  if (action.kind === "mask") {
    await saveMasks(state.docRecord.id, entry.id, ink.getMasks());
  } else {
    await saveStrokes(state.docRecord.id, entry.id, ink.getStrokes());
  }
  scheduleNotesSync();
}

function onInkChange(action) {
  const h = getHistory();
  h.undo.push(action);
  h.redo.length = 0;
  updateUndoRedoButtons();
  persistAfterAction(action);
}

function applyUndo(action) {
  if (action.kind === "mask") {
    const masks = ink.getMasks();
    if (action.type === "add") {
      const idx = masks.lastIndexOf(action.mask);
      if (idx !== -1) masks.splice(idx, 1);
    } else if (action.type === "erase") {
      masks.push(...action.masks);
    }
  } else {
    const strokes = ink.getStrokes();
    if (action.type === "add") {
      const idx = strokes.lastIndexOf(action.stroke);
      if (idx !== -1) strokes.splice(idx, 1);
    } else if (action.type === "erase") {
      strokes.push(...action.strokes);
    }
  }
  ink.redraw();
}

function applyRedo(action) {
  if (action.kind === "mask") {
    const masks = ink.getMasks();
    if (action.type === "add") {
      masks.push(action.mask);
    } else if (action.type === "erase") {
      for (const m of action.masks) {
        const idx = masks.indexOf(m);
        if (idx !== -1) masks.splice(idx, 1);
      }
    }
  } else {
    const strokes = ink.getStrokes();
    if (action.type === "add") {
      strokes.push(action.stroke);
    } else if (action.type === "erase") {
      for (const s of action.strokes) {
        const idx = strokes.indexOf(s);
        if (idx !== -1) strokes.splice(idx, 1);
      }
    }
  }
  ink.redraw();
}

undoBtn.addEventListener("click", () => {
  const h = getHistory();
  const action = h.undo.pop();
  if (!action) return;
  applyUndo(action);
  h.redo.push(action);
  updateUndoRedoButtons();
  persistAfterAction(action);
});

redoBtn.addEventListener("click", () => {
  const h = getHistory();
  const action = h.redo.pop();
  if (!action) return;
  applyRedo(action);
  h.undo.push(action);
  updateUndoRedoButtons();
  persistAfterAction(action);
});

backBtn.addEventListener("click", () => {
  hideAllViews();
  homeView.classList.remove("hidden");
  renderHome();
});

prevPageBtn.addEventListener("click", async () => {
  if (state.currentPage > 1) {
    state.currentPage--;
    await renderCurrentPage(false);
  }
});

nextPageBtn.addEventListener("click", async () => {
  if (state.currentPage < state.totalPages) {
    state.currentPage++;
    await renderCurrentPage(false);
  }
});

zoomInBtn.addEventListener("click", async () => {
  state.zoom = Math.min(3, +(state.zoom + 0.25).toFixed(2));
  await renderCurrentPage(false);
});

zoomOutBtn.addEventListener("click", async () => {
  state.zoom = Math.max(0.5, +(state.zoom - 0.25).toFixed(2));
  await renderCurrentPage(false);
});

// ---------- Tools: pen / eraser / mask / pan ----------

const toolButtons = { pen: toolPen, eraser: toolEraser, mask: toolMask, pan: toolPan };

function selectTool(tool) {
  ink.setTool(tool);
  Object.entries(toolButtons).forEach(([t, btn]) => btn.classList.toggle("active", t === tool));
  penControls.classList.toggle("hidden", tool !== "pen");
  maskControls.classList.toggle("hidden", tool !== "mask");
}

toolPen.addEventListener("click", () => selectTool("pen"));
toolEraser.addEventListener("click", () => selectTool("eraser"));
toolMask.addEventListener("click", () => selectTool("mask"));
toolPan.addEventListener("click", () => selectTool("pan"));

autoAdvanceToggle.classList.toggle("active", autoAdvance);
autoAdvanceToggle.addEventListener("click", () => {
  autoAdvance = !autoAdvance;
  localStorage.setItem("pdf-note:auto-advance", autoAdvance ? "on" : "off");
  autoAdvanceToggle.classList.toggle("active", autoAdvance);
  if (ink) ink.setAutoAdvance(autoAdvance);
});

$$(".swatch").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".swatch").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    ink.setColor(btn.dataset.color);
  });
});

$$(".width-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".width-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    ink.setWidth(Number(btn.dataset.width));
  });
});

// ---------- Memorize mode ----------

function syncGroupSelectChips() {
  $$(".group-chip.select").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.group) === ink.currentGroup);
  });
}

function syncVisibilityChips() {
  $$(".group-chip.visibility").forEach((btn) => {
    btn.classList.toggle("active", ink.isGroupActive(Number(btn.dataset.group)));
  });
}

$$(".group-chip.select").forEach((btn) => {
  btn.addEventListener("click", () => {
    ink.setCurrentGroup(Number(btn.dataset.group));
    syncGroupSelectChips();
  });
});

$$(".group-chip.visibility").forEach((btn) => {
  btn.addEventListener("click", () => {
    const g = Number(btn.dataset.group);
    ink.setGroupActive(g, !ink.isGroupActive(g));
    syncVisibilityChips();
  });
});

memorizeToggle.addEventListener("click", () => {
  const on = !memorizeToggle.classList.contains("active");
  memorizeToggle.classList.toggle("active", on);
  ink.setMemorizeOn(on);
});

revealAllBtn.addEventListener("click", () => {
  ink.setAllGroupsActive(false);
  syncVisibilityChips();
});

hideAllBtn.addEventListener("click", () => {
  ink.setAllGroupsActive(true);
  syncVisibilityChips();
});

// ---------- Export ----------

exportBtn.addEventListener("click", async () => {
  showToast("내보내는 중...");
  try {
    const notesByEntryId = {};
    for (let i = 0; i < state.order.length; i++) {
      const entry = state.order[i];
      const isCurrent = i === state.currentPage - 1;
      const strokes = isCurrent ? ink.getStrokes() : await getStrokes(state.docRecord.id, entry.id);
      const masks = isCurrent ? ink.getMasks() : await getMasks(state.docRecord.id, entry.id);
      notesByEntryId[entry.id] = { strokes, masks: masks.filter((m) => ink.isMaskOpaque(m.group)) };
    }
    await exportAnnotatedPdf(state.currentFile, state.docRecord.name, state.order, notesByEntryId);
    showToast("저장 완료");
  } catch (err) {
    console.error(err);
    showToast("내보내기 실패");
  }
});

window.addEventListener("resize", () => {
  if (!viewerView.classList.contains("hidden")) renderCurrentPage(false);
  if (!studyView.classList.contains("hidden")) renderStudyCard();
});

// ---------- Pages view: thumbnails, jump, insert/delete pages ----------

pagesViewBtn.addEventListener("click", renderPagesView);
pagesBackBtn.addEventListener("click", async () => {
  hideAllViews();
  viewerView.classList.remove("hidden");
  // Re-render in case a page was inserted/deleted while in this view —
  // state.order and/or state.currentPage may have changed underneath us.
  await renderCurrentPage(false);
});

async function renderPagesView() {
  hideAllViews();
  pagesView.classList.remove("hidden");
  pagesGrid.innerHTML = "";
  pagesGrid.appendChild(makeInsertTile(-1));

  for (let i = 0; i < state.order.length; i++) {
    const entry = state.order[i];
    const cell = document.createElement("div");
    cell.className = "page-cell";

    const canvas = document.createElement("canvas");
    cell.appendChild(canvas);

    const num = document.createElement("div");
    num.className = "page-num";
    num.textContent = String(i + 1);
    cell.appendChild(num);

    if (entry.kind !== "original") {
      const del = document.createElement("button");
      del.className = "page-del-btn";
      del.textContent = "✕";
      del.title = "이 페이지 삭제";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteInsertedPage(i);
      });
      cell.appendChild(del);
    }

    const pos = i + 1;
    cell.addEventListener("click", () => jumpToPage(pos));
    pagesGrid.appendChild(cell);
    pagesGrid.appendChild(makeInsertTile(i));

    const width = await entryUnscaledWidth(state.pdfDoc, entry, state.syntheticSize);
    const scale = 130 / width;
    await renderEntry(state.pdfDoc, entry, canvas, scale, state.syntheticSize);
    // renderEntry sets an inline canvas.style.width/height (needed for the
    // full-size viewer); clear it here so the .page-cell canvas CSS rule
    // (width:100%) can stretch the thumbnail to fill its actual grid cell
    // instead of sitting at its fixed intrinsic size.
    canvas.style.width = "";
    canvas.style.height = "";
  }
}

function makeInsertTile(afterIndex) {
  const btn = document.createElement("button");
  btn.className = "insert-tile";
  btn.textContent = "+";
  btn.title = "여기에 페이지 추가";
  btn.addEventListener("click", () => openInsertModal(afterIndex));
  return btn;
}

function jumpToPage(pos) {
  state.currentPage = pos;
  hideAllViews();
  viewerView.classList.remove("hidden");
  renderCurrentPage(false);
}

function openInsertModal(afterIndex) {
  insertAfterIndex = afterIndex;
  insertModal.classList.remove("hidden");
}

insertCancelBtn.addEventListener("click", () => insertModal.classList.add("hidden"));
insertModal.addEventListener("click", (e) => {
  if (e.target === insertModal) insertModal.classList.add("hidden");
});

$$(".modal-option").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const kind = btn.dataset.kind;
    insertModal.classList.add("hidden");
    if (kind === "image") {
      imageInput.click();
      return;
    }
    await insertPage(kind, null);
  });
});

imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  imageInput.value = "";
  if (!file) return;
  showToast("이미지 넣는 중...");
  const pngBlob = await normalizeToPng(file);
  await insertPage("image", pngBlob);
});

const MAX_INSERTED_IMAGE_DIMENSION = 1800;

async function normalizeToPng(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_INSERTED_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function insertPage(kind, imageBlob) {
  const entry = { id: newInsertedPageId(), kind, size: { ...state.syntheticSize } };
  if (imageBlob) entry.imageBlob = imageBlob;
  state.order.splice(insertAfterIndex + 1, 0, entry);
  state.totalPages = state.order.length;
  await savePagePlan(state.docRecord.id, state.order);
  showToast("페이지를 추가했어요");
  await renderPagesView();
}

async function deleteInsertedPage(index) {
  const entry = state.order[index];
  if (!confirm("이 페이지를 삭제할까요? 이 페이지의 필기도 함께 삭제됩니다.")) return;
  state.order.splice(index, 1);
  state.totalPages = state.order.length;
  await savePagePlan(state.docRecord.id, state.order);
  await saveStrokes(state.docRecord.id, entry.id, []);
  await saveMasks(state.docRecord.id, entry.id, []);
  if (state.currentPage > state.totalPages) state.currentPage = state.totalPages;
  showToast("페이지를 삭제했어요");
  await renderPagesView();
}

// ---------- Flashcards (cards view + study view) ----------

cardsBtn.addEventListener("click", renderCardsView);
cardsBackBtn.addEventListener("click", () => {
  hideAllViews();
  homeView.classList.remove("hidden");
});

function isOriginalPageId(id) {
  return /^\d+$/.test(id);
}

async function renderCardsView() {
  hideAllViews();
  cardsView.classList.remove("hidden");
  const pages = await getAllMaskedPages();
  state.cardPages = pages;
  cardListEl.innerHTML = "";
  cardsEmptyHint.classList.toggle("hidden", pages.length > 0);
  pages.forEach((entry, idx) => {
    const li = document.createElement("li");
    li.className = "doc-item";
    const original = isOriginalPageId(entry.page);
    li.innerHTML = `
      <div class="doc-icon">${original ? `${entry.page}p` : "＋"}</div>
      <div class="doc-info">
        <div class="doc-name"></div>
        <div class="doc-meta"></div>
      </div>
    `;
    li.querySelector(".doc-name").textContent = entry.docName;
    li.querySelector(".doc-meta").textContent = original
      ? `${entry.page}페이지 · 가림 ${entry.count}개`
      : `삽입 페이지 · 가림 ${entry.count}개`;
    li.addEventListener("click", () => openStudy(idx));
    cardListEl.appendChild(li);
  });
}

async function openStudy(idx) {
  state.studyIndex = idx;
  hideAllViews();
  studyView.classList.remove("hidden");
  await renderStudyCard();
}

studyCloseBtn.addEventListener("click", () => {
  hideAllViews();
  cardsView.classList.remove("hidden");
});

studyPrevBtn.addEventListener("click", async () => {
  if (state.studyIndex > 0) {
    state.studyIndex--;
    await renderStudyCard();
  }
});

studyNextBtn.addEventListener("click", async () => {
  if (state.studyIndex < state.cardPages.length - 1) {
    state.studyIndex++;
    await renderStudyCard();
  }
});

function setStudyRevealed(revealed) {
  state.studyRevealed = revealed;
  studyRevealBtn.classList.toggle("active", !revealed);
  studyRevealBtn.textContent = revealed ? "다시 가리기" : "정답 보기";
  drawStudyOverlay();
}

studyRevealBtn.addEventListener("click", () => setStudyRevealed(!state.studyRevealed));
studyCanvas.addEventListener("click", () => setStudyRevealed(!state.studyRevealed));

async function renderStudyCard() {
  const entry = state.cardPages[state.studyIndex];
  if (!entry) return;
  studyIndexLabel.textContent = `${state.studyIndex + 1} / ${state.cardPages.length}`;
  studyPrevBtn.disabled = state.studyIndex <= 0;
  studyNextBtn.disabled = state.studyIndex >= state.cardPages.length - 1;

  let pdfDoc = state.studyPdfCache.get(entry.docId);
  let order = state.studyOrderCache.get(entry.docId);
  if (!pdfDoc || !order) {
    const doc = await getDocument(entry.docId);
    if (!doc) return;
    const file = await resolveFile(doc);
    if (!file) return;
    const buf = await file.arrayBuffer();
    pdfDoc = await loadPdf(buf);
    order = await loadPageOrder(entry.docId, pdfDoc);
    state.studyPdfCache.set(entry.docId, pdfDoc);
    state.studyOrderCache.set(entry.docId, order);
  }

  const orderEntry = order.find((e) => e.id === entry.page);
  if (!orderEntry) return; // stale masks referencing a page that no longer exists

  const firstPage = await getPage(pdfDoc, 1);
  const fallbackSize = (() => {
    const s = getUnscaledSize(firstPage);
    return { pageWidth: s.pageWidth, pageHeight: s.pageHeight };
  })();

  studyTitle.textContent = `${entry.docName} · ${isOriginalPageId(orderEntry.id) ? `${orderEntry.id}p` : "삽입 페이지"}`;

  const available = studyStage.clientWidth - 24;
  const width = await entryUnscaledWidth(pdfDoc, orderEntry, fallbackSize);
  const scale = Math.min(2.5, available / width);
  // Render into an offscreen canvas so drawStudyOverlay() can always start
  // from pristine pixels (drawing directly on the visible canvas would make
  // a mask permanent — there'd be no way to "reveal" it again).
  const { viewport } = await renderEntry(pdfDoc, orderEntry, studyBaseCanvas, scale, fallbackSize);
  studyCanvas.width = studyBaseCanvas.width;
  studyCanvas.height = studyBaseCanvas.height;
  studyCanvas.style.width = studyBaseCanvas.style.width;
  studyCanvas.style.height = studyBaseCanvas.style.height;

  const [strokes, masks] = await Promise.all([
    getStrokes(entry.docId, orderEntry.id),
    getMasks(entry.docId, orderEntry.id),
  ]);
  state.studyDraw = { viewport, strokes, masks };
  window.__studyDraw = state.studyDraw; // debug handle
  setStudyRevealed(false);
}

function drawStudyOverlay() {
  if (!state.studyDraw) return;
  const { viewport, strokes, masks } = state.studyDraw;
  const ctx = studyCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, studyCanvas.width, studyCanvas.height);
  ctx.drawImage(studyBaseCanvas, 0, 0);

  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stroke of strokes) {
    ctx.strokeStyle = stroke.color;
    for (let i = 1; i < stroke.points.length; i++) {
      const [ax, ay] = viewport.convertToViewportPoint(stroke.points[i - 1].x, stroke.points[i - 1].y);
      const [bx, by] = viewport.convertToViewportPoint(stroke.points[i].x, stroke.points[i].y);
      ctx.lineWidth = stroke.width * viewport.scale;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }

  if (!state.studyRevealed) {
    for (const mask of masks) {
      const [x0, y0] = viewport.convertToViewportPoint(mask.x, mask.y);
      const [x1, y1] = viewport.convertToViewportPoint(mask.x + mask.w, mask.y + mask.h);
      ctx.fillStyle = mask.color;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
  }
}

// ---------- Boot ----------

renderHome();
initNotesFolder();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // updateViaCache:"none" stops the browser from ever serving sw.js
    // itself out of HTTP cache when checking for updates — otherwise a
    // cached response for this exact file can make the browser think
    // there's nothing new to install, even after bumping CACHE_NAME.
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  });
}
