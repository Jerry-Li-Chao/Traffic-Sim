import type { CameraModel } from '../render/camera';
import type { Vec2 } from '../core/math';

export interface PointerInfo {
  world: Vec2;
  screen: Vec2;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface InputHandler {
  /** return true if the handler consumed the event (prevents left-drag pan) */
  onDown?(p: PointerInfo): boolean | void;
  onMove?(p: PointerInfo): void;
  onUp?(p: PointerInfo): void;
  onKey?(key: string, e: KeyboardEvent): boolean | void;
  /** right-click (or Esc): cancel the current step. Returns true if there was one to cancel. */
  onCancel?(): boolean | void;
  /** Esc key: if absent, Esc acts like onCancel */
  onEscape?(): void;
}

/** Camera navigation + pointer/keyboard routing to the active tool. */
export class Input {
  handler: InputHandler | null = null;
  private keys = new Set<string>();
  private drag: { x: number; y: number; moved: number; button: number; pan: boolean } | null = null;
  private disposers: (() => void)[] = [];
  lastPointer: PointerInfo | null = null;

  constructor(
    private el: HTMLElement,
    private cam: CameraModel,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(
      t: EventTarget,
      type: K | string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(el, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(el, 'pointerdown', (e: PointerEvent) => this.down(e));
    on(window, 'pointermove', (e: PointerEvent) => this.move(e));
    on(window, 'pointerup', (e: PointerEvent) => this.up(e));
    on(el, 'wheel', (e: WheelEvent) => this.wheel(e), { passive: false });
    on(window, 'keydown', (e: KeyboardEvent) => this.keydown(e));
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => this.keys.clear());
  }

  private info(e: PointerEvent | MouseEvent): PointerInfo {
    const r = this.el.getBoundingClientRect();
    const sx = e.clientX - r.left,
      sy = e.clientY - r.top;
    return {
      world: this.cam.screenToWorld(sx, sy),
      screen: { x: sx, y: sy },
      button: e.button,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
    };
  }

  private down(e: PointerEvent) {
    const p = this.info(e);
    this.lastPointer = p;
    if (e.button === 1 || e.button === 2) {
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button, pan: true };
      return;
    }
    const consumed = this.handler?.onDown?.(p);
    this.drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button, pan: !consumed };
  }

  private move(e: PointerEvent) {
    if (this.drag?.pan) {
      const dx = e.clientX - this.drag.x,
        dy = e.clientY - this.drag.y;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.cam.panPixels(dx, dy);
    }
    if (e.target !== this.el && !this.drag) return;
    const p = this.info(e);
    this.lastPointer = p;
    this.handler?.onMove?.(p);
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const p = this.info(e);
    if (d.button === 2 && d.moved < 6) {
      // right click without drag = cancel
      this.handler?.onCancel?.();
      return;
    }
    if (d.button === 0) this.handler?.onUp?.({ ...p, button: 0 });
  }

  /**
   * Trackpads: a two-finger swipe pans the map and a pinch zooms (browsers report a pinch as a
   * wheel event with ctrlKey set). A mouse wheel — whole notches, no sideways movement — zooms.
   */
  private wheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY ?? 0;
    const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && legacy !== 0 && legacy % 120 === 0);
    if (e.ctrlKey || mouseWheel) {
      const f = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.cam.zoomAt(e.clientX - r.left, e.clientY - r.top, f);
    } else {
      // move the map with the fingers, like scrolling a page
      this.cam.panPixels(-e.deltaX, -e.deltaY);
    }
    if (this.lastPointer) this.handler?.onMove?.(this.info(e as unknown as PointerEvent));
  }

  private keydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (this.handler?.onKey?.(k, e)) {
      e.preventDefault();
      return;
    }
    if (k === 'escape') {
      if (this.handler?.onEscape) this.handler.onEscape();
      else this.handler?.onCancel?.();
    }
    this.keys.add(k);
  }

  /** Per-frame keyboard panning. */
  update(dt: number) {
    const speed = 900 * dt; // pixels per second
    let dx = 0,
      dy = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx += speed;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx -= speed;
    if (this.keys.has('w') || this.keys.has('arrowup')) dy += speed;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dy -= speed;
    if (dx || dy) this.cam.panPixels(dx, dy);
  }

  dispose() {
    this.disposers.forEach((d) => d());
  }
}
