<#
.SYNOPSIS
    Back up the TAILIEU TTN PostgreSQL database.

.DESCRIPTION
    Windows twin of the backup documented in docs/DEPLOYMENT.md.

    Two things this script does that a naive pg_dump one-liner does not:

    1. VERIFIES the dump is readable before keeping it. A pg_dump that fails
       partway still leaves a file, and a file that exists looks like a
       successful backup — until the day it is needed. `pg_restore --list`
       against the fresh dump is what turns "a file appeared" into "the backup
       works".

    2. PRUNES by count, keeping the newest N. Pruning by age on a machine that
       was offline for a month would delete the only backups that exist.

    What it does NOT back up: the object store (documents) and the .env file.
    Both are covered in docs/DEPLOYMENT.md and both are needed for a real
    restore — a database alone gives you metadata pointing at files that are
    gone. The .env holds ARGON2_PEPPER, without which every password in the
    dump is unusable.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File backup.ps1 -Keep 30
#>

[CmdletBinding()]
param(
    [string]$BackupDir = 'C:\tailieu\backups',
    [string]$BackendRoot = 'C:\tailieu\backend',
    [string]$EnvFile = 'C:\tailieu\.env',
    [int]$Keep = 30,
    # PostgreSQL bin directory; pg_dump is not on PATH by default on Windows.
    [string]$PgBin = 'C:\Program Files\PostgreSQL\14\bin'
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$m) Write-Host "  $m" }
function Write-Ok   { param([string]$m) Write-Host "  [ok]   $m" -ForegroundColor Green }
function Write-Fail { param([string]$m) Write-Host "  [fail] $m" -ForegroundColor Red }

Write-Host ''
Write-Host 'TAILIEU TTN - database backup'
Write-Host ''

if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

# Read DATABASE_URL from the environment file rather than duplicating
# credentials in a scheduled task, where they would be visible in the task's
# action parameters to anyone who can read the task list.
if (-not (Test-Path $EnvFile)) {
    Write-Fail "Environment file not found: $EnvFile"
    exit 1
}

$databaseUrl = $null
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*DATABASE_URL\s*=\s*(.+)$') {
        $databaseUrl = $Matches[1].Trim()
    }
}

if (-not $databaseUrl) {
    Write-Fail "DATABASE_URL not found in $EnvFile"
    exit 1
}

$pgDump = Join-Path $PgBin 'pg_dump.exe'
$pgRestore = Join-Path $PgBin 'pg_restore.exe'

if (-not (Test-Path $pgDump)) {
    Write-Fail "pg_dump not found at $pgDump"
    Write-Step 'Pass -PgBin with the correct PostgreSQL bin directory.'
    exit 1
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $BackupDir "tailieu-$stamp.dump"

Write-Step "dumping to $target"

# -Fc is the custom format: compressed, and restorable selectively with
# pg_restore. A plain SQL dump cannot be restored table-by-table, which is
# exactly what is needed when one table is corrupted and the rest is fine.
& $pgDump --dbname=$databaseUrl --format=custom --file=$target --no-owner --no-privileges

if ($LASTEXITCODE -ne 0) {
    Write-Fail "pg_dump exited with $LASTEXITCODE"
    if (Test-Path $target) { Remove-Item $target -Force }
    exit 1
}

$sizeMb = [math]::Round((Get-Item $target).Length / 1MB, 2)
Write-Ok "dump written ($sizeMb MB)"

# --- Verify the dump is actually readable -------------------------------------
#
# This is the step that separates a backup from a file. pg_restore --list parses
# the archive's table of contents; if the dump was truncated — a full disk, a
# killed process — this fails here rather than during a restore.
Write-Step 'verifying the dump is readable'

& $pgRestore --list $target > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Fail 'The dump cannot be read back. It is NOT a usable backup.'
    Write-Step 'Keeping it for inspection, but do not rely on it.'
    exit 1
}
Write-Ok 'dump verified'

# --- Prune --------------------------------------------------------------------
#
# By count, not by age. A server that was down for two months would, under an
# age-based rule, have every backup expire at once — losing everything at the
# moment it is most needed.
$all = Get-ChildItem -Path $BackupDir -Filter 'tailieu-*.dump' |
       Sort-Object LastWriteTime -Descending

if ($all.Count -gt $Keep) {
    $toRemove = $all | Select-Object -Skip $Keep
    Write-Step "removing $($toRemove.Count) old backup(s), keeping the newest $Keep"
    foreach ($file in $toRemove) { Remove-Item $file.FullName -Force }
}

Write-Ok "done - $((Get-ChildItem -Path $BackupDir -Filter 'tailieu-*.dump').Count) backup(s) retained"
Write-Host ''
Write-Host '  Reminder: this backs up the DATABASE only.'
Write-Host '  A full restore also needs the object store and the .env file'
Write-Host '  (which holds ARGON2_PEPPER - without it every password is unusable).'
Write-Host '  See docs\WINDOWS.md and docs\DEPLOYMENT.md.'
Write-Host ''
