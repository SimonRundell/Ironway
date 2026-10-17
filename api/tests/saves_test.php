<?php

/**
 * PHP CLI integration tests for the T1.13 saves endpoints. Requires
 * Laragon's Apache to be serving this project at http://localhost and
 * Node to be on PATH (used to build a realistic create.php payload
 * from a freshly generated world).
 *
 * Run with: php api/tests/saves_test.php
 *
 * @package Ironway\Api\Tests
 */

require_once __DIR__ . '/../db.php';

$baseUrl = 'http://localhost/api';
$projectRoot = __DIR__ . '/../..';
$failures = 0;

/**
 * Sends a request to the running API and returns its status, decoded
 * JSON body (if any) and raw body bytes.
 *
 * @param string      $method HTTP method.
 * @param string      $path   Path under $baseUrl.
 * @param mixed       $body   Request body: an array to JSON-encode, a raw string, or null for none.
 * @param string|null $token  Bearer token to send, if any.
 * @param string|null $rawBody Pre-encoded request body string, takes priority over $body if set.
 * @return array{status: int, body: array, raw: string, contentType: string}
 */
function request(string $method, string $path, $body, ?string $token = null, ?string $rawBody = null): array
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

    if ($rawBody !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    } elseif ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }

    $raw = curl_exec($ch);

    if ($raw === false) {
        fwrite(STDERR, 'curl error: ' . curl_error($ch) . PHP_EOL);
        exit(1);
    }

    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?? '';
    curl_close($ch);

    return ['status' => $status, 'body' => json_decode($raw, true) ?? [], 'raw' => $raw, 'contentType' => $contentType];
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

/**
 * Registers a fresh test user and returns their bearer token.
 *
 * @param string $usernamePrefix A prefix for the random test username.
 * @return array{username: string, token: string}
 */
function register_test_user(string $usernamePrefix): array
{
    $username = $usernamePrefix . '_' . bin2hex(random_bytes(4));
    $res = request('POST', '/auth/register.php', ['username' => $username, 'password' => 'a-strong-password-1']);
    if ($res['status'] !== 201) {
        fwrite(STDERR, "Failed to register test user: " . json_encode($res) . PHP_EOL);
        exit(1);
    }
    return ['username' => $username, 'token' => $res['body']['token']];
}

// Build a realistic create.php payload from a freshly generated world.
$fixturePath = sys_get_temp_dir() . '/ironway_save_fixture_' . bin2hex(random_bytes(4)) . '.json';
exec("node \"$projectRoot/scripts/build-save-fixture.mjs\" ironway-005 \"$fixturePath\" 2>&1", $buildOutput, $buildExit);
if ($buildExit !== 0) {
    fwrite(STDERR, 'Failed to build save fixture: ' . implode(PHP_EOL, $buildOutput) . PHP_EOL);
    exit(1);
}
$payload = json_decode(file_get_contents($fixturePath), true);
unlink($fixturePath);

$owner = register_test_user('save_owner');
$other = register_test_user('save_other');

// --- create ---------------------------------------------------------------

$res = request('POST', '/saves/create.php', $payload, $owner['token']);
check('create returns 201', $res['status'] === 201, json_encode($res['body']));
check('create returns an id and version 1', is_int($res['body']['id'] ?? null) && ($res['body']['version'] ?? null) === 1);
$saveId = $res['body']['id'] ?? null;

// --- load round trip --------------------------------------------------------

$res = request('GET', "/saves/load.php?id=$saveId", null, $owner['token']);
check('load returns 200', $res['status'] === 200);
check('load returns the same settlement count', count($res['body']['settlements'] ?? []) === count($payload['world']['settlements']));
check('load returns the same link count', count($res['body']['links'] ?? []) === count($payload['world']['links']));
check('load returns the company row', ($res['body']['company']['name'] ?? null) === 'Test Transport Co');
check('load returns gameDay 0 and version 1', ($res['body']['save']['gameDay'] ?? null) === 0 && ($res['body']['save']['version'] ?? null) === 1);

// --- map ---------------------------------------------------------------

$res = request('GET', "/saves/map.php?id=$saveId", null, $owner['token']);
check('map returns 200', $res['status'] === 200);
check('map returns octet-stream', str_contains($res['contentType'], 'application/octet-stream'));
$expectedBlobBytes = strlen(base64_decode($payload['blob'], true));
check('map returns the exact blob bytes', strlen($res['raw']) === $expectedBlobBytes);

// --- list ---------------------------------------------------------------

$res = request('GET', '/saves/list.php', null, $owner['token']);
check('list returns 200', $res['status'] === 200);
$listedIds = array_map(static fn (array $s) => $s['id'], $res['body']['saves'] ?? []);
check('list includes the created save', in_array($saveId, $listedIds, true));

// --- ownership ---------------------------------------------------------------

