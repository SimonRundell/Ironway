<?php

/**
 * Lists the authenticated user's saves with summary stats.
 *
 * @package Ironway\Api\Saves
 */

require_once __DIR__ . '/../cors.php';  // always first
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/json.php';
require_once __DIR__ . '/../lib/auth.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    json_error(405, 'method_not_allowed', 'Use GET.');
}

$pdo = ironway_db();
$user = require_auth($pdo);

$stmt = $pdo->prepare(
    'SELECT s.id, s.name, s.seed, s.attempt, s.generator_version, s.start_year, s.difficulty,
            s.game_day, s.version, s.created_at, s.updated_at,
            (SELECT SUM(pop) FROM settlement_pop WHERE save_id = s.id) AS population,
            c.cash, c.rank_key
     FROM saves s
     LEFT JOIN company c ON c.save_id = s.id
     WHERE s.user_id = :user_id
     ORDER BY s.updated_at DESC'
);
$stmt->execute(['user_id' => $user['id']]);

$saves = array_map(static function (array $row): array {
    return [
        'id' => (int) $row['id'],
        'name' => $row['name'],
        'seed' => $row['seed'],
        'attempt' => (int) $row['attempt'],
        'generatorVersion' => (int) $row['generator_version'],
        'startYear' => (int) $row['start_year'],
        'difficulty' => $row['difficulty'],
        'gameDay' => (int) $row['game_day'],
        'version' => (int) $row['version'],
        'createdAt' => $row['created_at'],
        'updatedAt' => $row['updated_at'],
        'population' => $row['population'] !== null ? (int) $row['population'] : 0,
        'cash' => $row['cash'] !== null ? (float) $row['cash'] : null,
        'rankKey' => $row['rank_key'],
    ];
}, $stmt->fetchAll());

json_ok(['saves' => $saves]);
