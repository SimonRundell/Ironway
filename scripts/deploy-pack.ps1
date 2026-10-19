<#
.SYNOPSIS
    Assembles a production-ready release folder for Hostinger or
    Dreamhost (Apache). See DESIGN.md 3.4 and PHASES.md T1.27.

.DESCRIPTION
    Runs `npm run build`, then copies the built front end, the `api/`
    folder and the root `.htaccess` into a clean release folder. Writes
    `.config.example.json` in as `.config.json` so the folder cannot be
    deployed by accident with real secrets still in the repo working
    copy; the server operator must edit the copy in the release folder
    with real database credentials before going live.

    Nothing under `node_modules`, `.git` or the repo's own
    `.config.json` is ever copied, since the release folder is built
    only from `dist/`, `api/` and the two named files.

.PARAMETER ReleaseDir
    Folder to (re)create the release in. Defaults to `release` in the
    project root. Deleted and recreated on every run.

.PARAMETER SkipBuild
    Skip `npm run build` and pack whatever is already in `dist/`. Useful
    when iterating on the pack step itself.

.EXAMPLE
    .\scripts\deploy-pack.ps1

.EXAMPLE
    .\scripts\deploy-pack.ps1 -ReleaseDir out\release -SkipBuild
#>

param(
    [string]$ReleaseDir = 'release',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

if (-not $SkipBuild) {
    Step 'Building the front end (npm run build)'
    Push-Location $root
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build exited with code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

$distDir = Join-Path $root 'dist'
if (-not (Test-Path $distDir) -or (Get-ChildItem $distDir -ErrorAction SilentlyContinue).Count -eq 0) {
    throw "dist/ is missing or empty at $distDir. Run npm run build first, or omit -SkipBuild."
}

$releasePath = Join-Path $root $ReleaseDir
Step "Resetting release folder: $releasePath"
if (Test-Path $releasePath) {
    Remove-Item $releasePath -Recurse -Force
}
New-Item -ItemType Directory -Path $releasePath | Out-Null

Step 'Copying dist/ contents to the release root'
Copy-Item (Join-Path $distDir '*') $releasePath -Recurse

Step 'Copying api/'
Copy-Item (Join-Path $root 'api') (Join-Path $releasePath 'api') -Recurse

Step 'Copying root .htaccess'
Copy-Item (Join-Path $root '.htaccess') (Join-Path $releasePath '.htaccess')

Step 'Writing .config.json template (from .config.example.json)'
Copy-Item (Join-Path $root '.config.example.json') (Join-Path $releasePath '.config.json')

Write-Host ''
Write-Host 'Release folder ready at:' $releasePath -ForegroundColor Green
Write-Host 'Before going live:'
Write-Host '  1. Edit .config.json in the release folder with the real database credentials.'
Write-Host '  2. Upload the whole folder to the site document root.'
Write-Host '  3. Run api/migrate.php once against the production database.'
Write-Host '  4. Confirm GET /.config.json and GET /api/.config.json both return 403.'
