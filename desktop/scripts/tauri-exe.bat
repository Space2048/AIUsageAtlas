@echo off
rem Build the PRODUCTION exe WITHOUT bundling installers (tauri build --no-bundle).
rem WARNING: plain `cargo build --release` produces a DEV-mode binary that loads
rem devUrl (1420) instead of the embedded dist - it renders a blank window when
rem vite is not running. Always go through the tauri CLI for prod binaries.
rem Note: keep comments ASCII-only - cmd.exe decodes this file as ANSI/GBK.
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b 1
cd /d "%~dp0.."
call npm run tauri build -- --no-bundle
