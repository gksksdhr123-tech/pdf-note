// Ink + memorization-mask layer. Stroke/mask points are stored in real PDF
// coordinate space (pdf.js's convertToPdfPoint output: origin bottom-left,
// y-up, rotation already resolved) so they stay correct across zoom/rotation
// and feed straight into pdf-lib for export with no extra math.
//
// touch-action is "none" on the canvas (see style.css) so the browser never
// tries to interpret an in-progress pen stroke as a scroll/pan gesture —
// we do all touch panning ourselves below, and pen/mouse always draw.

const ERASE_RADIUS_CSS_PX = 14;
const MIN_MASK_PDF_SIZE = 3;

export const GROUP_COLORS = {
  1: "#1c1c1e",
  2: "#c0392b",
  3: "#2f6fed",
  4: "#1f8a54",
  5: "#8e44ad",
};

export class AnnotationLayer {
  constructor(canvas, { onChange, scrollContainer } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onChange = onChange || (() => {});
    this.scrollContainer = scrollContainer;
    this.strokes = [];
    this.masks = [];
    this.tool = "pen";
    this.color = "#1c1c1e";
    this.width = 2;
    this.currentGroup = 1;
    this.memorizeOn = false;
    this.groupActive = new Map(); // group -> bool, default true (unset = active)
    this.viewport = null;

    this._active = null; // in-progress pen stroke
    this._activeMask = null; // in-progress mask rect
    this._activeTool = null; // tool locked in for the current gesture
    this._erasingStrokes = null;
    this._erasingMasks = null;
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

  setMasks(masks) {
    this.masks = masks || [];
    this._redraw();
  }

  getMasks() {
    return this.masks;
  }

  redraw() {
    this._redraw();
  }

  setTool(tool) {
    this.tool = tool;
    this._redraw(); // mask tool forces edit-view; switching away restores it
  }

  setColor(color) {
    this.color = color;
  }

  setWidth(width) {
    this.width = width;
  }

  setCurrentGroup(group) {
    this.currentGroup = group;
  }

  setMemorizeOn(on) {
    this.memorizeOn = on;
    this._redraw();
  }

  setGroupActive(group, active) {
    this.groupActive.set(group, active);
    this._redraw();
  }

  isGroupActive(group) {
    return this.groupActive.get(group) !== false;
  }

  setAllGroupsActive(active) {
    for (let g = 1; g <= 5; g++) this.groupActive.set(g, active);
    this._redraw();
  }

  // Fresh document, fresh quiz state: no groups mid-review, nothing hidden.
  resetGroups() {
    this.groupActive = new Map();
    this.currentGroup = 1;
    this.memorizeOn = false;
    this._redraw();
  }

  // Whether a mask would render opaque in an exported PDF — same as
  // _isGroupOpaque but ignores the "mask tool selected" edit-view override,
  // since export always reflects the persisted memorize/group state.
  isExportOpaque(group) {
    if (!this.memorizeOn) return false;
    return this.isGroupActive(group);
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
      this._erasingStrokes = new Set();
      this._erasingMasks = new Set();
      this._eraseAt(pt);
    } else if (this._activeTool === "mask") {
      this._activeMask = {
        group: this.currentGroup,
        color: GROUP_COLORS[this.currentGroup] || "#1c1c1e",
        x0: pt.x,
        y0: pt.y,
        x1: pt.x,
        y1: pt.y,
      };
      this._redraw();
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
    } else if (this._activeTool === "eraser" && (this._erasingStrokes || this._erasingMasks)) {
      const pt = this._eventToPagePoint(e);
      this._eraseAt(pt);
    } else if (this._activeTool === "mask" && this._activeMask) {
      const pt = this._eventToPagePoint(e);
      this._activeMask.x1 = pt.x;
      this._activeMask.y1 = pt.y;
      this._redraw();
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
        this.onChange({ kind: "stroke", type: "add", stroke: this._active });
      }
      this._active = null;
    } else if (this._activeTool === "eraser") {
      if (this._erasingStrokes && this._erasingStrokes.size > 0) {
        const removed = [];
        const kept = [];
        this.strokes.forEach((s, i) => {
          if (this._erasingStrokes.has(i)) removed.push(s);
          else kept.push(s);
        });
        this.strokes = kept;
        this.onChange({ kind: "stroke", type: "erase", strokes: removed });
      }
      if (this._erasingMasks && this._erasingMasks.size > 0) {
        const removed = [];
        const kept = [];
        this.masks.forEach((m, i) => {
          if (this._erasingMasks.has(i)) removed.push(m);
          else kept.push(m);
        });
        this.masks = kept;
        this.onChange({ kind: "mask", type: "erase", masks: removed });
      }
      this._erasingStrokes = null;
      this._erasingMasks = null;
      this._redraw();
    } else if (this._activeTool === "mask" && this._activeMask) {
      const mask = normalizeMask(this._activeMask);
      this._activeMask = null;
      if (mask.w >= MIN_MASK_PDF_SIZE && mask.h >= MIN_MASK_PDF_SIZE) {
        this.masks.push(mask);
        this.onChange({ kind: "mask", type: "add", mask });
      }
      this._redraw();
    }
    this._activeTool = null;
  }

  _eraseAt(pt) {
    const threshold = ERASE_RADIUS_CSS_PX / this.viewport.scale;
    let changed = false;
    this.strokes.forEach((stroke, i) => {
      if (this._erasingStrokes.has(i)) return;
      for (let j = 1; j < stroke.points.length; j++) {
        if (distToSegment(pt, stroke.points[j - 1], stroke.points[j]) < threshold) {
          this._erasingStrokes.add(i);
          changed = true;
          break;
        }
      }
    });
    this.masks.forEach((mask, i) => {
      if (this._erasingMasks.has(i)) return;
      if (
        pt.x >= mask.x - threshold &&
        pt.x <= mask.x + mask.w + threshold &&
        pt.y >= mask.y - threshold &&
        pt.y <= mask.y + mask.h + threshold
      ) {
        this._erasingMasks.add(i);
        changed = true;
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

  // Fully opaque (hides content) only when actually quizzing that group;
  // while the mask tool is selected we always show the see-through edit
  // view so you can see what you're covering.
  _isGroupOpaque(group) {
    if (this.tool === "mask") return false;
    if (!this.memorizeOn) return false;
    return this.isGroupActive(group);
  }

  _drawMask(mask) {
    const c0 = this._toCanvasPoint({ x: mask.x, y: mask.y });
    const c1 = this._toCanvasPoint({ x: mask.x + mask.w, y: mask.y + mask.h });
    const rx = Math.min(c0.x, c1.x);
    const ry = Math.min(c0.y, c1.y);
    const rw = Math.abs(c1.x - c0.x);
    const rh = Math.abs(c1.y - c0.y);
    const ctx = this.ctx;
    if (this._isGroupOpaque(mask.group)) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = mask.color;
      ctx.fillRect(rx, ry, rw, rh);
    } else {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = mask.color;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = mask.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    }
  }

  _redraw() {
    if (!this.viewport) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.viewport.width, this.viewport.height);
    this.strokes.forEach((stroke, i) => {
      if (this._erasingStrokes && this._erasingStrokes.has(i)) return;
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
    this.masks.forEach((mask, i) => {
      if (this._erasingMasks && this._erasingMasks.has(i)) return;
      this._drawMask(mask);
    });
    if (this._activeMask) this._drawMask(normalizeMask(this._activeMask));
  }
}

function normalizeMask(m) {
  return {
    group: m.group,
    color: m.color,
    x: Math.min(m.x0, m.x1),
    y: Math.min(m.y0, m.y1),
    w: Math.abs(m.x1 - m.x0),
    h: Math.abs(m.y1 - m.y0),
  };
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
