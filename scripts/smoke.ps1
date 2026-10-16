<#
.SYNOPSIS
    Smoke tests for the T0.02 foundations: CORS, config protection and
    the health check endpoint. See DESIGN.md 3.5 and PHASES.md T0.02.

.DESCRIPTION
    Requires Laragon's Apache to be serving this project's root at the
    given base URL (default http://localhost). Run after `php
    api/migrate.php` has created the database, or db:true in the ping
    check will fail because the "ironway" database does not exist yet.

.PARAMETER BaseUrl
    The origin Apache is serving this project on. Defaults to
    http://localhost.

.EXAMPLE
    .\scripts\smoke.ps1
#>

param(
    [string]$BaseUrl = 'http://localhost'
)

$failures = 0

function Test-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    if ($Passed) {
        Write-Host "PASS: $Name"
    } else {
        Write-Host "FAIL: $Name $Detail" -ForegroundColor Red
        $script:failures++
    }
}

# 1. ping.php is reachable, includes cors then db, and reports db health.
try {
    $ping = Invoke-RestMethod -Uri "$BaseUrl/api/ping.php" -Method Get
    Test-Result 'ping.php returns ok:true' ($ping.ok -eq $true)
    Test-Result 'ping.php reports db:true' ($ping.db -eq $true)
} catch {
    Test-Result 'ping.php is reachable' $false $_.Exception.Message
}

# 2. An OPTIONS preflight from the Vite dev origin is answered with 200
#    and the origin echoed back.
try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/ping.php" -Method Options `
        -Headers @{ Origin = 'http://localhost:5173' } -UseBasicParsing
    Test-Result 'OPTIONS preflight returns 200' ($resp.StatusCode -eq 200)
    $allowOrigin = $resp.Headers['Access-Control-Allow-Origin']
    Test-Result 'OPTIONS preflight echoes the origin' ($allowOrigin -eq 'http://localhost:5173') "(got '$allowOrigin')"
} catch {
    Test-Result 'OPTIONS preflight succeeds' $false $_.Exception.Message
}

# 3. A non-localhost origin gets no Access-Control-Allow-Origin header.
try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/ping.php" -Method Get `
        -Headers @{ Origin = 'http://evil.example' } -UseBasicParsing
    $allowOrigin = $resp.Headers['Access-Control-Allow-Origin']
    Test-Result 'evil.example origin gets no Allow-Origin header' ([string]::IsNullOrEmpty($allowOrigin)) "(got '$allowOrigin')"
} catch {
    Test-Result 'request from evil.example origin completes' $false $_.Exception.Message
}

# 4. .config.json is never served, at the root or under /api.
foreach ($path in @('/.config.json', '/api/.config.json')) {
    try {
        Invoke-WebRequest -Uri "$BaseUrl$path" -Method Get -UseBasicParsing | Out-Null
        Test-Result "$path returns 403" $false '(request succeeded)'
    } catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        Test-Result "$path returns 403" ($status -eq 403) "(got $status)"
    }
}

if ($failures -gt 0) {
    Write-Host "`n$failures check(s) failed." -ForegroundColor Red
    exit 1
}

Write-Host "`nAll smoke checks passed."
exit 0
