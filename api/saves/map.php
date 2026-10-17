<?php

/**
 * Returns a save's map blob as raw bytes (DESIGN 4.4, 8.3), not JSON.
 *
 * @package Ironway\Api\Saves
 */

require_once __DIR__ . '/../cors.php';  // always first
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/json.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/saves.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    json_error(405, 'method_not_allowed', 'Use GET.');
}

$pdo = ironway_db();
$user = require_auth($pdo);

$saveId = (int) ($_GET['id'] ?? 0);
if ($saveId <= 0) {
    json_error(400, 'invalid_request', 'A valid "id" query parameter is required.');
}

require_save_ownership($pdo, $saveId, $user['id']);

$stmt = $pdo->prepare('SELECT `blob`, bytes FROM save_map WHERE save_id = :id');
$stmt->execute(['id' => $saveId]);
$row = $stmt->fetch();

if ($row === false) {
    json_error(404, 'not_found', 'This save has no map blob.');
}

header('Content-Type: application/octet-stream');
header('Content-Length: ' . $row['bytes']);
echo $row['blob'];
exit();
