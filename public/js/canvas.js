// Pan/zoom controller for the infinite canvas.
// Drag / touch-drag to pan, pinch or ctrl/cmd+wheel to zoom, wheel to scroll,
// double-tap/click to zoom in. flyTo() animates to a world-space rect.

export class PanZoom {
  constructor(viewport, world, bounds) {
    this.viewport = viewport;
    this.world = world;
    this.bounds = bounds; // { w, h } world size
    this.x = 0; this.y = 0; this.scale = 1;
    this.minScale = 0.1; this.maxScale = 2.5;
    this.pointers = new Map();
    this.anim = null;
    this.moved = false;
    this.bind();
  }

  apply() {
    this.world.style.transform =
      `translate3d(${this.x}px, ${this.y}px, 0) scale(${this.scale})`;
  }

  clamp() {
    const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
    const margin = 0.25; // keep at least 25% of viewport on the canvas
    const w = this.bounds.w * this.scale, h = this.bounds.h * this.scale;
    this.x = Math.min(vw * (1 - margin), Math.max(vw * margin - w, this.x));
    this.y = Math.min(vh * (1 - margin), Math.max(vh * margin - h, this.y));
  }

  zoomAt(cx, cy, factor) {
    const s = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    const k = s / this.scale;
    this.x = cx - (cx - this.x) * k;
    this.y = cy - (cy - this.y) * k;
    this.scale = s;
    this.clamp();
    this.apply();
  }

  // Animate so that world-space rect fits the viewport.
  flyTo(rect, padding = 60, duration = 600) {
    const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
    const scale = Math.min(
      this.maxScale,
      Math.max(this.minScale, Math.min(
        (vw - padding * 2) / rect.w,
        (vh - padding * 2) / rect.h
      ))
    );
    const tx = vw / 2 - (rect.x + rect.w / 2) * scale;
    const ty = vh / 2 - (rect.y + rect.h / 2) * scale;
    this.animateTo(tx, ty, scale, duration);
  }

  animateTo(tx, ty, ts, duration) {
    cancelAnimationFrame(this.anim);
    const from = { x: this.x, y: this.y, s: this.scale };
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);
      this.x = from.x + (tx - from.x) * e;
      this.y = from.y + (ty - from.y) * e;
      this.scale = from.s + (ts - from.s) * e;
      this.apply();
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  bind() {
    const vp = this.viewport;
    vp.addEventListener("pointerdown", (e) => {
      cancelAnimationFrame(this.anim);
      vp.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.moved = false;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });

    vp.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.moved = true;
      p.x = e.clientX; p.y = e.clientY;

      if (this.pointers.size === 1) {
        this.x += dx; this.y += dy;
        this.clamp();
        this.apply();
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        if (this.pinchDist) this.zoomAt(cx, cy, dist / this.pinchDist);
        this.pinchDist = dist;
      }
    });

    const up = (e) => {
      this.pointers.delete(e.pointerId);
      this.pinchDist = null;
    };
    vp.addEventListener("pointerup", up);
    vp.addEventListener("pointercancel", up);

    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      cancelAnimationFrame(this.anim);
      if (e.ctrlKey || e.metaKey) {
        this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else {
        this.x -= e.deltaX;
        this.y -= e.deltaY;
        this.clamp();
        this.apply();
      }
    }, { passive: false });

    vp.addEventListener("dblclick", (e) => this.zoomAt(e.clientX, e.clientY, 1.6));
  }
}
