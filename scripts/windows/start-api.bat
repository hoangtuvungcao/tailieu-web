@echo off
rem ============================================================================
rem  Khoi dong Backend Fastify API tren Windows Server 2012 R2
rem ============================================================================
cd /d "%~dp0..\.."

echo ====================================================
echo   KHOI DONG API SERVER - TAI LIEU SINH VIEN
echo   Windows Server 2012 R2
echo ====================================================

call npm run start --workspace backend
if %errorlevel% neq 0 (
    echo [THONG BAO] Chua co thu muc dist, khoi dong bang tsx dev...
    call npm run dev --workspace backend
)
pause
