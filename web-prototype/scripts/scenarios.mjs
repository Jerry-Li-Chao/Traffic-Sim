// Smoke scenarios, one or more per implementation stage.
// Each `run(page, shot)` throws on failure and may return a short summary string.

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// Click at a world coordinate.
export async function clickWorld(page, x, y, opts = {}) {
  const s = await page.evaluate(([x, y]) => window.game.cam.worldToScreen(x, y), [x, y]);
  await page.mouse.move(s.x, s.y, { steps: 3 });
  await page.mouse.down(opts);
  await page.mouse.up(opts);
  await page.waitForTimeout(40);
}

export async function zoomTo(page, cx, cy, mpp) {
  await page.evaluate(([cx, cy, mpp]) => {
    const c = window.game.cam;
    c.cx = cx; c.cy = cy; c.mpp = mpp;
  }, [cx, cy, mpp]);
  await page.waitForTimeout(50);
}

export async function drawRoad(page, cls, pts, opts = {}) {
  // frame the road in the upper part of the screen (clear of the palette/toolbar)
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
  const mpp = Math.max((Math.max(...xs) - Math.min(...xs) + 60) / 1200, (Math.max(...ys) - Math.min(...ys) + 60) / 520, opts.mpp ?? 0.3);
  await zoomTo(page, mx, my - 85 * mpp, mpp);
  await page.evaluate(([cls, level, curve]) => {
    const { setUI } = window.__store;
    window.game.setTool('road');
    // scenarios click exact coordinates: no angle / guide snapping unless a test asks for it
    setUI({ roadClass: cls, level, curveMode: curve, snapAngle: false, snapGuides: false });
  }, [cls, opts.level ?? 0, !!opts.curve]);
  for (const [x, y] of pts) await clickWorld(page, x, y);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

export const scenarios = [
  {
    name: 'stage0-boot',
    async run(page, shot) {
      await page.waitForTimeout(800);
      await shot('boot');
      // camera zoom + pan respond
      const before = await page.evaluate(() => ({ ...window.game.renderer.cam }));
      await page.mouse.move(700, 450);
      await page.mouse.wheel(0, -600);
      await page.mouse.move(700, 450);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(600, 400, { steps: 5 });
      await page.mouse.up({ button: 'right' });
      const after = await page.evaluate(() => ({ ...window.game.renderer.cam }));
      assert(after.mpp < before.mpp, 'wheel should zoom in');
      assert(after.cx !== before.cx, 'right drag should pan');
      // sim worker ticks when running
      await page.evaluate(() => window.game.setRunning(true));
      await page.waitForTimeout(1500);
      const t = await page.evaluate(() => window.game.sim.curr?.time ?? 0);
      assert(t > 0.8, `sim time should advance (got ${t})`);
      const fps = await page.evaluate(() => window.game.renderer.fps);
      await shot('zoomed');
      return `sim t=${t.toFixed(1)}s fps≈${fps.toFixed(0)}`;
    },
  },
  {
    name: 'stage1-roads',
    async run(page, shot) {
      await zoomTo(page, 600, 420, 1.0);
      const base = await page.evaluate(() => window.game.world.segments.size);
      const count = () => page.evaluate((base) => ({ segs: window.game.world.segments.size - base, nodes: window.game.world.nodes.size, money: window.__store.getUI().money }), base);
      // straight avenue W-E (two clicks + chain)
      await drawRoad(page, 'avenue', [[250, 450], [600, 450], [950, 450]]);
      let c = await count();
      assert(c.segs === 2, `expected 2 segments, got ${c.segs}`);
      // crossing street N-S creates a junction
      await drawRoad(page, 'street', [[600, 200], [600, 700]]);
      c = await count();
      assert(c.segs === 4, `crossing should split into 4 segments, got ${c.segs}`);
      // bridge: level +1 road crossing the avenue, with ramps from ground nodes
      await drawRoad(page, 'street', [[800, 200], [800, 230]]);
      await drawRoad(page, 'street', [[800, 230], [800, 380], [800, 560]], { level: 1 });
      await drawRoad(page, 'street', [[800, 560], [800, 720]], { level: 0 });
      c = await count();
      const segsAfterBridge = c.segs;
      assert(segsAfterBridge === 8, `bridge should not split avenue (segs=${segsAfterBridge})`);
      // curved road
      await drawRoad(page, 'lane', [[300, 600], [380, 750], [500, 650]], { curve: true });
      c = await count();
      assert(c.segs === 9, `curve road should add one segment (segs=${c.segs})`);
      await shot('built');
      // bulldoze one section out of the middle of the curved road (leaving a stub each side), then undo
      await page.evaluate(() => window.game.setTool('bulldoze'));
      await clickWorld(page, 390, 687);
      c = await count();
      assert(c.segs === 10, `bulldoze should cut one section out of the curve (segs=${c.segs})`);
      await page.keyboard.press('Meta+z');
      await page.waitForTimeout(100);
      c = await count();
      assert(c.segs === 9, `undo should restore (segs=${c.segs})`);
      await zoomTo(page, 600, 450, 0.25);
      await shot('junction');
      await zoomTo(page, 800, 450, 0.3);
      await shot('bridge');
      return `segments=${c.segs} nodes=${c.nodes}`;
    },
  },
  {
    name: 'stage2-junctions',
    async run(page, shot) {
      await zoomTo(page, 600, 420, 1.0);
      await drawRoad(page, 'avenue', [[250, 450], [950, 450]]);
      await drawRoad(page, 'street', [[600, 250], [600, 700]]);
      await drawRoad(page, 'street', [[400, 450], [400, 650]]);
      const conns = await page.evaluate(() => [...window.game.connectors.values()].reduce((a, c) => a + c.length, 0));
      assert(conns > 12, `expected junction connectors, got ${conns}`);
      // lanes tool: select the north street arm, add a lane in each direction
      await page.evaluate(() => window.game.setTool('lanes'));
      await clickWorld(page, 600, 330);
      await page.waitForSelector('[data-testid=inspector]');
      const segId = await page.evaluate(() => window.__store.getUI().selection?.id);
      assert(segId, 'segment should be selected');
      await page.click('[data-testid=lanesF-plus]');
      await page.click('[data-testid=lanesB-plus]');
      let lanes = await page.evaluate((id) => { const s = window.game.world.segments.get(id); return [s.lanesF, s.lanesB]; }, segId);
      assert(lanes[0] === 2 && lanes[1] === 2, `lanes should be 2/2, got ${lanes}`);
      // make it one-way then reverse
      await page.click('[data-testid=oneway]');
      lanes = await page.evaluate((id) => { const s = window.game.world.segments.get(id); return [s.lanesF, s.lanesB]; }, segId);
      assert(lanes[1] === 0 && lanes[0] === 4, `one-way should be 4/0, got ${lanes}`);
      await page.click('[data-testid=reverse]');
      lanes = await page.evaluate((id) => { const s = window.game.world.segments.get(id); return [s.lanesF, s.lanesB]; }, segId);
      assert(lanes[0] === 0 && lanes[1] === 4, `reversed should be 0/4, got ${lanes}`);
      await page.keyboard.press('Meta+z');
      await page.keyboard.press('Meta+z');
      // upgrade tool: convert the south street to a boulevard
      await page.evaluate(() => { window.game.setTool('upgrade'); window.__store.setUI({ roadClass: 'boulevard' }); });
      await clickWorld(page, 600, 600);
      const cls = await page.evaluate(() => [...window.game.world.segments.values()].filter((s) => s.cls === 'boulevard').length);
      assert(cls === 1, `one boulevard expected, got ${cls}`);
      await page.evaluate(() => window.game.setTool('lanes'));
      await clickWorld(page, 600, 330);
      await zoomTo(page, 600, 450, 0.12);
      await shot('junction-close');
      await zoomTo(page, 520, 470, 0.35);
      await shot('junctions');
      return `connectors=${conns}`;
    },
  },
  {
    name: 'stage3-traffic',
    async run(page, shot) {
      await zoomTo(page, 700, 520, 1.1);
      // connect all five sandbox ports
      await drawRoad(page, 'avenue', [[40, 500], [700, 510], [1360, 520]]);
      await drawRoad(page, 'street', [[720, 960], [700, 510]]);
      await drawRoad(page, 'street', [[700, 510], [640, 40]]);
      await drawRoad(page, 'street', [[1060, 790], [1060, 516]]);
      const reach = await page.evaluate(() => window.game.simInput.ports.map((p) => p.spawnEdges.length + p.sinkEdges.length));
      assert(reach.every((n) => n >= 2), `every port should be connected: ${reach}`);
      await page.evaluate(() => { window.game.setSpeed(4); window.game.setRunning(true); });
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.game.sim.advance(120));
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => window.game.sim.curr.stats);
      assert(st.vehicles > 5, `vehicles should be driving (got ${st.vehicles})`);
      assert(st.completed > 0, `some trips should complete (got ${st.completed}, t=${st.time})`);
      await shot('overview');
      // inspect a vehicle: find one and click it
      const v = await page.evaluate(() => { const c = window.game.sim.curr; return { x: c.vehicles[0], y: c.vehicles[1], id: c.ids[0] }; });
      await page.evaluate(() => window.game.setSpeed(1));
      await page.evaluate(() => window.game.setRunning(false));
      await page.waitForTimeout(300);
      const v2 = await page.evaluate(() => { const c = window.game.sim.curr; return { x: c.vehicles[0], y: c.vehicles[1], id: c.ids[0] }; });
      await zoomTo(page, v2.x, v2.y, 0.15);
      await page.evaluate(() => window.game.setTool('inspect'));
      await clickWorld(page, v2.x, v2.y);
      await page.waitForTimeout(400);
      const sel = await page.evaluate(() => window.__store.getUI().selection);
      assert(sel && sel.kind === 'vehicle', `vehicle should be selected, got ${JSON.stringify(sel)}`);
      await shot('vehicle');
      await zoomTo(page, 700, 510, 0.3);
      await shot('junction');
      return `vehicles=${st.vehicles} completed=${st.completed} t=${st.time.toFixed(0)}s`;
    },
  },
  {
    name: 'stage4-control',
    async run(page, shot) {
      await drawRoad(page, 'avenue', [[40, 500], [700, 510], [1360, 520]]);
      await drawRoad(page, 'street', [[720, 960], [700, 510]]);
      await drawRoad(page, 'street', [[700, 510], [640, 40]]);
      await drawRoad(page, 'street', [[1060, 790], [1060, 517]]);
      // junction tool: signalise the main crossing
      await zoomTo(page, 700, 470, 0.3);
      await page.evaluate(() => window.game.setTool('junction'));
      await clickWorld(page, 700, 510);
      await page.waitForSelector('[data-testid=control-signal]');
      await page.click('[data-testid=control-signal]');
      const ctl = await page.evaluate(() => [...window.game.world.nodes.values()].find((n) => Math.hypot(n.x - 700, n.y - 510) < 2).control);
      assert(ctl === 'signal', `junction should be signalised, got ${ctl}`);
      await page.click('[data-testid=green-0-plus]');
      // roundabout at the station T-junction
      await zoomTo(page, 1060, 470, 0.4);
      await page.evaluate(() => window.game.setTool('roundabout'));
      await clickWorld(page, 1060, 517);
      const ring = await page.evaluate(() => [...window.game.world.segments.values()].filter((s) => s.roundabout).length);
      assert(ring >= 3, `roundabout should create ring segments, got ${ring}`);
      await page.evaluate(() => { window.game.setTool('inspect'); window.game.setRunning(true); });
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.game.sim.advance(240));
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => window.game.sim.curr.stats);
      assert(st.completed > 40, `trips should complete (got ${st.completed})`);
      assert(st.removed < 3, `no gridlock expected (removed ${st.removed})`);
      const sig = await page.evaluate(() => window.game.sim.curr.signals.length);
      assert(sig >= 12, `signal states should stream (got ${sig / 3} heads)`);
      await zoomTo(page, 700, 510, 0.18);
      await page.waitForTimeout(300);
      await shot('signals');
      await zoomTo(page, 1060, 517, 0.2);
      await page.waitForTimeout(300);
      await shot('roundabout');
      return `completed=${st.completed} vehicles=${st.vehicles} removed=${st.removed}`;
    },
  },
  {
    name: 'stage5-lanes',
    async run(page, shot) {
      await drawRoad(page, 'avenue', [[40, 500], [700, 510], [1360, 520]]);
      await drawRoad(page, 'avenue', [[720, 960], [700, 510]]);
      await drawRoad(page, 'street', [[700, 510], [640, 40]]);
      // open the lane editor on the main junction
      await zoomTo(page, 700, 480, 0.12);
      await page.evaluate(() => window.game.setTool('junction'));
      await clickWorld(page, 700, 510);
      await page.waitForSelector('[data-testid=edit-lanes]');
      await page.click('[data-testid=edit-lanes]');
      const markers = await page.evaluate(() => {
        const n = [...window.game.world.nodes.values()].find((n) => Math.hypot(n.x - 700, n.y - 510) < 2);
        return { node: n.id, list: window.__laneMarkers(n.id) };
      });
      assert(markers.list.length >= 10, `lane markers expected, got ${markers.list.length}`);
      const inc = markers.list.find((m) => m.incoming);
      const out = markers.list.find((m) => !m.incoming && m.seg !== inc.seg);
      const before = await page.evaluate((id) => window.game.connectors.get(id).length, markers.node);
      await clickWorld(page, inc.pos.x, inc.pos.y);
      await clickWorld(page, out.pos.x, out.pos.y);
      const after = await page.evaluate((id) => window.game.connectors.get(id).length, markers.node);
      assert(after !== before, `toggling a lane connection should change connectors (${before} -> ${after})`);
      await shot('lane-editor');
      await page.click('[data-testid=reset-lanes]');
      const reset = await page.evaluate((id) => window.game.connectors.get(id).length, markers.node);
      assert(reset === before, `reset should restore defaults (${reset} vs ${before})`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      // a highway bypass with ramps: a 2-lane one-way flyover from West to East (level +1)
      await drawRoad(page, 'highway', [[200, 500], [320, 700]], { curve: false });
      await drawRoad(page, 'highway', [[320, 700], [1000, 700]]);
      await drawRoad(page, 'highway', [[1000, 700], [1200, 520]]);
      await page.evaluate(() => { window.game.setTool('inspect'); window.game.setRunning(true); });
      await page.waitForTimeout(800);
      await page.evaluate(() => window.game.sim.advance(200));
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => window.game.sim.curr.stats);
      assert(st.completed > 30, `trips should complete (${st.completed})`);
      await zoomTo(page, 700, 600, 0.6);
      await page.waitForTimeout(300);
      await shot('bypass');
      return `connectors ${before}->${after}, completed=${st.completed}`;
    },
  },
  {
    name: 'stage6-levels',
    async run(page, shot) {
      await drawRoad(page, 'avenue', [[40, 500], [1360, 520]]);
      // street flies over the avenue: ground -> ramp up -> bridge -> ramp down -> ground
      await drawRoad(page, 'street', [[720, 960], [720, 780]]);
      await drawRoad(page, 'street', [[720, 780], [720, 640], [720, 380]], { level: 1 });
      await drawRoad(page, 'street', [[720, 380], [700, 240]], { level: 0 });
      await drawRoad(page, 'street', [[700, 240], [640, 40]], { level: 0 });
      const info = await page.evaluate(() => {
        const w = window.game.world;
        const junctionUnder = [...w.nodes.values()].some((n) => Math.abs(n.x - 720) < 6 && Math.abs(n.y - 513) < 8);
        const lv = [...w.nodes.values()].filter((n) => n.level === 1).length;
        return { junctionUnder, lv, segs: w.segments.size };
      });
      assert(!info.junctionUnder, 'the bridge must not create a junction with the avenue');
      assert(info.lv >= 2, `bridge nodes at level 1 expected (got ${info.lv})`);
      // station road dives into a tunnel under the avenue and comes up south of it
      await drawRoad(page, 'street', [[1060, 790], [1060, 640]]);
      await drawRoad(page, 'street', [[1060, 640], [1060, 420]], { level: -2 });
      await drawRoad(page, 'street', [[1060, 420], [1060, 340], [1060, 120]], { level: -2 });
      const tunnel = await page.evaluate(() => [...window.game.world.nodes.values()].filter((n) => n.level === -2).length);
      await page.evaluate(() => { window.game.setTool('inspect'); window.game.setRunning(true); });
      await page.waitForTimeout(800);
      await page.evaluate(() => window.game.sim.advance(240));
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => window.game.sim.curr.stats);
      assert(st.completed > 20, `trips should complete (${st.completed})`);
      await zoomTo(page, 720, 515, 0.22);
      await page.waitForTimeout(400);
      await shot('bridge');
      await zoomTo(page, 900, 520, 0.6);
      await page.waitForTimeout(400);
      await shot('overview');
      return `tunnelNodes=${tunnel} completed=${st.completed}`;
    },
  },
  {
    name: 'stage7-rail',
    async run(page, shot) {
      const rails = await page.evaluate(() => window.game.world.rails.length);
      assert(rails === 1, 'sandbox should have a railway');
      // avenue crosses the railway at grade -> level crossing
      await drawRoad(page, 'avenue', [[40, 500], [700, 510], [1360, 520]]);
      const crossings = await page.evaluate(() => window.game.simInput.rail.crossings.length);
      assert(crossings >= 2, `level crossing expected (got ${crossings} track crossings)`);
      await page.evaluate(() => { window.game.setTool('inspect'); window.game.setRunning(true); });
      await page.waitForTimeout(500);
      // run until a train is near the crossing (barriers closed)
      let closed = false;
      for (let i = 0; i < 40 && !closed; i++) {
        await page.evaluate(() => window.game.sim.advance(5));
        await page.waitForTimeout(150);
        closed = await page.evaluate(() => Array.from(window.game.sim.curr.crossings).some((c) => c === 1));
      }
      assert(closed, 'barriers should close for an approaching train');
      const trains = await page.evaluate(() => window.game.sim.curr.trainCount);
      assert(trains > 0, 'train cars should stream to the renderer');
      await page.evaluate(() => window.game.setRunning(false));
      await zoomTo(page, 1200, 515, 0.22);
      await page.waitForTimeout(400);
      await shot('crossing');
      await page.evaluate(() => window.game.setRunning(true));
      await page.evaluate(() => window.game.sim.advance(120));
      await page.waitForTimeout(1200);
      const st = await page.evaluate(() => window.game.sim.curr.stats);
      assert(st.completed > 10, `traffic should still flow across the tracks (${st.completed})`);
      await zoomTo(page, 1200, 515, 0.7);
      await page.waitForTimeout(300);
      await shot('overview');
      return `trainCars=${trains} completed=${st.completed}`;
    },
  },
  {
    name: 'stage8-campaign',
    menu: true,
    async run(page, shot) {
      await page.waitForSelector('[data-testid=menu]');
      await page.waitForTimeout(1500);
      await shot('menu');
      const cards = await page.locator('.level-card').count();
      assert(cards === 11, `11 campaign cards expected, got ${cards}`);
      const locked = await page.locator('.level-card:disabled').count();
      assert(locked === 10, `only the first site should be unlocked (locked=${locked})`);
      // play site 1 through the real UI: road tool + two clicks
      await page.click('[data-testid=level-c1-first-road]');
      await page.waitForSelector('[data-testid=tutorial]');
      await shot('site1');
      await page.evaluate(() => window.__store.setUI({ tutorial: null }));
      await drawRoad(page, 'street', [[40, 300], [860, 320]]);
      const money = await page.evaluate(() => window.__store.getUI().money);
      assert(money < 150000 && money > 0, `budget should be charged (${money})`);
      await page.click('[data-testid=play]');
      await page.waitForTimeout(500);
      // fast-forward until the site completes
      let won = false;
      for (let i = 0; i < 30 && !won; i++) {
        await page.evaluate(() => window.game.sim.advance(20));
        await page.waitForTimeout(250);
        won = await page.evaluate(() => window.__store.getUI().won);
      }
      assert(won, 'site 1 should complete');
      await page.waitForSelector('[data-testid=win]');
      await shot('win');
      // progress persisted -> site 2 unlocked after returning to the menu
      await page.click('text=Menu');
      await page.waitForSelector('[data-testid=menu]');
      const unlocked = await page.locator('[data-testid=level-c2-crossroads]').isEnabled();
      assert(unlocked, 'site 2 should unlock after completing site 1');
      // a site with a river and a heat map
      await page.evaluate(() => window.__play('c4-river'));
      await page.waitForTimeout(500);
      const blocked = await page.evaluate(() => window.__road('street', [[40, 400], [1160, 420]]));
      assert(blocked && blocked.includes('bridge'), `crossing the river at ground level must be refused (${blocked})`);
      await page.click('[data-testid=heatmap]');
      await page.waitForTimeout(300);
      await zoomTo(page, 600, 400, 0.9);
      await shot('river');
      return `cards=${cards} site1 won`;
    },
  },
  {
    name: 'stage9-polish',
    async run(page, shot) {
      // settings: toggle shadows + FPS, persisted
      await page.click('[data-testid=settings-btn]');
      await page.waitForSelector('[data-testid=settings]');
      await page.click('[data-testid=shadows]');
      const shadows = await page.evaluate(() => window.game.renderer.shadowsEnabled);
      assert(shadows === false, 'shadows should switch off');
      await shot('settings');
      await page.click('[data-testid=settings] button.primary');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('flowline.settings.v1')).shadows);
      assert(stored === false, 'settings should persist');
      // save slot round trip
      await page.evaluate(() => window.__road('avenue', [[40, 500], [1360, 520]]));
      const segs = await page.evaluate(() => window.game.world.segments.size);
      await page.click('[data-testid=saves-btn]');
      await page.fill('[data-testid=save-name]', 'Test network');
      await page.click('[data-testid=save-slot]');
      await page.click('[data-testid=saves] button:text-is("Close")');
      await page.evaluate(() => window.__road('street', [[720, 960], [700, 512]]));
      const more = await page.evaluate(() => window.game.world.segments.size);
      assert(more > segs, 'network should grow');
      await page.click('[data-testid=saves-btn]');
      await page.click('[data-testid="load-Test network"]');
      const restored = await page.evaluate(() => window.game.world.segments.size);
      assert(restored === segs, `loading the slot should restore the network (${restored} vs ${segs})`);
      // help + menu round trip keeps an autosave
      await page.evaluate(() => window.__store.setUI({ showHelp: true }));
      await shot('help');
      await page.evaluate(() => window.__store.setUI({ showHelp: false }));
      await page.click('[data-testid=menu-btn]');
      await page.waitForSelector('[data-testid=continue]');
      await page.click('[data-testid=continue]');
      await page.waitForTimeout(400);
      const resumed = await page.evaluate(() => window.game.world.segments.size);
      assert(resumed === segs, `continue should resume the autosave (${resumed} vs ${segs})`);
      return `segments=${segs}`;
    },
  },
  {
    name: 'precision-tools',
    async run(page, shot) {
      // guide lines: a road end's straight-ahead line catches the cursor
      await drawRoad(page, 'street', [[300, 300], [420, 300]]);
      await page.evaluate(() => { window.game.setTool('road'); window.__store.setUI({ roadClass: 'street', level: 0, snapGuides: true, snapAngle: true }); });
      await zoomTo(page, 480, 340, 0.25);
      await clickWorld(page, 450, 420);
      let e = await page.evaluate(() => window.game.cam.worldToScreen(520, 301.5));
      await page.mouse.move(e.x, e.y, { steps: 4 });
      await page.waitForTimeout(200);
      const g = await page.evaluate(() => ({ detail: window.__store.getUI().ghostInfo?.detail, end: window.game.tools.road.lastPlan?.proposal.end.pos }));
      assert(g.detail?.includes('on guide') && Math.abs(g.end.y - 300) < 0.01, `guide snap expected (${JSON.stringify(g)})`);
      await shot('guide');
      // angle snapping: branch square off the road
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.evaluate(() => { window.game.setTool('road'); window.__store.setUI({ snapGuides: false, snapAngle: true }); });
      await clickWorld(page, 360, 300);
      e = await page.evaluate(() => window.game.cam.worldToScreen(362, 380));
      await page.mouse.move(e.x, e.y, { steps: 4 });
      await page.waitForTimeout(200);
      const a = await page.evaluate(() => ({ detail: window.__store.getUI().ghostInfo?.detail, end: window.game.tools.road.lastPlan?.proposal.end.pos }));
      assert(a.detail?.includes('square to road') && Math.abs(a.end.x - 360) < 0.01, `angle snap expected (${JSON.stringify(a)})`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      // roundabout on a bridge over an avenue
      await drawRoad(page, 'avenue', [[40, 700], [1360, 700]]);
      await drawRoad(page, 'street', [[900, 980], [900, 860]]);
      await drawRoad(page, 'street', [[900, 860], [900, 760], [900, 640]], { level: 1 });
      await drawRoad(page, 'street', [[900, 640], [900, 540], [900, 420]], { level: 0 });
      await zoomTo(page, 900, 700, 0.25);
      await page.evaluate(() => window.game.setTool('roundabout'));
      e = await page.evaluate(() => window.game.cam.worldToScreen(900, 700));
      await page.mouse.move(e.x - 4, e.y);
      await page.mouse.move(e.x, e.y, { steps: 2 });
      await page.waitForTimeout(200);
      const hover = await page.evaluate(() => window.__store.getUI().ghostInfo?.reason ?? '');
      assert(hover.startsWith('Bridge'), `roundabout should target the bridge (${hover})`);
      await shot('roundabout-bridge-hover');
      await clickWorld(page, 900, 700);
      const ring = await page.evaluate(() => [...window.game.world.segments.values()].filter((s) => s.roundabout).map((s) => window.game.world.node(s.a).level));
      assert(ring.length >= 4 && ring.every((l) => l === 1), `ring at bridge level expected (${ring})`);
      return `ring=${ring.length} at level 1`;
    },
  },
  {
    name: 'help-settings-reset',
    async run(page, shot) {
      // how to play: every tab renders
      await page.evaluate(() => window.__store.setUI({ showHelp: true }));
      for (const t of ['goal', 'tools', 'building', 'controls']) {
        await page.click(`[data-testid=help-tab-${t}]`);
        await page.waitForTimeout(100);
        await shot(`help-${t}`);
      }
      await page.evaluate(() => window.__store.setUI({ showHelp: false }));
      // settings: styled switches still drive the settings
      await page.click('[data-testid=settings-btn]');
      await shot('settings');
      await page.click('[data-testid=mute]');
      const muted = await page.evaluate(() => JSON.parse(localStorage.getItem('flowline.settings.v1')).muted);
      assert(muted === true, 'mute switch should save');
      await page.click('[data-testid=mute]');
      await page.click('[data-testid=settings] button:text-is("Done")');
      // reset site: back to the start, and undo brings the network back
      const def = await page.evaluate(async () => {
        const { CAMPAIGN } = await import('/src/levels/campaign.ts');
        const d = CAMPAIGN[0];
        window.game.play(d, false);
        return { budget: d.budget };
      });
      const start = await page.evaluate(() => ({ segs: window.game.world.segments.size, money: window.__store.getUI().money }));
      await page.evaluate(() => window.__store.setUI({ tutorial: null }));
      // lay a short street somewhere open on the site
      await page.evaluate(() => {
        const { width, height } = window.game.map;
        for (const f of [0.3, 0.5, 0.7]) {
          for (const g of [0.3, 0.5, 0.7]) {
            const n = window.game.world.segments.size;
            window.__road('lane', [[width * f, height * g], [width * f + 60, height * g + 10]]);
            if (window.game.world.segments.size > n) return;
          }
        }
      });
      const built = await page.evaluate(() => ({ segs: window.game.world.segments.size, money: window.__store.getUI().money }));
      assert(built.segs > start.segs && built.money < start.money, `a road should be built (${JSON.stringify(built)})`);
      await page.click('[data-testid=reset-site-btn]');
      await shot('reset-confirm');
      await page.click('[data-testid=reset-site-confirm]');
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ segs: window.game.world.segments.size, money: window.__store.getUI().money }));
      assert(after.segs === start.segs && after.money === def.budget, `reset should restore the start (${JSON.stringify(after)} vs ${JSON.stringify(start)})`);
      await page.evaluate(() => window.game.undo());
      const back = await page.evaluate(() => ({ segs: window.game.world.segments.size, money: window.__store.getUI().money }));
      assert(back.segs === built.segs && back.money === built.money, 'undo should bring the network back');
      return `start=${start.segs} built=${built.segs} reset=${after.segs}`;
    },
  },
  {
    name: 'bulldoze-sweep',
    async run(page, shot) {
      await drawRoad(page, 'street', [[200, 300], [900, 300]]);
      const before = await page.evaluate(() => ({ segs: window.game.world.segments.size, len: [...window.game.world.segments.values()].reduce((a, s) => a + window.game.world.poly(s).length, 0) }));
      await zoomTo(page, 550, 300, 0.6);
      await page.evaluate(() => window.game.setTool('bulldoze'));
      // a single click removes one ~50 m section, not the whole road
      await clickWorld(page, 300, 300);
      const one = await page.evaluate(() => [...window.game.world.segments.values()].reduce((a, s) => a + window.game.world.poly(s).length, 0));
      assert(before.len - one > 30 && before.len - one < 80, `one section expected (${before.len} -> ${one})`);
      // hold and sweep along the road: everything touched goes, in one undo step
      const a = await page.evaluate(() => window.game.cam.worldToScreen(450, 300));
      const b = await page.evaluate(() => window.game.cam.worldToScreen(800, 300));
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      const cursor = await page.evaluate(() => document.querySelector('[data-testid=view]').style.cursor);
      assert(cursor.includes('data:image/svg'), `bulldozer cursor expected while held (${cursor.slice(0, 40)})`);
      await page.mouse.move(b.x, b.y, { steps: 12 });
      await page.mouse.up();
      const swept = await page.evaluate(() => [...window.game.world.segments.values()].reduce((a, s) => a + window.game.world.poly(s).length, 0));
      assert(one - swept > 300, `the sweep should clear ~350 m (${one} -> ${swept})`);
      const cursorAfter = await page.evaluate(() => document.querySelector('[data-testid=view]').style.cursor);
      assert(cursorAfter === 'crosshair', 'cursor back to crosshair after release');
      await shot('after-sweep');
      await page.evaluate(() => window.game.undo());
      const undone = await page.evaluate(() => [...window.game.world.segments.values()].reduce((a, s) => a + window.game.world.poly(s).length, 0));
      assert(Math.abs(undone - one) < 1, `one undo should restore the whole sweep (${undone} vs ${one})`);
      await page.screenshot({ path: '.smoke/bulldoze-sweep-topleft.png', clip: { x: 0, y: 0, width: 460, height: 80 } });
      return `section=${Math.round(before.len - one)} m, sweep=${Math.round(one - swept)} m`;
    },
  },
  {
    name: 'templates-layout',
    async run(page, shot) {
      const play = (id) =>
        page.evaluate(async (id) => {
          const { CAMPAIGN } = await import('/src/levels/campaign.ts');
          window.game.play(CAMPAIGN.find((l) => l.id === id), false);
          window.__store.setUI({ tutorial: null });
        }, id);
      // layout: the site from the bug report, road tool open (palette + goals + options)
      const twin = await page.evaluate(async () => (await import('/src/levels/campaign.ts')).CAMPAIGN.find((l) => l.name === 'Twin Towns').id);
      await play(twin);
      await page.evaluate(() => window.game.setTool('road'));
      await page.waitForTimeout(300);
      const overlap = await page.evaluate(() => {
        const r = (q) => document.querySelector(q)?.getBoundingClientRect();
        const a = r('[data-testid=goals]'), b = r('[data-testid=palette]');
        return a && b ? !(a.bottom <= b.top || a.right <= b.left || b.right <= a.left) : false;
      });
      assert(!overlap, 'goals panel and road palette must not overlap');
      await shot('twin-towns');
      // a cutting, for its shadow
      await play('c6-highway-exit');
      await page.evaluate(() => window.__store.setUI({ unlimited: true }));
      await drawRoad(page, 'street', [[300, 900], [300, 800]]);
      await drawRoad(page, 'street', [[300, 800], [300, 700], [300, 300]], { level: -1 });
      await zoomTo(page, 300, 650, 0.12);
      await page.waitForTimeout(300);
      await shot('cutting');
      // templates: a diamond on the A1
      await page.evaluate(() => window.game.setTool('templates'));
      await page.click('[data-testid=template-diamond]');
      await zoomTo(page, 800, 500, 0.9);
      const at = await page.evaluate(() => window.game.cam.worldToScreen(820, 505));
      await page.mouse.move(at.x - 5, at.y);
      await page.mouse.move(at.x, at.y, { steps: 2 });
      await page.waitForTimeout(300);
      const ghost = await page.evaluate(() => window.__store.getUI().ghostInfo);
      assert(ghost?.valid, `diamond should fit the A1 (${ghost?.reason})`);
      await shot('diamond-preview');
      const before = await page.evaluate(() => window.game.world.segments.size);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({ segs: window.game.world.segments.size, ramps: [...window.game.world.segments.values()].filter((s) => s.cls === 'ramp').length }));
      assert(after.ramps >= 4 && after.segs > before, `diamond should be built (${JSON.stringify(after)})`);
      await page.mouse.move(10, 10);
      await zoomTo(page, 800, 500, 0.5);
      await shot('diamond-built');
      // a street template on the sandbox
      await page.evaluate(() => window.__play('sandbox'));
      await page.evaluate(() => { window.game.setTool('templates'); window.__store.setUI({ templateId: 'signal-cross' }); });
      await zoomTo(page, 600, 600, 0.5);
      const c = await page.evaluate(() => window.game.cam.worldToScreen(600, 600));
      await page.mouse.move(c.x, c.y, { steps: 2 });
      await page.keyboard.press('q');
      await page.waitForTimeout(200);
      await shot('templates-palette');
      await page.mouse.down();
      await page.mouse.up();
      const sig = await page.evaluate(() => [...window.game.world.nodes.values()].filter((n) => n.control === 'signal').length);
      assert(sig === 1, `signalised crossing expected (${sig})`);
      return `diamond ramps=${after.ramps}, signals=${sig}`;
    },
  },
  {
    name: 'houses-standalone',
    async run(page, shot) {
      // houses along a street
      await drawRoad(page, 'street', [[200, 880], [900, 880]]);
      await page.evaluate(() => window.game.setTool('houses'));
      await zoomTo(page, 420, 860, 0.3);
      const reasons = [];
      for (const [x, y] of [[300, 905], [380, 855], [460, 905], [540, 855]]) {
        const s = await page.evaluate(([x, y]) => window.game.cam.worldToScreen(x, y), [x, y]);
        await page.mouse.move(s.x, s.y, { steps: 2 });
        reasons.push(await page.evaluate(() => window.__store.getUI().ghostInfo?.reason));
        await clickWorld(page, x, y);
      }
      const houses = await page.evaluate(() => [...window.game.world.nodes.values()].filter((n) => n.house).length);
      assert(houses === 4, `four houses expected (${houses}): ${JSON.stringify(reasons)} rails=${JSON.stringify(await page.evaluate(() => window.game.world.rails.map((r) => r.pts)))}`);
      await page.mouse.move(620, 450);
      await shot('houses');
      await page.evaluate(() => { window.game.setTool('inspect'); window.game.setRunning(true); });
      await page.evaluate(() => window.game.sim.advance(240));
      await page.waitForTimeout(800);
      const st = await page.evaluate(() => window.game.sim.curr.stats);
      assert(st.removed === 0, 'no stuck cars');
      // bulldoze one house
      await page.evaluate(() => window.game.setTool('bulldoze'));
      const hc = await page.evaluate(() => {
        const n = [...window.game.world.nodes.values()].find((n) => n.house);
        return { x: n.x + Math.cos(n.house.angle) * 6, y: n.y + Math.sin(n.house.angle) * 6 };
      });
      await clickWorld(page, hc.x, hc.y);
      const left = await page.evaluate(() => [...window.game.world.nodes.values()].filter((n) => n.house).length);
      assert(left === 3, `bulldozing a house should remove it (${left})`);
      // a highway interchange on open ground brings its own highway
      await page.evaluate(() => { window.game.setTool('templates'); window.__store.setUI({ templateId: 'diamond' }); });
      await zoomTo(page, 700, 400, 0.9);
      const c = await page.evaluate(() => window.game.cam.worldToScreen(700, 400));
      await page.mouse.move(c.x - 4, c.y);
      await page.mouse.move(c.x, c.y, { steps: 2 });
      await page.waitForTimeout(200);
      const g = await page.evaluate(() => window.__store.getUI().ghostInfo);
      assert(g?.valid, `diamond should place on open ground (${g?.reason})`);
      await page.mouse.down();
      await page.mouse.up();
      const hw = await page.evaluate(() => [...window.game.world.segments.values()].filter((s) => s.cls === 'highway').length);
      assert(hw >= 4, `own highway expected (${hw})`);
      await page.mouse.move(10, 10);
      await shot('standalone-diamond');
      await page.evaluate(() => window.game.setTool('road'));
      await page.waitForTimeout(200);
      await shot('road-options');
      return `houses=${houses}, highway pieces=${hw}`;
    },
  },
  {
    name: 'pathfinder-defaults',
    async run(page, shot) {
      // two streets crossing, and a street crossing an avenue
      await drawRoad(page, 'avenue', [[40, 500], [700, 510], [1360, 520]]);
      await drawRoad(page, 'street', [[720, 960], [700, 510]]);
      await drawRoad(page, 'street', [[700, 510], [640, 40]]);
      await drawRoad(page, 'street', [[300, 800], [1000, 800]]);
      const ctl = await page.evaluate(() => {
        const w = window.game.world;
        const near = (x, y) => [...w.nodes.values()].filter((n) => w.degree(n.id) >= 4).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
        return { avenue: near(700, 510)?.control, streets: near(710, 800)?.control };
      });
      assert(ctl.avenue === 'signal' && ctl.streets === 'allstop', `default controls (${JSON.stringify(ctl)})`);
      await page.evaluate(() => { window.game.setTool('inspect'); window.game.setRunning(true); });
      await page.evaluate(() => window.game.sim.advance(60));
      await page.waitForTimeout(600);
      // click a car: its whole route and status
      const v = await page.evaluate(() => {
        const c = window.game.sim.curr;
        return { id: c.ids[0], x: c.vehicles[0], y: c.vehicles[1] };
      });
      await page.evaluate((id) => window.game.select({ kind: 'vehicle', id }), v.id);
      await zoomTo(page, v.x, v.y, 0.8);
      await page.waitForTimeout(800);
      const status = await page.textContent('[data-testid=vehicle-status]');
      assert(status && status.length > 3, 'vehicle status shown');
      await shot('vehicle-route');
      return `controls ok, status="${status}"`;
    },
  },
  {
    name: 'trackpad-escape',
    async run(page, shot) {
      const cam = () => page.evaluate(() => ({ cx: window.game.cam.cx, cy: window.game.cam.cy, mpp: window.game.cam.mpp }));
      const wheel = (init) =>
        page.evaluate((init) => {
          const el = document.querySelector('[data-testid=view]');
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + 500, clientY: r.top + 400, bubbles: true, cancelable: true, ...init }));
        }, init);
      // two-finger swipe pans (no zoom)
      let a = await cam();
      await wheel({ deltaX: 40, deltaY: 30, deltaMode: 0 });
      let b = await cam();
      assert(Math.abs(b.mpp - a.mpp) < 1e-9 && (b.cx !== a.cx || b.cy !== a.cy), `swipe should pan (${JSON.stringify([a, b])})`);
      // pinch zooms
      a = b;
      await wheel({ deltaY: -20, ctrlKey: true, deltaMode: 0 });
      b = await cam();
      assert(b.mpp < a.mpp, 'pinch should zoom in');
      // a mouse wheel (line mode) zooms too
      a = b;
      await wheel({ deltaY: 3, deltaMode: 1 });
      b = await cam();
      assert(b.mpp > a.mpp, 'mouse wheel should zoom out');

      // follow a car, then drag the map: still following it
      await drawRoad(page, 'avenue', [[40, 500], [700, 510], [1360, 520]]);
      await page.evaluate(() => { window.game.setTool('inspect'); window.game.setRunning(true); });
      await page.evaluate(() => window.game.sim.advance(40));
      await page.waitForTimeout(500);
      const id = await page.evaluate(() => window.game.sim.curr.ids[0]);
      await page.evaluate((id) => window.game.select({ kind: 'vehicle', id }), id);
      await page.mouse.move(400, 600);
      await page.mouse.down();
      await page.mouse.move(250, 450, { steps: 6 });
      await page.mouse.up();
      const sel = await page.evaluate(() => window.__store.getUI().selection);
      assert(sel?.kind === 'vehicle' && sel.id === id, `dragging the map keeps the vehicle view (${JSON.stringify(sel)})`);

      // Esc: closes a dialog first, then cancels a half-drawn road, then returns to Inspect
      await page.evaluate(() => { window.__store.setUI({ showHelp: true }); window.game.setTool('road'); });
      await page.keyboard.press('Escape');
      let ui = await page.evaluate(() => ({ help: window.__store.getUI().showHelp, tool: window.__store.getUI().tool }));
      assert(!ui.help && ui.tool === 'road', `Esc closes the dialog first (${JSON.stringify(ui)})`);
      await zoomTo(page, 600, 700, 0.5);
      await clickWorld(page, 300, 700);
      const started = await page.evaluate(() => !!window.game.tools.road.start);
      assert(started, 'road started');
      await page.keyboard.press('Escape');
      ui = await page.evaluate(() => ({ start: !!window.game.tools.road.start, tool: window.__store.getUI().tool }));
      assert(!ui.start && ui.tool === 'road', `Esc cancels the road being drawn (${JSON.stringify(ui)})`);
      await page.keyboard.press('Escape');
      ui = await page.evaluate(() => ({ tool: window.__store.getUI().tool }));
      assert(ui.tool === 'inspect', `Esc returns to Inspect (${JSON.stringify(ui)})`);
      for (const t of ['bulldoze', 'templates', 'houses', 'roundabout', 'upgrade']) {
        await page.evaluate((t) => window.game.setTool(t), t);
        await page.keyboard.press('Escape');
        const now = await page.evaluate(() => window.__store.getUI().tool);
        assert(now === 'inspect', `Esc from ${t} returns to Inspect (${now})`);
      }
      return 'swipe pans, pinch/wheel zoom, drag keeps the car, Esc steps back';
    },
  },
  {
    name: 'big-maps-river',
    async run(page, shot) {
      // the Sandbox button opens a choice of maps
      await page.evaluate(() => window.game.toMenu());
      await page.locator('[data-testid=sandbox]').click();
      const maps = await page.locator('[data-testid^=map-]').count();
      assert(maps === 3, `three sandbox maps expected, got ${maps}`);
      await page.locator('[data-testid=map-sandbox-river]').click();
      await page.waitForTimeout(800);
      const info = await page.evaluate(() => ({
        id: window.game.level.id,
        w: window.game.map.width,
        water: window.game.world.obstacles.filter((o) => o.kind === 'water').length,
        plates: window.game.portLayer.group.children.filter((c) => c.geometry?.type === 'PlaneGeometry' && c.renderOrder === 40).length,
        rows: window.__store.getUI().goals?.map((g) => g.name) ?? [],
      }));
      assert(info.id === 'sandbox-river' && info.w === 3600 && info.water === 1, `river sandbox loaded (${JSON.stringify(info)})`);
      assert(info.plates === 8, `one plate per town (${info.plates})`);
      await page.evaluate(() => window.game.setRunning(true));
      await page.waitForFunction(() => window.__store.getUI().goals?.some((g) => g.name === 'Holme'), null, { timeout: 15000 });
      const rows = await page.evaluate(() => window.__store.getUI().goals.map((g) => g.name));
      assert(new Set(rows).size === rows.length && rows.includes('Holme'), `traffic panel lists each town once (${rows})`);
      await page.evaluate(() => window.game.setRunning(false));
      await zoomTo(page, 1800, 1200, 0.5);
      await page.waitForTimeout(400);
      await shot('river-sandbox-water');

      // Four Shores: highways cross only on different levels
      await page.evaluate(() => window.__play('c11-four-shores'));
      await page.waitForTimeout(600);
      const flat = await page.evaluate(() => window.__road('ramp', [[1000, 1150], [1000, 1400]], 0));
      assert(/bridge or in a tunnel/.test(flat), `at-grade highway crossing refused (${flat})`);
      const raised = await page.evaluate(() => window.__road('ramp', [[1000, 1150], [1000, 1400]], 1));
      assert(raised === 'ok', `bridge over the highways allowed (${raised})`);
      return `maps=${maps}, plates=${info.plates}, rows=${rows.length}`;
    },
  },
];
