@echo off
REM Race-day boot script - Windows.
REM Sets up venv if missing, installs deps, prints LAN URLs for phones,
REM then runs the Flask server bound to all interfaces on %PORT% (default 5050).
setlocal enabledelayedexpansion

cd /d "%~dp0"

if "%PORT%"=="" set PORT=5050
if "%VENV%"=="" set VENV=.venv

REM --- venv ----------------------------------------------------------------
if not exist "%VENV%\Scripts\python.exe" (
  echo [run] creating venv in %VENV%
  python -m venv "%VENV%"
)

REM --- deps ----------------------------------------------------------------
if not exist "%VENV%\.deps-installed" (
  echo [run] installing requirements
  "%VENV%\Scripts\pip.exe" install -q -r requirements.txt
  type nul > "%VENV%\.deps-installed"
)

REM --- LAN IP --------------------------------------------------------------
set LAN_IP=^<your-laptop-ip^>
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
  set CANDIDATE=%%a
  set CANDIDATE=!CANDIDATE: =!
  if not "!CANDIDATE!"=="127.0.0.1" set LAN_IP=!CANDIDATE!
  goto :got_ip
)
:got_ip

REM --- banner --------------------------------------------------------------
echo.
echo ====================================================================
echo   WLOO/EV * PIT TELEMETRY * race-day server
echo ====================================================================
echo   Local laptop:        http://localhost:%PORT%/
echo   Phones / pit crew:   http://%LAN_IP%:%PORT%/
echo.
echo   Pages:
echo     /            PIT WALL    (laptop big-screen)
echo     /scout       SPOTTER     (phones)
echo     /race-log    RACE LOG    (LoRa USB, Chrome only)
echo     /self        DRIVER      (in-car phone)
echo.
echo   Stop with Ctrl-C. Reset DB: del scouting.db, restart.
echo ====================================================================
echo.

REM --- run -----------------------------------------------------------------
"%VENV%\Scripts\python.exe" app.py
