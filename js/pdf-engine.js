import * as pdfjsLib from "../vendor/pdf.min.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdf.worker.min.js",
  import.meta.url
).href;

export async function loadPdf(arrayBuffer) {
  const task = pdfjsLib.getDocument({ data: arrayBuffer });
  return task.promise;
}

export async function getPageSize(pdfDoc, pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });
  return { pageWidth: unscaled.width, pageHeight: unscaled.height };
}

// Renders a page onto `canvas` at the given scale (relative to PDF points,
// i.e. scale=1 means 1 PDF point = 1 CSS pixel). Returns {width, height} in
// PDF point space (unscaled), used as the coordinate system for ink strokes.
export async function renderPage(pdfDoc, pageNumber, canvas, scale) {
  const page = await pdfDoc.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * dpr });

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${Math.ceil(viewport.width / dpr)}px`;
  canvas.style.height = `${Math.ceil(viewport.height / dpr)}px`;

  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  return { pageWidth: unscaled.width, pageHeight: unscaled.height };
}
