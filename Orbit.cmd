@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "ORBIT_ROOT=%~dp0"
set "ORBIT_TARGET=%ORBIT_ROOT%Orbit.exe"

if exist "%ORBIT_ROOT%scripts\standalone-resolve.cjs" (
  set "ORBIT_RESOLVED="
  for /f "delims=" %%T in ('node "%ORBIT_ROOT%scripts\standalone-resolve.cjs" --print-exe "%ORBIT_ROOT%." 2^>nul') do set "ORBIT_RESOLVED=%%T"
  if not defined ORBIT_RESOLVED (
    echo Orbit: no valid standalone bundle found. Need Orbit.exe and non-empty resources\app.asar. 1>&2
    exit /b 1
  )
  if not exist "%ORBIT_RESOLVED%" (
    echo Orbit: resolved exe missing: %ORBIT_RESOLVED% 1>&2
    exit /b 1
  )
  set "ORBIT_TARGET=%ORBIT_RESOLVED%"
) else (
  rem Inside a packaged bundle: use this directory's Orbit.exe ^(no mtime dir scan^).
  if not exist "%ORBIT_TARGET%" (
    echo Orbit: Orbit.exe not found in %ORBIT_ROOT% 1>&2
    exit /b 1
  )
)

start "Orbit" "%ORBIT_TARGET%" %*
