<?php

/**
 * Accepts a checkpoint: changed entity rows (dirty tracking), new
 * history rows and new event rows, written in one transaction
 * (DESIGN 4.4). Body: { id, baseVersion, gameDay, settlements?,
 * settlementPop?, industries?, links?, historyMonthly?, eventsLog? }
 * — every entity array is optional, since a real checkpoint usually
 * touches only a few entities.
 *
 * @package Ironway\Api\Saves
 */

require_once __DIR__ . '/../cors.php';  // always first
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/json.php';
require_once __DIR__ . '/../lib/validate.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/saves.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_error(405, 'method_not_allowed', 'Use POST.');
}

$pdo = ironway_db();
$user = require_auth($pdo);

$limits = ironway_save_limits();
$body = read_json_body((int) $limits['maxCheckpointBytes']);

if (!isset($body['id'], $body['baseVersion'], $body['gameDay'])) {
    json_error(400, 'invalid_body', 'Body must have "id", "baseVersion" and "gameDay".');
}
if (!is_int($body['id']) || !is_int($body['baseVersion']) || !is_int($body['gameDay'])) {
    json_error(400, 'invalid_body', '"id", "baseVersion" and "gameDay" must be integers.');
}

$saveId = $body['id'];
$baseVersion = $body['baseVersion'];
$gameDay = $body['gameDay'];

$save = require_save_ownership($pdo, $saveId, $user['id']);

if ($baseVersion !== (int) $save['version']) {
    json_error(409, 'version_mismatch', 'This save has changed since you last loaded it. Reload and try again.');
}

if ($gameDay < (int) $save['game_day']) {
    json_error(422, 'game_day_backwards', 'gameDay cannot go backwards.');
}
$maxAdvance = (int) $limits['maxAdvanceDaysPerCheckpoint'];
if ($gameDay > (int) $save['game_day'] + $maxAdvance) {
    json_error(422, 'game_day_too_far', "gameDay cannot advance more than $maxAdvance days in one checkpoint.");
}

$cargoIds = ironway_cargo_ids();
$classCount = count(ironway_class_ids());

/**
 * Validates an optional array-of-rows field from the checkpoint body:
 * absent or null becomes an empty array; present must be a JSON array
 * within its row-count cap.
 *
 * @param array<string,mixed> $body    The decoded checkpoint body.
 * @param string               $key     Field name, e.g. "settlements".
 * @param int                  $maxRows The row-count cap.
 * @return array<int,mixed> The rows (possibly empty).
 */
function optional_rows(array $body, string $key, int $maxRows): array
{
    $value = $body[$key] ?? [];
    if (!is_array($value)) {
        json_error(400, 'invalid_body', "\"$key\" must be an array.");
    }
    require_row_count($value, $maxRows, $key);
    return $value;
}

$settlementRows = [];
foreach (optional_rows($body, 'settlements', MAX_SETTLEMENTS_PER_SAVE) as $i => $row) {
    $context = "settlements[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $validated = validate_row($row, settlement_schema(), $context);
    $validated['stock'] = validate_stock($row['stock'] ?? null, $cargoIds, "$context.stock");
    $settlementRows[] = $validated;
}

$settlementPopRows = [];
foreach (optional_rows($body, 'settlementPop', MAX_SETTLEMENT_POP_ROWS_PER_SAVE) as $i => $row) {
    $context = "settlementPop[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $validated = validate_row($row, settlement_pop_schema(), $context);
    validate_class_index($validated['class'], $classCount, $context);
    $settlementPopRows[] = $validated;
}

$industryRows = [];
foreach (optional_rows($body, 'industries', MAX_INDUSTRIES_PER_SAVE) as $i => $row) {
    $context = "industries[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $validated = validate_row($row, industry_schema(), $context);
    $validated['stock'] = validate_stock($row['stock'] ?? null, $cargoIds, "$context.stock");
    $industryRows[] = $validated;
}

$linkRows = [];
foreach (optional_rows($body, 'links', MAX_LINKS_PER_SAVE) as $i => $row) {
    $context = "links[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $linkRows[] = validate_row($row, link_schema(), $context);
}

$historyRows = [];
foreach (optional_rows($body, 'historyMonthly', MAX_HISTORY_ROWS_PER_CHECKPOINT) as $i => $row) {
    $context = "historyMonthly[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $historyRows[] = validate_row($row, history_monthly_schema(), $context);
}

$eventRows = [];
foreach (optional_rows($body, 'eventsLog', MAX_EVENTS_PER_CHECKPOINT) as $i => $row) {
    $context = "eventsLog[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $eventRows[] = validate_row($row, event_schema(), $context);
}

$economyState = null;
if (isset($body['economyState'])) {
    if (!is_array($body['economyState'])) {
        json_error(400, 'invalid_body', '"economyState" must be an object.');
    }
    $economyState = validate_row($body['economyState'], economy_state_schema(), 'economyState');
}

$company = null;
if (isset($body['company'])) {
    if (!is_array($body['company'])) {
        json_error(400, 'invalid_body', '"company" must be an object.');
    }
    $company = validate_row($body['company'], company_schema(), 'company');
}

$withSaveId = static fn (array $rows) => array_map(
    static fn (array $row) => ['save_id' => $saveId] + $row,
    $rows
);

$pdo->beginTransaction();

try {
    chunked_upsert($pdo, 'settlements', ['save_id', 'id', 'name', 'kind', 'x', 'y', 'port_tier', 'housing', 'region_cells', 'stock'], $withSaveId($settlementRows));
    chunked_upsert($pdo, 'settlement_pop', ['save_id', 'settlement_id', 'class', 'pop', 'employed', 'confidence'], $withSaveId($settlementPopRows));
    chunked_upsert($pdo, 'industries', ['save_id', 'id', 'type_id', 'name', 'x', 'y', 'home_settlement_id', 'capacity', 'utilisation', 'richness_left', 'opened_day', 'closed_day', 'months_low', 'stock'], $withSaveId($industryRows));
    chunked_upsert($pdo, 'links', ['save_id', 'id', 'a_type', 'a_id', 'b_type', 'b_id', 'mode', 'tier', 'length_mi', 'gradient', 'condition', 'owner', 'path'], $withSaveId($linkRows));
    chunked_upsert($pdo, 'history_monthly', ['save_id', 'month_index', 'pop_total', 'pop_u', 'pop_m', 'pop_w', 'employment', 'confidence', 'trade_value', 'level', 'extra'], $withSaveId($historyRows));
    chunked_insert($pdo, 'events_log', ['save_id', 'game_day', 'kind', 'subject_type', 'subject_id', 'text'], $withSaveId($eventRows));

    if ($economyState !== null) {
        $pdo->prepare(
            'INSERT INTO economy_state (save_id, level, last_change_dir, last_check_day, indicators)
             VALUES (:save_id, :level, :last_change_dir, :last_check_day, :indicators)
             ON DUPLICATE KEY UPDATE level = VALUES(level), last_change_dir = VALUES(last_change_dir),
                 last_check_day = VALUES(last_check_day), indicators = VALUES(indicators)'
        )->execute(['save_id' => $saveId] + $economyState);
    }

    if ($company !== null) {
        $pdo->prepare(
            'INSERT INTO company (save_id, name, cash, loans, rank_key, stats)
             VALUES (:save_id, :name, :cash, :loans, :rank_key, :stats)
             ON DUPLICATE KEY UPDATE name = VALUES(name), cash = VALUES(cash), loans = VALUES(loans),
                 rank_key = VALUES(rank_key), stats = VALUES(stats)'
        )->execute(['save_id' => $saveId] + $company);
    }

    $update = $pdo->prepare(
        'UPDATE saves SET game_day = :game_day, version = version + 1 WHERE id = :id AND version = :base_version'
    );
    $update->execute(['game_day' => $gameDay, 'id' => $saveId, 'base_version' => $baseVersion]);

    if ($update->rowCount() === 0) {
        // Another checkpoint for this save committed between our
        // ownership check and here (two tabs, or a retried request).
        $pdo->rollBack();
        json_error(409, 'version_mismatch', 'This save has changed since you last loaded it. Reload and try again.');
    }

    $pdo->commit();
} catch (PDOException $e) {
    $pdo->rollBack();
    if ($e->getCode() === '23000') {
        json_error(422, 'invalid_reference', 'A row refers to an entity that does not exist in this save.');
    }
    throw $e;
} catch (Throwable $e) {
    $pdo->rollBack();
    throw $e;
}

json_ok(['version' => $baseVersion + 1]);
