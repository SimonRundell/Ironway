# Ironway: Work Schedule for Claude Code

Companion to `DESIGN.md`. Read `CLAUDE.md` first, then the sections of `DESIGN.md` named in each task.

Licence: CC BY-NC-SA 4.0. Summary and link in `DESIGN.md` Appendix G.

---

## How to work through this schedule

1. Take one task at a time, in dependency order. Tasks marked **Parallel** may run in separate agents on separate branches or worktrees, provided they touch different files.
2. Before starting a task, read the DESIGN sections it names. If a needed decision is missing, pick the default in `DESIGN.md`, record it in `DECISIONS.md` (date, task id, decision, reason), and carry on. Stop and ask Simon only if blocked or if the choice changes cost or scope.
3. Write the tests named in "Done when" as part of the task, not afterwards.
4. Every JS function has JSDoc. Every PHP function and class has PHPDoc. One CSS file (`src/index.css`). No inline CSS unless a canvas or measurement forces it.
5. Finish each task by running `npm test`, `npm run build` and `npx react-doctor` (when the task touches React), then append a dated line to `PROGRESS.md`: task id, what changed, anything left.
6. Commit per task with the task id in the message.
7. If a task takes more than about 400 lines of new code, split it and record the split in `DECISIONS.md`.

Size key: **S** under half a day, **M** about a day, **L** several days of agent work.

Phase gates: do not start a phase until the previous gate demo passes.

---

# Phase 0: Foundations

### T0.01 Scaffold project (S)
- Depends on: none. See DESIGN 3.1, 3.2, 3.8.
- Do: `npm create vite@latest` (React, JavaScript) into the project root. Install `axios`, `react-router-dom`, `fflate`, `vitest`. Run `npx -y react-doctor@latest install`. Create the folder layout from DESIGN 3.2 with empty index files and README stubs. Collapse the template CSS to `src/index.css` only, with custom properties. Add `README.md` (purpose, setup, licence summary and link), `CREDITS.md`, `PROGRESS.md`, `DECISIONS.md`.
- Done when: `npm run dev`, `npm run build` and `npm test` (one trivial test) all pass. App shows a placeholder page. Only one CSS file exists.

### T0.02 Config, CORS, htaccess, DB bootstrap (S)
- Depends on: T0.01. See DESIGN 3.3, 3.5.
- Do: Create `.config.json` (and `.config.example.json` for the repo, with `.config.json` in `.gitignore`). Create `api/cors.php`, `api/db.php`, `api/lib/config.php`, `api/lib/json.php`. Create root `.htaccess` and `api/.htaccess` exactly as in DESIGN 3.5. Create `public/data/client.json`. Write `api/ping.php` (includes cors then db, returns `{ ok: true, db: true }`).
- Done when: with Laragon running, `Invoke-RestMethod http://localhost/api/ping.php` returns ok. OPTIONS preflight from `http://localhost:5173` returns 200 with the origin echoed. A request from `http://evil.example` gets no allow-origin header. `GET /.config.json` and `GET /api/.config.json` both return 403. `scripts/smoke.ps1` automates these checks.

### T0.03 Migrations (S)
- Depends on: T0.02. See DESIGN 8.2.
- Do: `api/sql/001_schema.sql` for all Phase 1 tables. `api/migrate.php` (CLI) that creates a `schema_migrations` table and applies unapplied numbered files in order, each in a transaction where possible.
- Done when: `php api/migrate.php` on an empty database creates every table. Running it twice changes nothing. Foreign keys cascade on save deletion.

### T0.04 Auth endpoints (M)
- Depends on: T0.03. See DESIGN 3.6, 8.3.
- Do: `api/lib/auth.php` (`require_auth()`, token create and hash), `api/lib/validate.php`, endpoints `auth/register.php`, `login.php`, `logout.php`, `me.php`. Login throttle with `login_attempts`. Axios client in `src/api/client.js` that attaches the bearer token and handles 401 by routing to login. Minimal login and register pages.
- Done when: PHP CLI tests cover register, duplicate username, weak password, login success and failure, 5-failure lockout returning 429, `me` with and without token, logout invalidating the token. The browser can register, log in, reload and stay logged in.

---

# Phase 1: Conceptual model and economic core

Goal: a persistent, deterministic island economy that runs with no player action, with a plain inspector UI to prove it.

## 1A Generation foundations

### T1.01 Rules JSON and loader (M)
- Depends on: T0.01. See DESIGN 8.1, Appendices A to F.
- Do: Create every JSON file in `public/data/` from the appendices (starter values). Write `src/sim/rules.js` that loads them (browser fetch and Node fs variants), validates shape, ranges and cross references, and freezes the result. Provide `api/lib/rules.php` that reads the same files and exposes the few values PHP needs (class ids, cargo ids, caps).
- Done when: tests prove the loader rejects a missing field, an unknown cargo id in an industry, a negative price and an era table out of order. A deliberately broken fixture file produces a readable message naming file and key.

