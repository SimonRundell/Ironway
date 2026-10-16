<?php

/**
 * Health check endpoint: confirms CORS is wired up correctly and that
 * the database is reachable.
 *
 * @package Ironway\Api
 */

require_once __DIR__ . '/cors.php';  // always first
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/lib/json.php';

$dbOk = true;

try {
    ironway_db()->query('SELECT 1');
} catch (PDOException $e) {
    $dbOk = false;
}

json_ok(['ok' => true, 'db' => $dbOk]);
