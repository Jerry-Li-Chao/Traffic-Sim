// Top-down orthographic camera model. Pure math so it can be unit tested;
// the Three.js camera is synced from it each frame.

export interface CameraBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class CameraModel {
  /** world point at the centre of the screen */
  cx = 0;
  cy = 0;
  /** metres per screen pixel */
  mpp = 0.5;
  minMpp = 0.04;
  maxMpp = 6;
  width = 1;
  height = 1;
  bounds: CameraBounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };

  setViewport(w: number, h: number) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.clampToBounds();
  }

  screenToWorld(px: number, py: number) {
    return {
      x: this.cx + (px - this.width / 2) * this.mpp,
      y: this.cy - (py - this.height / 2) * this.mpp,
    };
  }

  worldToScreen(x: number, y: number) {
    return {
      x: (x - this.cx) / this.mpp + this.width / 2,
      y: -(y - this.cy) / this.mpp + this.height / 2,
    };
  }

  /** Pan by a screen-space delta (pixels). */
  panPixels(dx: number, dy: number) {
    this.cx -= dx * this.mpp;
    this.cy += dy * this.mpp;
    this.clampToBounds();
  }

  /** Zoom by factor (>1 zooms out) keeping the world point under (px,py) fixed. */
  zoomAt(px: number, py: number, factor: number) {
    const before = this.screenToWorld(px, py);
    this.mpp = Math.min(this.maxMpp, Math.max(this.minMpp, this.mpp * factor));
    const after = this.screenToWorld(px, py);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
    this.clampToBounds();
  }

  /** Visible world rectangle. */
  view() {
    const hw = (this.width / 2) * this.mpp,
      hh = (this.height / 2) * this.mpp;
    return { minX: this.cx - hw, maxX: this.cx + hw, minY: this.cy - hh, maxY: this.cy + hh };
  }

  fit(b: CameraBounds, margin = 1.05) {
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
    const mppX = ((b.maxX - b.minX) * margin) / this.width;
    const mppY = ((b.maxY - b.minY) * margin) / this.height;
    this.mpp = Math.min(this.maxMpp, Math.max(this.minMpp, Math.max(mppX, mppY)));
  }

  clampToBounds() {
    const b = this.bounds;
    this.cx = Math.min(b.maxX, Math.max(b.minX, this.cx));
    this.cy = Math.min(b.maxY, Math.max(b.minY, this.cy));
  }
}
