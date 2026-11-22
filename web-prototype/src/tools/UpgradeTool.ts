import type { Tool, ToolContext } from './Tool';
import type { PointerInfo } from '../game/Input';
import { pickSegment } from '../world/pick';
import { getUI, setUI, toast } from '../game/store';
import { getClass } from '../world/roads';
import { segmentCost, type World, type WSegment } from '../world/World';

/** Cost of converting a segment to another class, and the resulting lane layout. */
export function upgradePlan(world: World, s: WSegment, clsId: string) {
  const cls = getClass(clsId);
  const reversed = s.lanesF === 0 && s.lanesB > 0;
  const lanesF = reversed && cls.lanesB === 0 ? 0 : cls.lanesF;
  const lanesB = reversed && cls.lanesB === 0 ? cls.lanesF : cls.lanesB;
  const probe: WSegment = { ...s, cls: clsId, lanesF, lanesB };
  const newCost = segmentCost(world, probe);
  const oldCost = s.cost ?? segmentCost(world, s);
  const cost = Math.max(Math.round(newCost * 0.2), newCost - oldCost);
  return { cls, lanesF, lanesB, newCost, cost };
}

/** Change a road's class in place (keeps connections). Shift-click reverses direction. */
export class UpgradeTool implements Tool {
  id = 'upgrade';
  hover: number | null = null;
  private cursor: PointerInfo | null = null;
  constructor(private ctx: ToolContext) {}

  deactivate() {
    this.ctx.overlay.clear('hover');
    setUI({ hover: null });
  }
  refresh() {
    if (this.cursor) this.onMove(this.cursor);
  }

  onMove(p: PointerInfo) {
    this.cursor = p;
    const hit = pickSegment(this.ctx.world, this.ctx.geom, p.world, 2);
    this.hover = hit?.seg ?? null;
    if (!hit) {
      this.ctx.overlay.clear('hover');
      setUI({ hover: null });
      return;
    }
    const s = this.ctx.world.seg(hit.seg);
    const g = this.ctx.geom.segs.get(hit.seg)!;
    const target = getUI().roadClass;
    const plan = upgradePlan(this.ctx.world, s, target);
    const same = s.cls === target;
    this.ctx.overlay.ribbons('hover', [{ line: g.center, z: g.z, halfWidth: g.cs.width / 2 + 0.5, color: s.locked ? '#888' : '#2f7fd6', opacity: 0.45 }]);
    setUI({
      hover: s.locked
        ? 'Fixed road'
        : same
          ? `${plan.cls.name} · shift-click to reverse direction`
          : `Convert ${getClass(s.cls).name} → ${plan.cls.name} · $${plan.cost.toLocaleString()}`,
    });
  }

  onDown(p: PointerInfo) {
    if (p.button !== 0) return false;
    this.onMove(p);
    if (this.hover === null) return false;
    const w = this.ctx.world;
    const s = w.seg(this.hover);
    if (s.locked) {
      toast('This road is part of the site and cannot be changed', 'warn');
      return true;
    }
    const id = s.id;
    if (p.shift) {
      this.ctx.commit('Reverse road', 0, () => w.reverseSegment(id));
      return true;
    }
    const target = getUI().roadClass;
    if (s.cls === target) return true;
    const plan = upgradePlan(w, s, target);
    if (!this.ctx.unlimited() && plan.cost > this.ctx.money()) {
      toast('Not enough money', 'warn');
      return true;
    }
    this.ctx.commit(`Upgrade to ${plan.cls.name}`, plan.cost, () => {
      const seg = w.seg(id);
      seg.cls = target;
      seg.lanesF = plan.lanesF;
      seg.lanesB = plan.lanesB;
      seg.cost = plan.newCost;
      w.clearNodeOverrides(seg.a);
      w.clearNodeOverrides(seg.b);
      w.touch();
    });
    return true;
  }
}
