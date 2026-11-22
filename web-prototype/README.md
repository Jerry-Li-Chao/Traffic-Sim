# Flowline

A road-network traffic puzzle in the spirit of *Highways & Co.*: build roads, junctions and interchanges, open them to traffic, find the bottleneck, fix it. Every vehicle has its own route and driving behaviour, and the simulation is deterministic.

## Run it

```bash
npm install
npm run dev          # http://localhost:5174
```

## Build and test

```bash
npm test             # unit + simulation + campaign-solvability tests (vitest)
npm run e2e          # headless browser smoke tests for every stage (playwright)
npm run build        # typecheck + production bundle in dist/
npm run desktop      # build, then launch the Electron desktop app
npm run dist:mac     # unpacked macOS app (electron-builder; also dist:win / dist:linux)
```

electron-builder refuses output paths containing shell-special characters such as `&`. Because this project
lives in `Highways & Co.`, point the release folder somewhere else when packaging:

```bash
FLOWLINE_RELEASE_DIR=$HOME/flowline-release npm run dist:mac
```

Steam achievements (`SITE_1` … `SITE_10`) activate only when `steamworks.js` is installed and
`FLOWLINE_STEAM_APP_ID` is set.

`npm run e2e` needs Playwright's Chromium once: `npx playwright install chromium`.

## How to play

- Every site has entries and destinations, marked by coloured name plates beside the road (a town with separate in and out carriageways gets one plate). Keep each destination at or above its target flow (vehicles/min) until the completion bar fills.
- **Sandbox** offers three maps: Valley (1.4 × 1 km), River (3.6 × 2.4 km, highway towns on both banks of a river) and Plains (4 × 2.8 km, motorways from every side and a main line).
- Site 11, **Four Shores**, is a grade-separation puzzle: four highway towns on two banks of a river, highway classes only, and highways may only cross on a bridge or in a tunnel, so every cross-river movement needs ramps that loop or fly over.
- Tools: **1** Inspect · **2** Road · **3** Upgrade · **4** Lanes · **5** Junction · **6** Roundabout · **7** Bulldoze · **8** Templates · **9** Houses.
- Houses: build beside a street; each sends and receives a little local traffic (at most two cars out and two in at a time), which doesn't count towards site goals.
- Templates: diamond and dumbbell interchanges that join a dual-carriageway highway (or bring their own), plus a signalised avenue crossing, a large roundabout, a one-way pair and a street grid (**Q / E** to turn).
- **C** curved roads · **[ ]** height level (tunnel → cutting → ground → bridge → viaducts) · **G** grid snap · **Shift** force 15° angles.
- Bulldoze removes roads a ~50 m section at a time; hold and drag to sweep away everything you touch (one undo per sweep).
- Precision aids in the Road tool: Angle / Length / Grid / Guide snapping toggles, and a live read-out of length, bearing, turn angle, grade and height.
- Roundabouts follow the height of the road under the cursor (drop one on a bridge for a two-level interchange); **L** switches level where roads are stacked.
- **Space** opens the site to traffic or pauses it · **⌘Z / ⇧⌘Z** undo/redo · pan with a two-finger trackpad swipe, a drag, or **WASD** · zoom with a pinch or the mouse wheel · **Esc** closes a dialog, cancels the current step, or returns to Inspect.
- The Junction tool sets priority roads, stop signs, all-way stops and signals (with per-phase green times), and edits individual lane connections.
- The **Heat map** colours lanes by speed so you can find the slow spots. Click a vehicle to trace its whole route to its destination (red when it has none), see what it is waiting for, or remove it.
- New crossings get sensible controls automatically: signals where an avenue (4+ lanes) crosses another road, an all-way stop where two-lane roads cross; T-junctions keep give-way priority. A control you pick yourself is never overridden.

## Architecture

| Path | What lives there |
|---|---|
| `src/core` | Vector/Bézier/polyline maths, seeded PRNG |
| `src/world` | Editable network (nodes + Bézier segments), road classes, height levels, junction geometry, lane connectors, control (priority/signals/conflicts), rail, roundabouts, compiler to the sim lane graph |
| `src/sim` | Deterministic simulation in a Web Worker: IDM car following, MOBIL lane changes, cost-to-go routing with congestion feedback, gap acceptance, conflict reservations, signals, trains and level crossings |
| `src/render` | Three.js top-down orthographic renderer: terrain, animated water, trees, road meshes and markings, bridges/cuttings/tunnels, instanced vehicles and trains, signals, overlays |
| `src/tools` | Road, upgrade, lanes, junction (incl. lane editor), roundabout and bulldoze tools |
| `src/game` | Game orchestration, undo/redo, goals, progress/autosave, audio |
| `src/levels` | Three sandbox maps, the 11-site campaign and a river-outline helper |
| `tests` | Unit and behaviour tests, including scripted reference solutions proving every campaign site is solvable |
| `electron` | Desktop shell (optional Steam achievements via steamworks.js) |
