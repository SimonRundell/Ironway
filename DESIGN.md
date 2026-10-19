# Ironway: Design Document

Working title. Rename freely. The folder slug used throughout is `ironway`.

Version 0.1, 16 October 2026. Author: Simon Rundell. Readers: Claude Code agents and Simon.

Released under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0). See section 12 (Appendix G) for a summary and the link to the full terms.

---

## 0. Reading guide, decisions and assumptions

This is a set of three files.

| File | Purpose |
|---|---|
| `DESIGN.md` | What we are building and why: world model, economic rules, data model, APIs, rendering and logistics design. |
| `PHASES.md` | The work schedule: small, agent-sized tasks with dependencies and acceptance tests. |
| `CLAUDE.md` | Standing conventions Claude Code reads on every session (stack, style, licence, local dev). |

Section references in `PHASES.md` point at section numbers here (for example "DESIGN 7.5").

### 0.1 Decisions already agreed

| Topic | Decision |
|---|---|
| Deliverable | This markdown set, written for Claude Code. |
| Simulation clock | Client-driven ticks with pause and 1x, 2x, 4x speeds. Server validates and persists. The world is frozen while the player is away. |
| Map generation | Deterministic generator in JavaScript from a seed. Island is 600 x 300 miles on a 2-mile grid (300 x 150 = 45,000 cells). Generated data is stored as a compressed blob per save. PHP stores and validates only. |
| Users and saves | New simple authentication. Several saves (islands) per user. |
| Era and money | Steam-era start (1830s style). Vehicles unlock by date. Currency is pounds sterling. |

### 0.2 Assumptions made while writing (please review)

1. **One player, no AI rivals, no stock market.** Bonds or loans are an optional task in Phase 3.
2. **Calendar is 12 months of 30 days (360-day year).** Keeps arithmetic clean. Dates are displayed with month names.
3. **Annual tax is charged on profit** (revenue less running costs, maintenance and interest). The rate depends on the island economy level (Appendix D). The task that implements it keeps the base as a config switch so it can become revenue-based if you prefer.
4. **Initial rail is a thin skeleton** (early low-capacity lines between the capital, cities and main ports, plus colliery tramways). Roads connect every settlement. See 5.5.
5. **Phase 3 core is upgrading existing links.** Laying brand new track or road between arbitrary points is a stretch task (T3.18).
6. **No tamper protection.** Server checks protect against corruption and two-tab clashes, not against a determined cheater. One player, so this is acceptable.
7. **No assets, names or text are copied from Railroad Tycoon or any other game.** Mechanics are inspired by them. All art is procedural.
8. **Starting population** target is 2 to 3 million across the island, growing to roughly 5 to 10 million over a century if the player does well. Values live in JSON and are expected to be tuned.

---

## 1. Vision and scope

A single-player economic and logistics sandbox in the browser. A randomly generated island has a living economy: farms, mines and mills feed processing industries, which feed towns and ports. Population and prosperity rise and fall with employment, supply and demand. The player runs a transport company that moves people and goods by road and rail, earns money from real demand, pays annual maintenance and tax, and is ranked by total cash and net worth.

The world must work without the player. With only low-capacity roads and early rail, a trickle of goods and people keeps the island ticking over inefficiently. The player's job is to make it efficient and profit from that.

### 1.1 In scope

- Procedurally generated island with rivers, bays, natural harbours, hills, mountains and flatlands.
- Three social classes (Upper, Middle, Working) with different jobs, wealth, consumption and mobility.
- Primary, secondary and tertiary production chains with siting rules (river, coast, resource).
- Dynamic prices, migration, housing, employment, confidence and an island-wide economy level.
- Zoomable, scrollable canvas map with floating place names and visible commercial activity.
- Freight and passenger services by train, truck and bus, with multi-stop schedules and editable load lists.
- Annual maintenance, tax, profit, and ranking by cash.

### 1.2 Out of scope (for now)

- Multiplayer, AI rival companies, share trading, real-time collisions or signalling, tunnelling and bridge engineering detail, mobile-first layout, audio.

---

## 2. Ideas borrowed from the reference games

Taken from the Railroad Tycoon series (reference URLs supplied by Simon). Ideas only.

| Idea | How it appears here |
|---|---|
| Five-level economy checked twice a year (Depression to Boom), influenced by player activity, finances and randomness, and affecting cargo supply, revenue, demand and build costs. | Island economy level, checked each March and September. See 7.10 and Appendix D. |
| Players found that laying track (cells, not money spent) and steady profitability pushed the economy up, while long idleness pushed it down. | "Player activity" is one weighted input to the economy score from Phase 3. Counted in link-miles upgraded and vehicle-miles run, not pounds. |
| Stations pull cargo from industries and towns inside a catchment radius. Supply and demand come from what is in range. | Stops have a catchment radius by tier (10.1). |
| Basic versus complex economy toggle. | `difficulty.json` has a `demandMode`: `basic` (any moderate town accepts all cargo) or `complex` (demand follows real consumption). Default `complex`. |
| Cargo spoils or is wasted unless storage is built. | Perishables decay per month in stock. Storage facilities reduce decay (10.1). |
| Era-gated locomotives, steam to diesel. | `vehicles.json` with `introYear` and `retireYear`. |
| Dynamic prices across the map (RT3), cargo finding alternative transport if none provided. | Local scarcity drives price. Baseline carriers move cargo slowly when no service exists (7.4, 7.5). |
| Loans cost money and can hurt. | Optional bonds with interest tied to economy level (T3.13). |
| Four zoom views from region to detail. | Four semantic zoom bands on the canvas (9.2). |
| Terrain grades and curves slow trains. | Link gradient factor lowers speed and raises upgrade cost (10.6). |

---

## 3. Technical architecture

### 3.1 Stack

React 18 + Vite + JavaScript (no TypeScript), Axios, PHP 8+ REST backend, MySQL. One CSS file with custom properties. JSDoc and PHPDoc on all code. Tests with Vitest. Compression with `fflate` (MIT).

Rendering in Phase 2 is Canvas 2D with Web Workers and OffscreenCanvas. A WebGL library is adopted only if the performance spike in T2.15 shows Canvas 2D cannot meet the budget.

### 3.2 Folder layout

React app in the project root, created with `npm create vite@latest`. Backend in `/api`.

```
ironway/
  .config.json                 server secrets and settings (never served)
  .htaccess                    SPA fallback plus deny rules
  CLAUDE.md  DESIGN.md  PHASES.md  README.md  CREDITS.md  PROGRESS.md  DECISIONS.md
  index.html  vite.config.js  package.json
  public/
    data/                      static rules JSON (section 8.1), served to client, read by PHP
  src/
    main.jsx  App.jsx  index.css      single CSS file only
    api/                       axios client and endpoint wrappers
    sim/                       pure JS simulation, no React, no DOM
      rng.js noise.js
      mapgen/                  island, hydrology, coast, climate, soil, resources, settlements, links, industries, names, validate, pack
      model/                   production, demand, market, flows, population, employment, confidence, economyLevel, lifecycle, tick, state
      rules.js                 loads and validates rules JSON
    render/                    Phase 2 canvas code and workers
    ui/                        React components and pages
    state/                     React-side stores
  scripts/                     balance.mjs, smoke.ps1, deploy-pack.ps1
  api/
    cors.php  db.php  .htaccess
    lib/                       config.php auth.php json.php validate.php
    auth/                      register.php login.php logout.php me.php
    saves/                     list.php create.php load.php delete.php checkpoint.php map.php
    sql/                       001_schema.sql, 002_...
    migrate.php                CLI migration runner
    tests/                     PHP CLI tests
```

### 3.3 Configuration

`.config.json` (project root, server only):

```json
{
  "db": { "host": "localhost", "name": "ironway", "user": "root", "pass": "", "charset": "utf8mb4" },
  "auth": { "sessionDays": 30, "allowRegistration": true, "minPasswordLength": 10 },
  "limits": { "maxSavesPerUser": 10, "maxAdvanceDaysPerCheckpoint": 1080, "maxCheckpointBytes": 4000000 },
  "staticDataDir": "../public/data"
}
```

In production `staticDataDir` is `../data` because Vite copies `public/` to the deploy root.

Client options that are not secret live in `public/data/client.json` (API base URLs for dev and production, autosave interval, default speeds). The client chooses `apiBaseDev` when `import.meta.env.DEV` is true, else `apiBaseProd`.

### 3.4 Local development and deployment

