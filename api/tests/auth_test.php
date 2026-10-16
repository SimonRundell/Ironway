<?php

/**
 * PHP CLI integration tests for the T0.04 auth endpoints. Requires
 * Laragon's Apache to be serving this project at http://localhost.
 *
 * Run with: php api/tests/auth_test.php
 *
 * @package Ironway\Api\Tests
 */

require_once __DIR__ . '/../db.php';

$baseUrl = 'http://localhost/api';
$failures = 0;

/**
 * Sends a JSON request to the running API and returns its status and
 * decoded body.
 *
 * @param string      $method HTTP method.
 * @param string      $path   Path under $baseUrl.
 * @param array|null  $body   Request body to JSON-encode, or null for none.
 * @param string|null $token  Bearer token to send, if any.
 * @return array{status: int, body: array}
 */
function request(string $method, string $path, ?array $body, ?string $token = null): array
{
    global $baseUrl;

    $ch = curl_init($baseUrl . $path);
    $headers = ['Content-Type: application/json'];

    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
    ]);

    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }

    $raw = curl_exec($ch);

    if ($raw === false) {
        fwrite(STDERR, 'curl error: ' . curl_error($ch) . PHP_EOL);
        exit(1);
    }

    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return ['status' => $status, 'body' => json_decode($raw, true) ?? []];
}

/**
 * Records a pass/fail result for one check.
 *
 * @param string $name   Test description.
 * @param bool   $passed Whether the assertion held.
 * @param string $detail Extra context to print on failure.
 * @return void
 */
function check(string $name, bool $passed, string $detail = ''): void
{
    global $failures;

    if ($passed) {
        echo "PASS: $name" . PHP_EOL;
    } else {
        echo "FAIL: $name $detail" . PHP_EOL;
        $failures++;
    }
}

$username = 'test_' . bin2hex(random_bytes(4));
$weakUsername = $username . '_weak';
$password = 'a-strong-password-1';

// A password shorter than minPasswordLength is rejected before any row is created.
$res = request('POST', '/auth/register.php', ['username' => $weakUsername, 'password' => 'short']);
check('register with a weak password returns 422', $res['status'] === 422);
check('register with a weak password reports the password field', isset($res['body']['error']['fields']['password']));

// Registration succeeds and returns a usable token.
$res = request('POST', '/auth/register.php', ['username' => $username, 'password' => $password]);
check('register returns 201', $res['status'] === 201);
check('register returns a 64-char token', is_string($res['body']['token'] ?? null) && strlen($res['body']['token']) === 64);

// Registering the same username again is rejected.
$res = request('POST', '/auth/register.php', ['username' => $username, 'password' => $password]);
check('duplicate username returns 409', $res['status'] === 409);

// Login with the correct password succeeds.
$res = request('POST', '/auth/login.php', ['username' => $username, 'password' => $password]);
check('login with correct password returns 200', $res['status'] === 200);
check('login returns a token', is_string($res['body']['token'] ?? null));
$loginToken = $res['body']['token'] ?? null;

// Five wrong-password attempts are each rejected on their own merits...
for ($i = 1; $i <= 5; $i++) {
    $res = request('POST', '/auth/login.php', ['username' => $username, 'password' => 'wrong-password']);
    check("login with wrong password returns 401 (failure $i of 5)", $res['status'] === 401);
}

// ...and the 6th attempt within 15 minutes is locked out before credentials are even checked.
$res = request('POST', '/auth/login.php', ['username' => $username, 'password' => 'wrong-password']);
check('6th failed login in 15 minutes returns 429', $res['status'] === 429);

$res = request('POST', '/auth/login.php', ['username' => $username, 'password' => $password]);
check('correct password is still locked out', $res['status'] === 429);

// me with a valid token returns the user.
$res = request('GET', '/auth/me.php', null, $loginToken);
check('me with a valid token returns 200', $res['status'] === 200);
check('me returns the right username', ($res['body']['username'] ?? null) === $username);

// me without a token is rejected.
$res = request('GET', '/auth/me.php', null);
check('me without a token returns 401', $res['status'] === 401);

// Logout deletes the session, so the same token no longer works.
$res = request('POST', '/auth/logout.php', null, $loginToken);
check('logout returns 200', $res['status'] === 200);

$res = request('GET', '/auth/me.php', null, $loginToken);
check('me with a revoked token returns 401', $res['status'] === 401);

// Clean up so the test is safe to run again immediately.
$pdo = ironway_db();
$pdo->prepare('DELETE FROM users WHERE username = :username')->execute(['username' => $username]);
$pdo->prepare('DELETE FROM login_attempts WHERE username = :username')->execute(['username' => $username]);

if ($failures > 0) {
    echo PHP_EOL . "$failures check(s) failed." . PHP_EOL;
    exit(1);
}

echo PHP_EOL . 'All auth checks passed.' . PHP_EOL;
exit(0);
