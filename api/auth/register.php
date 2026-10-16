<?php

/**
 * Creates a new user account and returns a session token.
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

$config = ironway_config();

if (!($config['auth']['allowRegistration'] ?? true)) {
    json_error(403, 'registration_closed', 'Registration is currently closed.');
}

$body = read_json_body();

try {
    $fields = validate_fields($body, [
        'username' => [
            'minLength' => 3,
            'maxLength' => 32,
            'pattern' => '/^[A-Za-z0-9_-]+$/',
            'patternMessage' => 'May only contain letters, numbers, underscores and hyphens.',
        ],
        'password' => [
            'minLength' => (int) $config['auth']['minPasswordLength'],
            'maxLength' => 72, // bcrypt (PASSWORD_DEFAULT) ignores bytes beyond this
        ],
        'email' => [
            'required' => false,
            'type' => 'email',
            'maxLength' => 255,
        ],
    ]);
} catch (ValidationException $e) {
    json_error(422, 'validation_failed', 'Please correct the highlighted fields.', $e->fieldErrors);
}

$pdo = ironway_db();

$existing = $pdo->prepare('SELECT id FROM users WHERE username = :username');
$existing->execute(['username' => $fields['username']]);

if ($existing->fetch() !== false) {
    json_error(409, 'username_taken', 'That username is already in use.');
}

$passwordHash = password_hash($fields['password'], PASSWORD_DEFAULT);

try {
    $insert = $pdo->prepare(
        'INSERT INTO users (username, email, password_hash) VALUES (:username, :email, :password_hash)'
    );
    $insert->execute([
        'username' => $fields['username'],
        'email' => $fields['email'] ?? null,
        'password_hash' => $passwordHash,
    ]);
} catch (PDOException $e) {
    if ($e->getCode() === '23000') {
        // Lost the race against another request registering the same username.
        json_error(409, 'username_taken', 'That username is already in use.');
    }
    throw $e;
}

$userId = (int) $pdo->lastInsertId();
$session = create_session($pdo, $userId);

json_ok([
    'token' => $session['token'],
    'user' => ['id' => $userId, 'username' => $fields['username']],
], 201);
