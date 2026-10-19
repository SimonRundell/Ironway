<?php

/**
 * Shared helpers for the saves/* endpoints: ownership checks, chunked
 * upserts/inserts, and row validation against the same static rules
 * (cargo ids, class count) the JS loader validates against.
 *
 * @package Ironway\Api\Lib
 */

require_once __DIR__ . '/json.php';
require_once __DIR__ . '/rules.php';

/** @var int Row-count sanity ceilings, well above any real generated world (T1.25's higher industry density: max ~321 settlements, ~2,372 industries, ~604 links across the golden seeds), to block a wildly oversized payload before it reaches the database. */
const MAX_SETTLEMENTS_PER_SAVE = 600;
const MAX_SETTLEMENT_POP_ROWS_PER_SAVE = 1800;
const MAX_INDUSTRIES_PER_SAVE = 4000;
const MAX_LINKS_PER_SAVE = 1200;
const MAX_HISTORY_ROWS_PER_CHECKPOINT = 50;
const MAX_EVENTS_PER_CHECKPOINT = 300;

/**
 * Fetches a save row, scoped to its owner. Sends a 404 json_error()
 * and exits if the save does not exist or belongs to someone else —
 * the same response either way, so a request can never distinguish
 * "no such save" from "not yours".
 *
 * @param PDO $pdo    The database connection.
 * @param int $saveId The save id from the request.
 * @param int $userId The authenticated user's id.
 * @return array<string,mixed> The save row.
 */
function require_save_ownership(PDO $pdo, int $saveId, int $userId): array
{
    $stmt = $pdo->prepare('SELECT * FROM saves WHERE id = :id AND user_id = :user_id');
    $stmt->execute(['id' => $saveId, 'user_id' => $userId]);
    $save = $stmt->fetch();

    if ($save === false) {
        json_error(404, 'not_found', 'Save not found.');
    }

    return $save;
}

/**
 * Runs a single-parameter SELECT and returns every row. A thin
 * wrapper so call sites never fall back to raw string-interpolated
 * SQL for convenience — prepared statements only, per project
 * convention, even for a value that happens to already be an int.
 *
 * @param PDO    $pdo   The database connection.
 * @param string $sql   SQL with exactly one named placeholder, `:id`.
 * @param int    $id    The value to bind to `:id`.
 * @return array<int,array<string,mixed>> Every matching row.
 */
function run_select(PDO $pdo, string $sql, int $id): array
{
    $stmt = $pdo->prepare($sql);
    $stmt->execute(['id' => $id]);
    return $stmt->fetchAll();
}

/**
 * Decodes a possibly-null JSON column fetched via PDO (always a raw
 * string, or null; PDO never auto-decodes JSON columns).
 *
 * @param string|null $value The raw column value.
 * @return mixed|null The decoded value, or null.
 */
function decode_json_column(?string $value)
{
    return $value === null ? null : json_decode($value, true);
}

/**
 * Sends a 422 json_error() and exits if a row list is over its cap.
 *
 * @param array<int,mixed> $rows    The rows to count.
 * @param int               $max    The cap.
 * @param string            $context A label for the error message, e.g. "settlements".
 * @return void
 */
function require_row_count(array $rows, int $max, string $context): void
{
    if (count($rows) > $max) {
        json_error(422, 'too_many_rows', "$context has too many rows (max $max).");
    }
}

/**
 * Validates and normalises one row against a small declarative schema,
 * returning values ready to bind into a prepared statement (`json`
 * -typed fields pre-encoded to a string). Sends a 422 json_error() and
 * exits on the first problem found.
 *
 * Schema entry per column:
 *   - type: 'int' | 'float' | 'string' | 'json'
 *   - nullable: bool, default false
 *   - min, max: number, for 'int'/'float'
 *   - maxLength: int, for 'string'
 *   - enum: string[], for 'string'
 *
 * @param array<string,mixed>  $row     The decoded row.
 * @param array<string,array>  $schema  Column name to rule set.
 * @param string                $context A label for error messages, e.g. "settlements[3]".
 * @return array<string,mixed> Normalised values, keyed by column.
 */
