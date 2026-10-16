<?php

/**
 * Shared CORS handling for every Ironway API endpoint.
 *
 * Must be required first in every endpoint, before api/db.php. Echoes the
 * request Origin back only when it is localhost on any port (so Vite's
 * dev server is accepted regardless of which port it picked), sets the
 * JSON content type for the response, and answers an OPTIONS preflight
 * request directly. CORS headers must never be set inline in an endpoint;
 * this file is the only place they are defined.
 *
 * @package Ironway\Api
 */

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';

if (preg_match('#^https?://localhost(:\d+)?$#', $origin) === 1) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Authorization, Content-Type');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(200);
    exit();
}
