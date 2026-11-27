@echo off
setlocal
set "ROOT_DIR=%~dp0"
set "APP_DIR=%ROOT_DIR%frontend"
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

if not exist "%APP_DIR%\dist\index.html" (
  echo Building Musak frontend...
  pushd "%APP_DIR%"
  call "C:\Program Files\nodejs\npm.cmd" run build
  if errorlevel 1 (
    echo Frontend build failed.
    popd
    pause
    exit /b 1
  )
  popd
)
start "" "%APP_DIR%\node_modules\electron\dist\electron.exe" "%APP_DIR%"
