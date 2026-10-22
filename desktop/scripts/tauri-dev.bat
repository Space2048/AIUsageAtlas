@echo off
rem tauri dev wrapper: cargo needs the vcvars64 environment (see cargo-vcvars.bat).
rem Note: keep comments ASCII-only - cmd.exe decodes this file as ANSI/GBK.
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b 1
cd /d "%~dp0.."
call npm run tauri dev %*
