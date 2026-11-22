# Traffic Sim

A road-building traffic puzzle in the spirit of *Highways & Co.*: build streets, junctions and interchanges between fixed towns, open them to traffic, find the jam, fix it.

## Repository layout

| Folder | Status | What it is |
|---|---|---|
| `unity/` | **Active development (planned)** | The fully 3D version, built in Unity. Create the Unity project in this folder. |
| `web-prototype/` | **Reference only** | *Flowline*, the finished browser/desktop prototype (TypeScript, Three.js, Web Worker sim). It is kept as a working reference for game design, simulation rules and level data. New features go into the Unity version. |

## Using the web prototype as a reference

```bash
cd web-prototype
npm install
npm run dev      # play it in the browser
npm test         # unit and behaviour tests
```

See [`web-prototype/README.md`](web-prototype/README.md) for controls and architecture, and [`web-prototype/PLAN.md`](web-prototype/PLAN.md) for the original design plan.

### What to port, and where it lives

| System | Prototype source | Notes for Unity |
|---|---|---|
| Road classes, lanes, height levels | `src/world/roads.ts`, `World.ts` | Plain data; port as ScriptableObjects. Levels are 6 m apart. |
| Road geometry (Bézier segments, junction trims, tapers, merges) | `src/world/geometry.ts`, `build.ts` | Planning rules (grades, clearance, crossing angles, grade separation) are pure functions with tests. |
| Lane graph and junction control | `src/world/lanes.ts`, `control.ts`, `compile.ts` | Connectors, priority, signals, all-way stops, default controls. |
| Traffic simulation | `src/sim/Sim.ts` | Deterministic fixed step (0.1 s): IDM car following, MOBIL lane changes, cost-to-go routing with congestion, gap acceptance, rail crossings. Engine-independent; port to C# and keep it off the main thread. |
| Campaign and sandbox maps | `src/levels/` | 11 sites + 3 sandboxes as data (ports, demand, goals, rivers, rails). |
| Reference solutions | `tests/solutions.ts`, `tests/campaign.test.ts` | Scripted builds that prove each site is solvable; useful for balancing the 3D version. |
| Rendering ideas | `src/render/` | Cutting shadows, animated water shader, name plates. Replace with real 3D meshes and lighting. |
