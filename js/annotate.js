// Ink annotation layer. All stroke coordinates are stored in "PDF point"
// space (i.e. at PDF scale=1, origin top-left, y-down) so they stay valid
// across zoom levels and translate directly into pdf-lib export coords.

const ERASE_RADIUS_CSS_PX = 12;

export class AnnotationLayer {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onChange = onChange || (() => {});
    this.strokes = [];
    this.tool = "pen";
    this.color = "#1c1c1e";
    this.width = 2;
    this.scale = 1;
    this.pageWidth = 0;
    this.pageHeight = 0;

    this._active = null; // in-progress pen stroke
    this._erasing = null; // Set of indices removed during current erase drag

    canvas.addEventListener("pointerdown", (e) => this._onDown(e));
    canvas.addEventListener("pointermove", (e) => this._onMove(e));
    canvas.addEventListener("pointerup", (e) => this._onUp(e));
    canvas.addEventListener("pointercancel", (e) => this._onUp(e));
  }

  setViewport(pageWidth, pageHeight, scale) {
    const dpr = window.devicePixelRatio || 1;
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.scale = scale;
    this.canvas.width = Math.ceil(pageWidth * scale * dpr);
    this.canvas.height = Math.ceil(pageHeight * scale * dpr);
    this.canvas.style.width = `${Math.ceil(pageWidth * scale)}px`;
    this.canvas.style.height = `${Math.ceil(pageHeight * scale)}px`;
    this.ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    this._redraw();
  }

  setStrokes(strokes) {
    this.strokes = strokes || [];
    this._redraw();
  }

  getStrokes() {
    return this.strokes;
  }

  redraw() {
    this._redraw();
  }

  setTool(tool) {
    this.tool = tool;
  }

  setColor(color) {
    this.color = color;
  }

  setWidth(width) {
    this.width = width;
  }

  _eventToPagePoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / this.scale,
      y: (e.clientY - rect.top) / this.scale,
      p: e.pointerType === "mouse" ? 0.5 : e.pressure || 0.5,
    };
  }

  _onDown(e) {
    // Ignore bare-finger touch so scroll/pinch gestures aren't hijacked;
    // only the S Pen (pointerType "pen") and mouse draw.
    if (e.pointerType === "touch") return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const pt = this._eventToPagePoint(e);
    if (this.tool === "pen") {
      this._active = { color: this.color, width: this.width, points: [pt] };
    } else if (this.tool === "eraser") {
      this._erasing = new Set();
      this._eraseAt(pt);
    }
  }

  _onMove(e) {
    if (this.tool === "pen" && this._active) {
      const pt = this._eventToPagePoint(e);
      const pts = this._active.points;
      const prev = pts[pts.length - 1];
      pts.push(pt);
      this._drawSegment(prev, pt, this._active.color, this._active.width);
    } else if (this.tool === "eraser" && this._erasing) {
      const pt = this._eventToPagePoint(e);
      this._eraseAt(pt);
    }
  }

  _onUp() {
    if (this.tool === "pen" && this._active) {
      if (this._active.points.length > 1) {
        this.strokes.push(this._active);
        this.onChange({ type: "add", stroke: this._active });
      }
      this._active = null;
    } else if (this.tool === "eraser" && this._erasing) {
      if (this._erasing.size > 0) {
        const removed = [];
        const kept = [];
        this.strokes.forEach((s, i) => {
          if (this._erasing.has(i)) removed.push(s);
          else kept.push(s);
        });
        this.strokes = kept;
        this.onChange({ type: "erase", strokes: removed });
        this._redraw();
      }
      this._erasing = null;
    }
  }

  _eraseAt(pt) {
    const threshold = ERASE_RADIUS_CSS_PX / this.scale;
    let changed = false;
    this.strokes.forEach((stroke, i) => {
      if (this._erasing.has(i)) return;
      for (let j = 1; j < stroke.points.length; j++) {
        if (distToSegment(pt, stroke.points[j - 1], stroke.points[j]) < threshold) {
          this._erasing.add(i);
          changed = true;
          break;
        }
      }
    });
    if (changed) this._redraw();
  }

  _drawSegment(p1, p2, color, baseWidth) {
    const ctx = this.ctx;
    const pressure = clamp(p2.p, 0.3, 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = baseWidth * (0.6 + pressure * 0.6);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  _redraw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.pageWidth, this.pageHeight);
    this.strokes.forEach((stroke, i) => {
      if (this._erasing && this._erasing.has(i)) return;
      for (let j = 1; j < stroke.points.length; j++) {
        this._drawSegment(stroke.points[j - 1], stroke.points[j], stroke.color, stroke.width);
      }
    });
    if (this._active) {
      const pts = this._active.points;
      for (let j = 1; j < pts.length; j++) {
        this._drawSegment(pts[j - 1], pts[j], this._active.color, this._active.width);
      }
    }
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = clamp(t, 0, 1);
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}
