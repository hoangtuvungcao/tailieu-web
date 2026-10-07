<#
.SYNOPSIS
    Download and set up Poppler (pdftoppm.exe) for Windows Server 2012 R2.

.DESCRIPTION
    Tải và cài đặt bản Poppler portable (pdftoppm.exe) phục vụ tính năng render
    trang ảnh siêu tốc (~40KB/trang, mở trong 0.2s - 0.5s) cho hệ thống TAILIEU TTN.

    Tương thích PowerShell 4.0 và 5.1 trên Windows Server 2012 R2.
    Không yêu cầu cài MSI, chỉ giải nén portable binary vào C:\tailieu\bin\poppler.

.PARAMETER Destination
    Thư mục cài đặt Poppler. Mặc định: C:\tailieu\bin\poppler

.EXAMPLE
    .\install-poppler.ps1
#>

[CmdletBinding()]
param(
    [string]$Destination = 'C:\tailieu\bin\poppler'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Step { param([string]$Message) Write-Host "  $Message" }
function Write-Ok   { param([string]$Message) Write-Host "  [ok]   $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  [warn] $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "  [fail] $Message" -ForegroundColor Red }

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Cai dat Poppler (pdftoppm) cho Windows Server 2012 R2   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Kích hoạt TLS 1.2 cho Windows Server 2012 R2 (bắt buộc để tải từ GitHub)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Kiểm tra xem pdftoppm đã có sẵn chưa
$foundBin = $null
if (Test-Path $Destination) {
    $existingItem = Get-ChildItem -Path $Destination -Filter "pdftoppm.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existingItem) {
        $foundBin = $existingItem.FullName
    }
}

if (!$foundBin) {
    $candidateBins = @(
        (Join-Path $Destination 'Library\bin\pdftoppm.exe'),
        (Join-Path $Destination 'bin\pdftoppm.exe'),
        (Join-Path $Destination 'pdftoppm.exe'),
        'C:\tailieu\bin\poppler\Library\bin\pdftoppm.exe',
        'C:\Program Files\poppler\bin\pdftoppm.exe'
    )
    foreach ($bin in $candidateBins) {
        if (Test-Path $bin) {
            $foundBin = $bin
            break
        }
    }
}

if ($foundBin) {
    Write-Ok "Da tim thay pdftoppm tai: $foundBin"
    & $foundBin -v
    [Environment]::SetEnvironmentVariable('PDFTOPPM_PATH', $foundBin, 'Machine')
    Write-Ok "Da thiet lap bien moi truong PDFTOPPM_PATH vao Machine."
    Write-Host ""
    Write-Ok "Poppler da san sang hoat dong!"
    exit 0
}

Write-Step "Chua co Poppler. Dang tien hanh tai ban portable x64..."

if (!(Test-Path $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

$tempZip = Join-Path $env:TEMP "poppler-windows-24.02.0.zip"
$downloadUrl = "https://github.com/oschwartz10612/poppler-windows/releases/download/v24.02.0-0/Release-24.02.0-0.zip"

Write-Step "Dang tai tu: $downloadUrl"
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -UseBasicParsing
    Write-Ok "Tai thanh cong tap tin zip ($((Get-Item $tempZip).Length / 1MB | ForEach-Object { '{0:N1}' -f $_ }) MB)"
} catch {
    Write-Fail "Khong the tai Poppler tu GitHub: $_"
    Write-Host ""
    Write-Host "Neu may chu khong co Internet truc tiep:" -ForegroundColor Yellow
    Write-Host "1. Tai Release-24.02.0-0.zip tu mot may khac tai: $downloadUrl"
    Write-Host "2. Chep vao thu muc: $Destination"
    Write-Host "3. Giai nen sao cho co file pdftoppm.exe"
    exit 1
}

Write-Step "Dang giai nen vao $Destination..."
try {
    # Tương thích PowerShell 4.0 và 5.1
    if (Get-Command Expand-Archive -ErrorAction SilentlyContinue) {
        Expand-Archive -Path $tempZip -DestinationPath $Destination -Force
    } else {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($tempZip, $Destination)
    }
    Write-Ok "Giai nen hoan tat."
} catch {
    Write-Fail "Loi khi giai nen zip: $_"
    exit 1
} finally {
    if (Test-Path $tempZip) {
        Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
    }
}

# Kiểm tra lại sau giải nén
$targetBin = Join-Path $Destination 'Library\bin\pdftoppm.exe'
if (!(Test-Path $targetBin)) {
    $foundItem = Get-ChildItem -Path $Destination -Filter "pdftoppm.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($foundItem) {
        $targetBin = $foundItem.FullName
    }
}

if (Test-Path $targetBin) {
    Write-Ok "Da cai dat thanh cong pdftoppm tai: $targetBin"
    & $targetBin -v

    # Thiet lap bien moi truong PDFTOPPM_PATH de he thong nhan dien ngay lap tuc
    [Environment]::SetEnvironmentVariable('PDFTOPPM_PATH', $targetBin, 'Machine')
    Write-Ok "Da luu bien moi truong PDFTOPPM_PATH vao Machine."

    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "  HOAN TAT: He thong da san sang render trang anh sieu toc! " -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "Vui long khoi dong lai service tailieu-api va tailieu-worker:"
    Write-Host "  Restart-Service tailieu-api" -ForegroundColor Yellow
    Write-Host "  Restart-Service tailieu-worker" -ForegroundColor Yellow
} else {
    Write-Fail "Khong tim thay pdftoppm.exe sau khi giai nen. Vui long kiem tra thu muc: $Destination"
    exit 1
}
