# Progress

One dated line per finished task: id, what changed, anything left.

- 2026-10-16 T0.01: Vite React 18 JS scaffold in project root, axios, react-router-dom, fflate, vitest installed, react-doctor installed (100/100). Folder layout from DESIGN 3.2 stubbed. One CSS file. README, CREDITS, LICENSE.md, DECISIONS written. test, build and dev pass. Left: not a git repo yet, nothing committed.
- 2026-10-16 T0.02: Initialised git, pushed to https://github.com/SimonRundell/Ironway.git. Added `.config.json`/`.config.example.json`, `api/lib/config.php`, `api/lib/json.php`, `api/cors.php`, `api/db.php`, root and `api/.htaccess`, `public/data/client.json`, `api/ping.php`, `scripts/smoke.ps1`. Repointed local Laragon/Apache DocumentRoot to this project (was serving another project) and created the `ironway` database. Local MySQL needed a `developer` user instead of `root` (see DECISIONS.md). All 7 smoke checks pass: ping ok/db, OPTIONS preflight echoes localhost origin, evil.example gets no CORS header, `/.config.json` and `/api/.config.json` both 403. Left: database has no tables yet (T0.03), no PHP CLI tests yet.