### T1.02 RNG, hashing, noise (M)
- Depends on: T0.01. See DESIGN 4.5.
- Do: `rng.js` with `hashString`, `mulberry32` or `sfc32`, `rngFor(seed, ...keys)`, helpers (`int`, `pick`, `shuffle`, `gaussian` using only exact arithmetic). `noise.js` with seeded value or simplex noise, fBm, ridged noise, domain warp, all using integer hashing. `checksum.js` (FNV-1a over canonical serialisation of typed arrays and plain objects). No `Math.random` anywhere (add an ESLint or grep test that fails if it appears under `src/sim`).
- Done when: golden-value tests (fixed seed gives fixed first 10 outputs). Cross-run equality. A distribution test of the noise. The grep guard test is in place.

### T1.03 Island, elevation, ranges, sea level (M)
- Depends on: T1.02. See DESIGN 5.1, 5.2 steps 1 to 5. Parallel with T1.07, T1.08.
- Do: Layer container (`WorldGrid` with typed arrays, indexers, neighbour helpers). Implement the mask, base elevation, mountain spines, sea-level selection, landmass filtering and light erosion.
- Done when: for 20 seeds land fraction is 35 to 50 percent, exactly one major landmass, at least one range with 40 or more `rock`-height cells, nothing within 20 miles of the grid edge. Node run time for these steps under 2 seconds. A debug script writes a PNG (or ASCII preview) per seed for human inspection into `scripts/out/`.

### T1.04 Climate and hydrology (L)
- Depends on: T1.03. See DESIGN 5.2 steps 6 to 8.
- Do: Rainfall with orographic effect and rain shadow. Priority-flood fill, D8 flow, rain-weighted accumulation, river width classes, lakes, river mouths, slope layer.
- Done when: property tests on 20 seeds: every river cell drains to sea or lake, no river flows uphill after filling, at least 3 rivers over 100 miles, rain shadow visible (mean rain on lee side of the main range lower than windward by a set margin).

### T1.05 Coast, bays, harbours (M)
- Depends on: T1.04. See DESIGN 5.2 step 9.
- Do: Coastal flags, ray-cast shelter, bay regions, harbour scoring and spaced candidate selection.
- Done when: at least 10 harbour candidates and 3 estuary harbours on all 20 seeds, spacing 40 miles or more, candidates all lie on the coast or river mouths. `harbourCandidates` list has scores for debugging.

### T1.06 Soil, land use, resources (M)
- Depends on: T1.05. See DESIGN 5.2 steps 10 and 11.
- Do: Fertility, arable and pastoral scores, land-use classes, resource deposits with richness, guarantees of at least 4 coal, 4 iron, 6 stone, 6 clay and coal-iron proximity.
- Done when: at least 5 percent each of arable, pastoral, forest and at least 1 percent marsh on all seeds. All non-`rock` land is farmable or buildable or exploitable (test asserts every land cell has a class other than none). Resource guarantees pass on 20 seeds.

## 1B Places, networks, industries

### T1.07 Names (S)
- Depends on: T1.01, T1.02. See DESIGN 5.7. Parallel with T1.03.
- Do: Name generators for island, settlements by kind and coast, rivers, bays, ranges. Uniqueness, blocklist.
- Done when: 500 names for one seed are unique, none on the blocklist, coastal settlements show coastal endings in at least 60 percent of cases, same seed gives same names.

### T1.08 Save and world model types (S)
- Depends on: T1.01. See DESIGN 4.4, 8.2. Parallel with T1.03.
- Do: Document (JSDoc typedefs) the in-memory world and sim state shapes: `World` (grid, settlements, industries, links, harbours, names, meta) and `SimState` (date, per-entity dynamic fields, economy, company, history). Build `state.js` with constructors, a dirty-tracking wrapper (set of changed entity keys), and `toRows()` and `fromRows()` mappers matching the SQL columns exactly.
- Done when: round-trip test: `fromRows(toRows(state))` equals state by checksum on a synthetic world. Dirty tracker reports only touched entities.

### T1.09 Settlements and hinterlands (L)
- Depends on: T1.06, T1.07. See DESIGN 5.4.
- Do: Placement by score with spacing per kind, initial populations (rank-size shaped), hinterland assignment into `region`, port tier, class split, housing.
- Done when: counts within DESIGN 5.4 ranges on 20 seeds, spacing rules hold, capital within 12 miles of a harbour or estuary, total initial population 2 to 3 million at default difficulty, hinterland cells have no gaps inside radius, all ports lie on harbour candidates or estuaries.

