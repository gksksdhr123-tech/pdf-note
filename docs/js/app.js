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
} from "./db.js";
import { loadPdf, getPage, getUnscaledSize, renderPage } from "./pdf-engine.js";
import { AnnotationLayer } from "./annotate.js";
import { exportAnnotatedPdf } from "./export.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const homeView = $("#home-view");
const viewerView = $("#viewer-view");
const cardsView = $("#cards-view");
const studyView = $("#study-view");

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
const studyBaseCanvas = document.createElement("canvas"); // offscreen: pristine PDF render

const state = {
  docRecord: null,
  currentFile: null, // the File/Blob actually backing the open document
  pdfDoc: null,
  page: null, // current pdf.js page proxy
  currentPage: 1,
  totalPages: 1,
  baseScale: 1,
  zoom: 1,
  history: new Map(), // page -> { undo: [], redo: [] }
  cardPages: [],
  studyIndex: 0,
  studyRevealed: false,
  studyDraw: null,
  studyPdfCache: new Map(), // docId -> pdf.js document proxy
};

let ink = null;
let autoAdvance = localStorage.getItem("pdf-note:auto-advance") !== "off"; // default on

// File System Access API lets us keep a lightweight, reusable reference to
// a file on disk instead of copying the whole PDF into IndexedDB — avoids
// storing every PDF twice. Falls back to caching the file's bytes (the old
// behavior) on browsers that don't support it.
const supportsFilePicker = typeof window.showOpenFilePicker === "function";

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
}

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
  state.totalPages = state.pdfDoc.numPages;

  docTitle.textContent = doc.name;
  hideAllViews();
  viewerView.classList.remove("hidden");

  if (!ink) {
    ink = new AnnotationLayer(inkCanvas, {
      onChange: onInkChange,
      scrollContainer: pageStage,
      onReachBottom: goToNextPageAuto,
      onReachTop: goToPrevPageAuto,
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

async function renderCurrentPage(fitToWidth) {
  state.page = await getPage(state.pdfDoc, state.currentPage);
  const unscaled = getUnscaledSize(state.page);
  if (fitToWidth) {
    const available = pageStage.clientWidth - 24;
    state.baseScale = Math.min(2, available / unscaled.pageWidth);
  }
  const scale = state.baseScale * state.zoom;

  const viewport = await renderPage(state.page, pdfCanvas, scale);
  ink.setViewport(viewport);

  const [strokes, masks] = await Promise.all([
    getStrokes(state.docRecord.id, state.currentPage),
    getMasks(state.docRecord.id, state.currentPage),
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
  if (action.kind === "mask") {
    await saveMasks(state.docRecord.id, state.currentPage, ink.getMasks());
  } else {
    await saveStrokes(state.docRecord.id, state.currentPage, ink.getStrokes());
  }
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
    const strokesByPage = {};
    const masksByPage = {};
    for (let p = 1; p <= state.totalPages; p++) {
      const strokes = p === state.currentPage ? ink.getStrokes() : await getStrokes(state.docRecord.id, p);
      const masks = p === state.currentPage ? ink.getMasks() : await getMasks(state.docRecord.id, p);
      strokesByPage[p] = strokes;
      masksByPage[p] = masks.filter((m) => ink.isMaskOpaque(m.group));
    }
    await exportAnnotatedPdf(state.currentFile, state.docRecord.name, strokesByPage, masksByPage);
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

// ---------- Flashcards (cards view + study view) ----------

cardsBtn.addEventListener("click", renderCardsView);
cardsBackBtn.addEventListener("click", () => {
  hideAllViews();
  homeView.classList.remove("hidden");
});

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
    li.innerHTML = `
      <div class="doc-icon">${entry.page}p</div>
      <div class="doc-info">
        <div class="doc-name"></div>
        <div class="doc-meta"></div>
      </div>
    `;
    li.querySelector(".doc-name").textContent = entry.docName;
    li.querySelector(".doc-meta").textContent = `${entry.page}페이지 · 가림 ${entry.count}개`;
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
  studyTitle.textContent = `${entry.docName} · ${entry.page}p`;
  studyIndexLabel.textContent = `${state.studyIndex + 1} / ${state.cardPages.length}`;
  studyPrevBtn.disabled = state.studyIndex <= 0;
  studyNextBtn.disabled = state.studyIndex >= state.cardPages.length - 1;

  let pdfDoc = state.studyPdfCache.get(entry.docId);
  if (!pdfDoc) {
    const doc = await getDocument(entry.docId);
    if (!doc) return;
    const file = await resolveFile(doc);
    if (!file) return;
    const buf = await file.arrayBuffer();
    pdfDoc = await loadPdf(buf);
    state.studyPdfCache.set(entry.docId, pdfDoc);
  }

  const page = await getPage(pdfDoc, entry.page);
  const unscaled = getUnscaledSize(page);
  const available = studyStage.clientWidth - 24;
  const scale = Math.min(2.5, available / unscaled.pageWidth);
  // Render into an offscreen canvas so drawStudyOverlay() can always start
  // from pristine pixels (drawing directly on the visible canvas would make
  // a mask permanent — there'd be no way to "reveal" it again).
  const viewport = await renderPage(page, studyBaseCanvas, scale);
  studyCanvas.width = studyBaseCanvas.width;
  studyCanvas.height = studyBaseCanvas.height;
  studyCanvas.style.width = studyBaseCanvas.style.width;
  studyCanvas.style.height = studyBaseCanvas.style.height;

  const [strokes, masks] = await Promise.all([
    getStrokes(entry.docId, entry.page),
    getMasks(entry.docId, entry.page),
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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // updateViaCache:"none" stops the browser from ever serving sw.js
    // itself out of HTTP cache when checking for updates — otherwise a
    // cached response for this exact file can make the browser think
    // there's nothing new to install, even after bumping CACHE_NAME.
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  });
}