$res = request('GET', "/saves/load.php?id=$saveId", null, $other['token']);
check('load by another user returns 403 or 404', in_array($res['status'], [403, 404], true));

$res = request('GET', "/saves/map.php?id=$saveId", null, $other['token']);
check('map by another user returns 403 or 404', in_array($res['status'], [403, 404], true));

$res = request('DELETE', "/saves/delete.php?id=$saveId", null, $other['token']);
check('delete by another user returns 403 or 404', in_array($res['status'], [403, 404], true));

// --- checkpoint: happy path, with a ~300-settlement payload for the timing check ---

$checkpointBody = [
    'id' => $saveId,
    'baseVersion' => 1,
    'gameDay' => 30,
    'settlements' => $payload['world']['settlements'],
    'settlementPop' => $payload['world']['settlementPop'],
];
$start = microtime(true);
$res = request('POST', '/saves/checkpoint.php', $checkpointBody, $owner['token']);
$elapsedMs = (microtime(true) - $start) * 1000;
check('checkpoint returns 200', $res['status'] === 200, json_encode($res['body']));
check('checkpoint returns version 2', ($res['body']['version'] ?? null) === 2);
check(
    sprintf('a %d-settlement checkpoint completes in under 1 second (%.0fms)', count($payload['world']['settlements']), $elapsedMs),
    $elapsedMs < 1000
);

// --- checkpoint: stale baseVersion ---------------------------------------------------------------

$res = request('POST', '/saves/checkpoint.php', ['id' => $saveId, 'baseVersion' => 1, 'gameDay' => 60], $owner['token']);
check('stale baseVersion returns 409', $res['status'] === 409);

// --- checkpoint: gameDay backwards ---------------------------------------------------------------

$res = request('POST', '/saves/checkpoint.php', ['id' => $saveId, 'baseVersion' => 2, 'gameDay' => 10], $owner['token']);
check('gameDay going backwards returns 422', $res['status'] === 422);

// --- checkpoint: gameDay too far ahead ---------------------------------------------------------------

$res = request('POST', '/saves/checkpoint.php', ['id' => $saveId, 'baseVersion' => 2, 'gameDay' => 1_000_000], $owner['token']);
check('gameDay too far ahead returns 422', $res['status'] === 422);

// --- checkpoint: malformed row, no partial write ---------------------------------------------------------------

$beforeLoad = request('GET', "/saves/load.php?id=$saveId", null, $owner['token']);
$untouchedHousing = $beforeLoad['body']['settlements'][5]['housing'];

$malformedBody = [
    'id' => $saveId,
    'baseVersion' => 2,
    'gameDay' => 45,
    'settlements' => [
        ['id' => $payload['world']['settlements'][5]['id'], 'name' => 'Changed', 'kind' => 'town', 'x' => 1, 'y' => 1, 'port_tier' => 0, 'housing' => 99999, 'region_cells' => 1],
        ['id' => $payload['world']['settlements'][6]['id'], 'name' => 'Bad', 'kind' => 'town', 'x' => 1, 'y' => 1, 'port_tier' => 0, 'housing' => -5, 'region_cells' => 1], // negative housing: invalid
    ],
];
$res = request('POST', '/saves/checkpoint.php', $malformedBody, $owner['token']);
check('a malformed row returns 422', $res['status'] === 422);

$afterLoad = request('GET', "/saves/load.php?id=$saveId", null, $owner['token']);
$stillUntouchedHousing = $afterLoad['body']['settlements'][5]['housing'];
check('the valid row in the same malformed batch was not written (no partial write)', $stillUntouchedHousing === $untouchedHousing);

// --- create: oversize body ---------------------------------------------------------------

$oversizePayload = $payload;
$oversizePayload['padding'] = str_repeat('x', 9_000_000); // over maxCreateBytes (8,000,000)
$res = request('POST', '/saves/create.php', $oversizePayload, $owner['token']);
check('an oversize create body returns 413', $res['status'] === 413);

// --- delete + cascade ---------------------------------------------------------------

$res = request('DELETE', "/saves/delete.php?id=$saveId", null, $owner['token']);
check('delete returns 200', $res['status'] === 200);

$res = request('GET', "/saves/load.php?id=$saveId", null, $owner['token']);
check('loading a deleted save returns 404', $res['status'] === 404);

$pdo = ironway_db();
$remaining = $pdo->prepare('SELECT COUNT(*) FROM settlements WHERE save_id = :id');
$remaining->execute(['id' => $saveId]);
check('delete cascaded to child rows', (int) $remaining->fetchColumn() === 0);

// Clean up the test users.
$pdo->prepare('DELETE FROM users WHERE username IN (:u1, :u2)')->execute(['u1' => $owner['username'], 'u2' => $other['username']]);

if ($failures > 0) {
    echo PHP_EOL . "$failures check(s) failed." . PHP_EOL;
    exit(1);
}

echo PHP_EOL . 'All saves checks passed.' . PHP_EOL;
exit(0);