### T1.10 Links (L)
- Depends on: T1.09. See DESIGN 5.5.
- Do: A* routing with terrain cost, road graph, connectivity guarantee, cycle edges, rail skeleton, colliery tramways, sea lanes between ports, `world` links at ports. Path simplification (Douglas-Peucker) and length and gradient computation.
- Done when: every settlement reachable from the capital by road on all 20 seeds, every port reachable from every other port by sea, no road passes through `rock` cells, rail miles at most 15 percent of road miles, path JSON under 4 KB per link on average.

### T1.11 Industry placement (M)
- Depends on: T1.10. See DESIGN 5.6, Appendix B.
- Do: Siting rule evaluators, placement scoring, initial counts by era, home settlement assignment.
- Done when: every industry satisfies its siting rule (test asserts per rule), each primary chain has at least 2 plausible downstream sites, no industry placed before its `eraFrom`, every industry has a home settlement within 10 miles.

### T1.12 Validation, retry, world packing (M)
- Depends on: T1.11. See DESIGN 5.2 step 14, 5.3, 5.1.
- Do: `validateWorld`, attempt loop, `generateWorld(seed, difficulty)` entry point returning the `World`. `pack.js` with `packWorld` and `unpackWorld` (header, layers, gzip with `fflate`, checksum).
- Done when: 20 seeds generate and validate within 5 seconds each in Node, pack then unpack equals the original by checksum, blob size reported (expect well under 1 MB), golden checksums for `ironway-001` to `-005` committed in a test.

## 1C Persistence

### T1.13 Saves API (L)
- Depends on: T0.04, T1.08. See DESIGN 4.4, 8.3.
- Do: `saves/list`, `create`, `load`, `map`, `delete`, `checkpoint` endpoints, ownership checks, version handling, row validation against rules, size limits, transactions with multi-row upserts in chunks of 500.
- Done when: PHP tests cover create then load round trip, another user gets 403 or 404, stale `baseVersion` gets 409, `gameDay` going backwards gets 422, oversize body gets 413, malformed rows get 422 with no partial writes, delete cascades. A 300-settlement checkpoint completes in under 1 second locally.

### T1.14 Client persistence layer (M)
- Depends on: T1.12, T1.13.
- Do: `src/api/saves.js` wrappers, new-game flow (generate in a worker or async chunks, show progress, POST), load flow (rows plus blob into `World` and `SimState`), autosave scheduler (interval, on pause, on visibility change), conflict handling UI.
- Done when: from the browser: create an island with a seed, reload the page, load it, and the world checksum matches the one at creation. Two tabs trigger the 409 path and the UI offers reload.

## 1D Economic engine

### T1.15 Clock and scheduler (M)
- Depends on: T1.08. See DESIGN 4.1 to 4.3.
- Do: `clock.js` (calendar maths, month names, 360-day year), fixed-step loop with accumulator and speed control, event hooks for day, month, March and September, year end. Pause on hidden tab. Pure functions so Node tests can drive ticks directly.
- Done when: tests step 1,080 days and see exactly 36 month hooks, 6 level checks, 3 year ends. Speed changes alter only wall-clock pace, not results.

### T1.16 Production and consumption (L)
- Depends on: T1.11, T1.15. See DESIGN 7.2, 7.3.
- Do: Hinterland farm yields with seasonality and era productivity. Industry utilisation rule. Population demand tables with seasonal coal factor and confidence spending. Industry input draw. Perishable decay. `basic` and `complex` demand modes.
- Done when: unit tests for each formula with hand-computed cases. A single-settlement fixture reaches a steady state without NaN over 120 months. Utilisation responds correctly to missing inputs, missing labour and a full output store.

### T1.17 Market and pricing (S)
- Depends on: T1.16. See DESIGN 7.4.
- Do: Coverage, price multiplier using a lookup table for fractional powers, price and cost-of-living helpers.
- Done when: table-based power matches a high-precision reference within 0.5 percent over the range, price bounds respected, zero-demand nodes sit at the floor.

### T1.18 Baseline carrier flows (L)
- Depends on: T1.10, T1.17. See DESIGN 7.5.
- Do: Synchronous snapshot flow algorithm with reserves, gradient threshold, node and link oversubscription scaling, capacity priority, losses by mode, seaport world links later in T1.21.
- Done when: tests show conservation (moved minus losses equals net change), order independence (shuffled link order gives identical results), capacity never exceeded, no flow below `minGradient`. On a two-settlement fixture where one has coal and the other lacks it, coal arrives at the capped baseline rate and the price gap narrows slowly.

