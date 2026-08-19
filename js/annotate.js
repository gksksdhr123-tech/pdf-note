// Ink annotation layer. Stroke points are stored in real PDF coordinate
// space (pdf.js's convertToPdfPoint output: origin bottom-left, y-up,
// rotation already resolved) so they stay correct across zoom/rotation and
// feed straight into pdf-lib for export with no extra math.
//
// touch-action is "none" on the canvas (see style.css) so the browser never
// tries to interpret an in-progress pen stroke as a scroll/pan gesture —
// we do all touch panning ourselves below, and pen/mouse always draw.

const ERASE_RADIUS_CSS_PX = 14;

export class AnnotationLayer {
  constructor(canvas, { onChange, scrollContainer } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onChange = onChange || (() => {});
    this.scrollContainer = scrollContainer;
    this.strokes = [];
    this.tool = "pen";
    this.color = "#1c1c1e";
    this.width = 2;
    this.viewport = null;

    this._active = null; // in-progress pen stroke
    this._activeTool = null; // tool locked in for the current gesture
    this._erasing = null; // Set of indices removed during current erase drag
    this._pan = null; // finger-drag pan state

    canvas.addEventListener("pointerdown", (e) => this._onDown(e));
    canvas.addEventListener("pointermove", (e) => this._onMove(e));
    canvas.addEventListener("pointerup", (e) => this._onUp(e));
    canvas.addEventListener("pointercancel", (e) => this._onUp(e));
    // Barrel-button-triggered eraser opens the browser context menu on
    // some builds; suppress it so a S Pen side-button hold doesn't pop one.
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  setViewport(viewport) {
    const dpr = window.devicePixelRatio || 1;
    this.viewport = viewport;
    this.canvas.width = Math.ceil(viewport.width * dpr);
    this.canvas.height = Math.ceil(viewport.height * dpr);
    this.canvas.style.width = `${Math.ceil(viewport.width)}px`;
    this.canvas.style.height = `${Math.ceil(viewport.height)}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

  // Pen/mouse only. Barrel button held (buttons bit 2) always means eraser,
  // regardless of the tool currently selected in the toolbar.
  _effectiveTool(e) {
    if (e.pointerType === "pen" && (e.buttons & 2) !== 0) return "eraser";
    return this.tool;
  }

  _trySetCapture(pointerId) {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      // Ignore — happens for synthetic/edge-case pointers with no active
      // session; drawing still works via the regular event listeners.
    }
  }

  _eventToPagePoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const [x, y] = this.viewport.convertToPdfPoint(cssX, cssY);
    return { x, y, p: e.pointerType === "mouse" ? 0.5 : e.pressure || 0.5 };
  }

  _toCanvasPoint(pt) {
    const [x, y] = this.viewport.convertToViewportPoint(pt.x, pt.y);
    return { x, y };
  }

  _onDown(e) {
    if (e.pointerType === "touch") {
      // No native scrolling is possible here (touch-action: none), so a
      // single finger drags the page ourselves. Pen and mouse always draw.
      this._trySetCapture(e.pointerId);
      this._pan = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: this.scrollContainer.scrollLeft,
        startTop: this.scrollContainer.scrollTop,
      };
      return;
    }
    e.preventDefault();
    this._trySetCapture(e.pointerId);
    this._activeTool = this._effectiveTool(e);
    const pt = this._eventToPagePoint(e);
    if (this._activeTool === "pen") {
      this._active = { color: this.color, width: this.width, points: [pt] };
    } else if (this._activeTool === "eraser") {
      this._erasing = new Set();
      this._eraseAt(pt);
    }
  }

  _onMove(e) {
    if (this._pan && e.pointerId === this._pan.pointerId) {
      const dx = e.clientX - this._pan.startX;
      const dy = e.clientY - this._pan.startY;
      this.scrollContainer.scrollLeft = this._pan.startLeft - dx;
      this.scrollContainer.scrollTop = this._pan.startTop - dy;
      return;
    }
    if (e.pointerType === "touch") return;
    e.preventDefault();
    if (this._activeTool === "pen" && this._active) {
      const pt = this._eventToPagePoint(e);
      const pts = this._active.points;
      const prev = pts[pts.length - 1];
      pts.push(pt);
      this._drawSegment(prev, pt, this._active.color, this._active.width);
    } else if (this._activeTool === "eraser" && this._erasing) {
      const pt = this._eventToPagePoint(e);
      this._eraseAt(pt);
    }
  }

  _onUp(e) {
    if (this._pan && e.pointerId === this._pan.pointerId) {
      this._pan = null;
      return;
    }
    if (this._activeTool === "pen" && this._active) {
      if (this._active.points.length > 1) {
        this.strokes.push(this._active);
        this.onChange({ type: "add", stroke: this._active });
      }
      this._active = null;
    } else if (this._activeTool === "eraser" && this._erasing) {
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
    this._activeTool = null;
  }

  _eraseAt(pt) {
    const threshold = ERASE_RADIUS_CSS_PX / this.viewport.scale;
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

  // p1/p2 are PDF-space points; converted to canvas CSS pixels here.
  _drawSegment(p1, p2, color, baseWidth) {
    const ctx = this.ctx;
    const c1 = this._toCanvasPoint(p1);
    const c2 = this._toCanvasPoint(p2);
    const pressure = clamp(p2.p, 0.3, 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = baseWidth * this.viewport.scale * (0.6 + pressure * 0.6);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.stroke();
  }

  _redraw() {
    if (!this.viewport) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.viewport.width, this.viewport.height);
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
