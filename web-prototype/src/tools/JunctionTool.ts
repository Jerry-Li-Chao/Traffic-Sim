import type { Tool, ToolContext } from './Tool';
import type { PointerInfo } from '../game/Input';
import { SelectTool } from './SelectTool';
import { getUI, setUI } from '../game/store';
import { laneMarkers, toggleConnection, targetsOf } from '../world/laneEdit';
import { nodeConnectors } from '../world/lanes';
import { dist } from '../core/math';

/**
 * Select junctions (control panel in the inspector). When lane editing is on for the
 * selected junction, click an incoming lane (white) then outgoing lanes (blue) to toggle.
 */
export class JunctionTool implements Tool {
  id = 'junction';
  private select: SelectTool;
  constructor(private ctx: ToolContext) {
    this.select = new SelectTool(ctx, 'junction', ['node']);
  }

  activate() {
    this.select.activate();
  }
  deactivate() {
    this.select.deactivate();
    setUI({ laneEdit: null });
    this.ctx.overlay.clear('lanes-m');
    this.ctx.overlay.clear('lanes-c');
  }
  refresh() {
    this.select.refresh();
    this.draw();
  }

  /** Draw lane markers + connections for the junction being edited. */
  draw() {
    const le = getUI().laneEdit;
    const ov = this.ctx.overlay;
    if (!le || !this.ctx.world.nodes.has(le.node)) {
      ov.clear('lanes-m');
      ov.clear('lanes-c');
      return;
    }
    const ng = this.ctx.geom.nodes.get(le.node)!;
    const markers = laneMarkers(this.ctx.world, this.ctx.geom, le.node);
    const conns = nodeConnectors(this.ctx.world, this.ctx.geom, le.node);
    const sel = le.fromKey;
    const selTargets = sel ? targetsOf(conns, +sel.split(':')[0], +sel.split(':')[1]) : [];
    ov.markers(
      'lanes-m',
      markers.map((m) => ({
        pos: m.pos,
        z: ng.z,
        radius: 1.1,
        color: m.incoming ? (m.key === sel ? '#ff9f1c' : '#ffffff') : selTargets.includes(m.key) ? '#2fcf62' : '#5aa9ff',
        opacity: 0.95,
      })),
    );
    ov.lines(
      'lanes-c',
      conns
        .filter((c) => !c.direct)
        .map((c) => {
          const active = sel && `${c.from.seg}:${c.from.idx}` === sel;
          return { line: c.poly, color: active ? '#ff9f1c' : '#ffffff', width: active ? 0.5 : 0.25, z: ng.z, opacity: active ? 0.95 : 0.45 };
        }),
    );
  }

  onMove(p: PointerInfo) {
    if (!getUI().laneEdit) this.select.onMove(p);
  }

  onDown(p: PointerInfo) {
    if (p.button !== 0) return false;
    const le = getUI().laneEdit;
    if (le && this.ctx.world.nodes.has(le.node)) {
      const markers = laneMarkers(this.ctx.world, this.ctx.geom, le.node);
      let best: (typeof markers)[0] | null = null;
      let bd = Math.max(1.8, this.ctx.cam.mpp * 10);
      for (const m of markers) {
        const d = dist(m.pos, p.world);
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
      if (best) {
        if (best.incoming) setUI({ laneEdit: { node: le.node, fromKey: best.key } });
        else if (le.fromKey) {
          const from = le.fromKey;
          this.ctx.commit('Edit lane connection', 0, () => {
            toggleConnection(this.ctx.world, this.ctx.geom, le.node, from, best!.key);
          });
        }
        this.draw();
        return true;
      }
      return false;
    }
    return this.select.onDown(p);
  }

  onUp(p: PointerInfo) {
    this.select.onUp(p);
  }

  onCancel() {
    if (getUI().laneEdit) {
      setUI({ laneEdit: null });
      this.draw();
      return true;
    }
    return this.select.onCancel();
  }
}
