<?php

/**
 * Loads a save: the save row, every entity row, economy, company,
 * and a recent slice of history and events (DESIGN 4.4). The map blob
 * itself is fetched separately via saves/map.php.
 *
 * The response's settlements/settlementPop/industries/links/
 * economyState/company/historyMonthly/eventsLog keys are shaped so
 * the client can pass them straight into sim/state.js's fromRows().
 *
 * @package Ironway\Api\Saves
 */

require_once __DIR__ . '/../cors.php';  // always first
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/json.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/saves.php';

/** @var int How many recent months/events to return; "recent", not the full history (DESIGN 4.4). */
const LOAD_HISTORY_MONTHS = 24;
const LOAD_RECENT_EVENTS = 50;

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    json_error(405, 'method_not_allowed', 'Use GET.');
}

$pdo = ironway_db();
$user = require_auth($pdo);

$saveId = (int) ($_GET['id'] ?? 0);
if ($saveId <= 0) {
    json_error(400, 'invalid_request', 'A valid "id" query parameter is required.');
}

$save = require_save_ownership($pdo, $saveId, $user['id']);

$settlementsStmt = $pdo->prepare('SELECT * FROM settlements WHERE save_id = :id');
$settlementsStmt->execute(['id' => $saveId]);
$settlements = array_map(static function (array $row): array {
    return [
        'id' => (int) $row['id'],
        'name' => $row['name'],
        'kind' => $row['kind'],
        'x' => (float) $row['x'],
        'y' => (float) $row['y'],
        'port_tier' => (int) $row['port_tier'],
        'housing' => (int) $row['housing'],
        'region_cells' => (int) $row['region_cells'],
        'stock' => decode_json_column($row['stock']) ?? [],
    ];
}, $settlementsStmt->fetchAll());

$settlementPop = array_map(static function (array $row): array {
    return [
        'settlement_id' => (int) $row['settlement_id'],
        'class' => (int) $row['class'],
        'pop' => (int) $row['pop'],
        'employed' => (int) $row['employed'],
        'confidence' => (float) $row['confidence'],
    ];
}, run_select($pdo, 'SELECT * FROM settlement_pop WHERE save_id = :id', $saveId));

$industries = array_map(static function (array $row): array {
    return [
        'id' => (int) $row['id'],
        'type_id' => $row['type_id'],
        'name' => $row['name'],
        'x' => (float) $row['x'],
        'y' => (float) $row['y'],
        'home_settlement_id' => (int) $row['home_settlement_id'],
        'capacity' => (float) $row['capacity'],
        'utilisation' => (float) $row['utilisation'],
        'richness_left' => (float) $row['richness_left'],
        'opened_day' => (int) $row['opened_day'],
        'closed_day' => $row['closed_day'] !== null ? (int) $row['closed_day'] : null,
        'months_low' => (int) $row['months_low'],
        'stock' => decode_json_column($row['stock']) ?? [],
    ];
}, run_select($pdo, 'SELECT * FROM industries WHERE save_id = :id', $saveId));

$links = array_map(static function (array $row): array {
    return [
        'id' => (int) $row['id'],
        'a_type' => $row['a_type'],
        'a_id' => (int) $row['a_id'],
        'b_type' => $row['b_type'],
        'b_id' => (int) $row['b_id'],
        'mode' => $row['mode'],
        'tier' => (int) $row['tier'],
        'length_mi' => (float) $row['length_mi'],
        'gradient' => (float) $row['gradient'],
        'condition' => (float) $row['condition'],
        'owner' => $row['owner'],
        'path' => decode_json_column($row['path']) ?? [],
    ];
}, run_select($pdo, 'SELECT * FROM links WHERE save_id = :id', $saveId));

$economyRow = $pdo->prepare('SELECT * FROM economy_state WHERE save_id = :id');
$economyRow->execute(['id' => $saveId]);
$economy = $economyRow->fetch();
$economyState = $economy === false ? null : [
    'level' => (int) $economy['level'],
    'last_change_dir' => (int) $economy['last_change_dir'],
    'last_check_day' => (int) $economy['last_check_day'],
    'indicators' => decode_json_column($economy['indicators']) ?? [],
];

$companyRow = $pdo->prepare('SELECT * FROM company WHERE save_id = :id');
$companyRow->execute(['id' => $saveId]);
$companyData = $companyRow->fetch();
$company = $companyData === false ? null : [
    'name' => $companyData['name'],
    'cash' => (float) $companyData['cash'],
    'loans' => (float) $companyData['loans'],
    'rank_key' => $companyData['rank_key'],
    'stats' => decode_json_column($companyData['stats']) ?? [],
];

$historyStmt = $pdo->prepare(
    'SELECT * FROM history_monthly WHERE save_id = :id ORDER BY month_index DESC LIMIT :limit'
);
$historyStmt->bindValue('id', $saveId, PDO::PARAM_INT);
$historyStmt->bindValue('limit', LOAD_HISTORY_MONTHS, PDO::PARAM_INT);
$historyStmt->execute();
$historyMonthly = array_reverse(array_map(static function (array $row): array {
    return [
        'month_index' => (int) $row['month_index'],
        'pop_total' => (int) $row['pop_total'],
        'pop_u' => (int) $row['pop_u'],
        'pop_m' => (int) $row['pop_m'],
        'pop_w' => (int) $row['pop_w'],
        'employment' => (float) $row['employment'],
        'confidence' => (float) $row['confidence'],
        'trade_value' => (float) $row['trade_value'],
        'level' => (int) $row['level'],
        'extra' => decode_json_column($row['extra']) ?? [],
    ];
}, $historyStmt->fetchAll()));

$eventsStmt = $pdo->prepare(
    'SELECT * FROM events_log WHERE save_id = :id ORDER BY game_day DESC, id DESC LIMIT :limit'
);
$eventsStmt->bindValue('id', $saveId, PDO::PARAM_INT);
$eventsStmt->bindValue('limit', LOAD_RECENT_EVENTS, PDO::PARAM_INT);
$eventsStmt->execute();
$eventsLog = array_reverse(array_map(static function (array $row): array {
    return [
        'id' => (int) $row['id'],
        'game_day' => (int) $row['game_day'],
        'kind' => $row['kind'],
        'subject_type' => $row['subject_type'],
        'subject_id' => $row['subject_id'] !== null ? (int) $row['subject_id'] : null,
        'text' => $row['text'],
    ];
}, $eventsStmt->fetchAll()));

json_ok([
    'save' => [
        'id' => (int) $save['id'],
        'name' => $save['name'],
        'seed' => $save['seed'],
        'attempt' => (int) $save['attempt'],
        'generatorVersion' => (int) $save['generator_version'],
        'startYear' => (int) $save['start_year'],
        'difficulty' => $save['difficulty'],
        'gameDay' => (int) $save['game_day'],
        'version' => (int) $save['version'],
        'settings' => decode_json_column($save['settings']),
        'createdAt' => $save['created_at'],
        'updatedAt' => $save['updated_at'],
    ],
    'settlements' => $settlements,
    'settlementPop' => $settlementPop,
    'industries' => $industries,
    'links' => $links,
    'economyState' => $economyState,
    'company' => $company,
    'historyMonthly' => $historyMonthly,
    'eventsLog' => $eventsLog,
]);
