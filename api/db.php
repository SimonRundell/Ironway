<?php

/**
 * Shared PDO MySQL connection for Ironway API endpoints.
 *
 * @package Ironway\Api
 */

require_once __DIR__ . '/lib/config.php';

/**
 * Returns a PDO connection to the Ironway database, created on first use
 * and reused for the rest of the request.
 *
 * @return PDO The connection, with exceptions enabled and native prepares.
 * @throws PDOException If the connection cannot be established.
 */
function ironway_db(): PDO
{
    static $pdo = null;

    if ($pdo !== null) {
        return $pdo;
    }

    $db = ironway_config()['db'];

    $dsn = sprintf(
        'mysql:host=%s;dbname=%s;charset=%s',
        $db['host'],
        $db['name'],
        $db['charset'] ?? 'utf8mb4'
    );

    $pdo = new PDO($dsn, $db['user'], $db['pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);

    return $pdo;
}
