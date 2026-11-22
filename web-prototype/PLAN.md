# Traffic Sim Replica: Design & Implementation Plan

A replica of *Highways & Co.*, a road-network traffic puzzle and sim. The player builds roads,
junctions and interchanges between fixed entry points and destinations, then opens them to
traffic. Every vehicle follows its own route and driving behaviour, and the player watches for
congestion and fixes the layout. We use our own name and art in place of the original's branding
and assets.

---

## 1. What we are replicating

These features come from the Steam page, the official site's screenshots and press previews.

| Area | Target behaviour |
|---|---|
| **View** | Top-down orthographic "2.5D", stylized. Grassy terrain with scattered trees and soft drop shadows. Roads are dark asphalt with painted markings. Buildings are left out; destinations appear as coloured signboards. |
| **Road types** | Ten classes in three palette groups (Street / Avenue / Highway): country lane, 2-lane street, avenues with a median, up to a 4-lane motorway. Each has a speed limit, width and **price per metre**. |
| **Lanes** | Lane count set **independently per direction** (e.g. 3+2). One-way roads. A road can be upgraded, widened or reclassed **in place** without rebuilding it. |
| **Geometry** | Smooth curves for ramps and slip roads. Snapping to existing roads and nodes, and angle snapping. |
| **Junctions** | Auto-generated junctions, plus **signals**, **give-way/stop** priority, **roundabouts**, **channelized slip roads**, and a lane-connection editor. |
| **Height** | **7 height levels**: tunnel / cutting / ground / bridges / viaducts. Roads at different levels cross without connecting. |
| **Rail** | Railways with trains. Roads cross them by an expensive bridge or a cheap **level crossing** with barriers. |
| **Traffic** | Per-vehicle routes, car-following, merging, lane changes and queuing. The simulation is **deterministic**. |
| **Goals** | Hand-crafted campaign "sites". Each destination has a **minimum traffic threshold**. You win by sustaining the required flow within budget without gridlock. |
| **Loop** | Build → open to traffic → find the problem → fix it → repeat. Play, pause and speed controls. |

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript (strict)** | One language for sim, renderer and UI. The original ships on WebGL 2.0, which suggests a web-tech stack, so this route is proven for this game. |
| Build | **Vite** | Fast HMR and first-class Web Worker support. |
| Rendering | **Three.js (WebGL2)** with an **orthographic top-down camera** | A real depth buffer handles the 7 height levels, overpasses and tunnels correctly. `InstancedMesh` draws 10k+ vehicles and trees in a few draw calls. Shadow maps give bridges and cars soft shadows for free. Plain 2D (PixiJS) would need hand-managed layer sorting for stacked interchanges. |
| Simulation | **Pure TS in a Web Worker**, struct-of-arrays (`Float32Array`) | Keeps the UI at 60 fps while the sim runs fixed-step. A pure module with no DOM or Three imports is unit-testable and deterministic. |
| UI / HUD | **React + Zustand** | The build palette, inspector panels, level select and stats are ordinary UI work. Zustand bridges game state to React without re-rendering the canvas. |
| Geometry helpers | `clipper2-js` (polygon offset/union for junction shapes), `earcut` (triangulation), `rbush` (spatial index for snapping and picking) | These are mature, small libraries. |
| Determinism | Seeded PRNG (`mulberry32`), fixed `dt = 1/20 s`, stable iteration order, no `Math.random` and no wall-clock time in the sim | The same build and inputs give the same result, which allows replays and regression tests. |
| Testing | **Vitest** (sim and geometry unit tests, golden-replay determinism tests) + **Playwright** (smoke tests) | |
| Desktop | Web build first. Later **Electron + steamworks.js** for a Steam-style desktop release (Win/macOS/Linux). | Electron is the most mature path for Steam integration. Tauri is an option if bundle size matters. |
| Persistence | JSON save files (versioned schema), IndexedDB in the browser, the filesystem in Electron | |

**Performance budget:** 5,000 vehicles at 60 fps render, with the sim at 20 Hz in a worker. Each
tick the worker posts a transferable `Float32Array` of `[x, y, z, heading]`. The renderer
interpolates between the last two snapshots.

---

## 3. Architecture

