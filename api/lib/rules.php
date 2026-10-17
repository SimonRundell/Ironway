<?php

/**
 * Reads the same static rules JSON files used by src/sim/rules.js and
 * exposes the small subset of values PHP endpoints need: valid cargo
 * ids, valid class ids, and the save limits used to cap a checkpoint.
 * Full validation (required fields, ranges, cross references) is the
 * job of the JS loader; PHP only needs enough to check that incoming
 * checkpoint data refers to real ids and stays within configured caps.
 *
 * @package Ironway\Api\Lib
 */

require_once __DIR__ . '/config.php';

/**
 * Reads and decodes one rules JSON file from the static data directory.
 *
 * @param string $name File name without extension, e.g. "cargo".
 * @return array<string,mixed> The decoded JSON.
 * @throws RuntimeException If the file is missing or not valid JSON.
 */
function ironway_rules_file(string $name): array
{
    $path = ironway_static_data_dir() . '/' . $name . '.json';

    if (!is_file($path)) {
        throw new RuntimeException("$name.json not found in the static data directory.");
    }

    $decoded = json_decode(file_get_contents($path), true);

    if (!is_array($decoded)) {
        throw new RuntimeException("$name.json is not valid JSON.");
    }

    return $decoded;
}

/**
 * Returns the set of valid cargo ids from cargo.json, for validating
 * stock JSON keys in a checkpoint payload.
 *
 * @return string[] Cargo ids.
 */
function ironway_cargo_ids(): array
{
    static $ids = null;

    if ($ids === null) {
        $ids = array_map(
            static fn (array $entry) => $entry['id'],
            ironway_rules_file('cargo')['cargo']
        );
    }

    return $ids;
}

/**
 * Returns the set of valid social class ids from classes.json, for
 * validating settlement_pop.class values.
 *
 * @return string[] Class ids.
 */
function ironway_class_ids(): array
{
    static $ids = null;

    if ($ids === null) {
        $ids = array_map(
            static fn (array $entry) => $entry['id'],
            ironway_rules_file('classes')['classes']
        );
    }

    return $ids;
}

/**
 * Returns the save limits from .config.json: the caps a checkpoint
 * payload must stay within.
 *
 * @return array{maxSavesPerUser: int, maxAdvanceDaysPerCheckpoint: int, maxCheckpointBytes: int, maxCreateBytes: int}
 */
function ironway_save_limits(): array
{
    return ironway_config()['limits'];
}
