<#
.SYNOPSIS
    Register the TAILIEU TTN services on Windows.

.DESCRIPTION
    Windows Server 2012 R2 cannot run the Docker stack: native Windows
    containers need Server 2016 or later, and Docker Desktop is not supported on
    any server edition. So each piece runs as a native Windows service instead.

    This script registers the services that Node provides (API, converter
    worker, cleanup worker) and cloudflared. It does NOT install PostgreSQL,
    Memurai, SeaweedFS or LibreOffice — those have their own installers, and a
    script that silently installs database software is not something anyone
    should run by accident.

    Prerequisites are verified first and missing ones are reported together,
    rather than failing on the first one and making you re-run the script four
    times to discover the rest.

.PARAMETER InstallRoot
    Where the application lives. Defaults to C:\tailieu.

.PARAMETER NssmPath
    Path to nssm.exe. Node and cloudflared are console applications, not
    service-aware binaries, so a wrapper is required to run them as services.

.PARAMETER Uninstall
    Stop and remove the services. Leaves data and configuration untouched.

.EXAMPLE
    .\install-services.ps1 -InstallRoot C:\tailieu -NssmPath C:\tools\nssm\nssm.exe

.NOTES
    Written for PowerShell 4.0, which is what Server 2012 R2 ships with, so it
    avoids syntax that needs 5.1 or PowerShell 7 — no `??`, no ternaries, no
    `-Parallel`. Windows Management Framework 5.1 is still recommended.
#>