- Laragon serves the project folder as the document root, so the site is `http://localhost/` and the API is `http://localhost/api/`. Never use a `/ironway/` subfolder. No rewrites needed in dev.
- Vite serves only the React front end on its own port (default 5173). No Vite proxy. If port 5173 is already in use, the dev server is already running: test against it, do not kill it or start a second one.
- Cross-origin calls from Vite to Laragon rely on `api/cors.php`.
- Production targets Hostinger and Dreamhost (Apache). Build with `npm run build`, then `scripts/deploy-pack.ps1` assembles a `release/` folder: `dist/` contents, `api/`, `.htaccess`, `.config.json` template. Same-origin in production, so CORS is inert there.

### 3.5 Required PHP and Apache conventions

Every endpoint starts with:

```php
require_once __DIR__ . '/cors.php';   // always first (adjust relative path in sub-folders)
require_once __DIR__ . '/db.php';
```

`api/cors.php` must:
- Echo back the request `Origin` header when it matches `localhost` on any port.
- Set `Content-Type: application/json; charset=utf-8`.
- Set `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`.
- Set `Access-Control-Allow-Headers: Authorization, Content-Type`.
- Return HTTP 200 and `exit()` for `OPTIONS` preflight.
- Never contain CORS headers inline in any endpoint.

Root `.htaccess` (the deny rule comes first because `.config.json` is a real file and would otherwise be served by the "real files resolve" rule):

```apache
# Never expose configuration or dot-files
<FilesMatch "^\.(config\.json|env|git.*)$">
  Require all denied
</FilesMatch>

RewriteEngine On

# Let real files/directories (including /api/*) resolve normally.
RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]

# Everything else falls back to index.html so React Router can handle
# client-side routes (e.g. a hard refresh).
RewriteRule ^ index.html [L]
```

`api/.htaccess` repeats the `.config.json` deny rule and also denies directory listing and access to `/api/sql/`, `/api/lib/` and `/api/tests/`. A test must request `/.config.json` and `/api/.config.json` and expect 403.

### 3.6 Security basics

- Passwords with `password_hash(PASSWORD_DEFAULT)`. Minimum length from config.
- Opaque session tokens (32 random bytes, hex). Only the SHA-256 hash is stored in `sessions`. Sent as `Authorization: Bearer <token>`. Logout deletes the row.
- PDO with prepared statements only. No string-built SQL.
- Every `saves/*` endpoint checks the save belongs to the authenticated user.
- Login throttle: after 5 failures per username in 15 minutes, respond 429.
- Body size limits from config. JSON schema-style validation in `lib/validate.php`.

### 3.7 Licence and credits

Software and docs are CC BY-NC-SA 4.0. `README.md` carries a plain-English summary and the link (Appendix G). `CREDITS.md` lists dependencies (React, Vite, Axios, fflate, Vitest) and any bundled fonts with their licences. Prefer an OFL-licensed font for map labels, bundled under `public/fonts/`.

### 3.8 Standing setup step

When the project is first created, run `npm create vite@latest` (React, JavaScript), then `npx -y react-doctor@latest install` (pre-approved) to install the react-doctor skill. Follow its guidance for React code.

---

## 4. Clock, state and persistence

### 4.1 Calendar

`gameDay` is an integer count of days since 1 January of `startYear` (day 0). Year = 360 days. Month = `floor(day / 30) % 12`. Month ticks fire when `day % 30 === 0`. The economy level check fires in March (month index 2) and September (month index 8). Year end fires when `day % 360 === 0`.

### 4.2 Loop

Fixed-step loop on the client. At 1x, one game day lasts `msPerDayAt1x` (default 500 ms, so a year is 3 minutes; at 4x, 45 seconds). An accumulator advances whole days, at most 8 per animation frame. The clock pauses automatically when the tab is hidden (config flag). Speeds: paused, 1x, 2x, 4x.

Phase 2 moves the simulation into a Web Worker. The sim module has no DOM or React imports so this is a wrapper change only.

### 4.3 Cadence

| Event | Work done |
|---|---|
| Every day | Advance date. (Phase 3: vehicles move, load, unload, earn.) |
| Every month | Full economic update (7.1). History snapshot. |
| March and September | Island economy level check (7.10). |
| Year end | Annual statement, maintenance, tax (10.8) in Phase 3. Yearly mobility and long-term rules in Phase 1. |

### 4.4 Authority and persistence

The client runs the simulation and is authoritative for state. The server persists and validates.

- **Load:** `saves/load.php` returns the save row, entity rows and company row. `saves/map.php` returns the gzipped map blob. The client rebuilds in-memory typed state.
- **Checkpoint:** every `autosaveEveryGameMonths` (default 3), on pause, on manual save and on page hide, the client POSTs `saves/checkpoint.php` with the base version, current `gameDay`, changed entity rows (dirty tracking), new history rows and new event rows.
- **Version check:** `saves.version` increments on every accepted checkpoint. A mismatch returns 409 and the UI offers to reload (typical cause: two tabs).
- **Server validation:** `gameDay` not lower than stored and not more than `maxAdvanceDaysPerCheckpoint` ahead. Shape and numeric sanity (no negatives where not allowed, no NaN, population within caps, row counts within limits). Whole checkpoint is one transaction.
- **Atomicity of creation:** `saves/create.php` receives the entire generated world (rows plus blob) in one request and writes it in one transaction.
- **Away from the keyboard:** no catch-up. The world waits for the player. A rough tab close loses at most one autosave interval.

### 4.5 Determinism

All randomness comes from a seeded generator, never `Math.random()`. Streams are keyed: `rngFor(seed, 'name', ...keys)`. Simulation random draws use `rngFor(seed, 'tick', gameDay, entityId, purpose)` so a run can be replayed exactly. Only `+ - * /`, `Math.floor`, `Math.sqrt` and integer hashing are used inside generator and simulation maths. Avoid `Math.sin`, `Math.pow` with fractional exponents and similar in generation paths, because results can differ slightly between JavaScript engines. Where a curve is needed use lookup tables built from exact arithmetic or polynomial approximations.

A `checksum(state)` function (FNV-1a over a canonical serialisation) is used by tests to prove determinism.

---

## 5. World model and map generation

All generation code lives in `src/sim/mapgen/` and runs identically in Node (tests) and the browser.

### 5.1 Grid and layers

`W = 300`, `H = 150`, `cellMiles = 2`. World coordinates are in miles, origin top-left, x to the east, y to the south. Layers are typed arrays of length `W * H`.

| Layer | Type | Meaning |
|---|---|---|
| `elev` | Int16 | Metres relative to sea level. Roughly -200 to 1300. |
| `water` | Uint8 | 0 land, 1 sea, 2 lake. |
| `flow` | Uint16 | Rainfall-weighted flow accumulation. |
| `river` | Uint8 | 0 none, 1 to 5 width class. |
| `rain` | Uint8 | Annual rainfall index 0 to 255. |
| `soil` | Uint8 | Fertility 0 to 255. |
| `arable`, `pastoral` | Uint8 | Suitability scores 0 to 255. |
| `landuse` | Uint8 | Enum: sea, lake, arable, mixed, pastoral, forest, moor, marsh, rock (see 5.2 step 7). |
| `slope` | Uint8 | Quantised gradient. |
| `coast` | Uint8 | Bit flags: coastal land, beach, cliff, estuary, harbour candidate. |
| `shelter` | Uint8 | Shelter score for sea cells (bays). |
| `resource` | Uint8 | Enum: none, coal, iron, stone, clay. |
| `richness` | Uint8 | Deposit richness. |
| `region` | Uint8 | Id of nearest settlement hinterland (filled after 5.4). |

The packed blob has a small header (magic, `generatorVersion`, W, H, layer table) followed by each layer, then gzip via `fflate`. The blob is **authoritative** once created: a later change to the generator never alters an existing island. `generatorVersion` is recorded in `saves` and `save_map`.

### 5.2 Generation pipeline

Each step takes the seeded streams it needs and writes layers. Parameters live in `public/data/mapgen.json`.

