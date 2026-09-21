#!/usr/bin/env bash
# Launch WebPointCloud with its virtualenv, creating it on first run.
set -euo pipefail

cd "$(dirname "$0")"
VENV=".venv"
PY="$VENV/bin/python"

if [ ! -x "$PY" ]; then
    echo "Creating $VENV ..."
    python3 -m venv "$VENV"
fi

# Install/refresh dependencies only when something is missing.
if ! "$PY" -c "import flask, numpy, laspy, scipy, copclib" >/dev/null 2>&1; then
    echo "Installing dependencies from requirements.txt ..."
    "$PY" -m pip install --upgrade pip >/dev/null
    "$PY" -m pip install -r requirements.txt
fi

exec "$PY" app.py "$@"
