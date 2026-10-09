<#
.SYNOPSIS
    Script quan ly che do bao tri tren Windows Server 2012 R2 (PowerShell 4.0 compatible).
.DESCRIPTION
    Bat/Tat hoac kiem tra trang thai bao tri he thong Tai Lieu Sinh Vien.
.PARAMETER Action
    Hanh dong can thuc hien: "status" (mac dinh), "on", "off"
.EXAMPLE
    .\scripts\windows\maintenance.ps1 -Action status
    .\scripts\windows\maintenance.ps1 -Action on
    .\scripts\windows\maintenance.ps1 -Action off
#>
param(
    [ValidateSet("status", "on", "off")]
    [string]$Action = "status"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "   QUAN LY CHE DO BAO TRI - TAI LIEU SINH VIEN" -ForegroundColor Cyan
Write-Host "   Windows Server 2012 R2 / PowerShell 4.0+" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

Set-Location $RootDir

$npmCmd = "npm.cmd"
if (-not (Get-Command $npmCmd -ErrorAction SilentlyContinue)) {
    $npmCmd = "npm"
}

if ($Action -eq "on") {
    Write-Host "[THUC THI] Dang bat che do bao tri..." -ForegroundColor Yellow
    & $npmCmd run maintenance:on
}
elseif ($Action -eq "off") {
    Write-Host "[THUC THI] Dang tat che do bao tri..." -ForegroundColor Yellow
    & $npmCmd run maintenance:off
}
else {
    Write-Host "[THUC THI] Dang kiem tra trang thai bao tri..." -ForegroundColor Green
    & $npmCmd run maintenance:status
}