1. **Island mask.** Domain-warped ellipse (two low-frequency noise fields offset x and y) with a falloff so land never touches the grid edge. Margin of at least 20 miles of sea on every side.
2. **Base elevation.** fBm value or simplex noise (6 octaves, lacunarity 2, gain 0.5), multiplied by the mask.
3. **Mountain ranges.** Pick 2 to 4 spines as random walks inside the land interior. Add ridged noise weighted by a Gaussian of distance to the nearest spine. Vary peak height along each spine.
4. **Sea level.** Choose by percentile so land is 35 to 50 percent of the grid. Keep only the largest landmass plus up to 3 small islets (each under 60 cells). Remove all other land fragments.
5. **Light erosion.** 20 to 40 deterministic passes of thermal smoothing plus a simple stream-power pass. Purpose: believable valleys and coastal plains.
6. **Climate.** Prevailing wind from the west (configurable). March moisture eastwards from the sea, losing moisture as it climbs (orographic effect) so lee sides of ranges are dry (rain shadow). Output `rain`.
7. **Hydrology.** Priority-flood depression filling so every land cell drains to the sea. D8 flow directions. Accumulate flow weighted by `rain`. Cells with accumulation at or above `riverThreshold` are rivers. Width class from the base-2 log of accumulation. Depressions deeper than `lakeDepth` before filling stay as lakes. River mouths are river cells touching the sea.
8. **Slope.** From elevation gradient (central differences), quantised.
9. **Coast and harbours.** Mark coastal land. For each sea cell within 24 miles of land, cast 16 rays up to 20 miles and record the fraction blocked by land: this is `shelter`. Bays are connected sea regions with shelter above 0.6. Harbour score = shelter + estuary bonus (river mouth with flow above `portRiverFlow`) + shore-depth proxy (distance from shore to deeper water) minus a mudflat penalty on very low-slope shores. Pick the top candidates with a minimum spacing of 40 miles. These become `harbourCandidates` (target at least 10).
10. **Soil and land use.** Fertility from low slope, moderate elevation, rainfall, river proximity (floodplain bonus) and noise. Then:
    - `rock`: elevation above `mountainLine` (default 900 m) or slope above `rockSlope`. Not farmable, not buildable.
    - `moor`: elevation 600 to 900 m. Rough grazing only.
    - `marsh`: very low, flat, near river mouths or very wet.
    - `forest`: wet, mid-fertility cells chosen by noise and not already claimed as farmland.
    - Remaining land gets `arable` and `pastoral` scores. Arable favours flat, fertile, moderate rain. Pastoral favours hills and higher rain. Class is `arable` if arable > pastoral + margin, `pastoral` if the reverse, else `mixed`.
    - Everything that is not `rock` is farmable, buildable or exploitable, as required.
11. **Resources.** Place deposits as blobs with size and richness: coal in foothill sedimentary basins, iron in uplands near coal basins, stone in uplands and ridges, clay on floodplains and low valleys. Guarantee at least 4 coal, 4 iron, 6 stone and 6 clay deposits, with at least 3 coal and iron deposits within 60 miles of each other (so chains are possible). Forest comes from `landuse`. Fishing grounds come from shallow shelf near coast.
12. **Names.** Generate (5.7).
13. **Settlements** (5.4), **links** (5.5), **industries** (5.6).
14. **Validation** (5.3). If it fails, derive the next attempt seed from `seed + attempt` and retry, up to 12 attempts. Record `attempt` in the save so regeneration is reproducible.

### 5.3 Validation rules (`validateWorld`)

All must pass:

- Land fraction 35 to 50 percent. Exactly one major landmass.
- At least 3 rivers with source-to-sea length over 100 miles. Every river cell reaches the sea or a lake.
- At least 1 mountain range with `rock` cells totalling 40 or more cells.
- At least 10 harbour candidates, at least 3 estuary harbours.
- At least 5 percent of land in each of `arable`, `pastoral`, `forest`. At least 1 percent `marsh`.
- Settlement counts within bounds (5.4). The capital is within 12 miles of a harbour or estuary.
- Every settlement is reachable from the capital by road. Every port is reachable by sea from every other port.
- Resource guarantees from step 11.
- Generation time in Node under 5 seconds.

### 5.4 Settlements

Hierarchy and targets:

| Kind | Count | Min spacing (miles) | Initial population incl. hinterland |
|---|---|---|---|
| Capital | 1 | n/a | 250,000 to 450,000 |
| City | 6 to 8 | 70 | 40,000 to 150,000 |
| Town | 24 to 32 | 25 | 6,000 to 30,000 |
| Village | 90 to 130 | 8 | 1,200 to 6,000 |
| Hamlet | 110 to 160 | 4 | 250 to 1,000 |

Placement: score each buildable land cell by local fertility (10-mile radius), fresh water (river within 4 miles or coast), flatness, confluence or river-crossing bonus, harbour bonus, nearby resources, minus penalties for marsh, steep slope and `rock`. Place the capital first (coastal or estuary, large fertile hinterland, near central coordinates, near a harbour), then cities, towns, villages and hamlets, each by best remaining score subject to spacing. Add jitter to avoid grid-aligned patterns.

Each settlement gets:
- Hinterland: cells within radius (hamlet 3, village 6, town 10, city 16, capital 24 miles) assigned to the nearest settlement by size-weighted distance. Writes `region`.
- Port tier 0 to 3 if it sits on a harbour candidate or estuary. All ports are on the periphery.
- Initial class split by kind and sector (Upper / Middle / Working percent): village 3/12/85, town 5/25/70, industrial city 4/22/74, trading city 8/32/60, capital 12/38/50. Adjust by hinterland (large estates raise Upper in villages).
- Initial housing capacity of 105 percent of population.

### 5.5 Links (initial network)

A link is an edge between two nodes (settlement or industry) with `mode` (`road`, `rail`, `sea`), `tier`, `lengthMiles`, a simplified `path` polyline in world miles, `gradient` factor, `condition` 0 to 1, and `owner` (`public` or `player`).

- **Roads:** A* over terrain cost (slope, river crossing penalty, marsh penalty, `rock` forbidden). Connect each settlement to its 2 to 3 nearest neighbours (rank-aware: villages attach upward). Then ensure the whole graph is connected by adding minimum-spanning links by path cost, and add a few cycle edges (relative-neighbourhood graph filter). Tier 1 turnpike between capital and cities. Tier 0 cart track elsewhere.
- **Rail skeleton:** tier 0 early line between the capital and the 3 to 5 largest cities where terrain allows, and short tramways from coal and iron mines to the nearest river port or town. Never more than about 15 percent of road mileage.
- **Sea:** coastal lanes between each port and its 2 to 3 nearest ports, routed by A* over sea cells. Capacity by port tier (Appendix C).
- **Overseas:** each port has a virtual link to the `world` node for imports and exports (7.9).

### 5.6 Industry placement and siting rules

Industries are entities with a location. Farms are not entities: farming is a hinterland calculation per settlement (7.2).

Siting rules in `industries.json`:

| Rule | Meaning |
|---|---|
| `resource:<id>` | On a deposit cell of that type. |
| `river` | Within 1 cell of a river of width class 2 or higher (water power or process water). |
| `coast` | Coastal land cell. |
| `harbour` | Within 6 miles of a harbour candidate or estuary port. |
| `forest` | Forest cell or adjacent. |
| `town:<kind>` | Within 4 miles of a settlement of that kind or larger. |
| `near:<cargo>` | Within 25 miles of a producer of that input (prefer). |

Initial counts per era are in Appendix B. Each industry gets a `homeSettlementId` (nearest settlement within 10 miles) which supplies its labour. Initial set is era-gated to the start year, then grows and shrinks (7.8).

### 5.7 Names

`names.json` holds syllable and morpheme tables by place type. Settlements: stems plus endings (`-ton`, `-ford`, `-bury`, `-by`, `-wick`, `-ham`), coastal endings (`-mouth`, `-haven`, `-port`, `-stow`), prefixes (`Upper`, `Nether`, `Little`, `Great`, `Port`, `Saint`). Rivers, bays and ranges have their own tables. Names are unique per save, deterministic from the seed, and never clash with known real place names in a small blocklist file. The island itself gets a name.

---

## 6. Entities and rules data

### 6.1 Social classes

| Class | Typical roles | Consumption profile | Mobility |
|---|---|---|---|
| Upper | Landowners, merchants, financiers, owners | High luxuries and goods, steady food, low sensitivity to price | Low |
| Middle | Professionals, shopkeepers, clerks, managers, skilled trades | Balanced, rising goods and clothing | Medium |
| Working | Labourers, miners, mill hands, farm workers, domestic service | Food and fuel heavy, price sensitive | High (moves for work) |

Each settlement stores population, employed count and confidence per class.

### 6.2 Cargo

About 30 cargo types in `cargo.json`. See Appendix A for the starter table. Each has: `id`, `name`, `unit` (tonnes by default), `basePrice` (pounds per tonne), `elasticity`, `decayPerMonth`, `category` (`bulk`, `general`, `perishable`, `livestock`, `liquid`), `eraFrom`, `importable`, `exportable`.

### 6.3 Industries

