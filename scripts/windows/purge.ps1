<#
.SYNOPSIS
    Script ra soat va thanh loc tai lieu vi pham tren Windows Server 2012 R2.
.DESCRIPTION
    Ra soat (audit) hoac thanh loc/an (run) cac tai lieu vi pham ban quyen va thuong hieu.
.PARAMETER Mode
    Che do chay: "audit" (chi xem danh sach, mac dinh), "run" (thuc thi an/luu tru)
.EXAMPLE
    .\scripts\windows\purge.ps1 -Mode audit
    .\scripts\windows\purge.ps1 -Mode run
#>
param(
    [ValidateSet("audit", "run")]
    [string]$Mode = "audit"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "   RA SOAT & THANH LOC TAI LIEU VI PHAM BAN QUYEN" -ForegroundColor Cyan
Write-Host "   Windows Server 2012 R2 / PowerShell 4.0+" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

Set-Location $RootDir

$npmCmd = "npm.cmd"
if (-not (Get-Command $npmCmd -ErrorAction SilentlyContinue)) {
    $npmCmd = "npm"
}

if ($Mode -eq "run") {
    Write-Host "[CANH BAO] Dang tien hanh an/luu tru tai lieu vi pham..." -ForegroundColor Yellow
    & $npmCmd run purge:run
}
else {
    Write-Host "[KIEM TRA] Dang ra soat danh sach tai lieu..." -ForegroundColor Green
    & $npmCmd run purge:audit
}
