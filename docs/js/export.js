// Flattens ink strokes (and any currently-opaque memorization masks) onto a
// new PDF built from `order` — a mix of pages copied from the original
// file and any inserted blank/lined/grid/image pages — and triggers a
// download. The original `file` is only ever read, never written to.
// `notesByEntryId` maps each order entry's id to { strokes, masks }, with
// masks already filtered to only the ones that should render opaque.
export async function exportAnnotatedPdf(file, fileName, order, notesByEntryId) {
  const { PDFDocument, rgb } = window.PDFLib;
  const bytes = await file.arrayBuffer();
  const srcDoc = await PDFDocument.load(bytes);
  const outDoc = await PDFDocument.create();

  const originalIndices = order.filter((e) => e.kind === "original").map((e) => e.pdfPage - 1);
  const copiedPages = originalIndices.length ? await outDoc.copyPages(srcDoc, originalIndices) : [];
  const copiedByPdfPage = new Map();
  originalIndices.forEach((pdfIndex, i) => copiedByPdfPage.set(pdfIndex + 1, copiedPages[i]));

  for (const entry of order) {
    let page;
    if (entry.kind === "original") {
      page = copiedByPdfPage.get(entry.pdfPage);
      outDoc.addPage(page);
    } else {
      const { pageWidth, pageHeight } = entry.size;
      page = outDoc.addPage([pageWidth, pageHeight]);
      drawSyntheticBackground(page, entry, pageWidth, pageHeight, rgb);
      if (entry.kind === "image" && entry.imageBlob) {
        await drawEmbeddedImage(outDoc, page, entry.imageBlob, pageWidth, pageHeight);
      }
    }

    const notes = notesByEntryId[entry.id];
    if (notes && notes.strokes) drawStrokes(page, notes.strokes, rgb);
    if (notes && notes.masks) drawMasks(page, notes.masks, rgb);
  }

  const outBytes = await outDoc.save();
  const blob = new Blob([outBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = withSuffix(fileName, "_note");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Stroke/mask points are already in real PDF coordinate space (same
// convention pdf-lib expects: origin bottom-left, y-up), via pdf.js's
// convertToPdfPoint / the flat viewport used for inserted pages — no
// manual flip/scale needed here.
function drawStrokes(page, strokes, rgb) {
  for (const stroke of strokes) {
    const color = hexToRgb(stroke.color);
    for (let i = 1; i < stroke.points.length; i++) {
      const a = stroke.points[i - 1];
      const b = stroke.points[i];
      page.drawLine({
        start: { x: a.x, y: a.y },
        end: { x: b.x, y: b.y },
        thickness: stroke.width,
        color: rgb(color.r, color.g, color.b),
        opacity: stroke.highlight ? 0.4 : 1,
        lineCap: "Round",
      });
    }
  }
}

function drawMasks(page, masks, rgb) {
  for (const mask of masks) {
    const color = hexToRgb(mask.color);
    page.drawRectangle({
      x: mask.x,
      y: mask.y,
      width: mask.w,
      height: mask.h,
      color: rgb(color.r, color.g, color.b),
      opacity: 1,
    });
  }
}

function drawSyntheticBackground(page, entry, w, h, rgb) {
  if (entry.kind === "lined") {
    const margin = 40;
    const gap = 26;
    const lineColor = rgb(0.81, 0.84, 0.9);
    for (let y = h - margin * 1.6; y > margin; y -= gap) {
      page.drawLine({ start: { x: margin, y }, end: { x: w - margin, y }, thickness: 0.75, color: lineColor });
    }
    page.drawLine({
      start: { x: margin * 2, y: margin * 0.4 },
      end: { x: margin * 2, y: h - margin * 0.4 },
      thickness: 0.75,
      color: rgb(0.89, 0.6, 0.6),
    });
  } else if (entry.kind === "grid") {
    const gap = 20;
    const lineColor = rgb(0.86, 0.88, 0.93);
    for (let x = gap; x < w; x += gap) {
      page.drawLine({ start: { x, y: 0 }, end: { x, y: h }, thickness: 0.6, color: lineColor });
    }
    for (let y = gap; y < h; y += gap) {
      page.drawLine({ start: { x: 0, y }, end: { x: w, y }, thickness: 0.6, color: lineColor });
    }
  }
  // "blank" needs nothing extra — the page is already plain white.
}

async function drawEmbeddedImage(outDoc, page, blob, w, h) {
  // Images inserted via the app are always normalized to PNG at capture
  // time (see app.js), so this is the only format pdf-lib needs to embed.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const img = await outDoc.embedPng(bytes);
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  page.drawImage(img, { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh });
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

function withSuffix(filename, suffix) {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return filename + suffix;
  return filename.slice(0, dot) + suffix + filename.slice(dot);
}
