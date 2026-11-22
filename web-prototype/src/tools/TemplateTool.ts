import type { Tool, ToolContext } from './Tool';
import type { PointerInfo } from '../game/Input';
import { getUI, setUI, toast } from '../game/store';
import { makePolyline, type Vec2 } from '../core/math';
import { crossSection, type WSegment } from '../world/World';
import { getClass, levelZ } from '../world/roads';
import { TEMPLATES, highwayFrame, planTemplate, applyTemplate, OWN_HIGHWAY_H, type Frame, type TemplatePlan } from '../world/templates';

/**
 * Place a ready-made junction or interchange. Highway templates line themselves up with the
 * dual carriageway under the cursor; street templates go anywhere and turn with Q / E.
 */
export class TemplateTool implements Tool {
  id = 'templates';
  private angle = 0;
  private cursor: PointerInfo | null = null;
  private last: { key: string; frame: Frame | null; plan: TemplatePlan | null } | null = null;
  constructor(private ctx: ToolContext) {}

  private template() {
    return TEMPLATES.find((t) => t.id === getUI().templateId) ?? TEMPLATES[0];
  }

  deactivate() {
    this.ctx.overlay.clear('ghost');
    setUI({ ghostInfo: null });
    this.last = null;
  }

  refresh() {
    this.last = null;
    if (this.cursor) this.onMove(this.cursor);
  }

  private frameAt(p: Vec2): Frame | null {
    const t = this.template();
    const own = { origin: p, ex: { x: Math.cos(this.angle), y: Math.sin(this.angle) } };
    if (t.fit === 'highway') return highwayFrame(this.ctx.world, p) ?? { ...own, h: OWN_HIGHWAY_H, standalone: true };
    return { ...own, h: 0 };
  }

  /** Plan for the cursor position (re-planned only when the placement actually moves). */
  private evaluate(p: Vec2) {
    const t = this.template();
    const f = this.frameAt(p);
    const key = f ? `${t.id}:${f.standalone ? 'own' : 'fit'}:${Math.round(f.origin.x)}:${Math.round(f.origin.y)}:${f.ex.x.toFixed(3)}:${f.ex.y.toFixed(3)}:${this.ctx.money()}` : `${t.id}:none`;
    if (this.last?.key === key) return this.last;
    const allowed = getUI().allowedClasses;
    const locked = t.build(f?.h ?? 20).pieces.find((pc) => !allowed.includes(pc.cls));
    let plan: TemplatePlan | null = null;
    if (f) {
      plan = planTemplate(this.ctx.world, t, f, this.ctx.map, this.ctx.unlimited() ? Infinity : this.ctx.money());
      if (locked) plan = { ...plan, valid: false, reason: `${getClass(locked.cls).name} is not available on this site` };
    }
    this.last = { key, frame: f, plan };
    return this.last;
  }

  onMove(p: PointerInfo) {
    this.cursor = p;
    const t = this.template();
    const { plan } = this.evaluate(p.world);
    if (!plan) {
      this.ctx.overlay.clear('ghost');
      setUI({ ghostInfo: { cost: 0, length: 0, valid: false, reason: 'Point at a dual-carriageway highway to place this' } });
      return;
    }
    const color = plan.valid ? '#3f9b5f' : '#c0392b';
    this.ctx.overlay.ribbons(
      'ghost',
      plan.lines.map((l) => {
        const c = getClass(l.cls);
        const half = crossSection({ cls: c.id, lanesF: c.lanesF, lanesB: c.lanesB } as WSegment).width / 2;
        return { line: makePolyline(l.pts), halfWidth: half, color, opacity: 0.45, z: [levelZ(l.level) + 0.3] };
      }),
    );
    const total = plan.lines.reduce((a, l) => a + makePolyline(l.pts).length, 0);
    const hint = t.fit === 'free' ? 'Q / E to turn' : this.last?.frame?.standalone ? 'brings its own highway · Q / E to turn' : 'joins the highway under the cursor';
    setUI({ ghostInfo: { cost: plan.cost, length: total, valid: plan.valid, reason: plan.valid ? `${t.name} · ${hint}` : plan.reason } });
  }

  onDown(p: PointerInfo) {
    if (p.button !== 0) return false;
    const t = this.template();
    const { frame, plan } = this.evaluate(p.world);
    if (!frame || !plan) {
      toast('Point at a dual-carriageway highway to place this interchange', 'warn');
      return true;
    }
    if (!plan.valid) {
      toast(plan.reason ?? 'Cannot place this here', 'warn');
      return true;
    }
    this.ctx.commit(`Place ${t.name}`, plan.cost, () => {
      applyTemplate(this.ctx.world, t, frame, this.ctx.map);
    });
    this.last = null;
    this.onMove(p);
    return true;
  }

  onKey(k: string) {
    if (k === 'q' || k === 'e') {
      this.angle += ((k === 'e' ? -15 : 15) * Math.PI) / 180;
      this.last = null;
      if (this.cursor) this.onMove(this.cursor);
      return true;
    }
    return false;
  }
}
