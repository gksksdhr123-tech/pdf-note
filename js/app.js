import {
  hashFile,
  putDocument,
  getDocument,
  getAllDocuments,
  deleteDocument,
  getStrokes,
  saveStrokes,
} from "./db.js";
import { loadPdf, getPage, getUnscaledSize, renderPage } from "./pdf-engine.js";
import { AnnotationLayer } from "./annotate.js";
import { exportAnnotatedPdf } from "./export.js";

const $ = (sel) => document.querySelector(sel);

const homeView = $("#home-view");
const viewerView = $("#viewer-view");
const docList = $("#doc-list");
const emptyHint = $("#empty-hint");
const addBtn = $("#add-btn");
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
const undoBtn = $("#undo-btn");
const redoBtn = $("#redo-btn");
const prevPageBtn = $("#prev-page");
const nextPageBtn = $("#next-page");
const zoomInBtn = $("#zoom-in");
const zoomOutBtn = $("#zoom-out");

const state = {
  docRecord: null,
  pdfDoc: null,
  page: null, // current pdf.js page proxy
  currentPage: 1,
  totalPages: 1,
  baseScale: 1,
  zoom: 1,
  history: new Map(), // page -> { undo: [], redo: [] }
};

let ink = null;

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 1800);
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

addBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file) return;
  showToast("불러오는 중...");
  const id = await hashFile(file);
  let doc = await getDocument(id);
  if (!doc) {
    doc = {
      id,
      name: file.name,
      size: file.size,
      blob: file,
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    await putDocument(doc);
  }
  openDocument(id);
});

// ---------- Viewer view ----------

async function openDocument(id) {
  const doc = await getDocument(id);
  if (!doc) return;
  doc.lastOpenedAt = Date.now();
  await putDocument(doc);

  state.docRecord = doc;
  state.currentPage = 1;
  state.zoom = 1;
  state.history = new Map();

  const buf = await doc.blob.arrayBuffer();
  state.pdfDoc = await loadPdf(buf);
  state.totalPages = state.pdfDoc.numPages;

  docTitle.textContent = doc.name;
  homeView.classList.add("hidden");
  viewerView.classList.remove("hidden");

  if (!ink) {
    ink = new AnnotationLayer(inkCanvas, { onChange: onInkChange, scrollContainer: pageStage });
    window.__ink = ink; // debug handle
  }

  await renderCurrentPage(true);
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

  const strokes = await getStrokes(state.docRecord.id, state.currentPage);
  ink.setStrokes(strokes);

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

async function persistCurrentStrokes() {
  await saveStrokes(state.docRecord.id, state.currentPage, ink.getStrokes());
}

function onInkChange(action) {
  const h = getHistory();
  h.undo.push(action);
  h.redo.length = 0;
  updateUndoRedoButtons();
  persistCurrentStrokes();
}

undoBtn.addEventListener("click", () => {
  const h = getHistory();
  const action = h.undo.pop();
  if (!action) return;
  const strokes = ink.getStrokes();
  if (action.type === "add") {
    const idx = strokes.lastIndexOf(action.stroke);
    if (idx !== -1) strokes.splice(idx, 1);
  } else if (action.type === "erase") {
    strokes.push(...action.strokes);
  }
  ink.redraw();
  h.redo.push(action);
  updateUndoRedoButtons();
  persistCurrentStrokes();
});

redoBtn.addEventListener("click", () => {
  const h = getHistory();
  const action = h.redo.pop();
  if (!action) return;
  const strokes = ink.getStrokes();
  if (action.type === "add") {
    strokes.push(action.stroke);
  } else if (action.type === "erase") {
    for (const s of action.strokes) {
      const idx = strokes.indexOf(s);
      if (idx !== -1) strokes.splice(idx, 1);
    }
  }
  ink.redraw();
  h.undo.push(action);
  updateUndoRedoButtons();
  persistCurrentStrokes();
});

backBtn.addEventListener("click", () => {
  viewerView.classList.add("hidden");
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

toolPen.addEventListener("click", () => {
  ink.setTool("pen");
  toolPen.classList.add("active");
  toolEraser.classList.remove("active");
});

toolEraser.addEventListener("click", () => {
  ink.setTool("eraser");
  toolEraser.classList.add("active");
  toolPen.classList.remove("active");
});

document.querySelectorAll(".swatch").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".swatch").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    ink.setColor(btn.dataset.color);
  });
});

document.querySelectorAll(".width-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".width-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    ink.setWidth(Number(btn.dataset.width));
  });
});

exportBtn.addEventListener("click", async () => {
  showToast("내보내는 중...");
  try {
    const strokesByPage = {};
    for (let p = 1; p <= state.totalPages; p++) {
      strokesByPage[p] = p === state.currentPage ? ink.getStrokes() : await getStrokes(state.docRecord.id, p);
    }
    await exportAnnotatedPdf(state.docRecord, strokesByPage);
    showToast("저장 완료");
  } catch (err) {
    console.error(err);
    showToast("내보내기 실패");
  }
});

window.addEventListener("resize", () => {
  if (!viewerView.classList.contains("hidden")) renderCurrentPage(false);
});

// ---------- Boot ----------

renderHome();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