### T1.19 Population, housing, migration (L)
- Depends on: T1.16, T1.18. See DESIGN 7.6.
- Do: Births and deaths with era curves, food and housing factors, attractiveness, migration along road links with caps, rural drift, class drift (yearly), housing construction using materials, abandonment.
- Done when: closed-system test (no births and deaths) conserves people under migration. A settlement with food shortage declines. A settlement with vacancies and housing attracts migrants. A settlement without bricks, planks or stone cannot add housing. Class shares converge toward job-implied shares.

### T1.20 Employment, wages, confidence (M)
- Depends on: T1.19. See DESIGN 7.7.
- Do: Labour force and participation, job allocation from industries, farms, services and construction, vacancy and employment rates, wage and cost of living, needs coverage, smoothed confidence.
- Done when: unit tests for each indicator with worked examples, confidence bounded 0 to 100, a mine closure raises local unemployment and lowers confidence in the home settlement within 3 months in a fixture.

### T1.21 Imports, exports, ports (M)
- Depends on: T1.18. See DESIGN 7.9.
- Do: World node supply and demand by era, import caps and export caps by port tier, trade value tracking, port tier growth rule.
- Done when: imported cotton reaches a mill town only through flows, exports remove stock at ports, trade balance tracked monthly, port tier changes only after sustained throughput.

### T1.22 Industry lifecycle (M)
- Depends on: T1.20, T1.21. See DESIGN 7.8.
- Do: Opening rules with price signal, plausible inputs and site search. Expansion, contraction, closure. Deposit depletion. Era retirement and successors. Events emitted.
- Done when: a fixture with a sustained coal shortage causes a new mine to open on a valid site after the delay. A starved industry halves then closes on schedule. Closure sends workers to the unemployed pool. Events logged.

### T1.23 Island economy level (M)
- Depends on: T1.20, T1.21. See DESIGN 7.10, Appendix D.
- Do: Indicators, score, hysteresis, momentum, seeded shock, one step per check, effect multipliers wired into the monthly cycle and a stubbed `playerActivity` input.
- Done when: tests show one-step limit, hysteresis, deterministic shock per seed and date, and that a deliberately starved economy trends down while a healthy one trends up over 10 years in the harness.

### T1.24 Monthly tick assembly and history (M)
- Depends on: T1.16 to T1.23. See DESIGN 7.1.
- Do: `tick.js` orchestrating the monthly order exactly as listed, history snapshot, events, yearly hooks. A `runYears(state, n)` function for the harness.
- Done when: a full run of 10 years on a generated world completes without NaN, checksum is identical across two runs, and history rows exist for every month.

### T1.25 Headless balance harness (M)
- Depends on: T1.24. See DESIGN 11.
- Do: `scripts/balance.mjs` with arguments for seeds and years, CSV output, and the Phase 1 gate assertions. Tune `economy.json` until the gate passes.
- Done when: 50 years on seeds `ironway-001` to `-005` meet every Phase 1 gate in DESIGN 11, in under 60 seconds each. Document final tuned values and observations in `DECISIONS.md`.

## 1E Inspector UI and gate

### T1.26 Inspector UI (L)
- Depends on: T1.14, T1.24.
- Do: React pages: Saves (list, new with seed and difficulty, delete). Inspector with date and speed controls, island summary and economy level, tables for settlements (sortable, by class pop, employment, confidence, trend), industries (utilisation, stock), links, selected-settlement panel (stock and price table, history chart as simple SVG), events log, and a few debug actions (force a closure, add stock). Use the sim in the main thread for now.
- Done when: a user can create an island, run it at 1x, 2x and 4x, pause, watch numbers change, autosave, log out and back in and resume from the same date. No console errors. react-doctor clean.

### T1.27 Docs, deploy pack, Phase 1 gate (S)
- Depends on: T1.26.
- Do: Update `README.md` (setup on Laragon, build, deploy to Hostinger or Dreamhost, licence). Write `scripts/deploy-pack.ps1`. Add `docs/ECONOMY.md` explaining the model for students (plain prose, diagrams as Mermaid). Tag `phase-1`.
- Done when: **Phase 1 gate demo:** fresh clone, `migrate`, create account, create island, run 20 game years with no player action. Population and employment move believably, at least one industry opens and one closes, the economy level changes at least once, nothing crashes, deploy pack produces a folder that works on a clean Apache with the `.htaccess` rules.

---

# Phase 2: Graphical model

Goal: a high-quality, scrollable and zoomable canvas that makes the economy visible.

