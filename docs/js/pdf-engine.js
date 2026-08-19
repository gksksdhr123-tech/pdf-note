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

// A pdf.js PageViewport look-alike for pages that aren't backed by real PDF
// content (inserted blank/lined/grid/image pages) — same coordinate
// convention (origin bottom-left, y-up, no rotation), so AnnotationLayer's
// ink math works identically regardless of what kind of page it's on.
export function makeFlatViewport(pageWidth, pageHeight, scale) {
  return {
    scale,
    width: pageWidth * scale,
    height: pageHeight * scale,
    convertToPdfPoint(cssX, cssY) {
      return [cssX / scale, pageHeight - cssY / scale];
    },
    convertToViewportPoint(pdfX, pdfY) {
      return [pdfX * scale, (pageHeight - pdfY) * scale];
    },
  };
}

// Renders an inserted (non-PDF) page onto `canvas`: a plain background plus
// an optional ruled/grid pattern or a contained image. Returns a flat
// viewport in the same shape renderPage() returns.
export function renderSyntheticPage(canvas, kind, pageWidth, pageHeight, scale, image) {
  const dpr = window.devicePixelRatio || 1;
  const viewport = makeFlatViewport(pageWidth, pageHeight, scale);

  canvas.width = Math.ceil(viewport.width * dpr);
  canvas.height = Math.ceil(viewport.height * dpr);
  canvas.style.width = `${Math.ceil(viewport.width)}px`;
  canvas.style.height = `${Math.ceil(viewport.height)}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  if (kind === "lined") {
    drawRuledLines(ctx, viewport.width, viewport.height, scale);
  } else if (kind === "grid") {
    drawGridLines(ctx, viewport.width, viewport.height, scale);
  } else if (kind === "image" && image) {
    drawContainedImage(ctx, image, viewport.width, viewport.height);
  }

  return viewport;
}

function drawRuledLines(ctx, w, h, scale) {
  const margin = 26 * scale;
  const gap = 28 * scale;
  ctx.strokeStyle = "#cfd6e4";
  ctx.lineWidth = 1;
  for (let y = margin * 1.6; y < h - margin * 0.6; y += gap) {
    ctx.beginPath();
    ctx.moveTo(margin, y);
    ctx.lineTo(w - margin * 0.6, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "#e3a3a3";
  ctx.beginPath();
  ctx.moveTo(margin * 2, margin * 0.5);
  ctx.lineTo(margin * 2, h - margin * 0.2);
  ctx.stroke();
}

function drawGridLines(ctx, w, h, scale) {
  const gap = 22 * scale;
  ctx.strokeStyle = "#dbe1ee";
  ctx.lineWidth = 1;
  for (let x = gap; x < w; x += gap) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = gap; y < h; y += gap) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function drawContainedImage(ctx, image, w, h) {
  const scale = Math.min(w / image.width, h / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
