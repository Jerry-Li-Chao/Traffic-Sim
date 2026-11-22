import { Renderer } from '../render/Renderer';
import { RoadLayer } from '../render/RoadLayer';
import { OverlayLayer } from '../render/OverlayLayer';
import { SimClient } from './SimClient';
import { Input } from './Input';
import { setUI, getUI, toast, uiStore, type ToolId } from './store';
import { type SimInput } from '../sim/types';
import { type Snapshot, VEH_STRIDE, TRAIN_STRIDE } from '../sim/protocol';
import { VehicleLayer } from '../render/VehicleLayer';
import { PortLayer } from '../render/PortLayer';
import { compileWorld } from '../world/compile';
import type { LevelDef } from './level';
import { buildLevelWorld, type PortRuntime } from './loadLevel';
import { SANDBOX, SANDBOXES } from '../levels/sandbox';
import { makePolyline } from '../core/math';
import * as THREE from 'three';
import { ObstacleLayer } from '../render/ObstacleLayer';
import { GoalTracker, starsFor } from './goals';
import { autosave, loadAutosave, markCompleted, setLastLevel, clearAutosave } from './progress';
import { snapAnchor, planRoad, applyRoad } from '../world/build';
import { planRoundabout, applyRoundabout } from '../world/roundabout';
import { audio } from './audio';
import { loadSettings, type Settings } from './settings';
import type { SaveGame } from './progress';
import { CAMPAIGN } from '../levels/campaign';
import { World, type WorldData, housePorts } from '../world/World';
import { computeNetGeometry, type NetGeometry } from '../world/geometry';
import type { Tool, ToolContext } from '../tools/Tool';
import { RoadTool } from '../tools/RoadTool';
import { BulldozeTool } from '../tools/BulldozeTool';
import { UpgradeTool } from '../tools/UpgradeTool';
import { SelectTool } from '../tools/SelectTool';
import { RoundaboutTool } from '../tools/RoundaboutTool';
import { TemplateTool } from '../tools/TemplateTool';
import { HouseTool } from '../tools/HouseTool';
import { HouseLayer } from '../render/HouseLayer';
import { JunctionTool } from '../tools/JunctionTool';
import { SignalLayer } from '../render/SignalLayer';
import { RailLayer } from '../render/RailLayer';
import { stopStyleFor, signalPhases, majorArms, DEFAULT_GREEN, refreshDefaultControls } from '../world/control';
import type { NodeControl } from '../world/World';
import { allConnectors, laneGeometry, type Connector } from '../world/lanes';
import { getClass } from '../world/roads';
import { polyAt } from '../core/math';
import { segmentCost } from '../world/World';
import type { MapBounds } from '../world/build';

interface UndoEntry {
  label: string;
  world: WorldData;
  money: number;
}

