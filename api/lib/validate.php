<?php

/**
 * JSON-schema-style request validation for API endpoints.
 *
 * @package Ironway\Api\Lib
 */

/**
 * Thrown when request data fails a validate_fields() check, carrying a
 * per-field message for each failing field.
 */
class ValidationException extends RuntimeException
{
    /** @var array<string,string> */
    public array $fieldErrors;

    /**
     * @param array<string,string> $fieldErrors Field name to error message.
     */
    public function __construct(array $fieldErrors)
    {
        $this->fieldErrors = $fieldErrors;
        parent::__construct('Validation failed.');
    }
}

/**
 * Reads and decodes the raw JSON request body, rejecting bodies over
 * $maxBytes or that are not a JSON object, via a 413 or 400 json_error().
 *
 * @param int $maxBytes Maximum accepted body size in bytes.
 * @return array<string,mixed> The decoded body.
 */
function read_json_body(int $maxBytes = 8192): array
{
    $raw = file_get_contents('php://input');

    if (strlen($raw) > $maxBytes) {
        json_error(413, 'payload_too_large', 'Request body is too large.');
    }

    $data = json_decode($raw, true);

    if (!is_array($data)) {
        json_error(400, 'invalid_json', 'Request body must be a JSON object.');
    }

    return $data;
}

/**
 * Validates a flat set of fields against a small schema and returns the
 * trimmed, validated values. Each schema entry may set:
 *   - type: 'string' (default) or 'email'
 *   - required: bool, default true
 *   - minLength, maxLength: int
 *   - pattern, patternMessage: a preg_match() pattern and its message
 *
 * @param array<string,mixed>  $data   Decoded request body.
 * @param array<string,array>  $schema Field name to rule set.
 * @return array<string,string> Validated values, present fields only.
 * @throws ValidationException If any field fails its rules.
 */
function validate_fields(array $data, array $schema): array
{
    $errors = [];
    $values = [];

    foreach ($schema as $field => $rule) {
        $value = $data[$field] ?? null;
        $required = $rule['required'] ?? true;

        if ($value === null || $value === '') {
            if ($required) {
                $errors[$field] = 'This field is required.';
            }
            continue;
        }

        if (!is_string($value)) {
            $errors[$field] = 'Must be a string.';
            continue;
        }

        $value = trim($value);
        $type = $rule['type'] ?? 'string';

        if ($type === 'email' && filter_var($value, FILTER_VALIDATE_EMAIL) === false) {
            $errors[$field] = 'Must be a valid email address.';
            continue;
        }

        if (isset($rule['minLength']) && strlen($value) < $rule['minLength']) {
            $errors[$field] = "Must be at least {$rule['minLength']} characters.";
            continue;
        }

        if (isset($rule['maxLength']) && strlen($value) > $rule['maxLength']) {
            $errors[$field] = "Must be at most {$rule['maxLength']} characters.";
            continue;
        }

        if (isset($rule['pattern']) && preg_match($rule['pattern'], $value) !== 1) {
            $errors[$field] = $rule['patternMessage'] ?? 'Invalid format.';
            continue;
        }

        $values[$field] = $value;
    }

    if ($errors !== []) {
        throw new ValidationException($errors);
    }

    return $values;
}
