# Decisions

| Date | Task | Decision | Reason |
|---|---|---|---|
| 2026-10-16 | T0.01 | Pinned React to 18.3.1 | create-vite now ships React 19; CLAUDE.md specifies React 18. |
| 2026-10-16 | T0.02 | Local `.config.json` uses MySQL user `developer` (password set, not committed) instead of `root` with an empty password | On this machine `root@localhost` requires GSSAPI/Windows auth, which no PHP or CLI MySQL client here can satisfy. `.config.example.json` keeps the generic `root`/empty-password template from DESIGN 3.3 since that is still the common Laragon default; only the untracked local `.config.json` differs. |