`industries.json` entries: `id`, `name`, `tier` (`primary`, `secondary`, `tertiary`), `siteRules`, `inputs` (cargo to tonnes per month at full output), `outputs`, `jobs` (working, middle, upper per full output), `buildCost`, `eraFrom`, `eraTo`, `maxPerNode`, `storageMonths`. Appendix B has the starter set and the chains they form.

### 6.4 Settlement sector (tertiary)

Not individual entities. Each settlement has a service sector whose jobs and demand scale with population and wealth: retail, trades, professions, domestic service. It buys finished goods and provides middle and working jobs. This is the main source of Middle class growth.

### 6.5 Eras

`eras.json` holds the timeline (Appendix F): date gates for industries and vehicles, agricultural productivity multiplier by year (fewer farm workers needed over time, pushing rural-to-urban migration), health improvement (death rate falls), and world demand curves for exports.

---

## 7. Economic model (Phase 1 core)

### 7.1 Monthly cycle

Runs in this order every 30 game days. Steps 1 to 11 must be pure functions of state plus seeded random draws.

1. Apply economy level multipliers (Appendix D).
2. Hinterland farm output per settlement (7.2).
3. Industry production (7.2).
4. Consumption by population and industries (7.3).
5. Stock decay for perishables.
6. Prices (7.4).
7. Baseline carrier flows between nodes (7.5).
8. Imports and exports at ports (7.9).
9. Housing and construction (7.6).
10. Population: births, deaths, migration (7.6).
11. Employment and confidence (7.7).
12. Industry lifecycle: open, close, expand (7.8).
13. Snapshot island totals to `history_monthly`. Append events.
14. In March and September, run 7.10 after step 13.

### 7.2 Production

**Farms (hinterland).** For each settlement, sum over hinterland cells:
`grain = Σ arable * a_g`, `livestock, wool, milk = Σ pastoral * a_l`, mixed cells give about 60 percent of each at half the yields, `timber = Σ forest * a_t`. Yields per cell per month are in `economy.json`. Multiply by `era.agriProductivity(year)` and by the economy level production multiplier. Seasonal factor (harvest peak in months 8 to 10 for grain, spring for wool) gives a mild annual rhythm. Farm labour demand is a fixed share of Working pop in villages and hamlets, falling with agricultural productivity over time.

**Industries.** Utilisation `u` for the month:

```
labour    = min(1, workersAvailable / workersNeededAtFullOutput)
inputs    = min over inputs (stockOfInput / needAtFullOutput), capped 1
outputRoom= clamp((outputCap - currentOutputStock) / monthlyOutputAtFull, 0, 1)
u         = labour * inputs * outputRoom * economyProductionMultiplier (then cap 1.3)
```

Production adds `u * outputs` to the industry's local stock and removes `u * inputs`. `outputCap` is `storageMonths` times full monthly output. An industry that cannot sell stalls rather than piling up forever.

Workers available come from the home settlement's pool of unemployed people by class (7.7).

### 7.3 Demand

**Population demand** per 1,000 people per month, by class and cargo (starter values in `economy.json`):

| Cargo | Working | Middle | Upper | Note |
|---|---|---|---|---|
| food | 30 t | 34 t | 40 t | Rural settlements self-supply part from hinterland. |
| coal (heating, cooking) | 15 t | 20 t | 25 t | Seasonal factor 0.6 in summer up to 1.6 in winter. |
| clothing | 2 t | 3 t | 5 t | |
| goods | 2 t | 4 t | 8 t | |
| beer | 8 t | 6 t | 4 t | |
| luxuries | 0 | 0.2 t | 1.2 t | Imports mostly. |
| cars (from 1900) | 0 | 0.05 t | 0.3 t | 7.7 and 10.7. |

Demand is multiplied by the class confidence spending factor (0.7 at confidence 0, 1.0 at 50, 1.2 at 100) and the economy level demand multiplier.

**Industry demand** is the monthly input need at the planned utilisation.

**Construction demand** (bricks, planks, stone) arises from housing shortage (7.6).

`monthlyDemand[node][cargo]` is the sum of all three. In `basic` demand mode, any settlement of town size or larger demands every consumer cargo regardless of population mix.

### 7.4 Prices

For each node and cargo:

```
coverage  = stock / max(demand, tiny)            // demand 0 means coverage = infinity
priceMult = clamp(coverage ^ (-elasticity), pMin, pMax)    // defaults pMin 0.4, pMax 3.0
price     = basePrice * priceMult * economyRevenueMultiplier
```

Use a lookup table for the fractional power so results are engine-independent (4.5). Producers sit near `pMin`, scarce consumers sit near `pMax`. The gradient between neighbours drives flow (7.5) and, in Phase 3, drives the revenue premium (10.4).

### 7.5 Baseline carrier flows (the "trickle")

This is what keeps the island alive with no player services. It is deliberately slow and lossy.

Every link has capacity from its tier (Appendix C). Baseline carriers may use at most `baselineShare` (default 0.15) of that capacity, and lose a fraction `baselineLoss` of what they carry (roads 12 percent, rail 6, sea 4).

Algorithm, done synchronously from a snapshot so results do not depend on node order:

1. Compute prices for all nodes and cargos.
2. For each link and each cargo, for each direction from the lower-priced node `a` to the higher-priced node `b`: `gradient = (price_b - price_a) / price_a`. Skip if below `minGradient` (default 0.1).
3. `available = max(0, stock_a - reserve_a)` where reserve is the node's own coming-month demand times `reserveMonths` (default 0.5). Producers have reserve 0 on outputs.
4. `desired = min(available * flowRate, available * gradientFactor(gradient))` where `flowRate` default 0.3.
5. If a source node is oversubscribed across links, scale desired flows proportionally. If a link is oversubscribed, allocate capacity in order of descending `gradient * price_a` (most valuable gradient per tonne first), then scale.
6. Apply: source loses `moved`, destination gains `moved * (1 - loss)`.

Multi-hop movement happens over successive months. Cargo that nobody wants and nobody can move decays or stalls as stock, which lowers its price to the floor and eventually closes the producer (7.8).

### 7.6 Population, housing and migration

Per settlement and class, monthly:

```
births   = pop * birthRate(year, class) / 12 * foodFactor * housingFactor
deaths   = pop * deathRate(year, class) / 12 * (1 + shortagePenalty)
```

Defaults for 1830: crude birth 33 per 1,000 per year, death 22, falling death rate over the century (about 13 by 1930). `foodFactor` drops below 1 when food coverage is under 0.8. `housingFactor` drops when population exceeds housing capacity. Both floors are 0.5.

**Attractiveness** for class `c` in settlement `s`:

```
A(s,c) = 0.35*jobAvailability + 0.20*realWageIndex + 0.20*needsCoverage
       + 0.15*housingRoom + 0.10*serviceIndex
```

all normalised 0 to 1 in 7.7.

**Migration** along road links only, per month, per class:

```
movers(s -> t, c) = pop(s,c) * mobility(c) * max(0, A(t,c) - A(s,c)) * linkEase(s,t) * decay(distance)
```

`mobility` defaults: Working 0.02, Middle 0.008, Upper 0.002. Total outflow from a settlement is capped at 3 percent of a class per month. Multi-hop migration emerges over time.

**Ports** receive immigrants when island mean attractiveness exceeds a world baseline and lose emigrants when below, with era-dependent waves from `eras.json`. Immigrants arrive as Working class mostly.

**Rural drift.** As agricultural productivity rises, farm labour need falls and unemployed rural Working class migrate toward higher attractiveness, which naturally favours towns and cities.

**Class drift.** Each year, class shares move 10 percent of the way toward the shares implied by local jobs (plus a small rentier Upper floor). This is how a trading city becomes more Middle and a mill town stays Working.

**Housing.** `housingCapacity` per settlement. When population exceeds 95 percent of capacity, the settlement requests construction: demand for bricks, planks and stone scaled to the shortfall. Each month it builds `min(shortfall, materialsAvailable / materialsPerHome)` homes. No materials, no homes, and overcrowding lowers confidence and births. Population above 110 percent of capacity also raises deaths. This ties building-material industries to growth.

**Shrinkage.** Housing capacity decays slowly (0.2 percent a month) when population is below 70 percent of capacity (abandonment), so shrinking places visibly lose buildings in Phase 2.

### 7.7 Employment and confidence

**Jobs.** Each industry offers `jobs[class] * u_planned` positions, farms offer a labour share, the service sector offers jobs proportional to population and wealth, and construction offers jobs per home built. Industries draw from their `homeSettlementId` first, then the nearest neighbour settlement by road if short.

```
employmentRate(s,c) = employed(s,c) / labourForce(s,c)       // labourForce = pop * participation(c)
jobAvailability(s,c)= clamp(vacancies(s,c) / labourForce(s,c) * 5, 0, 1)
```