### T2.00 Projection spike (S)
- Depends on: T1.12 (needs `generateWorld` and the golden seeds). May run before the Phase 1 gate. See DESIGN 9.2.1.
- Do: a throwaway page in `scripts/spike/`, outside `src` and not part of the React app. Generate `ironway-001`, paint land use colours to an offscreen canvas, and draw the island two ways: top-down, and 2:1 isometric using a plain affine matrix. Overlay link polylines, settlement markers and 6 to 10 small sprites (industries, cottages, a train) from CC0 or CC BY packs such as Kenney. Capture four camera positions across the zoom bands and record frame time during a scripted pan.
- Done when: screenshots are committed to `docs/spike/`. A `DECISIONS.md` entry names the chosen projection and the reason. If iso is chosen, DESIGN 9.2.1 and the Phase 2 tasks it touches (T2.01, T2.03, T2.06, T2.07, T2.09, T2.10) are amended. If pack sprites are adopted, DESIGN 0.2 item 7 and `CLAUDE.md` are amended and every pack is listed in `CREDITS.md` with its licence. Nothing from the spike is imported by `src`.

### T2.01 Camera and input (M)
- Depends on: Phase 1 gate and T2.00. See DESIGN 9.2 and 9.2.1.
- Do: `projection.js` first (top-down, exporting `worldToScreen`, `screenToWorld`, `visibleWorldPolygon`, `tileTransform`, `depthKey` as in DESIGN 9.2.1). Then `camera.js` (exponential wheel zoom to cursor with easing, drag with inertia, clamps, keyboard, fit-to-island), built only on top of the projection and never doing its own screen maths. Pure functions with unit tests. Render loop skeleton with dirty flags and `devicePixelRatio` handling.
- Done when: unit tests for transforms and zoom anchoring (point under cursor stays fixed). The same round-trip and anchoring tests also pass against a 2:1 isometric projection defined in the test file, which proves the camera does not assume top-down. Resizing keeps the view centre. The loop idles at near zero CPU when nothing changes.

### T2.02 Canvas stack and React integration (S)
- Depends on: T2.01.
- Do: `MapView` component with layered canvases, resize observer, HUD slot. No game logic in React render paths.
- Done when: a blank world shows with pan and zoom working, no React re-render per frame (verified with a counter).

### T2.03 Tile pipeline and worker (L)
- Depends on: T2.02. See DESIGN 9.4. Parallel with T2.06.
- Do: Tile addressing by `ppm` bands, worker pool with `OffscreenCanvas`, request prioritisation (visible first, then neighbours), `ImageBitmap` transfer, LRU cache with memory cap, placeholder blurred parent tile while loading.
- Done when: panning across the island never shows holes for more than 150 ms, cache stays under cap in a 5-minute scripted pan and zoom, worker errors surface in the UI.

### T2.04 Terrain renderer (L)
- Depends on: T2.03.
- Do: Per-pixel relief with smooth sampling, hillshade, land-use palette blend, sea depth, SDF coastline with foam, deterministic texture noise. `palette.json` tuned for the atlas look.
- Done when: screenshots at all four zoom bands on the five golden seeds look crisp with no visible cell blockiness at ppm 96, coastline is smooth at every zoom. Frame time during pan stays within budget.

### T2.05 Rivers, lakes and fine land cover (M)
- Depends on: T2.04. See DESIGN 9.4.
- Do: Variable-width river curves with estuary widening, lakes, and at `ppm >= 24` deterministic forests, fields, moor and reeds.
- Done when: rivers connect smoothly to the sea with no gaps, tree and field patterns are stable between frames and tile boundaries (no seams), cost per tile within budget.

### T2.06 Network layer (M)
- Depends on: T2.02. See DESIGN 9.3. Parallel with T2.03.
- Do: Roads, rail and sea lanes from link paths with line style by mode and tier, smoothing, level-of-detail simplification, visibility by zoom band.
- Done when: new links and tier changes redraw only the network layer. Lines are clean at all zooms. Hit testing returns the nearest link under the cursor.

### T2.07 Settlement sprites and growth (L)
- Depends on: T2.04, T2.06. See DESIGN 9.5.
- Do: Region blob, footprint and street layouts, procedural buildings by class district, deterministic per settlement id. Building count follows housing capacity with fade-in and scale-in, abandonment tinting and removal on shrink. Churches, mills and wharves as features.
- Done when: running the sim for 30 years visibly changes building counts in growing and shrinking places. Layout is identical after reload. Frame time within budget with all settlements in view.

### T2.08 Industry sprites and activity (M)
- Depends on: T2.07. See DESIGN 9.6.
- Do: Sprites for each industry type, animated smoke or steam scaled by utilisation, turning wheels and glowing furnaces, derelict look after closure, construction look on opening.
- Done when: each industry type has a distinct recognisable sprite, idle industries do not animate, animation cost is capped by a particle budget.

