<?php

/**
 * Loads and caches the server-side configuration from the project root's
 * .config.json file, and resolves paths that are given relative to it.
 *
 * @package Ironway\Api\Lib
 */

/**
 * Reads .config.json once per request and returns it as an associative
 * array. The file lives at the project root, two levels above this file
 * (api/lib/config.php -> api -> project root), and is never served over
 * HTTP (see root .htaccess and api/.htaccess).
 *
 * @return array<string,mixed> The decoded configuration.
 * @throws RuntimeException If the file is missing or not valid JSON.
 */
function ironway_config(): array
{
    static $config = null;

    if ($config !== null) {
        return $config;
    }

    $path = __DIR__ . '/../../.config.json';

    if (!is_file($path)) {
        throw new RuntimeException(
            '.config.json not found at project root. Copy .config.example.json to .config.json and fill in local values.'
        );
    }

    $decoded = json_decode(file_get_contents($path), true);

    if (!is_array($decoded)) {
        throw new RuntimeException('.config.json is not valid JSON.');
    }

    $config = $decoded;

    return $config;
}

/**
 * Resolves the absolute path to the static rules data directory
 * (public/data in development, data in a deployed release). The
 * staticDataDir setting in .config.json is relative to the api/ folder,
 * not the project root, so that the same relative-path idea works both
 * in development and after a deploy pack has flattened public/ into the
 * release root alongside api/.
 *
 * @return string Absolute path, with no trailing slash.
 * @throws RuntimeException If the configured directory does not exist.
 */
function ironway_static_data_dir(): string
{
    $config = ironway_config();
    $apiDir = __DIR__ . '/..';
    $resolved = realpath($apiDir . '/' . $config['staticDataDir']);

    if ($resolved === false) {
        throw new RuntimeException('staticDataDir in .config.json does not resolve to a real directory.');
    }

    return $resolved;
}
