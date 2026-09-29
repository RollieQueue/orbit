@echo off
setlocal
rem Orbit runs from this repository: node_modules\electron\dist\electron.exe <repo> [args].
rem Arguments pass through; --relaunch asks an already running Orbit to restart itself
rem (second-instance handler in electron\main.cjs) and simply starts one when none runs.
set "ELECTRON_RUN_AS_NODE="
set "ORBIT_ROOT=%~dp0"
set "ORBIT_APP=%ORBIT_ROOT:~0,-1%"

rem Packaged layout (npm run package:win copies this file next to Orbit.exe): start the bundle's own exe.
if exist "%ORBIT_ROOT%Orbit.exe" (
  start "Orbit" /d "%ORBIT_APP%" "%ORBIT_ROOT%Orbit.exe" %*
  exit /b 0
)

set "ORBIT_ELECTRON=%ORBIT_ROOT%node_modules\electron\dist\electron.exe"
if not exist "%ORBIT_ROOT%dist\index.html" (
  echo Orbit: dist\index.html not found in "%ORBIT_APP%". Run "npm run build" first. 1>&2
  exit /b 1
)
if not exist "%ORBIT_ELECTRON%" (
  echo Orbit: node_modules\electron is missing in "%ORBIT_APP%". Run "npm install" first. 1>&2
  exit /b 1
)
start "Orbit" /d "%ORBIT_APP%" "%ORBIT_ELECTRON%" "%ORBIT_APP%" %*
exit /b 0
