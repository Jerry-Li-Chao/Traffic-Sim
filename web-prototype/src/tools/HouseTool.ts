import type { Tool, ToolContext } from './Tool';
import type { PointerInfo } from '../game/Input';
import { setUI, toast } from '../game/store';
import { makePolyline } from '../core/math';
import { planHouse, applyHouse, HOUSE_SIZE, type HousePlan } from '../world/houses';

/**
 * Place houses beside streets. Each makes and takes a trickle of local trips, never more than
 * two cars out or two on their way to it at a time.
 */
export class HouseTool implements Tool {
  id = 'houses';
  private cursor: PointerInfo | null = null;
  constructor(private ctx: ToolContext) {}

  deactivate() {
    this.ctx.overlay.clear('ghost');
    setUI({ ghostInfo: null });
  }

  refresh() {
    if (this.cursor) this.onMove(this.cursor);
  }

  private plan(p: PointerInfo): HousePlan {
    return planHouse(this.ctx.world, p.world, this.ctx.map, this.ctx.unlimited() ? Infinity : this.ctx.money());
  }

  onMove(p: PointerInfo) {
    this.cursor = p;
    const plan = this.plan(p);
    const color = plan.valid ? '#3f9b5f' : '#c0392b';
    const ribbons = [];
    if (plan.driveway) ribbons.push({ line: plan.driveway.poly, halfWidth: 3, color, opacity: 0.45 });
    if (plan.driveway || plan.reason !== 'Point beside a street to build a house') {
      // the house footprint
      const c = { x: plan.pos.x + Math.cos(plan.angle) * HOUSE_SIZE.back, y: plan.pos.y + Math.sin(plan.angle) * HOUSE_SIZE.back };
      const ax = { x: Math.cos(plan.angle), y: Math.sin(plan.angle) };
      const a = { x: c.x - ax.x * (HOUSE_SIZE.d / 2), y: c.y - ax.y * (HOUSE_SIZE.d / 2) };
      const b = { x: c.x + ax.x * (HOUSE_SIZE.d / 2), y: c.y + ax.y * (HOUSE_SIZE.d / 2) };
      ribbons.push({ line: makePolyline([a, b]), halfWidth: HOUSE_SIZE.w / 2, color, opacity: 0.6, z: [4] });
    }
    this.ctx.overlay.ribbons('ghost', ribbons);
    setUI({
      ghostInfo: { cost: plan.cost, length: plan.driveway?.length ?? 0, valid: plan.valid, reason: plan.valid ? 'House · up to 2 cars out and 2 in at a time' : plan.reason },
    });
  }

  onDown(p: PointerInfo) {
    if (p.button !== 0) return false;
    const plan = this.plan(p);
    if (!plan.valid) {
      toast(plan.reason ?? 'Cannot build a house here', 'warn');
      return true;
    }
    this.ctx.commit('Build house', plan.cost, () => {
      applyHouse(this.ctx.world, plan);
    });
    this.onMove(p);
    return true;
  }
}