function validate_row(array $row, array $schema, string $context): array
{
    $out = [];

    foreach ($schema as $column => $rule) {
        $value = $row[$column] ?? null;
        $nullable = $rule['nullable'] ?? false;

        if ($value === null) {
            if (!$nullable) {
                json_error(422, 'invalid_row', "$context.$column is required.");
            }
            $out[$column] = null;
            continue;
        }

        switch ($rule['type']) {
            case 'int':
                if (!is_int($value) && !(is_float($value) && floor($value) === $value)) {
                    json_error(422, 'invalid_row', "$context.$column must be an integer.");
                }
                $value = (int) $value;
                if (isset($rule['min']) && $value < $rule['min']) {
                    json_error(422, 'invalid_row', "$context.$column must be at least {$rule['min']}.");
                }
                if (isset($rule['max']) && $value > $rule['max']) {
                    json_error(422, 'invalid_row', "$context.$column must be at most {$rule['max']}.");
                }
                break;

            case 'float':
                if (!is_int($value) && !is_float($value)) {
                    json_error(422, 'invalid_row', "$context.$column must be a number.");
                }
                $value = (float) $value;
                if (!is_finite($value)) {
                    json_error(422, 'invalid_row', "$context.$column must be finite.");
                }
                if (isset($rule['min']) && $value < $rule['min']) {
                    json_error(422, 'invalid_row', "$context.$column must be at least {$rule['min']}.");
                }
                if (isset($rule['max']) && $value > $rule['max']) {
                    json_error(422, 'invalid_row', "$context.$column must be at most {$rule['max']}.");
                }
                break;

            case 'string':
                if (!is_string($value)) {
                    json_error(422, 'invalid_row', "$context.$column must be a string.");
                }
                if (isset($rule['maxLength']) && strlen($value) > $rule['maxLength']) {
                    json_error(422, 'invalid_row', "$context.$column is too long.");
                }
                if (isset($rule['enum']) && !in_array($value, $rule['enum'], true)) {
                    json_error(422, 'invalid_row', "$context.$column has an invalid value.");
                }
                break;

            case 'json':
                if (!is_array($value)) {
                    json_error(422, 'invalid_row', "$context.$column must be a JSON object or array.");
                }
                $value = json_encode($value);
                break;
        }

        $out[$column] = $value;
    }

    return $out;
}

/**
 * Validates a `stock` map (cargo id to tonnes): every key must be a
 * real cargo id, every value a non-negative, finite number. Sends a
 * 422 json_error() and exits on the first problem found.
 *
 * @param mixed  $stock   The decoded `stock` value (expected: array or null).
 * @param string[] $cargoIds Valid cargo ids, from ironway_cargo_ids().
 * @param string $context A label for error messages, e.g. "settlements[3].stock".
 * @return string|null The JSON-encoded stock map, or null if $stock was null.
 */
function validate_stock($stock, array $cargoIds, string $context): ?string
{
    if ($stock === null) {
        return null;
    }
    if (!is_array($stock)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }

    foreach ($stock as $cargoId => $qty) {
        if (!in_array($cargoId, $cargoIds, true)) {
            json_error(422, 'invalid_row', "$context references an unknown cargo id \"$cargoId\".");
        }
        if (!is_int($qty) && !is_float($qty)) {
            json_error(422, 'invalid_row', "$context.$cargoId must be a number.");
        }
        if ($qty < 0 || !is_finite((float) $qty)) {
            json_error(422, 'invalid_row', "$context.$cargoId must be a non-negative, finite number.");
        }
    }

    return json_encode($stock);
}

/**
 * Validates a `settlement_pop` row's `class` against the real class
 * count, since it is a plain TINYINT index, not a string id. Sends a
 * 422 json_error() and exits if out of range.
 *
 * @param int    $class      The class index.
 * @param int    $classCount Total valid classes, from count(ironway_class_ids()).
 * @param string $context    A label for the error message.
 * @return void
 */
function validate_class_index(int $class, int $classCount, string $context): void
{
    if ($class < 0 || $class >= $classCount) {
        json_error(422, 'invalid_row', "$context.class must be between 0 and " . ($classCount - 1) . '.');
    }
}

/**
 * Multi-row upsert (`INSERT ... ON DUPLICATE KEY UPDATE`), batched so
 * a large row set never becomes one unbounded SQL statement.
 *
 * @param PDO                        $pdo       The database connection.
 * @param string                     $table     Table name (trusted, never user input).
 * @param string[]                   $columns   Column names, in bind order.
 * @param array<int,array<string,mixed>> $rows  Normalised rows (e.g. from validate_row()).
 * @param int                        $chunkSize Rows per statement.
 * @return void
 */
