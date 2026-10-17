<?php

/**
 * Deletes a save and everything under it. Every child table has an
 * `ON DELETE CASCADE` foreign key back to `saves.id` (see
 * api/sql/001_schema.sql), so deleting the one `saves` row is enough.
 *
 * @package Ironway\Api\Saves
 */

require_once __DIR__ . '/../cors.php';  // always first
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/json.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/saves.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'DELETE') {
    json_error(405, 'method_not_allowed', 'Use DELETE.');
}

$pdo = ironway_db();
$user = require_auth($pdo);

$saveId = (int) ($_GET['id'] ?? 0);
if ($saveId <= 0) {
    json_error(400, 'invalid_request', 'A valid "id" query parameter is required.');
}

require_save_ownership($pdo, $saveId, $user['id']);

$pdo->prepare('DELETE FROM saves WHERE id = :id')->execute(['id' => $saveId]);

json_ok(['deleted' => true]);