### T2.09 Trickle visualisation (M)
- Depends on: T2.06, T2.08.
- Do: Carts, early trains and ships along links with density proportional to flow, colours by cargo category, ports with cranes and moored ships. Deterministic spawn from flow values and a per-link phase.
- Done when: a link with zero flow shows nothing, high flow shows more traffic, total animated sprites never exceed the budget, no sprite teleports at zoom changes.

### T2.10 Labels and declutter (M)
- Depends on: T2.07. See DESIGN 9.7.
- Do: Floating name labels with halo, priority and spatial grid declutter, fade by band, optional river and range labels.
- Done when: automated test over 200 random camera positions finds no overlapping labels, the capital and cities are always labelled in Region band, labels stay legible on all terrain colours.

### T2.11 Sim in a worker (M)
- Depends on: Phase 1 gate. Parallel with T2.03.
- Do: Wrap the sim in a Web Worker with a message protocol (init, step, setSpeed, request snapshot, dirty entities out). Main thread holds a read-only mirror for rendering. Autosave reads from the mirror.
- Done when: sim results are byte-identical (checksum) to the main-thread version, a 4x run never drops render frames below budget, worker crash is reported and the game can recover from the last checkpoint.

### T2.12 HUD, overlays, minimap, panels (L)
- Depends on: T2.07, T2.08, T2.11. See DESIGN 9.6, 9.8.
- Do: Date and speed controls, economy level badge, overlay toggles (prices by cargo, class mix, confidence, employment, flows, resources, suitability), search to jump to a place, minimap, selection panels with history charts and stock and price tables. The inspector page remains reachable.
- Done when: each overlay renders correctly on the golden seeds, selecting a settlement shows live-updating data, the minimap viewport rectangle tracks the camera and is draggable.

### T2.13 Seasons and polish (S, optional)
- Depends on: T2.04, T2.12.
- Do: Subtle seasonal tint by month, snow on high ground in winter, harvest colours on arable.
- Done when: toggleable in settings, no measurable cost when off.

### T2.14 Accessibility and settings (S)
- Depends on: T2.12.
- Do: Keyboard navigation to places, high-contrast label option, reduced-motion setting that disables animation and smooth zoom, quality setting (tile resolution, particle budget).
- Done when: every control reachable by keyboard, reduced-motion respected, quality settings change measurable cost.

### T2.15 Performance spike and pass (M)
- Depends on: T2.07 to T2.12. See DESIGN 9.9, 3.1.
- Do: Scripted camera tour with frame time capture, memory capture, tile cache stats. Fix hotspots. Only if the budget cannot be met with Canvas 2D, write a short `DECISIONS.md` entry proposing a WebGL library and stop for Simon's decision.
- Done when: DESIGN 9.9 budget met on a mid-range laptop and a 1920 x 1080 display, results table committed in `docs/PERF.md`.

### T2.16 Visual regression and Phase 2 gate (M)
- Depends on: T2.15.
- Do: Playwright screenshots of the five golden seeds at fixed cameras with tolerance, label overlap test in CI script, update docs and screenshots in `README.md`. Tag `phase-2`.
- Done when: **Phase 2 gate demo:** open a golden seed, zoom from region to detail with the wheel, see names above places, watch a town grow and a mine close over 30 game years, with traffic and smoke visibly following the economy, smooth throughout.

---

# Phase 3: Logistics and finance

Goal: the player runs a transport company that earns money from real demand.

### T3.01 Vehicle catalogue and era gating (S)
- Depends on: Phase 2 gate. See DESIGN 10.2, Appendix E.
- Do: Complete `vehicles.json`. Helpers `availableModels(year, mode)`, depreciation, age-based reliability and maintenance.
- Done when: tests confirm models appear and retire on the right years, prices and rates validated by the rules loader.

### T3.02 Phase 3 schema and API (M)
- Depends on: T3.01. See DESIGN 8.2, 10.3.
- Do: `002_logistics.sql` with `stops`, `vehicles`, `services`, `service_orders`, `ledger_monthly`, `annual_statements`, `achievements`. Extend `checkpoint.php` and `load.php`. Extend `state.js` row mappers and dirty tracking.
- Done when: round-trip tests for each new table, validation rejects orders pointing at stops from another save, checkpoint with 500 vehicles under 1 second.

### T3.03 Stops and catchments (M)
- Depends on: T3.02. See DESIGN 10.1.
- Do: Open, upgrade and close stops, cost with economy build-cost multiplier, catchment computation (cargo exchange between node stock and stop stock), facilities and their effects on decay and fares.
- Done when: unit tests for catchment membership, cost scaling, facility effects. UI action opens a stop on a selected settlement and it appears on the map.

