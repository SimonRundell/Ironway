<?php

/**
 * Deletes the current session.
 *
 * @package Ironway\Api\Auth
 */

require_once __DIR__ . '/../cors.php';  // always first
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/json.php';
require_once __DIR__ . '/../lib/auth.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_error(405, 'method_not_allowed', 'Use POST.');
}

$token = bearer_token();

if ($token === null) {
    json_error(401, 'unauthorized', 'Missing bearer token.');
}

revoke_session(ironway_db(), $token);

json_ok(['ok' => true]);