[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\tailieu',
    [string]$NssmPath = 'C:\tools\nssm\nssm.exe',
    [string]$EnvFile = 'C:\tailieu\.env',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# --- Helpers -----------------------------------------------------------------

function Write-Step  { param([string]$Message) Write-Host "  $Message" }
function Write-Ok    { param([string]$Message) Write-Host "  [ok]   $Message" -ForegroundColor Green }
function Write-Warn  { param([string]$Message) Write-Host "  [warn] $Message" -ForegroundColor Yellow }
function Write-Fail  { param([string]$Message) Write-Host "  [fail] $Message" -ForegroundColor Red }

function Test-CommandExists {
    param([string]$Name)
    # Get-Command throws under StrictMode when nothing matches, so the result is
    # captured rather than the call being trusted.
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    return $null -ne $found
}

function Test-FileExists {
    param([string]$Path)
    return [System.IO.File]::Exists($Path)
}

# --- Service definitions -----------------------------------------------------
#
# Ordered by dependency: the API needs the database, and the workers need Redis
# and the object store. Windows starts services in parallel by default, so the
# dependencies are declared rather than assumed.

# The PostgreSQL service name carries its major version, and which version you
# can install depends on the operating system: 15 and later require Windows
# Server 2016+, so a 2012 R2 host runs 14 and registers `postgresql-x64-14`.
#
# A hard-coded version here fails quietly rather than loudly. The dependency is
# applied only if the named service exists (see the `sc.exe config` below), so
# on a 2012 R2 machine `postgresql-x64-16` matched nothing, the filter dropped
# it, and the API came up with no database dependency at all — starting in
# parallel with Postgres and racing it on every boot. NSSM's restart eventually
# hid the race, which is what made it worth removing rather than documenting.
#
# Matching the same wildcard the prerequisite check below uses, so the two
# cannot disagree about what counts as "PostgreSQL is installed". That check
# exits before any service is registered, so this always finds a service here.
$postgresService = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue |
    Sort-Object Name |
    Select-Object -First 1

$postgresDependency = @()
if ($null -ne $postgresService) {
    $postgresDependency = @($postgresService.Name)
}

$redisService = Get-Service -Name @('Redis*', 'Memurai*') -ErrorAction SilentlyContinue |
    Sort-Object Name |
    Select-Object -First 1

$redisDependency = @()
if ($null -ne $redisService) {
    $redisDependency = @($redisService.Name)
}

$Services = @(
    @{
        Name        = 'tailieu-api'
        DisplayName = 'TAILIEU TTN API'
        Description = 'Fastify API server for TAILIEU TTN.'
        Command     = $null   # filled in after Node is located
        Args        = 'dist/server.js'
        Directory   = "$InstallRoot\backend"
        DependsOn   = $postgresDependency + $redisDependency
    },
    @{
        Name        = 'tailieu-worker'
        DisplayName = 'TAILIEU TTN Converter Worker'
        Description = 'LibreOffice document-to-PDF conversion worker.'
        Command     = $null
        Args        = 'node_modules\.bin\tsx.cmd src/workers/converter/index.ts'
        Directory   = "$InstallRoot\backend"
        DependsOn   = $redisDependency
    },
    @{
        Name        = 'tailieu-cleanup'
        DisplayName = 'TAILIEU TTN Maintenance'
        Description = 'Reaps abandoned uploads, purges expired tokens, reclaims orphaned objects.'
        Command     = $null
        Args        = 'node_modules\.bin\tsx.cmd src/workers/cleanup/index.ts --loop'
        Directory   = "$InstallRoot\backend"
        DependsOn   = @()
    },
    @{
        Name        = 'tailieu-tunnel'
        DisplayName = 'TAILIEU TTN Cloudflare Tunnel'
        Description = 'Publishes the local API through Cloudflare Tunnel.'
        Command     = $null   # resolved separately; cloudflared is its own binary
        Args        = '--no-autoupdate --config C:\tailieu\cloudflared\config.yml tunnel run'
        Directory   = 'C:\tailieu\cloudflared'
        DependsOn   = @('tailieu-api')
    }
)

# --- Uninstall ---------------------------------------------------------------

if ($Uninstall) {
    Write-Host "`nRemoving TAILIEU TTN services`n"

    # Reverse order so dependents stop before what they depend on.
    [array]::Reverse($Services)

    foreach ($service in $Services) {
        $existing = Get-Service -Name $service.Name -ErrorAction SilentlyContinue
        if ($null -eq $existing) {
            Write-Step "$($service.Name): not installed"
            continue
        }

        Write-Step "$($service.Name): stopping and removing"
        & $NssmPath stop $service.Name confirm | Out-Null
        & $NssmPath remove $service.Name confirm | Out-Null
        Write-Ok "$($service.Name) removed"
    }

    Write-Host "`nData, configuration and database were NOT touched.`n"
    exit 0
}

# --- Prerequisite checks -----------------------------------------------------

Write-Host "`nTAILIEU TTN - Windows service installation`n"
Write-Host "Checking prerequisites"

$missing = @()

if (Test-CommandExists 'node') {
    $nodeVersion = (& node --version) -join ''
    Write-Ok "Node $nodeVersion"
} else {
    Write-Fail 'Node.js not found on PATH'
    $missing += 'Node.js 20 (see docs\WINDOWS.md - unsupported on Server 2012 R2 but runs)'
}

if (Test-FileExists $NssmPath) {
    Write-Ok "NSSM at $NssmPath"
} else {
    Write-Fail "NSSM not found at $NssmPath"
    $missing += 'NSSM (https://nssm.cc/download) - required to run Node as a service'
}

if (Test-FileExists $EnvFile) {
    Write-Ok "Environment file at $EnvFile"
} else {
    Write-Fail "Environment file not found: $EnvFile"
    $missing += "Environment file - copy .env.production.example to $EnvFile and fill it in"
}

# LibreOffice is not a service, but the converter worker is useless without it
# and the failure shows up much later as "every preview fails".
$soffice = 'C:\Program Files\LibreOffice\program\soffice.exe'
if (Test-FileExists $soffice) {
    Write-Ok "LibreOffice"
} else {
    Write-Fail "LibreOffice not found at $soffice"
    $missing += 'LibreOffice - the converter worker cannot run without it'
}

# These are installed by their own installers; the script only verifies.
foreach ($dependency in @(
    @{ Name = 'PostgreSQL'; Service = 'postgresql*'; Hint = 'PostgreSQL 14 for Windows' },
    @{ Name = 'Redis-compatible store'; Service = @('Redis*', 'Memurai*'); Hint = 'Redis or Memurai' },
    @{ Name = 'Object storage'; Service = $null; Hint = 'SeaweedFS weed.exe' }
)) {
    if ($dependency.Service) {
        $found = Get-Service -Name $dependency.Service -ErrorAction SilentlyContinue
        if ($null -ne $found) {
            Write-Ok $dependency.Name
            continue
        }
        Write-Fail "$($dependency.Name) service not found"
        $missing += $dependency.Hint
    }
}

if ($missing.Count -gt 0) {
    Write-Host "`nInstall the following, then run this script again:`n" -ForegroundColor Yellow
    foreach ($item in $missing) { Write-Host "    - $item" }
    Write-Host "`nSee docs\WINDOWS.md for install links and configuration.`n"
    exit 1
}

$nodeExe = (Get-Command node).Source

# --- Directory layout --------------------------------------------------------

Write-Host "`nPreparing directories"
foreach ($dir in @(
    $InstallRoot,
    "$InstallRoot\logs",
    "$InstallRoot\backups",
    "$InstallRoot\cloudflared"
)) {
    if (-not [System.IO.Directory]::Exists($dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Step "created $dir"
    }
}
Write-Ok 'directories ready'

# Worker temp directories. LibreOffice writes a profile on first run, and a
# path with spaces in it breaks the file:// URL LibreOffice is passed.
foreach ($dir in @("$InstallRoot\tmp\convert", "$InstallRoot\tmp\profile")) {
    if (-not [System.IO.Directory]::Exists($dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

# --- Register services -------------------------------------------------------

Write-Host "`nRegistering services"

foreach ($service in $Services) {
    if ($service.Name -eq 'tailieu-tunnel') {
        $cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
        if ($null -eq $cloudflared) {
            Write-Warn 'cloudflared not on PATH - skipping the tunnel service'
            Write-Step 'install it, then re-run this script'
            continue
        }
        $service.Command = $cloudflared.Source
    } else {
        $service.Command = $nodeExe
    }

    $existing = Get-Service -Name $service.Name -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        Write-Step "$($service.Name): already exists, updating"
        & $NssmPath stop $service.Name confirm 2>&1 | Out-Null
    } else {
        Write-Step "$($service.Name): creating"
        & $NssmPath install $service.Name $service.Command 2>&1 | Out-Null
    }

    & $NssmPath set $service.Name AppDirectory $service.Directory 2>&1 | Out-Null
    & $NssmPath set $service.Name AppParameters $service.Args 2>&1 | Out-Null
    & $NssmPath set $service.Name DisplayName $service.DisplayName 2>&1 | Out-Null
    & $NssmPath set $service.Name Description $service.Description 2>&1 | Out-Null

    # NSSM reads the .env file and injects it, so secrets are not passed on a
    # command line where any local process could read them from the process list.
    & $NssmPath set $service.Name AppEnvironmentExtra "NODE_ENV=production" 2>&1 | Out-Null

    # Logs, with rotation. Without this NSSM discards stdout and a crash leaves
    # no evidence at all.
    & $NssmPath set $service.Name AppStdout "$InstallRoot\logs\$($service.Name).log" 2>&1 | Out-Null
    & $NssmPath set $service.Name AppStderr "$InstallRoot\logs\$($service.Name).error.log" 2>&1 | Out-Null
    & $NssmPath set $service.Name AppRotateFiles 1 2>&1 | Out-Null
    & $NssmPath set $service.Name AppRotateBytes 10485760 2>&1 | Out-Null

    # Restart on crash, but give up after repeated failures rather than
    # thrashing — a service that crash-loops forever hides the real problem.
    & $NssmPath set $service.Name AppExit Default Restart 2>&1 | Out-Null
    & $NssmPath set $service.Name AppRestartDelay 5000 2>&1 | Out-Null
    & $NssmPath set $service.Name AppThrottle 10000 2>&1 | Out-Null

    if ($service.DependsOn.Count -gt 0) {
        $deps = ($service.DependsOn | Where-Object {
            $null -ne (Get-Service -Name $_ -ErrorAction SilentlyContinue)
        }) -join '/'
        if ($deps -ne '') {
            & sc.exe config $service.Name depend= $deps 2>&1 | Out-Null
        }
    }

    & $NssmPath set $service.Name Start SERVICE_AUTO_START 2>&1 | Out-Null
    Write-Ok "$($service.Name) registered"
}

Write-Host "`nDone.`n"
Write-Host "  Start everything:   Start-Service tailieu-api, tailieu-worker, tailieu-cleanup"
Write-Host "  Verify the API:     Invoke-RestMethod http://localhost:3000/api/health"
Write-Host "  Logs:               $InstallRoot\logs\"
Write-Host ''
Write-Host '  The .env file is read by the API itself (dotenv), not injected by NSSM,'
Write-Host '  so changing it needs a service restart, not a re-run of this script.'
Write-Host ''
