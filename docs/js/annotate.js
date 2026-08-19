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
const MIN_STRAIGHT_LINE_PDF_LENGTH = 1;
const EDGE_DRAG_THRESHOLD_CSS_PX = 40;
const HIGHLIGHT_ALPHA = 0.4;
const DRAW_TOOLS = new Set(["pen", "pen-straight", "highlighter", "highlighter-straight"]);

export const GROUP_COLORS = {
  1: "#1c1c1e",
  2: "#c0392b",
  3: "#2f6fed",
  4: "#1f8a54",
  5: "#8e44ad",
};

export class AnnotationLayer {
  constructor(canvas, { onChange, scrollContainer, onReachTop, onReachBottom, onPinchStart, onPinch, onPinchEnd } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onChange = onChange || (() => {});
    this.scrollContainer = scrollContainer;
    this.onReachTop = onReachTop || (() => {});
    this.onReachBottom = onReachBottom || (() => {});
    this.onPinchStart = onPinchStart || (() => {});
    this.onPinch = onPinch || (() => {});
    this.onPinchEnd = onPinchEnd || (() => {});
    this.strokes = [];
    this.masks = [];
    this.tool = "pen";
    this.color = "#1c1c1e";
    this.width = 2;
    this.currentGroup = 1;
    this.memorizeOn = false;
    this.groupActive = new Map(); // group -> bool, default true (unset = active)
    this.autoAdvance = true;
    this.viewport = null;

    this._active = null; // in-progress pen stroke
    this._activeMask = null; // in-progress mask rect
    this._activeTool = null; // tool locked in for the current gesture
    this._erasingStrokes = null;
    this._erasingMasks = null;
    this._pan = null; // finger-drag / pan-tool drag state
    this._touches = new Map(); // active touch pointerId -> {x, y}, for pinch
    this._pinch = null; // {startDist}
    this._lastPinchScale = 1;

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
  }