### T3.04 Link upgrades and infrastructure upkeep (M)
- Depends on: T3.03. See DESIGN 10.1, Appendix C.
- Do: Upgrade orders with cost by length, gradient and economy multiplier. Build time. Capacity and speed update on completion. Annual upkeep. Feed upgraded miles into `playerActivity`.
- Done when: capacity changes only after the build time, money is debited once, upkeep appears in the annual statement, an upgrade changes the next economy score input.

### T3.05 Vehicle purchase, fleet and consists (M)
- Depends on: T3.03. See DESIGN 10.2.
- Do: Shop API and UI, consist builder for trains, sell and scrap with depreciation, fleet list.
- Done when: only era-valid models are offered, consist limits enforced, cash debited and credited correctly, sale value follows the depreciation curve.

### T3.06 Services and orders model (M)
- Depends on: T3.05. See DESIGN 10.3.
- Do: Services, ordered stops, unload and load rules, auto-load flag, wait time, assign vehicles. Pure functions that produce the next action for a vehicle at a stop.
- Done when: tests for `all`, `none`, `demanded` and explicit unload lists, `any` and explicit load lists, partial list change at a middle stop, and auto-load picking the best expected revenue on a fixture with known prices.

### T3.07 Vehicle movement and congestion (L)
- Depends on: T3.06. See DESIGN 10.4, 10.6.
- Do: Daily movement along link paths, speed by tier, gradient and congestion, arrival, dwell, departure, breakdowns by reliability and age and condition, repair delays.
- Done when: a vehicle on a known link arrives in the expected number of days, adding vehicles beyond capacity slows all of them measurably, a vehicle with low reliability breaks down more often over 10 years in the harness, determinism holds.

### T3.08 Freight loading, delivery and revenue (L)
- Depends on: T3.07, T1.17. See DESIGN 10.4.
- Do: Loadable stock rule with reserve, daily draw from stock, delivery into destination stock, revenue formula with demand premium, speed bonus and economy multiplier, perishable loss, undemanded cargo penalty.
- Done when: carrying coal from a mine town to a coal-starved city pays more than the reverse and relieves the shortage (price at destination falls, confidence rises within a few months), revenue equals the formula on hand-worked cases, baseline flow on that link falls as the service draws stock.

### T3.09 Passenger model (L)
- Depends on: T3.07. See DESIGN 10.5.
- Do: Gravity-model demand by class, waiting pools per stop and destination, boarding and alighting per order, class fares and coach capacities, quality factor.
- Done when: demand scales with population product and falls with distance, class mapping to coach types works, a faster and more frequent service attracts more passengers, waiting pools cap and decay.

### T3.10 Private cars and modal share (M)
- Depends on: T3.07, T1.23. See DESIGN 10.7.
- Do: Car ownership by class confidence and era, road load, modal share reduction on parallel services, car plant and oil chain wiring, congestion contribution.
- Done when: no cars before the car era, ownership rises with Upper and Middle confidence, a busy road tier 0 link congests as car numbers rise, upgrading the road lowers congestion.

### T3.11 Player activity and economy feedback (S)
- Depends on: T3.04, T3.08. See DESIGN 7.10.
- Do: Replace the `playerActivity` stub with miles upgraded, vehicle-miles run and profitability over 6 months, normalised.
- Done when: in the harness an idle player leaves the economy neutral, an active profitable player nudges the level up over time, a long idle run with losses nudges it down, and effects remain bounded by the one-step-per-check rule.

### T3.12 Finance, annual cycle and tax (L)
- Depends on: T3.08, T3.09. See DESIGN 10.8, Appendix D.
- Do: Running cost accrual, monthly ledger roll-up, year-end maintenance due, interest, tax with the profit or revenue switch, annual statement rows and view, insolvency warnings and game over (sandbox switch).
- Done when: statement figures equal hand-calculated values on a fixture year, tax rate follows the economy level at year end, cash after year end equals prior cash plus revenue minus costs minus maintenance minus interest minus tax, insolvency path tested.

### T3.13 Bonds and loans (S, optional)
- Depends on: T3.12.
- Do: Issue and repay bonds with interest from the economy level, limits by net worth, effect on net worth.
- Done when: interest accrues and is paid at year end, limits enforced, repaying early works, rates track the economy level at issue.

### T3.14 Rank and achievements (S)
- Depends on: T3.12. See DESIGN 10.9.
- Do: `ranks.json` thresholds and achievement conditions, year-end evaluation, rank page, century review screen.
- Done when: rank follows cash and net worth thresholds, achievements fire once only, the century review appears at year 100 and play can continue.

