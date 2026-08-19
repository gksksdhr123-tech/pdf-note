// Flattens ink strokes onto a copy of the original PDF and triggers a
// download. The original blob stored in IndexedDB is never touched.
export async function exportAnnotatedPdf(docRecord, strokesByPage) {
  const { PDFDocument, rgb } = window.PDFLib;
  const bytes = await docRecord.blob.arrayBuffer();
  const pdfDoc = await PDFDocument.load(bytes);
  const pages = pdfDoc.getPages();

  for (const [pageNumStr, strokes] of Object.entries(strokesByPage)) {
    const pageIndex = Number(pageNumStr) - 1;
    const page = pages[pageIndex];
    if (!page || !strokes || strokes.length === 0) continue;
    const { height } = page.getSize();

    for (const stroke of strokes) {
      const color = hexToRgb(stroke.color);
      for (let i = 1; i < stroke.points.length; i++) {
        const a = stroke.points[i - 1];
        const b = stroke.points[i];
        page.drawLine({
          start: { x: a.x, y: height - a.y },
          end: { x: b.x, y: height - b.y },
          thickness: stroke.width,
          color: rgb(color.r, color.g, color.b),
          opacity: 1,
          lineCap: "Round",
        });
      }
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
