<?php

/**
 * CLI migration runner for Ironway.
 *
 * Applies any numbered SQL file under api/sql/ that is not yet recorded
 * in schema_migrations, in filename order. Run from the command line:
 *
 *   php api/migrate.php
 *
 * MySQL DDL statements auto-commit as they run, so a transaction around
 * a migration cannot roll back table creation that already happened.
 * Each table in api/sql is therefore written with IF NOT EXISTS so a
 * migration that fails partway through is safe to re-run from the top.
 *
 * @package Ironway\Api
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('migrate.php can only be run from the command line.');
}

require_once __DIR__ . '/db.php';

/**
 * Ensures the schema_migrations bookkeeping table exists.
 *
 * @param PDO $pdo The database connection.
 * @return void
 */
function ensure_migrations_table(PDO $pdo): void
{
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS schema_migrations (
            filename VARCHAR(255) NOT NULL,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (filename)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
}

/**
 * Returns the set of migration filenames already recorded as applied.
 *
 * @param PDO $pdo The database connection.
 * @return array<string,bool> Applied filenames as keys.
 */
function applied_migrations(PDO $pdo): array
{
    $rows = $pdo->query('SELECT filename FROM schema_migrations')->fetchAll(PDO::FETCH_COLUMN);

    return array_fill_keys($rows, true);
}

/**
 * Splits a migration file into individual statements on a semicolon at
 * the end of a line. Sufficient for the plain DDL used in api/sql and
 * avoids depending on a full SQL parser or multi-statement PDO support.
 *
 * @param string $sql Raw file contents.
 * @return string[] Non-empty statements, without trailing semicolons.
 */
function split_statements(string $sql): array
{
    $statements = [];

    foreach (explode(";\n", $sql) as $chunk) {
        $statement = trim($chunk);

        if ($statement !== '') {
            $statements[] = $statement;
        }
    }

    return $statements;
}

/**
 * Applies a single migration file and records it in schema_migrations.
 *
 * Each CREATE TABLE statement auto-commits in MySQL, so there is no
 * transaction to wrap the DDL in; a PDO transaction here would only
 * cover the final bookkeeping insert. If a statement partway through
 * fails, the tables created before it stay created (hence IF NOT
 * EXISTS everywhere) and the file is simply not marked as applied, so
 * the next run retries it from the top.
 *
 * @param PDO    $pdo      The database connection.
 * @param string $filePath Absolute path to the migration file.
 * @return void
 */
function apply_migration(PDO $pdo, string $filePath): void
{
    $filename = basename($filePath);
    echo "Applying $filename..." . PHP_EOL;

    $sql = file_get_contents($filePath);

    try {
        foreach (split_statements($sql) as $statement) {
            $pdo->exec($statement);
        }

        $stmt = $pdo->prepare('INSERT INTO schema_migrations (filename) VALUES (:filename)');
        $stmt->execute(['filename' => $filename]);
    } catch (Throwable $e) {
        throw new RuntimeException("Failed to apply $filename: " . $e->getMessage(), 0, $e);
    }
}

$pdo = ironway_db();
ensure_migrations_table($pdo);
$applied = applied_migrations($pdo);

$files = glob(__DIR__ . '/sql/[0-9][0-9][0-9]_*.sql');
sort($files);

$ranAny = false;

foreach ($files as $file) {
    if (isset($applied[basename($file)])) {
        continue;
    }

    try {
        apply_migration($pdo, $file);
    } catch (RuntimeException $e) {
        fwrite(STDERR, $e->getMessage() . PHP_EOL);
        exit(1);
    }

    $ranAny = true;
}

echo ($ranAny ? 'Migrations complete.' : 'Nothing to do; database already up to date.') . PHP_EOL;