```
src/
  core/            # shared, pure: math (vec2, bezier, arc-length LUT), PRNG, ids, types
  world/           # road network model (editable): nodes, segments, road classes, levels
    geometry/      # centreline curves, lane offsets, junction polygon & connector generation
  sim/             # runs in worker; NO DOM / Three imports
    lanegraph.ts   # compiled from world: lanes + junction connectors as a directed graph
    routing.ts     # A*/Dijkstra on lane graph, congestion-weighted costs
    vehicles.ts    # SoA vehicle store, IDM car-following, MOBIL lane changes
    junctions.ts   # conflict points, give-way gap acceptance, signals, roundabouts
    demand.ts      # spawners at map-edge entries, OD matrix -> destinations
    rail.ts        # trains + level crossing state machines
    stats.ts       # per-destination throughput, per-segment speed/density
    worker.ts      # message protocol, fixed-step loop
  render/          # Three.js: terrain, road meshes, markings, instanced vehicles/trees, overlays
  tools/           # input-driven editing tools: road draw, upgrade, delete, lane editor, signals
  game/            # levels/campaign, budget, win/lose evaluation, save/load
  ui/              # React HUD: palette, height picker, sim controls, inspector, menus
levels/            # hand-authored site JSON
```

**Data flow:** the main thread owns the editable `World`. When an edit is committed, the world
diff is recompiled into a `LaneGraph` and sent to the worker. Vehicles on the changed segments are
rerouted or removed. The worker sends back vehicle and train snapshots plus stats. All edits go
through a **command pattern**, which gives undo/redo and replays for free.

### Key models

- **Road network:** `Node { pos, level }` and `Segment { a, b, curve (cubic Bézier), class, lanesFwd, lanesBwd, level(s) }`.
  A segment's curve gets an arc-length lookup table. Lane `i` is the centreline offset by `(i + 0.5) * laneWidth`.
- **Junctions:** generated at every node with three or more segments, or at a class change. The
  steps are: trim the segments back to where their edges clear one another, build the junction
  polygon (clipper union), then generate **lane connectors** (Bézier curves from each incoming lane
  to the allowed outgoing lanes) using default turn rules. The player can override connectors.
- **Vehicle model:**
  - **IDM** handles longitudinal motion (desired speed, safe time gap, comfortable braking).
  - **MOBIL** handles lane changes, and also forced lane changes so a vehicle reaches the lane its route needs before a junction. Those decisions are look-ahead driven.
  - Each vehicle's route is a list of lane-graph edges. It is recomputed when the network changes, or when a vehicle is stuck for more than N seconds.
- **Junction control:** each pair of crossing connectors defines a **conflict point**.
  - *Give-way:* a vehicle may enter only if the time gap to priority traffic at every conflict point is at least the critical gap.
  - *Signals:* phase plans with green, amber and clearance times.
  - *Roundabouts:* circulating traffic has priority, and entries are give-way.
  - *Deadlock guard:* "don't block the box". A vehicle doesn't enter a junction unless the exit has space.
- **Height:**
  - Levels run from −2 to +4, with 0 as ground: −2 tunnel, −1 cutting, 0 ground, +1…+4 bridges and viaducts.
  - Grade changes are limited to a maximum slope, so a ramp needs a minimum length.
  - Segments only connect at the same level. Crossings at different levels are ignored by junction generation.
  - Elevated sections get piers, and tunnels get portals.
  - Cost multiplier per level away from ground.
- **Level / site:** map size, terrain, seed, budget, entry points (with their own spawn rates),
  destinations (signboard, colour, `minFlowPerMin`), pre-built roads and rail, and locked areas.

---

## 4. Staged implementation

Each stage ends with something playable or visible, and the sim stages add tests.

### Stage 0: Foundation
- Vite + TS + React + Three scaffold, ESLint/Prettier, Vitest.
- Orthographic camera with pan (drag/WASD), zoom (wheel) and bounds. Textured grass ground plane with instanced trees and soft shadows.
- Fixed-timestep loop, an empty sim worker with the message protocol, a seeded PRNG.
- **Done when:** an empty, pannable map renders at 60 fps.

### Stage 1: Road building
- World model: nodes, segments, road class table (10 classes: width, lanes, speed, cost/m).
- Road draw tool covering straight, curved (3-click Bézier) and continuous drawing. Snapping to nodes, segments, grid and angles (15°). Ghost preview showing length and cost.
- Road mesh generation with asphalt, edge lines, centre lines and lane dashes. Median for divided roads.
- Delete tool, undo/redo (command stack), segment splitting when connecting mid-segment.
- Build palette UI (grouped by Street / Avenue / Highway), and a budget readout.
- **Done when:** you can draw a curved highway network that looks right, and undo it.

