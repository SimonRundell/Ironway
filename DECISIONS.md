# Decisions

| Date | Task | Decision | Reason |
|---|---|---|---|
| 2026-10-16 | T0.01 | Pinned React to 18.3.1 | create-vite now ships React 19; CLAUDE.md specifies React 18. |
| 2026-10-16 | T0.02 | Local `.config.json` uses MySQL user `developer` (password set, not committed) instead of `root` with an empty password | On this machine `root@localhost` requires GSSAPI/Windows auth, which no PHP or CLI MySQL client here can satisfy. `.config.example.json` keeps the generic `root`/empty-password template from DESIGN 3.3 since that is still the common Laragon default; only the untracked local `.config.json` differs. |
| 2026-10-16 | T0.03 | `migrate.php` applies each migration's statements without a PDO transaction, and every `CREATE TABLE` in `api/sql` uses `IF NOT EXISTS` | MySQL/MariaDB DDL auto-commits per statement, so a transaction wrapped around several `CREATE TABLE` statements cannot roll them back; `IF NOT EXISTS` is what actually makes a failed, partially-applied migration safe to re-run. |
| 2026-10-16 | T0.03 | `migrate.php` exits with 403 when not run from the CLI SAPI | It lives directly under `api/` (not inside the `sql`/`lib`/`tests` folders `api/.htaccess` denies), so without this guard it would be reachable over HTTP and able to mutate the schema on request. |
| 2026-10-16 | T0.03 | `save_map.blob` is quoted with backticks in the schema | `blob` is a reserved word in MySQL/MariaDB; the bare column name fails with a syntax error. |
