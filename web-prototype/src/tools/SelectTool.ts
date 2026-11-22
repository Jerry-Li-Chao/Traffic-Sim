import type { Tool, ToolContext } from './Tool';
import type { PointerInfo } from '../game/Input';
import { pickNode, pickSegment } from '../world/pick';
import { getUI, setUI } from '../game/store';

/**
 * Generic click-to-select tool. Used by Inspect (vehicles, segments, junctions),
 * Lanes (segments) and Junction (nodes).
 */
export class SelectTool implements Tool {
  hoverKey: string | null = null;
  private cursor: PointerInfo | null = null;

  constructor(
    private ctx: ToolContext,
    public id: string,
    private kinds: ('vehicle' | 'segment' | 'node')[],
  ) {}

  activate() {
    if (getUI().selection && !this.kinds.includes(getUI().selection!.kind)) this.ctx.select(null);
  }

  deactivate() {
    this.ctx.overlay.clear('hover');
    setUI({ hover: null });
  }

  refresh() {
    if (this.cursor) this.onMove(this.cursor);
  }

  private pick(p: PointerInfo) {
    if (this.kinds.includes('vehicle')) {
      const v = this.ctx.pickVehicle(p.world);
      if (v !== null) return { kind: 'vehicle' as const, id: v };
    }
    if (this.kinds.includes('node')) {
      const n = pickNode(this.ctx.world, this.ctx.geom, p.world);
      if (n !== null && this.ctx.geom.nodes.get(n)?.junction) return { kind: 'node' as const, id: n };
    }
    if (this.kinds.includes('segment')) {
      const s = pickSegment(this.ctx.world, this.ctx.geom, p.world, 1);
      if (s) return { kind: 'segment' as const, id: s.seg };
    }
    return null;
  }

  onMove(p: PointerInfo) {
    this.cursor = p;
    const hit = this.pick(p);
    const ov = this.ctx.overlay;
    if (!hit || hit.kind === 'vehicle') {
      ov.clear('hover');
      setUI({ hover: hit?.kind === 'vehicle' ? 'Vehicle — click to follow its route' : null });
      return;
    }
    if (hit.kind === 'segment') {
      const g = this.ctx.geom.segs.get(hit.id)!;
      ov.ribbons('hover', [{ line: g.center, z: g.z, halfWidth: g.cs.width / 2 + 0.4, color: '#ffffff', opacity: 0.25 }]);
      setUI({ hover: null });
    } else {
      const n = this.ctx.world.node(hit.id);
      const ng = this.ctx.geom.nodes.get(hit.id)!;
      const r = Math.max(6, ...ng.arms.map((a) => Math.min(30, a.trim)));
      ov.markers('hover', [{ pos: n, radius: r, color: '#ffffff', ring: true, opacity: 0.6, z: ng.z }]);
      setUI({ hover: null });
    }
  }

  /** where the left button went down (screen px); a click selects, a drag only pans */
  private downAt: { x: number; y: number } | null = null;

  onDown(p: PointerInfo) {
    if (p.button !== 0) return false;
    this.downAt = { ...p.screen };
    // never take the drag: dragging anywhere pans the map and keeps the current selection
    return false;
  }

  onUp(p: PointerInfo) {
    const d = this.downAt;
    this.downAt = null;
    if (!d || Math.hypot(p.screen.x - d.x, p.screen.y - d.y) > 5) return;
    // a click: select what is under the cursor, or clear the selection on empty ground
    this.ctx.select(this.pick(p));
  }

  onCancel() {
    if (!getUI().selection) return false;
    this.ctx.select(null);
    return true;
  }
}