function chunked_upsert(PDO $pdo, string $table, array $columns, array $rows, int $chunkSize = 500): void
{
    if ($rows === []) {
        return;
    }

    $columnList = implode(', ', array_map(static fn (string $c) => "`$c`", $columns));
    $updateClause = implode(', ', array_map(static fn (string $c) => "`$c` = VALUES(`$c`)", $columns));
    $rowPlaceholder = '(' . implode(', ', array_fill(0, count($columns), '?')) . ')';

    foreach (array_chunk($rows, $chunkSize) as $chunk) {
        $placeholders = implode(', ', array_fill(0, count($chunk), $rowPlaceholder));
        $stmt = $pdo->prepare("INSERT INTO `$table` ($columnList) VALUES $placeholders ON DUPLICATE KEY UPDATE $updateClause");

        $params = [];
        foreach ($chunk as $row) {
            foreach ($columns as $col) {
                $params[] = $row[$col];
            }
        }
        $stmt->execute($params);
    }
}

/**
 * Multi-row plain insert, batched like chunked_upsert(). For tables
 * whose primary key is server-assigned (events_log), where an upsert
 * would make no sense since incoming rows never carry a real id yet.
 *
 * @param PDO                        $pdo       The database connection.
 * @param string                     $table     Table name (trusted, never user input).
 * @param string[]                   $columns   Column names, in bind order.
 * @param array<int,array<string,mixed>> $rows  Normalised rows (e.g. from validate_row()).
 * @param int                        $chunkSize Rows per statement.
 * @return void
 */
function chunked_insert(PDO $pdo, string $table, array $columns, array $rows, int $chunkSize = 500): void
{
    if ($rows === []) {
        return;
    }

    $columnList = implode(', ', array_map(static fn (string $c) => "`$c`", $columns));
    $rowPlaceholder = '(' . implode(', ', array_fill(0, count($columns), '?')) . ')';

    foreach (array_chunk($rows, $chunkSize) as $chunk) {
        $placeholders = implode(', ', array_fill(0, count($chunk), $rowPlaceholder));
        $stmt = $pdo->prepare("INSERT INTO `$table` ($columnList) VALUES $placeholders");

        $params = [];
        foreach ($chunk as $row) {
            foreach ($columns as $col) {
                $params[] = $row[$col];
            }
        }
        $stmt->execute($params);
    }
}

/**
 * The `settlements` row schema (DESIGN 8.2), for validate_row(). The
 * `stock` column is deliberately left out — it needs validate_stock(),
 * not the generic 'json' check, so callers validate it separately.
 *
 * @return array<string,array>
 */
function settlement_schema(): array
{
    return [
        'id' => ['type' => 'int', 'min' => 1],
        'name' => ['type' => 'string', 'maxLength' => 60],
        'kind' => ['type' => 'string', 'maxLength' => 16, 'enum' => ['capital', 'city', 'town', 'village', 'hamlet']],
        'x' => ['type' => 'float', 'min' => 0],
        'y' => ['type' => 'float', 'min' => 0],
        'port_tier' => ['type' => 'int', 'min' => 0, 'max' => 3],
        'housing' => ['type' => 'int', 'min' => 0],
        'region_cells' => ['type' => 'int', 'min' => 0],
    ];
}

/**
 * The `settlement_pop` row schema (DESIGN 8.2). `class` still needs
 * validate_class_index() separately, since its valid range depends on
 * classes.json's actual count.
 *
 * @return array<string,array>
 */
function settlement_pop_schema(): array
{
    return [
        'settlement_id' => ['type' => 'int', 'min' => 1],
        'class' => ['type' => 'int', 'min' => 0],
        'pop' => ['type' => 'int', 'min' => 0],
        'employed' => ['type' => 'int', 'min' => 0],
        'confidence' => ['type' => 'float', 'min' => 0, 'max' => 100],
    ];
}

/**
 * The `industries` row schema (DESIGN 8.2), minus `stock` (see
 * settlement_schema()'s note).
 *
 * @return array<string,array>
 */
