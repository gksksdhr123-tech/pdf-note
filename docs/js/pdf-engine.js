import * as pdfjsLib from "../vendor/pdf.min.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdf.worker.min.js",
  import.meta.url
).href;

export async function loadPdf(arrayBuffer) {
  const task = pdfjsLib.getDocument({ data: arrayBuffer });
  return task.promise;
}

export async function getPage(pdfDoc, pageNumber) {
  return pdfDoc.getPage(pageNumber);
}

export function getUnscaledSize(page) {
  const v = page.getViewport({ scale: 1 });
  return { pageWidth: v.width, pageHeight: v.height };
}

// Renders `page` onto `canvas` at the given scale (CSS pixels per PDF
// point) and returns the matching CSS-space viewport. That viewport's
// convertToPdfPoint / convertToViewportPoint methods are the single source
// of truth for ink coordinates, so drawing stays correct across zoom and
// page rotation without any manual math.
export async function renderPage(page, canvas, scale) {
  const dpr = window.devicePixelRatio || 1;
  const cssViewport = page.getViewport({ scale });
  const renderViewport = page.getViewport({ scale: scale * dpr });

  canvas.width = Math.ceil(renderViewport.width);
  canvas.height = Math.ceil(renderViewport.height);
  canvas.style.width = `${Math.ceil(cssViewport.width)}px`;
  canvas.style.height = `${Math.ceil(cssViewport.height)}px`;

  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

  return cssViewport;
}
