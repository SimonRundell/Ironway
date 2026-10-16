<?php

/**
 * Returns the currently authenticated user.
 *
 * @package Ironway\Api\Auth
 */

require_once __DIR__ . '/../cors.php';  // always first
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/json.php';
require_once __DIR__ . '/../lib/auth.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    json_error(405, 'method_not_allowed', 'Use GET.');
}

$user = require_auth(ironway_db());

json_ok([
    'id' => $user['id'],
    'username' => $user['username'],
    'email' => $user['email'],
    'createdAt' => $user['created_at'],
]);
