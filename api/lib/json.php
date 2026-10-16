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
 * { "error": { "code": "...", "message": "...", "fields": {...} } } and
 * ends the script. The "fields" key is only present when $fields is
 * non-empty, for per-field validation messages.
 *
 * @param int                  $status  HTTP status code.
 * @param string               $code    Short machine-readable error code.
 * @param string               $message Human-readable message.
 * @param array<string,string> $fields  Optional per-field error messages.
 * @return never
 */
function json_error(int $status, string $code, string $message, array $fields = [])
{
    http_response_code($status);
    $body = [
        'error' => [
            'code' => $code,
            'message' => $message,
        ],
    ];

    if ($fields !== []) {
        $body['error']['fields'] = $fields;
    }

    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit();
}