  setAutoAdvance(enabled) {
    this.autoAdvance = enabled;
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

  // Whether a mask currently renders opaque (hiding content) — true when
  // memorize mode is on and this group hasn't been individually revealed.
  // Same rule on screen and at export time, regardless of which tool is
  // selected, so toggling memorize mode always visibly does something.
  isMaskOpaque(group) {
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

  _startPan(pointerId, clientX, clientY) {
    this._pan = {
      pointerId,
      startX: clientX,
      startY: clientY,
      startLeft: this.scrollContainer.scrollLeft,
      startTop: this.scrollContainer.scrollTop,
      edgeFired: false,
    };
  }

  _applyPanDelta(dx, dy) {
    const targetTop = this._pan.startTop - dy;
    const maxTop = this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight;
    this.scrollContainer.scrollLeft = this._pan.startLeft - dx;
    this.scrollContainer.scrollTop = clamp(targetTop, 0, maxTop);

    if (this.autoAdvance && !this._pan.edgeFired) {
      if (maxTop >= 0 && targetTop > maxTop + EDGE_DRAG_THRESHOLD_CSS_PX) {
        this._pan.edgeFired = true;
        this.onReachBottom();
      } else if (targetTop < -EDGE_DRAG_THRESHOLD_CSS_PX) {
        this._pan.edgeFired = true;
        this.onReachTop();
      }
    }
  }

  _onTouchDown(e) {
    this._trySetCapture(e.pointerId);
    this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._touches.size === 2) {
      this._pan = null;
      const pts = Array.from(this._touches.values());
      this._pinch = { startDist: Math.max(1, dist(pts[0], pts[1])) };
      this._lastPinchScale = 1;
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      this.onPinchStart(midX, midY);
    } else if (this._touches.size === 1) {
      this._startPan(e.pointerId, e.clientX, e.clientY);
    }
  }

  _onDown(e) {
    // No native scrolling/pinch is possible here (touch-action: none), so
    // finger touch always drives pan/pinch ourselves.
    if (e.pointerType === "touch") {
      this._onTouchDown(e);
      return;
    }
    // Pen/mouse pans too when the hand tool is selected — e.g. so you can
    // move the page with the S Pen itself.
    if (this.tool === "pan") {
      e.preventDefault();
      this._trySetCapture(e.pointerId);
      this._startPan(e.pointerId, e.clientX, e.clientY);
      return;
    }
    e.preventDefault();
    this._trySetCapture(e.pointerId);
    this._activeTool = this._effectiveTool(e);
    const pt = this._eventToPagePoint(e);
    if (DRAW_TOOLS.has(this._activeTool)) {
      const highlight = this._activeTool.startsWith("highlighter");
      const straight = this._activeTool.endsWith("straight");
      this._active = {
        color: this.color,
        width: this.width,
        highlight,
        straight,
        points: straight ? [pt, pt] : [pt],
      };
    } else if (this._activeTool === "eraser") {
      this._erasingStrokes = new Set();
      this._eraseStrokesAt(pt);
    } else if (this._activeTool === "mask-erase") {
      this._erasingMasks = new Set();
      this._eraseMasksAt(pt);
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

  _onTouchMove(e) {
    if (!this._touches.has(e.pointerId)) return;
    this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pinch && this._touches.size >= 2) {
      const pts = Array.from(this._touches.values());
      const scaleFactor = dist(pts[0], pts[1]) / this._pinch.startDist;
      this._lastPinchScale = scaleFactor;
      this.onPinch(scaleFactor);
      return;
    }
    if (this._pan && e.pointerId === this._pan.pointerId) {
      this._applyPanDelta(e.clientX - this._pan.startX, e.clientY - this._pan.startY);
    }
  }

  _onMove(e) {
    if (e.pointerType === "touch") {
      this._onTouchMove(e);
      return;
    }
    if (this._pan && e.pointerId === this._pan.pointerId) {
      this._applyPanDelta(e.clientX - this._pan.startX, e.clientY - this._pan.startY);
      return;
    }
    e.preventDefault();
    if (DRAW_TOOLS.has(this._activeTool) && this._active) {
      const pt = this._eventToPagePoint(e);
      if (this._active.straight) {
        // Replace (not append) the end point each move, then redraw fully —
        // a straight-line stroke is only ever its start and current end.
        this._active.points[1] = pt;
        this._redraw();
      } else {
        const pts = this._active.points;
        const prev = pts[pts.length - 1];
        pts.push(pt);
        this._drawSegment(prev, pt, this._active.color, this._active.width, this._active.highlight);
      }
    } else if (this._activeTool === "eraser" && this._erasingStrokes) {
      this._eraseStrokesAt(this._eventToPagePoint(e));
    } else if (this._activeTool === "mask-erase" && this._erasingMasks) {
      this._eraseMasksAt(this._eventToPagePoint(e));
    } else if (this._activeTool === "mask" && this._activeMask) {
      const pt = this._eventToPagePoint(e);
      this._activeMask.x1 = pt.x;
      this._activeMask.y1 = pt.y;
      this._redraw();
    }
  }

  _onTouchUp(e) {
    this._touches.delete(e.pointerId);
    if (this._pinch) {
      if (this._touches.size < 2) {
        this.onPinchEnd(this._lastPinchScale);
        this._pinch = null;
        this._lastPinchScale = 1;
        if (this._touches.size === 1) {
          const [[id, pt]] = this._touches.entries();
          this._startPan(id, pt.x, pt.y);
        }
      }
      return;
    }
    if (this._pan && e.pointerId === this._pan.pointerId) {
      this._pan = null;
    }
  }

  _onUp(e) {
    if (e.pointerType === "touch") {
      this._onTouchUp(e);
      return;
    }
    if (this._pan && e.pointerId === this._pan.pointerId) {
      this._pan = null;
      return;
    }
    if (DRAW_TOOLS.has(this._activeTool) && this._active) {
      const pts = this._active.points;
      const valid = this._active.straight
        ? pts.length === 2 && dist(pts[0], pts[1]) > MIN_STRAIGHT_LINE_PDF_LENGTH
        : pts.length > 1;
      if (valid) {
        this.strokes.push(this._active);
        this.onChange({ kind: "stroke", type: "add", stroke: this._active });
      }
      this._active = null;
      this._redraw(); // clear a straight-line preview that didn't get saved
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
      this._erasingStrokes = null;
      this._redraw();
    } else if (this._activeTool === "mask-erase") {
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

  // Strokes only — the general eraser never touches memorization masks.
  // Erasing a hidden mask needs the dedicated mask-eraser sub-tool, so a
  // routine eraser swipe can't accidentally reveal what it's covering.
  _eraseStrokesAt(pt) {
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
    if (changed) this._redraw();
  }

  _eraseMasksAt(pt) {
    const threshold = ERASE_RADIUS_CSS_PX / this.viewport.scale;
    let changed = false;
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
  _drawSegment(p1, p2, color, baseWidth, highlight) {
    const ctx = this.ctx;
    const c1 = this._toCanvasPoint(p1);
    const c2 = this._toCanvasPoint(p2);
    const pressure = clamp(p2.p, 0.3, 1);
    ctx.globalAlpha = highlight ? HIGHLIGHT_ALPHA : 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = baseWidth * this.viewport.scale * (0.6 + pressure * 0.6);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _drawMask(mask) {
    const c0 = this._toCanvasPoint({ x: mask.x, y: mask.y });
    const c1 = this._toCanvasPoint({ x: mask.x + mask.w, y: mask.y + mask.h });
    const rx = Math.min(c0.x, c1.x);
    const ry = Math.min(c0.y, c1.y);
    const rw = Math.abs(c1.x - c0.x);
    const rh = Math.abs(c1.y - c0.y);
    const ctx = this.ctx;
    if (this.isMaskOpaque(mask.group)) {
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
        this._drawSegment(stroke.points[j - 1], stroke.points[j], stroke.color, stroke.width, stroke.highlight);
      }
    });
    if (this._active) {
      const pts = this._active.points;
      for (let j = 1; j < pts.length; j++) {
        this._drawSegment(pts[j - 1], pts[j], this._active.color, this._active.width, this._active.highlight);
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

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