**Wages and real wage index.** `wage(c)` base per class from `economy.json`, scaled by local tightness (low unemployment lifts it a little). Cost of living is the price of the class basket (food, coal, clothing, goods) at local prices. `realWageIndex = clamp(wage * employmentRate / costOfLiving, 0, 1.5) / 1.5`.

**Needs coverage.** Weighted average coverage (capped 1) of food, coal, clothing for the settlement.

**Confidence** per class, 0 to 100:

```
C(s,c) = 100 * (0.40*employmentRate + 0.25*realWageIndex + 0.20*needsCoverage + 0.15*(1 - overcrowding))
```

smoothed with the previous month (0.7 old, 0.3 new) so one bad month does not swing everything. Confidence feeds demand (7.3), migration (7.6) and the island economy score (7.10). Upper class confidence also drives luxury demand and later private car ownership (10.7).

### 7.8 Industry lifecycle

- **Opening.** Each month, for each cargo, if its island-wide mean `priceMult` has stayed above `openThreshold` (default 1.5) for 6 months, and a suitable site exists (5.6), and the era allows, an NPC investor may open an industry that makes it, with probability scaled by Upper class confidence and economy level. Opening needs the inputs to be plausible (a producer of inputs within 40 miles, or imports available).
- **Expansion.** An industry with utilisation above 0.9 for 12 months and unmet price signal gains capacity (+20 percent jobs and output), up to a cap by site quality.
- **Contraction and closure.** Utilisation below 0.3 for 12 months halves capacity. Below 0.15 for 24 months closes it. Closing releases its workers into the unemployed pool, which lowers confidence and prompts migration. Depleted deposits (`richness` falls with cumulative extraction) can trigger closure. Closure and opening emit events.
- **Era retirement.** Industries past `eraTo` shrink and close, replaced by successors in the same chain where defined.

### 7.9 Imports and exports

Ports connect to the `world` node. For each cargo flagged `importable`, a port of tier `T` supplies up to `importCap(T, cargo, year)` tonnes a month at `basePrice * worldPriceFactor`. For each `exportable` cargo, the world demands up to `exportCap` at a price from `eras.json` with the economy level applied. Imports reach inland nodes only through flows (7.5, and Phase 3 services). Trade balance (value exported minus value imported) feeds the economy score. Port tier rises when throughput stays high, and port infrastructure is a Phase 3 investment.

### 7.10 Island economy level

Five levels: Depression (0), Recession (1), Normal (2), Prosperity (3), Boom (4). Checked each March and September.

```
score = 0.25*employmentMean + 0.20*outputGrowth + 0.15*tradeBalanceIndex
      + 0.20*confidenceMean + 0.15*playerActivity + 0.05*shock
```

- `playerActivity` is a normalised measure of link-miles upgraded and vehicle-miles run over the last 6 months, plus company profitability. It is 0.5 neutral in Phase 1.
- `shock` is a seeded random draw from -1 to +1.
- Level moves at most one step per check. Up if `score > upThreshold[level]`, down if `score < downThreshold[level]`, with hysteresis (down thresholds lower than up thresholds).
- **Momentum:** if the previous change was upward, add +0.05 to the score (and the reverse downward), so trends tend to continue.
- Level effects are in Appendix D: production, demand, revenue and construction cost multipliers, interest rate and tax rate.

The forum discussion of Railroad Tycoon 2 suggests that real activity matters more than raw cash. That is reflected by counting miles and utilisation rather than pounds.

---

## 8. Database and API

### 8.1 Static rules JSON (`public/data/`)

| File | Content |
|---|---|
| `client.json` | API base URLs, autosave interval, default speed, UI flags. |
| `mapgen.json` | All generator parameters (5.2). |
| `terrain.json` | Land use enum, colours for Phase 1 debug view, thresholds. |
| `settlements.json` | Kind table: counts, spacing, hinterland radius, class splits. |
| `names.json` | Name morphemes and blocklist. |
| `classes.json` | Class parameters: participation, mobility, wage, spending. |
| `cargo.json` | Cargo catalogue. |
| `industries.json` | Industry catalogue. |
| `economy.json` | Yields, demand tables, price constants, flow constants, population constants, multipliers by level. |
| `difficulty.json` | Difficulty levels: starting cash, shock amplitude, demand mode, starting population scale. |
| `eras.json` | Timeline and curves. |
| `links.json` | Tier tables for road, rail, sea. |
| `vehicles.json` | Phase 3 vehicle catalogue. |
| `ranks.json` | Phase 3 rank thresholds and achievements. |
| `palette.json` | Phase 2 colours. |

`rules.js` loads these, validates them (required fields, ranges, cross references such as an industry input naming a missing cargo) and throws a readable error. Both the client and the PHP checkpoint validator use the same files.

### 8.2 MySQL schema (InnoDB, utf8mb4)

Phase 1 tables. Keys written as `PK(...)`.

```
users(id, username UNIQUE, email, password_hash, created_at)
sessions(id, user_id FK, token_hash CHAR(64) UNIQUE, created_at, expires_at, last_seen)
login_attempts(id, username, attempted_at, success)

saves(id, user_id FK, name, seed VARCHAR(40), attempt TINYINT, generator_version SMALLINT,
      start_year SMALLINT, difficulty VARCHAR(16), game_day INT, version INT,
      settings JSON, created_at, updated_at)
save_map(save_id PK FK, blob MEDIUMBLOB, checksum CHAR(16), bytes INT)

settlements(save_id, id, name, kind, x, y, port_tier, housing, region_cells INT,
            stock JSON, PK(save_id,id))
settlement_pop(save_id, settlement_id, class TINYINT, pop INT, employed INT, confidence FLOAT,
               PK(save_id,settlement_id,class))
industries(save_id, id, type_id, name, x, y, home_settlement_id, capacity FLOAT, utilisation FLOAT,
           richness_left FLOAT, opened_day INT, closed_day INT NULL, months_low INT, stock JSON,
           PK(save_id,id))
links(save_id, id, a_type CHAR(1), a_id, b_type CHAR(1), b_id, mode VARCHAR(8), tier TINYINT,
      length_mi FLOAT, gradient FLOAT, condition FLOAT, owner VARCHAR(8), path JSON,
      PK(save_id,id))
economy_state(save_id PK, level TINYINT, last_change_dir TINYINT, last_check_day INT, indicators JSON)
company(save_id PK, name, cash DECIMAL(14,2), loans DECIMAL(14,2), rank_key VARCHAR(24), stats JSON)
history_monthly(save_id, month_index INT, pop_total INT, pop_u INT, pop_m INT, pop_w INT,
                employment FLOAT, confidence FLOAT, trade_value DOUBLE, level TINYINT, extra JSON,
                PK(save_id,month_index))
events_log(id, save_id, game_day INT, kind VARCHAR(24), subject_type, subject_id, text VARCHAR(255))
```

Phase 3 adds: `stops`, `vehicles`, `services`, `service_orders`, `ledger_monthly`, `annual_statements`, `achievements`. See 10.

Notes: stockpiles live in the `stock` JSON column of settlements and industries (sparse map of cargo id to tonnes) to avoid thousands of tiny rows. Prices are derived, never stored. Migrations are numbered SQL files run by `api/migrate.php`.

### 8.3 API (file per endpoint, JSON in and out)

