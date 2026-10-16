# CLAUDE.md: Ironway standing conventions

Read this at the start of every session, then `DESIGN.md` and `PHASES.md`.

## Project
Ironway (working title): a browser economic and logistics sandbox on a generated island. Single player. Owner: Simon Rundell. Not an Exeter College app. Do not mention any private company in code, docs or UI.

## Stack
- React 18 + Vite + JavaScript (no TypeScript), Axios, PHP 8+ REST API in `/api`, MySQL.
- React app lives in the project root and follows the `npm create vite@latest` template layout.
- Config is read from `.config.json` (server only). Never commit it. Never expose it.
- Single CSS file: `src/index.css`, with custom properties. No inline CSS unless a canvas or measurement forces it.
- Documentation inline in JSDoc style (JS) and PHPDoc style (PHP) on every function and class.
- When the project is first created run `npx -y react-doctor@latest install` (pre-approved), and follow it.

## Local development
- Laragon serves the project folder as the document root: site at `http://localhost/`, API at `http://localhost/api/`. No subfolder.
- Vite serves only the front end (default port 5173). No Vite proxy.
- If port 5173 is in use, a dev server is already running. Test against it. Do not kill it or start another.
- Use PowerShell syntax in any shell commands you give or run.
- Permission for agent access is granted.

## PHP rules
- Every endpoint starts with:
  ```php
  require_once __DIR__ . '/cors.php';  // always first
  require_once __DIR__ . '/db.php';
  ```
- CORS lives only in `api/cors.php`: echo the request Origin when it is localhost on any port, set JSON content type, allow methods `GET, POST, PUT, DELETE, OPTIONS`, allow headers `Authorization, Content-Type`, answer `OPTIONS` with 200 and `exit()`.
- Prepared statements only. Check save ownership on every save endpoint.

## Deployment
- Targets Hostinger and Dreamhost (Apache). Root `.htaccess` must contain the deny rule for `.config.json` first, then the SPA fallback exactly as in `DESIGN.md` 3.5. `api/.htaccess` repeats the deny rule.

## Determinism
- No `Math.random()` under `src/sim`. Use `rngFor(seed, ...keys)`. See `DESIGN.md` 4.5.

## Writing style (docs, UI text, comments)
- Plain, human prose with sentences of mixed length. UK English. "program" for code.
- No em-dashes. Avoid stock AI phrasing and over-used tropes.
- Fonts for any generated documents: Trebuchet MS for text, Courier New for code.

## Licence
- Everything is released under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0).
- Keep the summary in `README.md` and link to https://creativecommons.org/licenses/by-nc-sa/4.0/ (legal code: https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode).

## Workflow
- One task at a time from `PHASES.md`. Tests first or alongside. Update `PROGRESS.md`. Record choices in `DECISIONS.md`.
- Ask Simon at most 5 clarifying questions before a task, and up to 5 more mid-task if truly needed. Otherwise take the default in `DESIGN.md`.
- Do not copy assets, names or text from Railroad Tycoon or other games. Mechanics are inspiration only. All art is procedural.
