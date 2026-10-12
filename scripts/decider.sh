#!/usr/bin/env bash
# Installs and runs the local Strands Decider server that strands-router asks for routing.
#
#   scripts/decider.sh install     create a Python venv and pip install strands-decider
#   scripts/decider.sh serve       run the server in the foreground (Ctrl-C to stop)
#   scripts/decider.sh check       ask the running server one question
#   scripts/decider.sh autostart   macOS: start the server at login with launchd
#   scripts/decider.sh stop        macOS: remove the launchd job
#
# Settings (environment): STRANDS_DECIDER_CHECKPOINT, STRANDS_DECIDER_PORT, STRANDS_DECIDER_DEVICE,
# STRANDS_HOME (default ~/.strands-router, where the venv and logs live).
set -euo pipefail

HOME_DIR="${STRANDS_HOME:-$HOME/.strands-router}"
VENV="$HOME_DIR/venv"
CHECKPOINT="${STRANDS_DECIDER_CHECKPOINT:-StrandsAgents/strands-decider-2B-hobson-v19}"
PORT="${STRANDS_DECIDER_PORT:-8000}"
DEVICE="${STRANDS_DECIDER_DEVICE:-}"
LABEL="com.strands-router.decider"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

die() { echo "decider: $*" >&2; exit 1; }

find_python() {
  # strands-decider needs Python 3.10+; macOS's bundled python3 is older.
  for py in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$py" >/dev/null 2>&1 &&
      "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      command -v "$py"
      return
    fi
  done
  die "Python 3.10+ not found. Install one with: brew install python@3.12"
}

cmd_install() {
  if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" != "arm64" ]]; then
    echo "decider: warning: current PyTorch has no Intel-Mac wheels; this needs Apple silicon." >&2
  fi
  mkdir -p "$HOME_DIR"
  [[ -x "$VENV/bin/python" ]] || "$(find_python)" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --upgrade pip >/dev/null
  "$VENV/bin/python" -m pip install --upgrade strands-decider
  echo "decider: installed into $VENV"
  echo "decider: the first 'serve' downloads the $CHECKPOINT weights from Hugging Face (a few GB)."
}

serve_args() {
  local args=(serve "$CHECKPOINT" --host 127.0.0.1 --port "$PORT")
  [[ -n "$DEVICE" ]] && args+=(--device "$DEVICE")
  printf '%s\n' "${args[@]}"
}

cmd_serve() {
  [[ -x "$VENV/bin/strands-decider" ]] || die "not installed; run: $0 install"
  # MPS lacks a few kernels; let PyTorch fall back to CPU for those instead of erroring.
  export PYTORCH_ENABLE_MPS_FALLBACK=1
  local args=()
  while IFS= read -r arg; do args+=("$arg"); done < <(serve_args)  # bash 3.2 has no mapfile
  exec "$VENV/bin/strands-decider" "${args[@]}"
}

cmd_check() {
  curl -fsS "http://127.0.0.1:$PORT/health" && echo
  curl -fsS "http://127.0.0.1:$PORT/v1/systemone" -H 'content-type: application/json' -d '{
    "state": "fix the typo recieve -> receive in README.md",
    "questions": {"model": {"type": "choice", "instructions": "Pick the cheapest model that can do this coding task.",
      "criteria": {"haiku": "Trivial, mechanical edits.", "sonnet": "Ordinary bounded engineering.", "opus": "Hard, ambiguous, high blast radius."}}}
  }' && echo
}

cmd_autostart() {
  [[ "$(uname -s)" == "Darwin" ]] || die "autostart uses launchd and is macOS-only"
  [[ -x "$VENV/bin/strands-decider" ]] || die "not installed; run: $0 install"
  mkdir -p "$(dirname "$PLIST")" "$HOME_DIR/logs"
  local program_args=""
  while IFS= read -r arg; do program_args+="    <string>$arg</string>"$'\n'; done < <(serve_args)
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$VENV/bin/strands-decider</string>
$program_args  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PYTORCH_ENABLE_MPS_FALLBACK</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME_DIR/logs/decider.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/decider.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "decider: starts at login; logs in $HOME_DIR/logs/decider.log"
}

cmd_stop() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "decider: launchd job removed"
}

case "${1:-}" in
  install) cmd_install ;;
  serve) cmd_serve ;;
  check) cmd_check ;;
  autostart) cmd_autostart ;;
  stop) cmd_stop ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
