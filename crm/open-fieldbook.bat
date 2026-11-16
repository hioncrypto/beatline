@echo off
cd /d "%~dp0"
where python >nul 2>&1
if errorlevel 1 (
  echo Python was not found. Opening Fieldbook as a file instead.
  start "" "%~dp0index.html"
  exit /b 0
)
echo Fieldbook is at http://127.0.0.1:8766/
echo Keep this window open while you use it.
start "" "http://127.0.0.1:8766/"
python -m http.server 8766