Path parameters are passed as query string or body fields, so no Apache rewrites are needed under `/api`.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/auth/register.php` | POST | Create user (if allowed). Returns token. |
| `/api/auth/login.php` | POST | Returns token and user. |
| `/api/auth/logout.php` | POST | Deletes session. |
| `/api/auth/me.php` | GET | Current user. |
| `/api/saves/list.php` | GET | The user's saves with summary stats. |
| `/api/saves/create.php` | POST | Body: meta, world rows, blob (base64). One transaction. |
| `/api/saves/load.php?id=` | GET | Save row, entity rows, economy, company, recent history. |
| `/api/saves/map.php?id=` | GET | The map blob as `application/octet-stream`. |
| `/api/saves/checkpoint.php` | POST | Body: id, baseVersion, gameDay, changed rows, history, events. Returns new version. |
| `/api/saves/delete.php` | DELETE | Delete a save and its rows. |

Errors are `{ "error": { "code": "...", "message": "..." } }` with sensible HTTP status codes (400, 401, 403, 404, 409, 413, 422, 429).

---

## 9. Phase 2: graphical model

### 9.1 Goals

A game-like, high-resolution view of the island and its life. Smooth wheel zoom and drag pan. Named places floating above their locations. Evidence of activity and of growth or decline. Procedural art only.

### 9.2 Camera and zoom

World in miles. Zoom is pixels per mile (`ppm`). Range roughly 1.5 (whole island visible) to 96 (one cell is 192 pixels). Wheel zoom is exponential and anchored to the cursor, with a short eased animation. Drag to pan with inertia. Pan is clamped to the island plus margin. Keyboard: arrows pan, plus and minus zoom, Home fits the island. Optional touch pinch.

Four semantic bands (echoing the reference games):

| Band | ppm | Shows |
|---|---|---|
| Region | 1.5 to 4 | Terrain colours, coast, large rivers, city and capital labels, big ports. |
| Area | 4 to 12 | Towns, roads and rail, regional industries, smoke. |
| Local | 12 to 36 | Villages, individual industries, carts and ships, hinterland fields. |
| Detail | 36 to 96 | Individual buildings, tree and crop patterns, street layouts. |

### 9.2.1 Projection

Every conversion between world miles and screen pixels goes through one module, `src/render/projection.js`. No other renderer code does its own screen maths. It exports:

- `worldToScreen` and `screenToWorld`, the pair the camera and pointer handling use.
- `visibleWorldPolygon(viewport)`, the world-space footprint of the viewport. It is a rectangle in top-down and a rotated quad in any other projection. Tile selection, culling, label placement and hit testing all call it.
- `tileTransform(tile)`, the matrix used to draw a cached tile.
- `depthKey(x, y, z)`, the draw order for tall objects. It is constant in top-down.

The shipped projection is top-down. A 2:1 isometric projection is a candidate replacement, to be settled by the spike in T2.00. Either way, terrain tiles are rendered in world-aligned space in the workers (9.4) and are only placed on screen through `tileTransform`, so the tile pipeline does not change. The hillshade light direction is read from `palette.json` instead of being fixed in the shader, so it can follow the view.

Sprite packs are not in use. All art is procedural (0.2, item 7). If T2.00 recommends bringing in CC0 or CC BY sprites for small objects, that item and `CLAUDE.md` must be amended first.

### 9.3 Layers and canvases

Stacked canvases, each sized to the viewport times `devicePixelRatio` (clamped to 2):

1. **Terrain** from cached tiles.
2. **Static overlays:** rivers, roads, rail, sea lanes, land use hints.
3. **Dynamic world:** settlements, industries, ships, carts, trains, smoke.
4. **Labels.**
5. **HUD** is React/DOM, not canvas.

Only layers whose inputs changed are redrawn. Animated layers redraw per frame only while something animates or the camera moves.

### 9.4 Terrain tiles

Tile pyramid, 512 px tiles, zoom levels aligned to `ppm` steps of 2x. Rendered in Web Workers with `OffscreenCanvas`, returned as `ImageBitmap`, stored in an LRU cache (memory cap in config). Per pixel:

- Bilinear (bicubic at high zoom) sample of elevation for smooth relief, with small deterministic noise for texture so cells never look blocky.
- Hillshade from a north-west light.
- Colour from a land-use blend (palette in `palette.json`), with soil and moisture tinting.
- Sea depth gradient, shore foam band, and a crisp coastline taken from a signed distance field built from smoothed elevation so the coast stays sharp at any zoom.
- At `ppm >= 24`: deterministic scatter of tree glyphs on forest, hedgerow and field patterns on farmland (arable stripes, pasture patches), heather speckle on moor, reeds on marsh.
- Rivers drawn as smooth variable-width curves from traced flow paths, with estuaries widening toward the sea. Lakes with soft edges.

Style target: a hand-painted atlas look, warm and readable, with strong value contrast so labels stay legible.

### 9.5 Settlements and growth

- Region band: a soft blob sized by the square root of population, tinted by dominant class mix.
- Area and local bands: a footprint polygon with streets.
- Detail band: individual procedural buildings. Cottages and terraces for Working class districts, shops and townhouses for Middle, villas and estates for Upper. Church or chapel, market square, mill, wharf where relevant. Layout is deterministic from the settlement id.
- Number of buildings tracks `housingCapacity`. New buildings fade and scale in. Shrinkage shows abandoned buildings with darker, desaturated roofs, then collapse and removal.
- A small trend arrow and pop figure appear on hover and in the info panel. History sparkline in the panel.

### 9.6 Evidence of commercial activity

- Industries: smoke or steam particles scaled by utilisation. Mine head-frames, water wheels or mills that turn, furnaces glowing, shipyard slipways with hulls under construction. Idle industries show no smoke and look derelict as months of closure pass.
- Roads: carts and wagons moving along links at a density proportional to baseline flow, coloured by cargo category. Rail: occasional early trains. Sea lanes: ships between ports in proportion to sea flow. Ports show cranes, stacked crates and moored ships.
- Heat overlays (toggles): prices by cargo, class distribution, confidence, employment, flows, resources, land suitability.

### 9.7 Labels

Name labels float above settlements, with a halo for legibility. Priority by rank then population. A spatial grid declutters labels so none overlap, fading in and out as zoom changes. Label size is nearly constant in screen pixels with a small scale with zoom. Industries and rivers, bays and ranges get labels at appropriate bands (river names follow the path in the Local band, optional).

### 9.8 HUD and interaction

React components over the canvas: date and speed controls, island economy level badge with the 5-step indicator, overlay toggles, search box (jump to a place), minimap with viewport rectangle, selection panel for a clicked settlement, industry or link (pop by class, jobs, confidence, stock and price table, history chart, recent events). The Phase 1 inspector remains as a developer panel.

### 9.9 Performance budget

60 fps pan and zoom at 1920 x 1080 on a mid-range laptop, first interactive render under 3 seconds after data load, tile cache under 400 MB, no main-thread task over 16 ms during interaction (measured). The simulation runs in its own worker.

---

## 10. Phase 3: logistics and finance

### 10.1 Stops and infrastructure

A **stop** is where services load and unload. The player opens a stop at a settlement or an industry for a mode (`road`, `rail`, `sea`). Tiers:

| Tier | Radius (miles) | Cost (1830) | Notes |
|---|---|---|---|
| Halt | 3 | £300 | Basic loading. |
| Station | 6 | £1,200 | More berths, supports longer trains. |
| Terminal | 10 | £4,000 | Large yards, passengers and freight. |

All settlements and industries inside the radius feed supply to the stop and draw demand from it (cargo moves between node stock and stop stock at a monthly rate). Facilities (each with a cost and annual upkeep): warehouse (reduces decay for general goods), cold store (perishables), livestock pens, goods shed, maintenance shed (cuts vehicle upkeep), inn or hotel and refreshment rooms (raise passenger fares). Ports use berth tiers.

**Link upgrades.** The player pays to raise a link to a higher tier (Appendix C). Cost scales with length, gradient and the economy level construction multiplier. Upgrades complete after a build time and then raise capacity, speed and condition. Each owned upgrade has annual maintenance. Upgraded miles feed `playerActivity` (7.10).

### 10.2 Vehicles

`vehicles.json` entries: `id`, `mode`, `kind` (`loco`, `wagon`, `coach`, `truck`, `bus`), `name`, `introYear`, `retireYear`, `speedMph`, `capacity` (tonnes or passengers by class), `maxWagons` for locomotives, `cargoClasses` accepted, `price`, `maintenanceRate` (share of price per year, rising with age), `reliability`, `gradeFactor`.

A **train** is a consist: one locomotive plus wagons and coaches chosen by the player up to `maxWagons`. Roads use a single vehicle per unit. Models appear and retire by date (Appendix E). The vehicle shop lists only models whose `introYear` has passed. Old vehicles lose reliability and cost more to maintain, and can be sold at depreciated value.

### 10.3 Services and orders

A **service** is a named route with one or more vehicles. Data:

```
services(save_id, id, name, mode, active, loop BOOL, created_day)
service_orders(save_id, service_id, seq, stop_id, unload JSON, load JSON, auto_load BOOL, max_wait_days)
vehicles(save_id, id, service_id NULL, model_id, bought_day, position JSON, load JSON, state, odometer_mi)
stops(save_id, id, node_type, node_id, mode, tier, facilities JSON)
```

Each order (one per stop in sequence) has:
- `unload`: `all`, `none`, `demanded` (only cargo the stop actually wants, price multiplier above 1), or an explicit list of cargo ids.
- `load`: `none`, `any`, or an explicit list. Lists may be changed fully or partly at each stop, as required.
- `auto_load`: when on, the vehicle picks, at each stop, the cargo list with the best expected revenue for the legs ahead given current prices and stock. It still respects the explicit list as an allow-list if one is set.
- Passenger rule: passengers board and alight at each stop (10.5). The order can restrict classes carried.
- `max_wait_days`: how long to wait for a full load.

Multi-location schedules are just longer order lists. A service may loop or run back and forth.

### 10.4 Freight loading and revenue

Vehicles move along link paths daily at `speed * linkSpeedFactor * gradientFactor / congestionFactor`. Arrival triggers unload then load.

**Loadable stock** at a stop = stop-catchment stock minus the local reserve (the stop nodes' coming-month demand times `reserveMonths`). Imports at a port count as loadable.

**Revenue per delivery** (per tonne):

```
rate = baseRate(cargo) * distanceMiles * speedBonus(deliveryDays) * demandPremium * economyRevenueMultiplier
demandPremium = clamp(priceMult_at_destination, 0.5, 2.0)
speedBonus    = 1.0 when on time, falling to 0.6 if slow, rising to 1.15 if fast
```

Perishables lose value and mass with transit time (`decayPerMonth`). Cargo delivered where it is not demanded earns `0.5 * baseRate` and gets dumped into stock at the destination (which then makes the price there drop). Delivered cargo goes into the destination stock, which is real: it relieves a shortage, lowers price, lifts confidence and employment, and can unlock growth.

**Player vehicles and baseline carriers share stock.** Vehicles draw from stock first each day, so a busy service shrinks the baseline flow on the same link. Baseline carriers continue at their small capped share.

### 10.5 Passenger model

Pairs of stops on the same service (or connected by transfers in later work) have a monthly demand by class from a gravity model:

```
trips(i->j, c) = G(c) * (pop_i,c * pop_j,c)^0.5 / distance^1.2 * confidenceFactor(i,j,c)
               * economyDemandMultiplier * qualityFactor
