<?php

/**
 * Verifies credentials and returns a session token.
 *
 * @package Ironway\Api\Auth
 */

require_once __DIR__ . '/../cors.php';  // always first
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/json.php';
require_once __DIR__ . '/../lib/validate.php';
require_once __DIR__ . '/../lib/auth.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_error(405, 'method_not_allowed', 'Use POST.');
}

$body = read_json_body();

try {
    $fields = validate_fields($body, [
        'username' => ['maxLength' => 32],
        'password' => ['maxLength' => 72],
    ]);
} catch (ValidationException $e) {
    json_error(422, 'validation_failed', 'Please enter a username and password.', $e->fieldErrors);
}

$pdo = ironway_db();

check_login_throttle($pdo, $fields['username']);

$stmt = $pdo->prepare('SELECT id, username, password_hash FROM users WHERE username = :username');
$stmt->execute(['username' => $fields['username']]);
$user = $stmt->fetch();

$valid = $user !== false && password_verify($fields['password'], $user['password_hash']);

record_login_attempt($pdo, $fields['username'], $valid);

if (!$valid) {
    json_error(401, 'invalid_credentials', 'Incorrect username or password.');
}

$session = create_session($pdo, (int) $user['id']);

json_ok([
    'token' => $session['token'],
    'user' => ['id' => (int) $user['id'], 'username' => $user['username']],
]);