### Stage 2: Junction geometry
- Automatic junction trimming, polygon, and crosswalk/stop-line markings.
- Default lane connectors with turn arrows painted on approach lanes.
- Road upgrade, widen and one-way tools that work **in place** and keep connectivity.
- Asymmetric per-direction lane counts.
- **Done when:** T, X and Y junctions between any classes render cleanly and expose connector data.

### Stage 3: Traffic core
- Compile the world into a `LaneGraph`. Entry spawners and destination sinks.
- Vehicle store (SoA), IDM car-following on lanes and through connectors. Routing (A*) from entry to destination.
- Instanced vehicle rendering with interpolation and several vehicle types and colours (car, van, truck).
- Sim controls: pause, 1×/2×/4×. "Open to traffic" toggle.
- Determinism test: same seed and network give an identical state hash after 10k ticks.
- **Done when:** cars drive a simple network from entries to destinations and queue behind each other.

### Stage 4: Junction control and priority
- Conflict-point detection between connectors. Give-way and stop signs with gap acceptance, priority tool UI.
- Traffic signals with an auto phase plan and an editable timing panel.
- Roundabout tool that generates a ring, entries and exits. Circulating traffic has priority.
- Don't-block-the-box rule, and a deadlock detector that flags gridlocked vehicles.
- **Done when:** a busy 4-way signalized junction and a roundabout run without collisions or permanent deadlock.

### Stage 5: Multi-lane behaviour and lane editing
- MOBIL discretionary lane changes and mandatory lane selection ahead of exits.
- Merging at on-ramps (zipper and gap-seeking), lane drops.
- Lane connection editor (click an incoming lane, toggle outgoing lanes). Channelized slip roads (free-flow right/left turns).
- Congestion-aware rerouting (edge costs from rolling average speed).
- **Done when:** a highway with on/off ramps shows realistic weaving and merge queues.

### Stage 6: Height levels and grade separation
- Height picker UI (7 levels) and elevation-aware drawing with a slope limit. Ramps between levels.
- Bridges and viaducts with piers, shadows and railings. Cuttings with retaining walls. Tunnels with portals, where vehicles are hidden or dimmed underground.
- Junction generation ignores crossings at different levels. Picking and snapping are level-aware. Cost multipliers apply.
- **Done when:** a cloverleaf, a diamond and a roundabout interchange (as in the trailer) can all be built and work.

### Stage 7: Railways
- Rail track tool and level-defined rail lines. Timetabled trains.
- Level crossings: barrier state machine, with road vehicles stopping for closed barriers. The alternative is grade separation from Stage 6.
- **Done when:** trains run on schedule and cause realistic queues at crossings.

### Stage 8: Game layer and campaign
- Level JSON format and loader. Entries, destinations as coloured signboards, budget, pre-placed roads and rail, no-build zones.
- Goal evaluation: each destination's rolling flow ≥ threshold for a sustained window → site complete. Gridlock or a blown budget triggers a warning, not an instant fail.
- Diagnostics overlays: segment speed/congestion heatmap, vehicle inspector (click a car to see its route), destination flow meters, junction wait times.
- Campaign of about 10 hand-crafted sites with rising difficulty: rural T junction → town signals → highway exit → full interchange → rail crossing site. Progress is saved.
- **Done when:** the campaign can be played from start to finish.

### Stage 9: Polish and ship
- Save/load sandbox maps. Settings (keybinds, graphics, units). Audio (ambient traffic, UI clicks).
- Tutorial prompts on the first sites.
- Performance pass: profile the worker, spatial hashing for neighbour queries, LOD for vehicles when zoomed out.
- Electron packaging + steamworks.js (achievements, cloud saves). A sandbox and level editor is a stretch goal.

---

## 5. Main risks

| Risk | Mitigation |
|---|---|
| Junction geometry edge cases (sharp angles, many-legged nodes, short segments) | Enforce minimum segment length and angle when building. Test on a fixture set of generated junctions. Fall back to a simpler polygon when the union fails. |
| Gridlock or unrealistic deadlocks from simple rules | Don't-block-the-box rule, conflict-zone reservation, a stuck-vehicle reroute timeout, and a deadlock overlay so the player can see *why*. |
| Sim performance with thousands of vehicles | SoA in a worker, per-lane sorted vehicle lists for leader lookup (O(1) leader), and spatial hashing only at junctions. |
| Determinism drift | All sim maths happens in the worker with a fixed dt, and a golden replay hash test runs in CI. |
| Scope creep | Each stage is shippable. Stages 0–5 alone already make a fun 2D traffic puzzle. |
