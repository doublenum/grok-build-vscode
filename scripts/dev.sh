#!/usr/bin/env bash
#
# Fast local development loop for grok-build-vscode.
#
# This script forces the required Node 22 (same logic as scripts/package.sh)
# and builds (or watches) both the extension host code and the React webview.
#
# Usage:
#   ./scripts/dev.sh            # one-shot build, then use "Run Extension (fast)" + F5
#   ./scripts/dev.sh --watch    # continuous rebuild on changes (recommended)
#
# Then in VS Code:
#   - Use the "Run Extension (fast)" launch configuration
#   - Press F5 to open an Extension Development Host
#   - In the host: Ctrl/Cmd+R to reload after changes
#
# For the React editor tab ("Grok: Open in Editor Tab"), changes to webview/src/
# will be picked up after the webview rebuild + reload in the host window.

set -euo pipefail

# === Force the pinned Node 22 (required for Vite 7 + React webview) ===
NODE_DIR="/home/offworld/.local/node-v22.14.0-linux-x64/bin"
if [ -x "$NODE_DIR/node" ]; then
    export PATH="$NODE_DIR:$PATH"
else
    echo "Warning: Node 22 not found at $NODE_DIR"
    echo "Falling back to whatever 'node' is in PATH. Vite build may fail."
fi

echo "Using Node: $(node --version)  |  npm: $(npm --version)"
echo

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# Install deps if node_modules is missing
if [ ! -d node_modules ]; then
    echo "==> Installing dependencies..."
    npm install
fi

WATCH=false
if [[ "${1:-}" == "--watch" || "${1:-}" == "watch" || "${1:-}" == "-w" ]]; then
    WATCH=true
fi

if $WATCH; then
    echo "==> Starting watchers (fast iteration mode)"
    echo "    - webview/src/*  → Vite will rebuild out/webview/"
    echo "    - src/*.ts       → tsc will rebuild out/"
    echo
    echo "Now open VS Code, select 'Run Extension (fast)' in the debug dropdown, and press F5."
    echo "In the Extension Development Host window use Ctrl/Cmd+R to reload after changes."
    echo
    echo "Press Ctrl+C here to stop watchers."
    echo

    # Run both watchers in parallel.
    # Vite supports `build --watch`. tsc supports `-w`.
    npm run build:webview -- --watch &
    WEBVIEW_PID=$!

    npx tsc -p . -w --preserveWatchOutput &
    TSC_PID=$!

    # If either exits, kill the other and exit
    trap 'kill $WEBVIEW_PID $TSC_PID 2>/dev/null || true' EXIT INT TERM

    wait
else
    echo "==> Building webview (React editor tab) + TypeScript (extension host)..."
    npm run build:webview
    npx tsc -p . --skipLibCheck

    echo
    echo "✅ Build complete."
    echo
    echo "Next steps:"
    echo "  1. In VS Code, select the 'Run Extension (fast)' debug configuration."
    echo "  2. Press F5 to launch an Extension Development Host."
    echo "  3. In the host window, run the command 'Grok: Open in Editor Tab' to test the React UI."
    echo
    echo "For continuous rebuilds while editing, run:"
    echo "  ./scripts/dev.sh --watch"
fi
