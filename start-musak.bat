@echo off
setlocal
set "APP_DIR=%~dp0frontend"
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