function industry_schema(): array
{
    return [
        'id' => ['type' => 'int', 'min' => 1],
        'type_id' => ['type' => 'string', 'maxLength' => 40],
        'name' => ['type' => 'string', 'maxLength' => 60],
        'x' => ['type' => 'float', 'min' => 0],
        'y' => ['type' => 'float', 'min' => 0],
        'home_settlement_id' => ['type' => 'int', 'min' => 1],
        'capacity' => ['type' => 'float', 'min' => 0],
        'utilisation' => ['type' => 'float', 'min' => 0, 'max' => 1],
        'richness_left' => ['type' => 'float', 'min' => 0, 'max' => 1],
        'opened_day' => ['type' => 'int', 'min' => 0],
        'closed_day' => ['type' => 'int', 'min' => 0, 'nullable' => true],
        'months_low' => ['type' => 'int', 'min' => 0],
    ];
}

/**
 * The `links` row schema (DESIGN 8.2).
 *
 * @return array<string,array>
 */
function link_schema(): array
{
    return [
        'id' => ['type' => 'int', 'min' => 1],
        'a_type' => ['type' => 'string', 'maxLength' => 1, 'enum' => ['s', 'i', 'w']],
        'a_id' => ['type' => 'int', 'min' => 0],
        'b_type' => ['type' => 'string', 'maxLength' => 1, 'enum' => ['s', 'i', 'w']],
        'b_id' => ['type' => 'int', 'min' => 0],
        'mode' => ['type' => 'string', 'maxLength' => 8, 'enum' => ['road', 'rail', 'sea']],
        'tier' => ['type' => 'int', 'min' => 0, 'max' => 3],
        'length_mi' => ['type' => 'float', 'min' => 0],
        'gradient' => ['type' => 'float', 'min' => 0],
        'condition' => ['type' => 'float', 'min' => 0, 'max' => 1],
        'owner' => ['type' => 'string', 'maxLength' => 8],
        'path' => ['type' => 'json', 'nullable' => true],
    ];
}

/**
 * The `economy_state` row schema (DESIGN 8.2), minus `indicators`
 * (generic JSON, validated inline where used).
 *
 * @return array<string,array>
 */
function economy_state_schema(): array
{
    return [
        'level' => ['type' => 'int', 'min' => 0, 'max' => 4],
        'last_change_dir' => ['type' => 'int', 'min' => -1, 'max' => 1],
        'last_check_day' => ['type' => 'int', 'min' => 0],
        'indicators' => ['type' => 'json', 'nullable' => true],
    ];
}

/**
 * The `company` row schema (DESIGN 8.2), minus `stats` (generic JSON,
 * validated inline where used).
 *
 * @return array<string,array>
 */
function company_schema(): array
{
    return [
        'name' => ['type' => 'string', 'maxLength' => 100],
        'cash' => ['type' => 'float'],
        'loans' => ['type' => 'float', 'min' => 0],
        'rank_key' => ['type' => 'string', 'maxLength' => 24],
        'stats' => ['type' => 'json', 'nullable' => true],
    ];
}

/**
 * The `history_monthly` row schema (DESIGN 8.2), minus `extra` (generic
 * JSON, validated inline where used).
 *
 * @return array<string,array>
 */
function history_monthly_schema(): array
{
    return [
        'month_index' => ['type' => 'int', 'min' => 0],
        'pop_total' => ['type' => 'int', 'min' => 0],
        'pop_u' => ['type' => 'int', 'min' => 0],
        'pop_m' => ['type' => 'int', 'min' => 0],
        'pop_w' => ['type' => 'int', 'min' => 0],
        'employment' => ['type' => 'float', 'min' => 0],
        'confidence' => ['type' => 'float', 'min' => 0, 'max' => 100],
        'trade_value' => ['type' => 'float', 'min' => 0],
        'level' => ['type' => 'int', 'min' => 0, 'max' => 4],
        'extra' => ['type' => 'json', 'nullable' => true],
    ];
}

/**
 * The `events_log` row schema (DESIGN 8.2). `id` is server-assigned
 * (AUTO_INCREMENT) and deliberately absent: incoming event rows never
 * carry one.
 *
 * @return array<string,array>
 */
function event_schema(): array
{
    return [
        'game_day' => ['type' => 'int', 'min' => 0],
        'kind' => ['type' => 'string', 'maxLength' => 24],
        'subject_type' => ['type' => 'string', 'maxLength' => 16, 'nullable' => true],
        'subject_id' => ['type' => 'int', 'min' => 0, 'nullable' => true],
        'text' => ['type' => 'string', 'maxLength' => 255],
    ];
}
