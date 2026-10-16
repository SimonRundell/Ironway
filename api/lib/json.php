<?php

/**
 * Small helpers for sending consistent JSON responses from API endpoints.
 *
 * @package Ironway\Api\Lib
 */

/**
 * Sends a successful JSON response and ends the script.
 *
 * @param mixed $data   The payload to encode as the response body.
 * @param int   $status HTTP status code.
 * @return never
 */
function json_ok($data, int $status = 200)
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit();
}

/**
 * Sends a JSON error response shaped as
 * { "error": { "code": "...", "message": "..." } } and ends the script.
 *
 * @param int    $status  HTTP status code.
 * @param string $code    Short machine-readable error code.
 * @param string $message Human-readable message.
 * @return never
 */
function json_error(int $status, string $code, string $message)
{
    http_response_code($status);
    echo json_encode([
        'error' => [
            'code' => $code,
            'message' => $message,
        ],
    ], JSON_UNESCAPED_SLASHES);
    exit();
}
