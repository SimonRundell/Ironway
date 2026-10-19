# Ironway

A single-player economic and logistics sandbox in the browser. A generated island has a living economy of farms, mines, mills, towns and ports. Later you run a transport company that earns money from real demand.

Working title. Owner: Simon Rundell.

## Status

Phase 1 complete: a persistent, deterministic island economy that runs with no player action, with a plain inspector UI to watch it. See `PHASES.md` for the schedule and `PROGRESS.md` for what is done.

## Setup (local, Windows with Laragon)

1. Laragon serves this folder as the document root, so the site is `http://localhost/` and the API is `http://localhost/api/`. No `/ironway/` subfolder, no Vite proxy.
2. Install packages: `npm install`
3. Create `.config.json` from `.config.example.json` and fill in your local MySQL credentials. `.config.json` is gitignored and must never be committed.
4. Create the database and run the migrations: `php api/migrate.php`
5. Start the front end: `npm run dev` (port 5173). If that port is already in use, a dev server is already running: test against it, do not start a second one.
6. Run the tests: `npm test`
7. Build: `npm run build`
8. Check React conventions: `npm run doctor`

## Deploying to Hostinger or Dreamhost

Both targets are plain Apache with FastCGI/PHP-FPM (not `mod_php`), so `.htaccess` must only use directives Apache itself understands; see `CLAUDE.md` for the DreamHost `mod_php`-directive trap this rules out.

1. `npm run build` to produce `dist/`.
2. `.\scripts\deploy-pack.ps1` assembles a `release/` folder: the built front end, `api/`, the root `.htaccess` and a `.config.json` template copied from `.config.example.json`.
3. Edit `release/.config.json` with the production database credentials, then upload the whole folder to the site's document root.
4. Run `api/migrate.php` once against the production database.
5. Confirm `GET /.config.json` and `GET /api/.config.json` both return 403 before telling anyone the site is live.

Production is same-origin (the site and its API share a host), so `api/cors.php` is inert there; it only matters for the Vite dev server talking to Laragon.

## Documents

- `DESIGN.md`: what we are building and why.
- `PHASES.md`: the work schedule.
- `CLAUDE.md`: standing conventions for coding agents.
- `docs/ECONOMY.md`: how the island economy works, for players.
- `DECISIONS.md`, `PROGRESS.md`, `CREDITS.md`.

## Licence

Released under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0).

In short: you may share and adapt this work, as long as you give credit, do not use it commercially, and release anything you build from it under the same licence.

Full terms: https://creativecommons.org/licenses/by-nc-sa/4.0/
Legal code: https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode