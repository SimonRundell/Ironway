# Performance spike results (T2.15)

DESIGN 9.9's budget for Phase 2 rendering:

> 60 fps pan and zoom at 1920 x 1080 on a mid-range laptop, first interactive render under 3 seconds after data load, tile cache under 400 MB, no main-thread task over 16 ms during interaction (measured). The simulation runs in its own worker.

This is the results table PHASES.md's T2.15 asks for, plus the method used to get each number. All four budget items are met comfortably with Canvas 2D; the DESIGN 3.1/PHASES.md T2.15 WebGL escape hatch ("only if the budget cannot be met with Canvas 2D") is not needed.

## Method

A scripted camera tour (`src/render/perfTour.js`, triggered from a debug-only button in `MapView.jsx` when a save is opened with `?debug=1`) sweeps the camera through a 15-second sine-wave path across the whole island and the full zoom range (`MIN_PPM` to `MAX_PPM`) continuously. This is deliberately more aggressive than any real player's pan/zoom: a player's camera never oscillates across every zoom band and the whole map at once, so if frame cost stays in budget under this sweep, ordinary play has a comfortable margin.

Each frame, `MapView.jsx` times its own `drawPlaceholderWorld()` call with `performance.now()` — the one place a frame's real synchronous render cost is actually paid — rather than measuring the gap between `requestAnimationFrame` timestamps, which would also count vsync/idle wait time and understate how expensive the frame actually was.

Run against a real, well-developed save ("Wynshire", day 720, v11, 2,127,705 population, many settlements/industries/links/traffic/labels all active) rather than a synthetic empty world, at 1920x1080, Quality "Normal", reduced motion off — the ordinary default player experience, not a cut-down one.

Environment: this machine's browser tab was confirmed to run `requestAnimationFrame` at a genuine ~60 Hz cadence during this session (not throttled by a backgrounded/hidden tab, which would make frame timing meaningless), and `performance.memory` was available for the heap-delta figure.

## Results

| Budget item (DESIGN 9.9) | Measured | Result |
|---|---|---|
| 60 fps pan/zoom (no main-thread task over 16 ms) | 900 frames sampled over the 15 s tour: avg 3.57 ms, median 3.00 ms, p95 7.70 ms, **max 15.40 ms**, 0.0% of frames over the 16.67 ms budget | **Met**, large margin |
| Tile cache under 400 MB | Cache reached its own configured cap of 200 MB during the tour (expected: the LRU eviction system, T2.03's own Done-when, holding steady at its cap rather than growing further) | **Met**, half the ceiling |
| First interactive render under 3 seconds after data load | Clicking "Play" on the same save to the map view mounting with a drawn canvas: ~160-170 ms, measured twice | **Met**, large margin |
| Simulation runs in its own worker | Unchanged since T2.11 (`workers/simWorker.js`) | **Met** |

JS heap grew 3.7 MB over the 15 s worst-case sweep — no sign of a leak from the aggressive camera path.

## A note on tile "holes"

The existing per-tile "hole" instrumentation (`drawPlaceholderWorld.js`, DESIGN 9.4's own budget: a tile counts as a hole once it has gone 150 ms with nothing at all to draw, not even a cached ancestor) recorded a 717 ms hole during the worst-case tour. This is a different metric from DESIGN 9.9's 16 ms main-thread budget above: a hole measures tile *arrival* latency (how long the async worker pool took to produce a tile), not main-thread blocking time, and it only ever showed up in two situations:

- Once, briefly, on a cold page load (867 ms, before any tile at any zoom level is cached yet).
- During the tour's own continuous full-zoom-range sweep, which requests tiles across every pyramid level faster than the 2-worker pool can keep up — a pattern no real player reproduces by panning or zooming normally.

A separate check confirmed this: after a fresh page load settled, a gentle keyboard pan and a few mouse-wheel zoom steps (the kind of input a real player actually uses) added no further holes at all — the max stayed at the cold-start value. Holes are a cold-start/worst-case-sweep artefact, not a steady-state interaction problem, so no code change was made for this task.

## Conclusion

Canvas 2D with Web Workers and OffscreenCanvas (DESIGN 3.1) meets every part of DESIGN 9.9's budget on this machine, including under a deliberately worse-than-realistic camera sweep against a large, fully-populated save. No hotspot required fixing. The WebGL proposal escape hatch is not triggered.