```

`qualityFactor` rewards speed and frequency and penalises high fares. Passengers are generated at the origin stop each month into a waiting pool by destination and class, with a cap and a slow decay. Vehicles board passengers for later stops of their order list and unload them at their destination. Classes map to fares: Upper first class, Middle second class, Working third class, each with its own fare per mile and vehicle capacity per coach type. Revenue is fare times miles with a punctuality factor.

### 10.6 Capacity, congestion and gradients

Each link has monthly capacity for freight tonnes and passengers (Appendix C). Load on a link in a month is baseline flows plus player vehicle throughput plus private cars (10.7). `congestionFactor = max(1, load / capacity)` raised slightly (power 1.3), slowing every vehicle on the link. `gradient` (from terrain) reduces speed for heavy vehicles and increases upgrade cost. Breakdown chance per vehicle per month falls with reliability and rises with age and a low link `condition`. A broken-down vehicle blocks its place and takes a repair period.

### 10.7 Private cars and traffic

From the car era (about 1905, `eras.json`), a settlement's `carOwnership` is derived from Upper and Middle confidence and wealth, saturating by class. Cars appear as road traffic (load on connected road links, proportional to ownership and population, and to road tier) and take a modal share from bus and rail passenger demand on parallel routes. Car manufacture and fuel are real supply chains (car plant, oil imports). The player does not control cars. Road upgrades reduce congestion and also encourage more cars.

### 10.8 Finance and annual cycle

Money is tracked in `company.cash`. Day-to-day: revenue credited on delivery, and running costs (wages and fuel per vehicle-day, stop upkeep) accrued. Purchases and upgrades debit immediately.

**At each year end:**

1. Compute annual **maintenance due**: per vehicle `maintenanceRate(age) * price`, plus upkeep on owned infrastructure upgrades and facilities.
2. Compute **interest** on loans (7.10 rates), if bonds are enabled.
3. Pre-tax profit = revenue − running costs − maintenance − interest.
4. **Tax** = max(0, pre-tax profit) * `taxRate[economyLevel]` (Appendix D). Config switch to change the base to revenue.
5. Net profit = pre-tax profit − tax. Cash is debited for maintenance, interest and tax.
6. Write an `annual_statements` row and a readable statement view. Update rank (10.9).
7. If cash stays below `-overdraftLimit` for 6 months, trigger insolvency warnings and then game over (sandbox switch can disable).

`ledger_monthly(save_id, month_index, category, amount)` stores rolled-up figures (revenue by service, costs by type) so charts are cheap.

### 10.9 Status and rank

Rank is determined by total cash and net worth (cash + vehicle and asset book value − loans). `ranks.json` thresholds in pounds, with period-flavoured titles (for example Clerk, Contractor, Promoter, Director, Chairman, Magnate). Achievements (first profitable year, first 100 miles served, first export cargo, all five economy levels experienced, 25-year survival, millionaire and so on) are listed in `ranks.json` and unlock on conditions evaluated at year end. A "century review" appears after 100 game years with final rank; play can continue.

### 10.10 Phase 3 UI

Network overview (map plus tabs), stop management, service editor (stop list, drag to reorder, per-stop load and unload editors with cargo pickers, auto-load switch, vehicle assignment, frequency estimate), vehicle shop, finance view (monthly chart, annual statement table), rank and achievements page, link upgrade dialog. On the canvas: vehicles move along links, selected service highlighted, congestion heat on links.

---

## 11. Testing and balancing

- **Unit tests (Vitest)** for rng, noise, each generator step, pricing, flows, population, economy level.
- **Property tests** on 20 fixed seeds: `validateWorld` passes, deterministic checksum equality across two runs, no NaN, no negative stock.
- **Golden seeds:** `ironway-001` to `ironway-005` used in docs and screenshots. Their world checksums are recorded in tests so accidental generator changes are caught.
- **Headless balance harness** `scripts/balance.mjs`: runs N sim years with no player action and prints CSV (population by class, employment, level, price multipliers, closures, openings). Phase 1 gate: 50 years on 5 seeds with no NaN, island population between 0.5x and 6x start, mean employment 60 to 98 percent, at least 90 percent of price multipliers inside `[pMin, pMax]` without sitting on the bounds for more than 25 percent of months, and under 60 seconds per 50-year run.
- **PHP tests:** CLI scripts for auth, ownership checks, version conflicts, validation failures, `.config.json` 403 check. `scripts/smoke.ps1` drives the API with `Invoke-RestMethod`.
- **Phase 2:** frame time capture, label overlap test, tile cache test, screenshot comparison on golden seeds (Playwright) with tolerance.
- **Phase 3 balance harness:** scripted player strategies (do nothing, one coal line, wide network) must yield sensible profit ordering and no exploit that earns unlimited money from one short loop.

All numbers in the JSON files and in this document are starter values. Expect a tuning pass at the end of each phase.

---

## 12. Appendices

### Appendix A: Cargo (starter)

| id | Category | £/t | Elasticity | Decay /month | Era from | Imp | Exp |
|---|---|---|---|---|---|---|---|
| grain | bulk | 8 | 0.6 | 0.01 | 1830 | no | yes |
| livestock | livestock | 14 | 0.6 | 0.02 | 1830 | no | yes |
| wool | general | 40 | 0.5 | 0.003 | 1830 | no | yes |
| milk | perishable | 9 | 0.7 | 0.30 | 1830 | no | no |
| timber | bulk | 6 | 0.5 | 0 | 1830 | yes | no |
| stone | bulk | 4 | 0.4 | 0 | 1830 | no | no |
| clay | bulk | 2 | 0.4 | 0 | 1830 | no | no |
| coal | bulk | 5 | 0.6 | 0 | 1830 | no | yes |
| iron_ore | bulk | 4 | 0.5 | 0 | 1830 | yes | no |
| fish | perishable | 18 | 0.7 | 0.25 | 1830 | no | yes |
| cotton | general | 45 | 0.5 | 0.003 | 1830 | yes | no |
| hides | general | 20 | 0.5 | 0.02 | 1830 | yes | no |
| flour | general | 14 | 0.6 | 0.02 | 1830 | no | no |
| food | perishable | 22 | 0.7 | 0.08 | 1830 | no | yes |
| beer | general | 20 | 0.5 | 0.03 | 1830 | no | yes |
| planks | bulk | 10 | 0.5 | 0 | 1830 | no | no |
| bricks | bulk | 6 | 0.5 | 0 | 1830 | no | no |
| cloth | general | 60 | 0.5 | 0.003 | 1830 | no | yes |
| clothing | general | 90 | 0.5 | 0.005 | 1830 | no | yes |
| leather | general | 45 | 0.5 | 0.005 | 1830 | no | no |
| iron | bulk | 12 | 0.5 | 0 | 1830 | no | yes |
| steel | bulk | 20 | 0.5 | 0 | 1856 | no | yes |
| machinery | general | 120 | 0.4 | 0 | 1830 | yes | yes |
| goods | general | 85 | 0.5 | 0.003 | 1830 | no | yes |
| ships | special | 2,000 | 0.3 | 0 | 1830 | no | yes |
| luxuries | general | 300 | 0.4 | 0.003 | 1830 | yes | no |
| rubber | general | 80 | 0.4 | 0.005 | 1890 | yes | no |
| oil | liquid | 15 | 0.5 | 0 | 1895 | yes | no |
| cars | general | 400 | 0.4 | 0 | 1900 | no | yes |
| mail | general | 500 | 0.3 | 0 | 1830 | no | no |

### Appendix B: Industries (starter chains)

| Industry | Tier | Site | Inputs (t/mo at full) | Outputs | Jobs W/M/U | From | To |
|---|---|---|---|---|---|---|---|
| Coal mine | primary | resource:coal | none | coal 3000 | 120/6/1 | 1830 | |
| Iron mine | primary | resource:iron | none | iron_ore 2000 | 100/5/1 | 1830 | |
| Quarry | primary | resource:stone | none | stone 2500 | 60/3/1 | 1830 | |
| Clay pit | primary | resource:clay | none | clay 2000 | 40/2/1 | 1830 | |
| Forestry camp | primary | forest | none | timber 800 | 30/2/1 | 1830 | |
| Fishery | primary | harbour | none | fish 120 | 40/2/1 | 1830 | |
| Flour mill | secondary | river | grain 600 | flour 540 | 12/3/1 | 1830 | |
| Food works | secondary | town:town | flour 400 or livestock 200 or milk 300 or fish 100 | food 380 | 30/6/1 | 1830 | |
| Slaughterhouse | secondary | town:town | livestock 200 | food 120, hides 30 | 20/4/1 | 1830 | |
| Brewery | secondary | town:town | grain 200 | beer 260 | 20/4/2 | 1830 | |
| Sawmill | secondary | river | timber 500 | planks 450 | 25/3/1 | 1830 | |
| Brickworks | secondary | near:clay | clay 800, coal 160 | bricks 700 | 40/3/1 | 1830 | |
| Ironworks | secondary | river | iron_ore 600, coal 800 | iron 300 | 90/8/2 | 1830 | |
| Steelworks | secondary | river or harbour | iron 400, coal 500 | steel 350 | 120/10/2 | 1856 | |
| Engineering works | secondary | town:city | iron 200 or steel 200, coal 60 | machinery 40 | 80/15/2 | 1830 | |
| Textile mill | secondary | river | wool 100 or cotton 100 | cloth 90 | 150/8/2 | 1830 | |
| Garment works | secondary | town:town | cloth 90 | clothing 80 | 90/10/2 | 1830 | |
| Tannery | secondary | river | hides 60 | leather 45 | 20/2/1 | 1830 | |
| Goods works | secondary | town:city | iron 100, planks 50 | goods 120 | 60/8/2 | 1830 | |
| Shipyard | secondary | harbour | planks 300, iron 100, cloth 20 | ships 0.6 | 160/12/3 | 1830 | |
| Car plant | secondary | town:city | steel 120, machinery 10, leather 15, rubber 20 | cars 40 | 200/25/3 | 1900 | |

Chains: farm to mill to food works to town. Mine to ironworks (with coal) to engineering works and goods works. Clay and coal to brickworks to housing. Timber to sawmill to housing and ships. Wool or cotton to textile mill to garment works to town.

### Appendix C: Link tiers (starter)

| Mode | Tier | Name | Speed mph | Freight t/mo | Passengers/mo | Upgrade £/mile | Era |
|---|---|---|---|---|---|---|---|
| road | 0 | Cart track | 3 | 150 | 400 | 800 | 1830 |
| road | 1 | Turnpike | 5 | 600 | 1,500 | 4,000 | 1830 |
| road | 2 | Macadam road | 8 | 1,200 | 3,000 | 9,000 | 1840 |
| road | 3 | Metalled road | 18 | 3,000 | 8,000 | 20,000 | 1910 |
| rail | 0 | Early line | 12 | 1,500 | 3,000 | n/a | 1830 |
| rail | 1 | Single line | 25 | 6,000 | 12,000 | 20,000 | 1830 |
| rail | 2 | Double line | 40 | 25,000 | 50,000 | 35,000 | 1850 |
| rail | 3 | Main line | 60 | 60,000 | 120,000 | 60,000 | 1880 |
| sea | by port tier | Coastal lane | 6 to 14 | 800 to 8,000 | 1,000 to 10,000 | n/a | 1830 |

### Appendix D: Economy levels (starter)

| Level | Production | Demand | Revenue | Build cost | Interest | Tax on profit |
|---|---|---|---|---|---|---|
| Depression | 0.80 | 0.80 | 0.85 | 0.80 | 11% | 10% |
| Recession | 0.90 | 0.92 | 0.93 | 0.90 | 9% | 15% |
| Normal | 1.00 | 1.00 | 1.00 | 1.00 | 7% | 20% |
| Prosperity | 1.10 | 1.08 | 1.08 | 1.10 | 6% | 25% |
| Boom | 1.20 | 1.18 | 1.15 | 1.25 | 5% | 30% |

### Appendix E: Vehicles (starter, generic names)

| id | Mode | Name | Intro | Retire | Speed mph | Capacity | Price £ | Maint %/yr |
|---|---|---|---|---|---|---|---|---|
| horse_wagon | road | Horse wagon | 1830 | 1925 | 3 | 3 t | 60 | 8 |
| stagecoach | road | Stagecoach | 1830 | 1900 | 8 | 12 pax | 250 | 9 |
| horse_omnibus | road | Horse omnibus | 1835 | 1915 | 6 | 22 pax | 180 | 9 |
| steam_wagon | road | Steam wagon | 1895 | 1925 | 8 | 5 t | 600 | 10 |
| motor_lorry | road | Motor lorry | 1908 | | 15 | 4 t | 450 | 9 |
| motor_bus | road | Motor bus | 1905 | | 12 | 28 pax | 500 | 9 |
| loco_early | rail | Early steam locomotive | 1830 | 1860 | 20 | pulls 10 | 1,500 | 7 |
| loco_goods | rail | Goods locomotive | 1850 | 1890 | 22 | pulls 20 | 3,000 | 6 |
| loco_express | rail | Express locomotive | 1865 | 1910 | 45 | pulls 12 | 4,500 | 6 |
| loco_compound | rail | Compound locomotive | 1890 | | 55 | pulls 25 | 6,500 | 5 |
| loco_heavy | rail | Heavy mixed-traffic locomotive | 1910 | | 60 | pulls 35 | 9,000 | 5 |
| wagon_open | rail | Open wagon | 1830 | | n/a | 6 t | 80 | 3 |
| wagon_box | rail | Box wagon | 1830 | | n/a | 6 t | 100 | 3 |
| coach_third | rail | Third class coach | 1830 | | n/a | 40 pax | 150 | 3 |
| coach_second | rail | Second class coach | 1830 | | n/a | 30 pax | 180 | 3 |
| coach_first | rail | First class coach | 1830 | | n/a | 18 pax | 220 | 3 |

### Appendix F: Era timeline (starter)

| Year | Event |
|---|---|
| 1830 | Start. Horse transport, early steam, wooden ships, windmills and water mills. |
| 1840 | Agricultural productivity step up. Macadam roads. |
| 1850 | Double-track railways. Goods locomotives. |
| 1856 | Steel becomes available at scale. |
| 1870 | Railways mature. Population growth peaks. |
| 1880 | Main-line railway standard. |
| 1890 | Rubber imports. Compound locomotives. |
| 1895 | Oil imports. First steam wagons. |
| 1900 | Car plants possible. |
| 1905 | Motor buses. Private cars appear. |
| 1910 | Metalled roads. Heavy locomotives. |
| 1920 | Mass-produced cars. Lorries dominate short freight. |
| 1930 | Century review. |

### Appendix G: Licence summary

This work is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0).

In short, you are free to:
- **Share:** copy and redistribute the material in any medium or format.
- **Adapt:** remix, transform and build on the material.

Under these terms:
- **Attribution:** give appropriate credit, link to the licence, and indicate if changes were made.
- **NonCommercial:** you may not use the material for commercial purposes.
- **ShareAlike:** if you remix or build on it, distribute your contributions under the same licence.
- **No additional restrictions:** you may not add legal terms or technology that restrict others from doing what the licence permits.

This summary is not the licence. Full terms: https://creativecommons.org/licenses/by-nc-sa/4.0/ and legal code at https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode
