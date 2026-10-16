# Ironway

A single-player economic and logistics sandbox in the browser. A generated island has a living economy of farms, mines, mills, towns and ports. Later you run a transport company that earns money from real demand.

Working title. Owner: Simon Rundell.

## Status

Phase 0, foundations. See `PHASES.md` for the schedule and `PROGRESS.md` for what is done.

## Setup (local, Windows with Laragon)

1. Laragon serves this folder as the document root, so the site is `http://localhost/` and the API is `http://localhost/api/`.
2. Install packages: `npm install`
3. Start the front end: `npm run dev` (port 5173).
4. Run the tests: `npm test`
5. Build: `npm run build`

## Documents

- `DESIGN.md`: what we are building and why.
- `PHASES.md`: the work schedule.
- `CLAUDE.md`: standing conventions for coding agents.
- `DECISIONS.md`, `PROGRESS.md`, `CREDITS.md`.

## Licence

Released under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0).

In short: you may share and adapt this work, as long as you give credit, do not use it commercially, and release anything you build from it under the same licence.

Full terms: https://creativecommons.org/licenses/by-nc-sa/4.0/
Legal code: https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode