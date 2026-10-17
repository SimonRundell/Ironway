<?php

/**
 * Creates a new save: the entire generated world (meta, entity rows,
 * map blob) in one request, written in one transaction (DESIGN 4.4).
 *
 * Body: { meta: {...}, world: { settlements, settlementPop,
 * industries, links, economyState, company, historyMonthly,
 * eventsLog }, blob: "<base64>" }.
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
$body = read_json_body((int) $limits['maxCreateBytes']);

$countStmt = $pdo->prepare('SELECT COUNT(*) FROM saves WHERE user_id = :user_id');
$countStmt->execute(['user_id' => $user['id']]);
if ((int) $countStmt->fetchColumn() >= (int) $limits['maxSavesPerUser']) {
    json_error(403, 'save_limit_reached', 'You have reached the maximum number of saves.');
}

if (!isset($body['meta'], $body['world'], $body['blob']) || !is_array($body['meta']) || !is_array($body['world']) || !is_string($body['blob'])) {
    json_error(400, 'invalid_body', 'Body must have "meta", "world" and "blob".');
}

$meta = validate_row($body['meta'], [
    'name' => ['type' => 'string', 'maxLength' => 100],
    'seed' => ['type' => 'string', 'maxLength' => 40],
    'attempt' => ['type' => 'int', 'min' => 0, 'max' => 255],
    'generatorVersion' => ['type' => 'int', 'min' => 1],
    'startYear' => ['type' => 'int', 'min' => 1800, 'max' => 2100],
    'difficulty' => ['type' => 'string', 'maxLength' => 16],
], 'meta');

$settings = $body['meta']['settings'] ?? null;
if ($settings !== null && !is_array($settings)) {
    json_error(422, 'invalid_row', 'meta.settings must be a JSON object.');
}

$world = $body['world'];
foreach (['settlements', 'settlementPop', 'industries', 'links', 'historyMonthly', 'eventsLog'] as $key) {
    if (!isset($world[$key]) || !is_array($world[$key])) {
        json_error(400, 'invalid_body', "world.$key must be an array.");
    }
}
foreach (['economyState', 'company'] as $key) {
    if (!isset($world[$key]) || !is_array($world[$key])) {
        json_error(400, 'invalid_body', "world.$key must be an object.");
    }
}

require_row_count($world['settlements'], MAX_SETTLEMENTS_PER_SAVE, 'world.settlements');
require_row_count($world['settlementPop'], MAX_SETTLEMENT_POP_ROWS_PER_SAVE, 'world.settlementPop');
require_row_count($world['industries'], MAX_INDUSTRIES_PER_SAVE, 'world.industries');
require_row_count($world['links'], MAX_LINKS_PER_SAVE, 'world.links');
require_row_count($world['historyMonthly'], MAX_HISTORY_ROWS_PER_CHECKPOINT, 'world.historyMonthly');
require_row_count($world['eventsLog'], MAX_EVENTS_PER_CHECKPOINT, 'world.eventsLog');

$cargoIds = ironway_cargo_ids();
$classCount = count(ironway_class_ids());

$settlementIds = [];
$settlementRows = [];
foreach ($world['settlements'] as $i => $row) {
    $context = "world.settlements[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $validated = validate_row($row, settlement_schema(), $context);
    $validated['stock'] = validate_stock($row['stock'] ?? null, $cargoIds, "$context.stock");
    $settlementIds[$validated['id']] = true;
    $settlementRows[] = $validated;
}

$settlementPopRows = [];
foreach ($world['settlementPop'] as $i => $row) {
    $context = "world.settlementPop[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $validated = validate_row($row, settlement_pop_schema(), $context);
    validate_class_index($validated['class'], $classCount, $context);
    if (!isset($settlementIds[$validated['settlement_id']])) {
        json_error(422, 'invalid_row', "$context.settlement_id does not match any settlement in this payload.");
    }
    $settlementPopRows[] = $validated;
}

$industryRows = [];
foreach ($world['industries'] as $i => $row) {
    $context = "world.industries[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $validated = validate_row($row, industry_schema(), $context);
    $validated['stock'] = validate_stock($row['stock'] ?? null, $cargoIds, "$context.stock");
    if (!isset($settlementIds[$validated['home_settlement_id']])) {
        json_error(422, 'invalid_row', "$context.home_settlement_id does not match any settlement in this payload.");
    }
    $industryRows[] = $validated;
}

$linkRows = [];
foreach ($world['links'] as $i => $row) {
    $context = "world.links[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $linkRows[] = validate_row($row, link_schema(), $context);
}

$economyState = validate_row($world['economyState'], economy_state_schema(), 'world.economyState');
$company = validate_row($world['company'], company_schema(), 'world.company');

$historyRows = [];
foreach ($world['historyMonthly'] as $i => $row) {
    $context = "world.historyMonthly[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $historyRows[] = validate_row($row, history_monthly_schema(), $context);
}

$eventRows = [];
foreach ($world['eventsLog'] as $i => $row) {
    $context = "world.eventsLog[$i]";
    if (!is_array($row)) {
        json_error(422, 'invalid_row', "$context must be an object.");
    }
    $eventRows[] = validate_row($row, event_schema(), $context);
}

$blobBytes = base64_decode($body['blob'], true);
if ($blobBytes === false || $blobBytes === '') {
    json_error(422, 'invalid_row', 'blob must be valid base64 data.');
}
$checksum = substr(hash('sha256', $blobBytes), 0, 16);

$pdo->beginTransaction();

try {
    $insertSave = $pdo->prepare(
        'INSERT INTO saves (user_id, name, seed, attempt, generator_version, start_year, difficulty, game_day, version, settings)
         VALUES (:user_id, :name, :seed, :attempt, :generator_version, :start_year, :difficulty, 0, 1, :settings)'
    );
    $insertSave->execute([
        'user_id' => $user['id'],
        'name' => $meta['name'],
        'seed' => $meta['seed'],
        'attempt' => $meta['attempt'],
        'generator_version' => $meta['generatorVersion'],
        'start_year' => $meta['startYear'],
        'difficulty' => $meta['difficulty'],
        'settings' => $settings !== null ? json_encode($settings) : null,
    ]);
    $saveId = (int) $pdo->lastInsertId();

    $pdo->prepare('INSERT INTO save_map (save_id, `blob`, checksum, bytes) VALUES (:save_id, :blob, :checksum, :bytes)')
        ->execute(['save_id' => $saveId, 'blob' => $blobBytes, 'checksum' => $checksum, 'bytes' => strlen($blobBytes)]);

    $withSaveId = static fn (array $rows) => array_map(
        static fn (array $row) => ['save_id' => $saveId] + $row,
        $rows
    );

    chunked_upsert($pdo, 'settlements', ['save_id', 'id', 'name', 'kind', 'x', 'y', 'port_tier', 'housing', 'region_cells', 'stock'], $withSaveId($settlementRows));
    chunked_upsert($pdo, 'settlement_pop', ['save_id', 'settlement_id', 'class', 'pop', 'employed', 'confidence'], $withSaveId($settlementPopRows));
    chunked_upsert($pdo, 'industries', ['save_id', 'id', 'type_id', 'name', 'x', 'y', 'home_settlement_id', 'capacity', 'utilisation', 'richness_left', 'opened_day', 'closed_day', 'months_low', 'stock'], $withSaveId($industryRows));
    chunked_upsert($pdo, 'links', ['save_id', 'id', 'a_type', 'a_id', 'b_type', 'b_id', 'mode', 'tier', 'length_mi', 'gradient', 'condition', 'owner', 'path'], $withSaveId($linkRows));

    $pdo->prepare(
        'INSERT INTO economy_state (save_id, level, last_change_dir, last_check_day, indicators)
         VALUES (:save_id, :level, :last_change_dir, :last_check_day, :indicators)'
    )->execute(['save_id' => $saveId] + $economyState);

    $pdo->prepare(
        'INSERT INTO company (save_id, name, cash, loans, rank_key, stats)
         VALUES (:save_id, :name, :cash, :loans, :rank_key, :stats)'
    )->execute(['save_id' => $saveId] + $company);

    chunked_upsert($pdo, 'history_monthly', ['save_id', 'month_index', 'pop_total', 'pop_u', 'pop_m', 'pop_w', 'employment', 'confidence', 'trade_value', 'level', 'extra'], $withSaveId($historyRows));
    chunked_insert($pdo, 'events_log', ['save_id', 'game_day', 'kind', 'subject_type', 'subject_id', 'text'], $withSaveId($eventRows));

    $pdo->commit();
} catch (Throwable $e) {
    $pdo->rollBack();
    throw $e;
}

json_ok(['id' => $saveId, 'version' => 1], 201);