### T3.15 Service editor and management UI (L)
- Depends on: T3.06, T3.09, T3.12.
- Do: Network overview, stop manager, service editor (ordered stop list, drag to reorder, per-stop load and unload editors with cargo pickers, auto-load switch, vehicle assignment, estimated frequency and capacity), vehicle shop page, finance page (monthly chart, annual statement table), link upgrade dialog.
- Done when: a tester can create a coal service between two named places using only the UI in under 2 minutes, edit a middle stop's load list while the service runs, and see the effect on revenue next month. react-doctor clean.

### T3.16 Vehicles and services on the canvas (M)
- Depends on: T3.07, T2.09.
- Do: Render player vehicles moving on links with type sprites, selected service highlight, congestion heat on links, stop markers with tier icons, click to select a vehicle or service.
- Done when: vehicle positions match sim positions exactly, no sprite exceeds budget with 500 vehicles, selection works at all zooms.

### T3.17 Balance pass and Phase 3 gate (L)
- Depends on: T3.12 to T3.16. See DESIGN 11.
- Do: Extend the harness with scripted strategies (do nothing, one coal line, wide mixed network, passengers only). Tune prices, rates, costs, demand, tax. Remove exploits (for example endless profit from one very short loop, or cargo created from nothing). Write `docs/PLAYING.md` for students. Tag `phase-3`.
- Done when: **Phase 3 gate demo:** from a fresh island, a player builds a coal and iron chain feeding a city, adds a passenger service, survives the first annual tax and maintenance, ends year 5 with positive net worth, and the ordering of strategies by profit is sensible. No exploit earns unlimited money. Rank moves with cash.

### T3.18 New track and road building (L, stretch)
- Depends on: T3.17.
- Do: Let the player lay new links between nodes with A* guidance, cost by terrain, bridges over rivers by cost, ferries and tunnels left for later. Counts toward `playerActivity`.
- Done when: a new link appears on the map and in `links`, routing respects terrain and `rock`, costs follow the economy multiplier, and the new link is usable by services.

---

## Dependency summary

```
T0.01 -> T0.02 -> T0.03 -> T0.04
T0.01 -> T1.01, T1.02
T1.02 -> T1.03 -> T1.04 -> T1.05 -> T1.06 -> T1.09 -> T1.10 -> T1.11 -> T1.12
T1.01 + T1.02 -> T1.07 (-> T1.09)          T1.01 -> T1.08 (-> T1.13, T1.15)
T0.04 + T1.08 -> T1.13 ;  T1.12 + T1.13 -> T1.14
T1.11 + T1.15 -> T1.16 -> T1.17 -> T1.18 -> T1.19 -> T1.20
T1.18 -> T1.21 ;  T1.20 + T1.21 -> T1.22, T1.23 -> T1.24 -> T1.25
T1.14 + T1.24 -> T1.26 -> T1.27   (Phase 1 gate)
Phase 2: T2.00 -> T2.01 -> T2.02 -> (T2.03 -> T2.04 -> T2.05) and (T2.06) -> T2.07 -> T2.08 -> T2.09
         T2.11 parallel; T2.10, T2.12 after T2.07; T2.14, T2.15, T2.16 last   (Phase 2 gate)
Phase 3: T3.01 -> T3.02 -> T3.03 -> (T3.04, T3.05) -> T3.06 -> T3.07 -> (T3.08, T3.09, T3.10)
         T3.11, T3.12 -> (T3.13, T3.14) -> T3.15, T3.16 -> T3.17   (Phase 3 gate) -> T3.18
```

## Suggested parallel lanes for multiple agents

| Lane | Tasks |
|---|---|
| Backend | T0.02 to T0.04, T1.13 |
| Map generation | T1.02 to T1.12 |
| Economy engine | T1.15 to T1.25 (after T1.11 exists in fixture form) |
| Front end | T1.14, T1.26, then Phase 2 UI tasks |
| Rendering | T2.03 to T2.10 |

Economy engine tasks can start early against a hand-built fixture world (small, five settlements, three industries) while map generation finishes, as long as the `World` and `SimState` types from T1.08 are agreed first.

## Done checklist for every task

- Tests written and passing, determinism preserved (no `Math.random`, no unseeded draws).
- JSDoc or PHPDoc on all new functions.
- No inline CSS. One stylesheet.
- No secrets in the repo. `.config.json` untouched in git.
- `.htaccess` rules intact, `.config.json` still returns 403.
- Plain, human prose in docs and UI text: no em-dashes, UK spelling, "program" for code.
- `PROGRESS.md` updated. Commit made with the task id.
