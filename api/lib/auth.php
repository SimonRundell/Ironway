<?php

/**
 * Session tokens and login throttling for Ironway API endpoints.
 *
 * @package Ironway\Api\Lib
 */

/**
 * Reads the bearer token from the Authorization header, falling back to
 * apache_request_headers() because some SAPIs (and Apache configs that
 * don't forward Authorization into $_SERVER) only expose it there.
 *
 * @return string|null The token, or null if no Bearer header is present.
 */
function bearer_token(): ?string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';

    if ($header === '' && function_exists('apache_request_headers')) {
        $headers = apache_request_headers();
        $header = $headers['Authorization'] ?? $headers['authorization'] ?? '';
    }

    if (preg_match('/^Bearer\s+(.+)$/i', $header, $matches) === 1) {
        return $matches[1];
    }

    return null;
}

/**
 * Creates a session for a user: a 32-byte random token whose SHA-256
 * hash is stored, never the token itself.
 *
 * @param PDO $pdo    The database connection.
 * @param int $userId The user to create a session for.
 * @return array{token: string, expiresAt: string} The plaintext token
 *     (sent to the client once) and its expiry.
 */
function create_session(PDO $pdo, int $userId): array
{
    $token = bin2hex(random_bytes(32));
    $hash = hash('sha256', $token);
    $sessionDays = (int) (ironway_config()['auth']['sessionDays'] ?? 30);
    $expiresAt = (new DateTimeImmutable())->modify("+{$sessionDays} days")->format('Y-m-d H:i:s');

    $stmt = $pdo->prepare(
        'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (:user_id, :hash, :expires_at)'
    );
    $stmt->execute(['user_id' => $userId, 'hash' => $hash, 'expires_at' => $expiresAt]);

    return ['token' => $token, 'expiresAt' => $expiresAt];
}

/**
 * Requires a valid, unexpired bearer token, touches the session's
 * last_seen timestamp and returns the authenticated user row. Sends a
 * 401 json_error() and exits if there is no valid session.
 *
 * @param PDO $pdo The database connection.
 * @return array{id: int, username: string, email: ?string, created_at: string}
 */
function require_auth(PDO $pdo): array
{
    $token = bearer_token();

    if ($token === null) {
        json_error(401, 'unauthorized', 'Missing bearer token.');
    }

    $hash = hash('sha256', $token);

    $stmt = $pdo->prepare(
        'SELECT u.id, u.username, u.email, u.created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = :hash AND s.expires_at > NOW()'
    );
    $stmt->execute(['hash' => $hash]);
    $user = $stmt->fetch();

    if ($user === false) {
        json_error(401, 'unauthorized', 'Invalid or expired session.');
    }

    $touch = $pdo->prepare('UPDATE sessions SET last_seen = NOW() WHERE token_hash = :hash');
    $touch->execute(['hash' => $hash]);

    $user['id'] = (int) $user['id'];

    return $user;
}

/**
 * Deletes the session matching a token, if any. Safe to call with an
 * already-expired or unknown token; logout is idempotent either way.
 *
 * @param PDO    $pdo   The database connection.
 * @param string $token The plaintext bearer token.
 * @return void
 */
function revoke_session(PDO $pdo, string $token): void
{
    $stmt = $pdo->prepare('DELETE FROM sessions WHERE token_hash = :hash');
    $stmt->execute(['hash' => hash('sha256', $token)]);
}

/**
 * Sends a 429 json_error() and exits if a username has 5 or more failed
 * login attempts recorded in the last 15 minutes.
 *
 * @param PDO    $pdo      The database connection.
 * @param string $username The attempted username.
 * @return void
 */
function check_login_throttle(PDO $pdo, string $username): void
{
    $stmt = $pdo->prepare(
        'SELECT COUNT(*) FROM login_attempts
         WHERE username = :username AND success = 0 AND attempted_at > (NOW() - INTERVAL 15 MINUTE)'
    );
    $stmt->execute(['username' => $username]);

    if ((int) $stmt->fetchColumn() >= 5) {
        json_error(429, 'too_many_attempts', 'Too many failed login attempts. Try again in 15 minutes.');
    }
}

/**
 * Records a login attempt for the throttle and audit trail.
 *
 * @param PDO    $pdo      The database connection.
 * @param string $username The attempted username.
 * @param bool   $success  Whether the credentials were correct.
 * @return void
 */
function record_login_attempt(PDO $pdo, string $username, bool $success): void
{
    $stmt = $pdo->prepare('INSERT INTO login_attempts (username, success) VALUES (:username, :success)');
    $stmt->execute(['username' => $username, 'success' => $success ? 1 : 0]);
}
