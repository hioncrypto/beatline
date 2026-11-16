#!/bin/bash
cd "$(dirname "$0")"
PORT=8766
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "Python is not installed. Opening Fieldbook as a file instead."
  open index.html
  exit 0
fi
echo "Fieldbook is at http://127.0.0.1:${PORT}/"
echo "Keep this window open while you use it."
(sleep 0.4 && open "http://127.0.0.1:${PORT}/") &
exec "$PY" -m http.server "$PORT"
