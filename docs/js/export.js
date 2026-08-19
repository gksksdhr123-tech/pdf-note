// Flattens ink strokes (and any currently-opaque memorization masks) onto a
// copy of the original PDF and triggers a download. The original blob
// stored in IndexedDB is never touched. `masksByPage` should already be
// filtered to only the masks that are opaque in the app's current view —
// this exports exactly what memorization mode currently shows on screen.
export async function exportAnnotatedPdf(docRecord, strokesByPage, masksByPage = {}) {
  const { PDFDocument, rgb } = window.PDFLib;
  const bytes = await docRecord.blob.arrayBuffer();
  const pdfDoc = await PDFDocument.load(bytes);
  const pages = pdfDoc.getPages();

  // Stroke/mask coordinates are already in real PDF coordinate space (same
  // convention pdf-lib expects: origin bottom-left, y-up), via pdf.js's
  // convertToPdfPoint — no manual flip/scale needed here.
  for (const [pageNumStr, strokes] of Object.entries(strokesByPage)) {
    const pageIndex = Number(pageNumStr) - 1;
    const page = pages[pageIndex];
    if (!page || !strokes || strokes.length === 0) continue;

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
          opacity: 1,
          lineCap: "Round",
        });
      }
    }
  }

  for (const [pageNumStr, masks] of Object.entries(masksByPage)) {
    const pageIndex = Number(pageNumStr) - 1;
    const page = pages[pageIndex];
    if (!page || !masks || masks.length === 0) continue;

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

  const outBytes = await pdfDoc.save();
  const blob = new Blob([outBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = withSuffix(docRecord.name, "_note");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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
