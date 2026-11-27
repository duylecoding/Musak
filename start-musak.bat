@echo off
setlocal
set "ROOT_DIR=%~dp0"
set "TAURI_REL=%ROOT_DIR%src-tauri\target\release\musak.exe"
set "TAURI_DBG=%ROOT_DIR%src-tauri\target\debug\musak.exe"

if exist "%TAURI_REL%" (
  start "" "%TAURI_REL%"
  exit /b 0
)

if exist "%TAURI_DBG%" (
  start "" "%TAURI_DBG%"
  exit /b 0
)

echo Musak native binary not built yet. Run "cargo build --release --bin musak" inside src-tauri\.
pause
exit /b 1