/** Top-level orchestrator: owns renderer, input, sim client and the editable world. */
export class Game implements ToolContext {
  renderer: Renderer;
  roads: RoadLayer;
  overlay: OverlayLayer;
  sim: SimClient;
  input: Input;
  world = new World();
  geom: NetGeometry = { segs: new Map(), nodes: new Map() };
  connectors = new Map<number, Connector[]>();
  vehicles: VehicleLayer;
  portLayer: PortLayer;
  signals: SignalLayer;
  rails: RailLayer;
  obstacles: ObstacleLayer;
  houses: HouseLayer;
  goals: GoalTracker = new GoalTracker({ goals: [], rampUp: 60, hold: 120 });
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private heatTimer = 0;
  private audioTimer = 0;
  /** the menu backdrop is a demo network, never saved */
  demo = false;
  level: LevelDef = SANDBOX;
  ports: PortRuntime[] = [];
  simInput: SimInput | null = null;
  private simLoaded = false;
  map: MapBounds = { width: 1200, height: 900 };
  tools: Record<string, Tool>;
  tool: Tool | null = null;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private uiTimer = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.roads = new RoadLayer(this.renderer);
    this.overlay = new OverlayLayer(this.renderer);
    this.sim = new SimClient();
    this.vehicles = new VehicleLayer(this.renderer, this.sim);
    this.portLayer = new PortLayer(this.renderer);
    this.signals = new SignalLayer(this.renderer, this.sim);
    this.rails = new RailLayer(this.renderer, this.sim);
    this.obstacles = new ObstacleLayer(this.renderer);
    this.houses = new HouseLayer(this.renderer);
    this.sim.onSnapshot = (snap) => this.onSnapshot(snap);
    // keep the Pause / Play button honest if the simulation ever trips
    this.sim.onError = (_msg, recovered) => {
      if (recovered) toast('Traffic hit a snag and was restarted', 'warn');
      else {
        setUI({ running: false });
        toast('Traffic stopped after an error · press Play to try again', 'error');
      }
    };
    this.input = new Input(canvas, this.renderer.cam);
    this.tools = {
      inspect: new SelectTool(this, 'inspect', ['vehicle', 'node', 'segment']),
      road: new RoadTool(this),
      upgrade: new UpgradeTool(this),
      lanes: new SelectTool(this, 'lanes', ['segment']),
      junction: new JunctionTool(this),
      roundabout: new RoundaboutTool(this),
      templates: new TemplateTool(this),
      houses: new HouseTool(this),
      bulldoze: new BulldozeTool(this),
    };
    this.renderer.addLayer({ update: (dt) => this.frame(dt) });
    this.input.handler = {
      onDown: (p) => this.tool?.onDown?.(p),
      onMove: (p) => this.tool?.onMove?.(p),
      onUp: (p) => this.tool?.onUp?.(p),
      onCancel: () => this.tool?.onCancel?.(),
      onEscape: () => this.escape(),
      onKey: (k, e) => this.onKey(k, e),
    };
    uiStore.subscribe((st, prev) => {
      if (st.templateId !== prev.templateId) this.tools.templates.refresh?.();
      if (st.laneEdit !== prev.laneEdit) (this.tools.junction as JunctionTool).draw();
    });
    this.applySettings(loadSettings());
    this.loadDemo();
    this.renderer.start();
  }

  get cam() {
    return this.renderer.cam;
  }

  // ------------------------------------------------------------------ setup
  newSandbox() {
    this.loadLevel(SANDBOX);
  }

  /** Animated network behind the main menu. */
  loadDemo() {
    this.demo = true;
    this.loadLevel(SANDBOX);
    const road = (cls: string, pts: [number, number][], level = 0, endLevel?: number) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const lv = i === pts.length - 2 && endLevel !== undefined ? endLevel : level;
        const a = snapAnchor(this.world, { x: pts[i][0], y: pts[i][1] }, 3, { level });
        const b = snapAnchor(this.world, { x: pts[i + 1][0], y: pts[i + 1][1] }, 3, { level: lv });
        const plan = planRoad(this.world, { start: a, end: b, cls, level: lv }, this.map);
        if (plan.valid) applyRoad(this.world, plan);
      }
    };
    road('avenue', [[40, 500], [700, 510], [1060, 516], [1360, 520]]);
    road('street', [[720, 960], [700, 510]]);
    road('street', [[700, 510], [640, 40]]);
    road('street', [[1060, 790], [1060, 516]]);
    const rb = planRoundabout(this.world, { x: 700, y: 510 }, 24, 'roundabout', this.map);
    if (rb.valid) applyRoundabout(this.world, rb);
    this.onWorldChanged();
    this.renderer.cam.cx = 760;
    this.renderer.cam.cy = 520;
    this.renderer.cam.mpp = 0.55;
    this.setSpeed(1);
    this.setRunning(true);
    this.sim.advance(90);
  }

  loadLevel(def: LevelDef, saved?: { world: import('../world/World').WorldData; money: number }) {
    this.setRunning(false);
    this.level = def;
    this.goals = new GoalTracker(def);
    this.overlay.clear('heat');
    this.map = { width: def.width, height: def.height, gradeSeparated: def.gradeSeparated };
    this.renderer.setMap({ width: def.width, height: def.height, seed: def.seed, treeDensity: def.treeDensity });
    const built = buildLevelWorld(def);
    this.world = built.world;
    if (saved) this.world.load(saved.world);
    this.ports = built.ports;
    this.portLayer.set(this.ports, def.width, def.height);
    this.obstacles.set(this.world.obstacles, def.width, def.height);
    this.undoStack = [];
    this.redoStack = [];
    const unlimited = !Number.isFinite(def.budget);
    setUI({
      money: saved ? saved.money : unlimited ? 0 : def.budget,
      budget: unlimited ? 0 : def.budget,
      unlimited,
      allowedClasses: def.allowed,
      roadClass: def.allowed.includes(getUI().roadClass) ? getUI().roadClass : def.allowed[0],
      levelId: def.id,
      levelName: def.name,
      levelBrief: def.brief,
      selection: null,
      simTime: 0,
      vehicles: 0,
      won: false,
      showWin: false,
      goalHold: 0,
      goalHoldTarget: def.hold,
      tutorial: def.tutorial ?? null,
      tutorialStep: 0,
      speed: 1,
    });
    this.simLoaded = false;
    this.onWorldChanged();
  }

  applySettings(s: Settings) {
    this.renderer.shadowsEnabled = s.shadows;
    this.renderer.setQuality(s.hiDpi);
    audio.setVolume(s.volume);
    audio.setMuted(s.muted);
    setUI({ showFps: s.showFps, units: s.units, muted: s.muted });
  }

  /** Load a named save / imported file for the current site. */
  loadSave(save: SaveGame) {
    const def = save.levelId === this.level.id ? this.level : [...SANDBOXES, ...CAMPAIGN].find((l) => l.id === save.levelId);
    if (!def) return;
    this.loadLevel(def, save);
    this.scheduleSave();
  }

  /** Start (or resume) a campaign site / the sandbox from the menu. */
  play(def: LevelDef, resume = true) {
    this.demo = false;
    const save = resume ? loadAutosave(def.id) : null;
    if (!resume) clearAutosave(def.id);
    this.loadLevel(def, save ?? undefined);
    setLastLevel(def.id);
    setUI({ screen: 'game', tool: 'inspect', selection: null });
    this.setTool('inspect');
    this.sim.speed(1);
  }

  /** Back to the main menu (current site is autosaved). */
  toMenu() {
    this.saveNow();
    setUI({ screen: 'menu', selection: null });
    this.loadDemo();
  }

  saveNow() {
    if (this.demo) return;
    autosave({ levelId: this.level.id, world: this.world.toJSON(), money: getUI().money, savedAt: Date.now() });
  }

  private scheduleSave() {
    if (this.demo) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  /** Compile the world to the simulation lane graph and push it to the worker. */
  recompile() {
    const input = compileWorld(this.world, this.geom, this.connectors, {
      seed: this.level.seed,
      demand: this.level.demand,
      ports: [...this.ports.map((p) => ({ id: p.id, name: p.name, node: p.node })), ...housePorts(this.world)],
      rampUp: this.level.rampUp ?? 60,
    });
    this.simInput = input;
    if (!this.simLoaded) {
      this.sim.load(input);
      this.simLoaded = true;
    } else this.sim.update(input);
  }

  /** Take the inspected vehicle off the road (unsticking a jam). */
  removeVehicle(id: number) {
    this.sim.removeVehicle(id);
    this.select(null);
    toast('Car removed');
  }

  /** Restart traffic from scratch (keeps the road network). */
  resetTraffic() {
    this.simLoaded = false;
    this.recompile();
    setUI({ simTime: 0, vehicles: 0, goalHold: 0 });
  }

  /**
   * Clear everything the player has built on this site: back to the roads, budget and traffic
   * the site started with. Undoable (⌘Z brings the network back).
   */
  resetSite() {
    if (this.demo) return;
    const before: UndoEntry = { label: 'Reset site', world: this.world.toJSON(), money: getUI().money };
    this.setRunning(false);
    this.world.load(buildLevelWorld(this.level).world.toJSON());
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.goals = new GoalTracker(this.level);
    this.overlay.clear('heat');
    setUI({ money: getUI().unlimited ? 0 : this.level.budget, selection: null, laneEdit: null, won: false, showWin: false });
    this.onWorldChanged();
    this.resetTraffic();
    this.scheduleSave();
    audio.bulldoze();
    toast('Site reset to how it started · ⌘Z to undo', 'info');
  }

  // ------------------------------------------------------------------ ToolContext
  money() {
    return getUI().money;
  }
  unlimited() {
    return getUI().unlimited;
  }

  setCursor(cursor: string | null) {
    this.canvas.style.cursor = cursor ?? '';
  }

  commit(label: string, cost: number, fn: () => void, opts?: { merge?: boolean }): boolean {
    const before: UndoEntry = { label, world: this.world.toJSON(), money: getUI().money };
    try {
      fn();
    } catch (e) {
      console.warn('command failed', label, e);
      this.world.load(before.world);
      this.onWorldChanged();
      toast(`Could not ${label.toLowerCase()}`, 'error');
      return false;
    }
    if (!(opts?.merge && this.undoStack.length)) this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    if (!getUI().unlimited) setUI({ money: getUI().money - cost });
    else setUI({ money: getUI().money + Math.max(0, cost) }); // sandbox: track total spent
    this.onWorldChanged();
    this.scheduleSave();
    if (cost < 0) audio.bulldoze();
    else audio.build();
    return true;
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push({ label: e.label, world: this.world.toJSON(), money: getUI().money });
    this.world.load(e.world);
    setUI({ money: e.money });
    this.onWorldChanged();
    toast(`Undo: ${e.label}`);
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push({ label: e.label, world: this.world.toJSON(), money: getUI().money });
    this.world.load(e.world);
    setUI({ money: e.money });
    this.onWorldChanged();
    toast(`Redo: ${e.label}`);
  }

  select(sel: { kind: 'segment' | 'node' | 'vehicle'; id: number } | null) {
    const le = getUI().laneEdit;
    if (le && !(sel?.kind === 'node' && sel.id === le.node)) setUI({ laneEdit: null });
    setUI({ selection: sel });
    this.sim.inspect(sel?.kind === 'vehicle' ? sel.id : null);
    if (sel?.kind !== 'vehicle') {
      this.overlay.clear('route');
      this.overlay.clear('route-end');
    }
    this.drawSelection();
  }

  /** Highlight the selected segment/node (lane arrows show travel directions). */
  drawSelection() {
    const sel = getUI().selection;
    const ov = this.overlay;
    ov.clear('sel');
    ov.clear('sel-arrows');
    if (!sel) return;
    if (sel.kind === 'segment') {
      if (!this.world.segments.has(sel.id)) return this.select(null);
      const g = this.geom.segs.get(sel.id)!;
      ov.ribbons('sel', [{ line: g.center, z: g.z, halfWidth: g.cs.width / 2 + 0.6, color: '#2f7fd6', opacity: 0.3 }]);
      const s = this.world.seg(sel.id);
      const arrows = [];
      for (const [dir, n] of [['f', s.lanesF], ['b', s.lanesB]] as const) {
        for (let i = 0; i < n; i++) {
          const lg = laneGeometry(this.world, this.geom, { seg: s.id, dir, idx: i });
          for (let d = 6; d < lg.poly.length - 4; d += 18) {
            const a = polyAt(lg.poly, d);
            arrows.push({ from: { x: a.x - a.tx * 2.2, y: a.y - a.ty * 2.2 }, to: { x: a.x + a.tx * 2.2, y: a.y + a.ty * 2.2 }, color: dir === 'f' ? '#ffffff' : '#ffd36b', width: 0.5, z: lg.z[0] });
          }
        }
      }
      ov.arrows('sel-arrows', arrows);
    } else if (sel.kind === 'node') {
      if (!this.world.nodes.has(sel.id)) return this.select(null);
      const n = this.world.node(sel.id);
      const ng = this.geom.nodes.get(sel.id)!;
      const r = Math.max(6, ...ng.arms.map((a) => Math.min(30, a.trim)));
      ov.markers('sel', [{ pos: n, radius: r + 1, color: '#2f7fd6', ring: true, opacity: 0.8, z: ng.z }]);
    }
  }

  // ------------------------------------------------------------------ segment editing (lanes tool / inspector)
  setSegmentLanes(id: number, lanesF: number, lanesB: number) {
    const s = this.world.segments.get(id);
    if (!s || s.locked) return;
    if (lanesF < 0 || lanesB < 0 || lanesF > 5 || lanesB > 5 || lanesF + lanesB < 1) return;
    const probe = { ...s, lanesF, lanesB };
    const newCost = segmentCost(this.world, probe);
    const oldCost = s.cost ?? segmentCost(this.world, s);
    const delta = newCost - oldCost;
    const cost = delta > 0 ? delta : Math.round(delta * 0.5);
    if (!getUI().unlimited && cost > getUI().money) return toast('Not enough money', 'warn');
    this.commit('Change lanes', cost, () => {
      s.lanesF = lanesF;
      s.lanesB = lanesB;
      s.cost = newCost;
      this.world.clearNodeOverrides(s.a);
      this.world.clearNodeOverrides(s.b);
      this.world.touch();
    });
  }

  reverseSegment(id: number) {
    const s = this.world.segments.get(id);
    if (!s || s.locked) return;
    this.commit('Reverse direction', 0, () => this.world.reverseSegment(id));
  }

  /** Two-way <-> one-way (keeps the total lane count where possible). */
  toggleOneWay(id: number) {
    const s = this.world.segments.get(id);
    if (!s || s.locked) return;
    if (s.lanesF > 0 && s.lanesB > 0) this.setSegmentLanes(id, Math.min(5, s.lanesF + s.lanesB), 0);
    else {
      const total = s.lanesF + s.lanesB;
      const f = Math.max(1, Math.ceil(total / 2)),
        b = Math.max(1, Math.floor(total / 2));
      this.setSegmentLanes(id, s.lanesF > 0 ? f : b, s.lanesF > 0 ? b : f);
    }
  }

  // ------------------------------------------------------------------ junction control (junction tool / inspector)
  static CONTROL_COST: Record<NodeControl, number> = { auto: 0, stop: 600, allstop: 1200, signal: 9000 };

  setNodeControl(id: number, control: NodeControl) {
    const n = this.world.nodes.get(id);
    if (!n || n.control === control) return;
    const cost = Math.max(0, Game.CONTROL_COST[control] - Game.CONTROL_COST[n.control] * 0.5);
    if (!getUI().unlimited && cost > getUI().money) return toast('Not enough money', 'warn');
    this.commit(control === 'signal' ? 'Install signals' : 'Change junction control', cost, () => {
      n.control = control;
      // the player's choice: automatic defaults leave this junction alone from now on
      n.controlSource = 'user';
      if (control === 'signal' && !n.signal) n.signal = { green: signalPhases(this.world, id).map(() => DEFAULT_GREEN) };
      this.world.touch();
    });
  }

  toggleMajor(nodeId: number, segId: number) {
    const n = this.world.nodes.get(nodeId);
    if (!n) return;
    const current = majorArms(this.world, nodeId);
    const next = new Set(current);
    if (next.has(segId)) next.delete(segId);
    else next.add(segId);
    this.commit('Change priority', 0, () => {
      n.major = [...next];
      this.world.touch();
    });
  }

  setSignalGreen(nodeId: number, phase: number, seconds: number) {
    const n = this.world.nodes.get(nodeId);
    if (!n) return;
    const phases = signalPhases(this.world, nodeId);
    const green = phases.map((_, k) => n.signal?.green[k] ?? DEFAULT_GREEN);
    green[phase] = Math.max(5, Math.min(90, seconds));
    this.commit('Adjust signal timing', 0, () => {
      n.signal = { green };
      this.world.touch();
    });
  }

  editLanes(nodeId: number | null) {
    setUI({ laneEdit: nodeId === null ? null : { node: nodeId, fromKey: null } });
    if (nodeId !== null && getUI().tool !== 'junction') this.setTool('junction');
  }

  resetLanes(nodeId: number) {
    const n = this.world.nodes.get(nodeId);
    if (!n?.lanes) return;
    this.commit('Reset lane connections', 0, () => {
      delete n.lanes;
      this.world.touch();
    });
  }

  nodeInfo(id: number) {
    const n = this.world.nodes.get(id);
    if (!n) return null;
    const ng = this.geom.nodes.get(id);
    const major = majorArms(this.world, id);
    const phases = signalPhases(this.world, id);
    const arms = (ng?.arms ?? []).map((a) => {
      const s = this.world.seg(a.seg);
      const deg = ((Math.atan2(a.dir.y, a.dir.x) * 180) / Math.PI + 360) % 360;
      const compass = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][Math.round(deg / 45) % 8];
      return { seg: a.seg, name: `${compass} · ${getClass(s.cls).name}`, major: major.has(a.seg) };
    });
    return { node: n, arms, phases, green: phases.map((_, k) => n.signal?.green[k] ?? DEFAULT_GREEN), connectors: this.connectors.get(id)?.length ?? 0 };
  }

  segmentInfo(id: number) {
    const s = this.world.segments.get(id);
    if (!s) return null;
    const c = getClass(s.cls);
    const poly = this.world.poly(s);
    const za = this.world.zAt(s, 0),
      zb = this.world.zAt(s, poly.length);
    return { seg: s, cls: c, length: poly.length, z: [za, zb], grade: this.world.maxGrade(s) };
  }

  pickVehicle(p: { x: number; y: number }): number | null {
    return this.vehicles.pick(p.x, p.y, Math.max(3, this.cam.mpp * 8));
  }

  // ------------------------------------------------------------------ world change pipeline
  onWorldChanged() {
    // junctions the player hasn't set get controls to suit the roads meeting there
    refreshDefaultControls(this.world);
    this.geom = computeNetGeometry(this.world);
    this.connectors = allConnectors(this.world, this.geom);
    this.roads.rebuild(this.world, this.geom, this.connectors, (n, seg) => stopStyleFor(this.world, n, seg));
    this.signals.rebuild(this.world, this.geom);
    this.houses.rebuild(this.world);
    this.recompile();
    this.rails.rebuild(this.world, this.geom, this.simInput);
    this.updateTrees();
    this.tool?.refresh?.();
    this.drawSelection();
    this.drawDirections();
    setUI({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0, worldRev: getUI().worldRev + 1 });
  }

  private updateTrees() {
    const cell = 24;
    const grid = new Map<string, { x: number; y: number; r: number }[]>();
    for (const g of this.geom.segs.values()) {
      const r = g.cs.width / 2 + 1.5;
      for (let i = 0; i < g.full.pts.length; i += 2) {
        const x = g.full.pts[i],
          y = g.full.pts[i + 1];
        const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push({ x, y, r });
      }
    }
    for (const line of this.world.rails) {
      for (let i = 0; i < line.pts.length - 1; i++) {
        const [x0, y0] = line.pts[i],
          [x1, y1] = line.pts[i + 1];
        const L = Math.hypot(x1 - x0, y1 - y0);
        for (let d = 0; d <= L; d += 2) {
          const x = x0 + ((x1 - x0) * d) / L,
            y = y0 + ((y1 - y0) * d) / L;
          const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k)!.push({ x, y, r: 8 });
        }
      }
    }
    for (const n of this.geom.nodes.values()) {
      if (!n.junction) continue;
      const node = this.world.nodes.get(n.id)!;
      const r = Math.max(...n.arms.map((a) => a.trim + a.halfWidth * 0.5), 5);
      const k = `${Math.floor(node.x / cell)},${Math.floor(node.y / cell)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push({ x: node.x, y: node.y, r });
    }
    const inObstacle = this.obstacles.blocks(this.world.obstacles);
    this.renderer.updateTreeVisibility((x, y, tr) => {
      if (inObstacle(x, y)) return true;
      const cx = Math.floor(x / cell),
        cy = Math.floor(y / cell);
      for (let dx = -2; dx <= 2; dx++)
        for (let dy = -2; dy <= 2; dy++) {
          const list = grid.get(`${cx + dx},${cy + dy}`);
          if (!list) continue;
          for (const p of list) if (Math.hypot(p.x - x, p.y - y) < p.r + tr * 0.7) return true;
        }
      return false;
    });
  }

  // ------------------------------------------------------------------ tools & keys
  setTool(id: ToolId) {
    this.tool?.deactivate?.();
    this.tool = this.tools[id] ?? null;
    this.tool?.activate?.();
    setUI({ tool: id, hover: null, ghostInfo: null });
    this.drawDirections();
  }

  /**
   * Travel-direction arrows on every road while building (Road / Upgrade tools), like the
   * Lanes tool shows for one road: white one way, yellow the other.
   */
  drawDirections() {
    const tool = getUI().tool;
    if (tool !== 'road' && tool !== 'upgrade') {
      this.overlay.clear('directions');
      return;
    }
    const arrows: import('../render/OverlayLayer').OverlayArrow[] = [];
    for (const s of this.world.segments.values()) {
      for (const [dir, n] of [['f', s.lanesF], ['b', s.lanesB]] as const) {
        if (n === 0) continue;
        // one arrow down the middle of each direction's lanes, about every 40 m
        const lg = laneGeometry(this.world, this.geom, { seg: s.id, dir, idx: Math.floor((n - 1) / 2) });
        const L = lg.poly.length;
        if (L < 12) continue;
        const count = Math.max(1, Math.round(L / 40));
        for (let k = 0; k < count; k++) {
          const d = ((k + 0.5) / count) * L;
          const a = polyAt(lg.poly, d);
          const zi = Math.min(lg.z.length - 1, Math.max(0, lg.poly.cum.findIndex((c) => c >= d)));
          arrows.push({ from: { x: a.x - a.tx * 2.4, y: a.y - a.ty * 2.4 }, to: { x: a.x + a.tx * 2.4, y: a.y + a.ty * 2.4 }, color: dir === 'f' ? '#ffffff' : '#ffd36b', width: 0.55, z: lg.z[zi] });
        }
      }
    }
    this.overlay.arrowField('directions', arrows);
  }

  /**
   * Esc steps back one level: close an open dialog, else cancel what the tool is in the middle
   * of (a road being drawn, a selection), else return to the Inspect tool.
   */
  escape() {
    const ui = getUI();
    if (ui.showHelp || ui.showSettings || ui.showSaves || ui.showReset) {
      setUI({ showHelp: false, showSettings: false, showSaves: false, showReset: false });
      return;
    }
    if (this.tool?.onCancel?.()) return;
    if (ui.tool !== 'inspect') {
      this.setTool('inspect');
      return;
    }
    if (ui.selection) this.select(null);
  }

  private onKey(k: string, e: KeyboardEvent): boolean {
    if (this.tool?.onKey?.(k, e)) return true;
    if ((e.metaKey || e.ctrlKey) && k === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if ((e.metaKey || e.ctrlKey) && k === 'y') {
      this.redo();
      return true;
    }
    if (k === ' ') {
      this.setRunning(!getUI().running);
      return true;
    }
    const toolKeys: Record<string, ToolId> = { '1': 'inspect', '2': 'road', '3': 'upgrade', '4': 'lanes', '5': 'junction', '6': 'roundabout', '8': 'templates', '9': 'houses', '7': 'bulldoze', b: 'bulldoze', r: 'road' };
    if (toolKeys[k] && !e.metaKey && !e.ctrlKey) {
      this.setTool(toolKeys[k]);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ sim controls
  setRunning(running: boolean) {
    this.sim.run(running);
    setUI({ running });
  }

  setSpeed(speed: number) {
    this.sim.speed(speed);
    setUI({ speed });
  }

  setOverlay(o: 'none' | 'congestion') {
    setUI({ overlay: o });
    if (o === 'congestion') this.drawHeat();
    else this.overlay.clear('heat');
  }

  /** Congestion heat map: lanes coloured by average speed relative to the limit. */
  drawHeat() {
    const snap = this.sim.curr;
    const input = this.simInput;
    if (!snap || !input) return;
    const flow = snap.stats.edgeFlow;
    const bad = new THREE.Color('#d0352b'),
      mid = new THREE.Color('#f0a53a'),
      good = new THREE.Color('#3fa75f');
    const items = [];
    for (const e of input.edges) {
      if (e.kind !== 0) continue;
      const f = flow[e.id];
      if (f === undefined || Number.isNaN(f)) continue; // no traffic measured yet
      const c = f < 0.5 ? bad.clone().lerp(mid, f / 0.5) : mid.clone().lerp(good, (f - 0.5) / 0.5);
      items.push({ pts: e.pts, z: e.z[0], halfWidth: 1.4, color: c });
    }
    this.overlay.heat('heat', items);
  }

  /** Per-port flow summary for the HUD (goal targets come from the level). */
  goalViews(snap: Snapshot | null) {
    const goals = this.level.goals;
    const view = (ids: number[]) => {
      const p = this.ports.find((x) => x.id === ids[0]);
      const sum = (f: (id: number) => number) => ids.reduce((a, id) => a + f(id), 0);
      return {
        port: ids[0],
        name: p?.name ?? `#${ids[0]}`,
        color: p?.color ?? '#888',
        target: sum((id) => goals.find((g) => g.port === id)?.minPerMin ?? 0),
        demand: sum((id) => this.level.demand.filter((d) => d.to === id).reduce((a, d) => a + d.perMin, 0)),
        flow: sum((id) => snap?.stats.flow[id] ?? 0),
        backlog: sum((id) => snap?.stats.backlog[id] ?? 0),
      };
    };
    if (goals.length) return goals.map((g) => view([g.port]));
    // no goals (sandbox): one row per town, adding up its carriageways
    const rows = new Map<string, number[]>();
    for (const p of this.ports) rows.set(p.name, [...(rows.get(p.name) ?? []), p.id]);
    return [...rows.values()].map(view);
  }

  private onSnapshot(snap: Snapshot) {
    if (!this.demo && this.level.goals.length) {
      const wasWon = this.goals.won;
      this.goals.update(snap.stats);
      if (!wasWon && this.goals.won) {
        const stars = starsFor(this.level.budget, getUI().money);
        markCompleted(this.level.id, stars);
        setUI({ won: true, showWin: true });
        audio.win();
        const n = CAMPAIGN.findIndex((l) => l.id === this.level.id);
        const desk = (window as unknown as { flowlineDesktop?: { unlockAchievement(id: string): Promise<boolean> } }).flowlineDesktop;
        if (desk && n >= 0) void desk.unlockAchievement(`SITE_${n + 1}`);
      }
    }
    const sel = getUI().selection;
    const ins = snap.inspected;
    const prevIns = getUI().inspected;
    if (
      (ins?.id ?? null) !== (prevIns?.id ?? null) ||
      (ins && prevIns && (Math.round(ins.wait) !== Math.round(prevIns.wait) || ins.reachable !== prevIns.reachable || ins.holdWhy !== prevIns.holdWhy || Math.round(ins.eta / 5) !== Math.round(prevIns.eta / 5)))
    )
      setUI({ inspected: ins ? { id: ins.id, dest: ins.dest, wait: ins.wait, reachable: ins.reachable, eta: ins.eta, holdWhy: ins.holdWhy } : null });
    if (sel?.kind === 'vehicle') {
      if (!snap.inspected) {
        this.select(null);
      } else if (this.simInput) {
        // the path finder's route: yellow to the destination, red when it cannot get there
        const ok = snap.inspected.reachable;
        const color = ok ? '#ffd23f' : '#e5533d';
        const path = snap.inspected.edges.map((id) => this.simInput!.edges[id]).filter(Boolean);
        const lines = path.map((e) => ({ line: makePolyline(Array.from({ length: e.pts.length / 2 }, (_, i) => ({ x: e.pts[i * 2], y: e.pts[i * 2 + 1] }))), color, width: Math.max(1.6, this.cam.mpp * 5), z: e.z[0], opacity: 0.9 }));
        this.overlay.lines('route', lines);
        const last = path[path.length - 1];
        if (last) {
          const n = last.pts.length;
          this.overlay.markers('route-end', [{ pos: { x: last.pts[n - 2], y: last.pts[n - 1] }, radius: ok ? 5 : 6, color, ring: true, opacity: 0.95, z: last.z[last.z.length - 1] }]);
        }
      }
    }
  }

  private crossingWasClosed = new Int8Array(0);

  /** Feed the soundscape: what is on screen, and how close the camera is to it. */
  private updateSound() {
    const snap = this.sim.curr;
    const ui = getUI();
    const v = this.cam.view();
    const cx = (v.minX + v.maxX) / 2,
      cy = (v.minY + v.maxY) / 2;
    const reach = Math.hypot(v.maxX - v.minX, v.maxY - v.minY) / 2;
    const closeness = Math.max(0.12, Math.min(1, 0.35 / this.cam.mpp));
    // loudness of something at (x, y): full in the middle of the view, fading past its edges
    const near = (x: number, y: number) => Math.max(0, Math.min(1, 1.25 - Math.hypot(x - cx, y - cy) / reach)) * closeness;
    let visible = 0,
      moving = 0,
      stuck = 0,
      bell = 0,
      train = 0,
      horn = 0;
    if (snap) {
      const vs = snap.vehicles;
      for (let i = 0; i < snap.vehicleCount; i++) {
        const o = i * VEH_STRIDE;
        const x = vs[o],
          y = vs[o + 1];
        if (x < v.minX || x > v.maxX || y < v.minY || y > v.maxY) continue;
        visible++;
        const flags = vs[o + 7];
        if (flags & 2) stuck++;
        else if (!(flags & 1)) moving++;
      }
      const ts = snap.trains;
      for (let i = 0; i < snap.trainCount; i++) train = Math.max(train, near(ts[i * TRAIN_STRIDE], ts[i * TRAIN_STRIDE + 1]));
      const closed = snap.crossings;
      if (this.crossingWasClosed.length !== closed.length) this.crossingWasClosed = new Int8Array(closed.length);
      for (const c of this.simInput?.rail.crossings ?? []) {
        if (!closed[c.id]) continue;
        const l = near(c.x, c.y);
        bell = Math.max(bell, l);
        // the driver sounds the horn as the barriers come down ahead of the train
        if (!this.crossingWasClosed[c.id]) horn = Math.max(horn, l);
      }
      this.crossingWasClosed.set(closed);
    }
    audio.scene({ active: ui.screen === 'game', running: ui.running, closeness, visible, moving, stuck, bell, train, horn });
  }

  private frame(dt: number) {
    this.input.update(dt);
    // direction arrows only read as arrows when zoomed in enough
    this.overlay.setVisible('directions', this.cam.mpp < 1.6);
    this.sim.advanceClock(dt, getUI().running, getUI().speed);
    this.vehicles.update();
    this.signals.update();
    this.audioTimer += dt;
    if (this.audioTimer > 0.15) {
      this.audioTimer = 0;
      this.updateSound();
    }
    this.rails.update(dt);
    this.portLayer.update(this.cam.mpp);
    this.uiTimer += dt;
    if (this.uiTimer > 0.25) {
      this.uiTimer = 0;
      const snap = this.sim.curr;
      setUI({
        fps: Math.round(this.renderer.fps),
        simTime: snap?.time ?? getUI().simTime,
        vehicles: snap?.stats.vehicles ?? 0,
        stuck: snap?.stats.stuck ?? 0,
        removed: snap?.stats.removed ?? 0,
        completed: snap?.stats.completed ?? 0,
        meanTrip: snap?.stats.meanTrip ?? 0,
        goals: this.goalViews(snap),
        goalHold: this.goals.hold,
      });
      this.heatTimer += 0.25;
      if (getUI().overlay === 'congestion' && this.heatTimer >= 1) {
        this.heatTimer = 0;
        this.drawHeat();
      }
    }
  }

  dispose() {
    this.renderer.dispose();
    this.input.dispose();
    this.sim.terminate();
  }
}
