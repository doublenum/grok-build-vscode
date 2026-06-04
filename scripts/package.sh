#!/usr/bin/env bash
#
# Builds the packaged .vsix for development/testing.
#
# Usage:
#   ./scripts/package.sh                 # Normal build (same identity as Marketplace)
#   ./scripts/package.sh --local         # Builds as a COMPLETELY SEPARATE extension
#                                        # (different ID so VS Code treats it as new)
#
# Note: In Windows + WSL2 setups, the installed version may not survive
# a full VS Code restart. For daily development, prefer `npm run dev:watch`
# + "Run Extension (fast)" instead.

set -euo pipefail

# === Force Node 22 (installed at ~/.local/node-v22.14.0-linux-x64) ===
NODE_DIR="/home/offworld/.local/node-v22.14.0-linux-x64/bin"
if [ -x "$NODE_DIR/node" ]; then
    export PATH="$NODE_DIR:$PATH"
else
    echo "Warning: Node 22 not found at $NODE_DIR"
    echo "Falling back to system node (Vite build may fail)"
fi

echo "Using Node: $(node --version)  |  npm: $(npm --version)"
echo

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

echo "==> Installing dependencies (if needed)"
[ -d node_modules ] || npm install

# === Handle local dev mode (completely separate extension) ===
LOCAL_MODE=false
if [[ "${1:-}" == "--local" ]]; then
    LOCAL_MODE=true
fi

if $LOCAL_MODE; then
    echo "==> Building as COMPLETELY NEW extension (different ID)"
    echo "    All command/view/config IDs will be under 'grok-local.*' to avoid conflicts."

    # Backup files we will patch
    cp package.json package.json.bak
    cp src/extension.ts src/extension.ts.bak
    cp src/sidebar.ts src/sidebar.ts.bak
    cp webview/src/App.tsx webview/src/App.tsx.bak

    # Ensure restoration even on error
    trap '
      [ -f package.json.bak ] && mv package.json.bak package.json
      [ -f src/extension.ts.bak ] && mv src/extension.ts.bak src/extension.ts
      [ -f src/sidebar.ts.bak ] && mv src/sidebar.ts.bak src/sidebar.ts
      [ -f webview/src/App.tsx.bak ] && mv webview/src/App.tsx.bak webview/src/App.tsx
    ' EXIT INT TERM

    # Patch package.json + sources for a completely isolated dev extension
    cat > /tmp/grok-local-patch.js << 'PATCHEOF'
      const fs = require("fs");
      let pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

      pkg.publisher = "local-dev";
      pkg.name = "grok-build-local";
      pkg.displayName = "Grok Build (Local Dev)";
      pkg.version = "0.0.0-local";
      pkg.description = "LOCAL DEV BUILD - completely separate from the Marketplace version. Uses grok-local.* command IDs.";
      pkg.author = { name: "LOCAL BUILD DEV", url: "" };

      // Make command titles clearly indicate this is the dev version
      if (pkg.contributes?.commands) {
        pkg.contributes.commands = pkg.contributes.commands.map((c) => {
          if (c.title && !c.title.includes("(Dev)")) {
            c.title = c.title.replace("Grok:", "Grok (Dev):");
          }
          return c;
        });
      }

      const replaceGrok = (s) => s.replace(/grok\./g, "grok-local.");

      // viewsContainers - make it a clearly separate "Grok (Local Dev)" view container
      if (pkg.contributes?.viewsContainers) {
        for (const loc of Object.keys(pkg.contributes.viewsContainers)) {
          pkg.contributes.viewsContainers[loc] = pkg.contributes.viewsContainers[loc].map(c => {
            if (c.id === "grokSidebar") {
              c.id = "grokLocalSidebar";
              c.title = "Grok (Local Dev)";
            }
            return c;
          });
        }
      }

      // views
      if (pkg.contributes?.views) {
        const oldViews = pkg.contributes.views;
        pkg.contributes.views = {};
        for (const [container, views] of Object.entries(oldViews)) {
          const newContainer = container === "grokSidebar" ? "grokLocalSidebar" : container;
          pkg.contributes.views[newContainer] = views.map(v => {
            if (v.id) v.id = v.id.replace("grok.chat", "grok-local.chat");
            if (v.name) v.name = "Grok (Local Dev)";
            return v;
          });
        }
      }

      // commands
      if (pkg.contributes?.commands) {
        pkg.contributes.commands = pkg.contributes.commands.map(c => {
          c.command = replaceGrok(c.command);
          return c;
        });
      }

      // keybindings
      if (pkg.contributes?.keybindings) {
        pkg.contributes.keybindings = pkg.contributes.keybindings.map(k => {
          if (k.command) k.command = replaceGrok(k.command);
          return k;
        });
      }

      // menus
      if (pkg.contributes?.menus) {
        for (const menu of Object.keys(pkg.contributes.menus)) {
          pkg.contributes.menus[menu] = pkg.contributes.menus[menu].map(m => {
            if (m.command) m.command = replaceGrok(m.command);
            return m;
          });
        }
      }

      // configuration properties
      if (pkg.contributes?.configuration?.properties) {
        const oldProps = pkg.contributes.configuration.properties;
        pkg.contributes.configuration.properties = {};
        for (const [key, val] of Object.entries(oldProps)) {
          const newKey = replaceGrok(key);
          pkg.contributes.configuration.properties[newKey] = val;
        }
        pkg.contributes.configuration.title = "Grok (Local Dev)";
      }

      fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
PATCHEOF

    node /tmp/grok-local-patch.js
    rm -f /tmp/grok-local-patch.js

    # Patch TypeScript sources for the new IDs
    cat > /tmp/grok-local-ts-patch.js << 'PATCHEOF'
      const fs = require("fs");
      let code;

      // extension.ts
      code = fs.readFileSync("src/extension.ts", "utf8");
      code = code.replace(/"grok\./g, "\"grok-local.");
      code = code.replace(/workbench\.view\.extension\.grokSidebar/g, "workbench.view.extension.grokLocalSidebar");
      fs.writeFileSync("src/extension.ts", code);

      // sidebar.ts
      code = fs.readFileSync("src/sidebar.ts", "utf8");
      code = code.replace(/"grok\.chat"/g, "\"grok-local.chat\"");
      code = code.replace(/"grok\.chatEditor"/g, "\"grok-local.chatEditor\"");
      code = code.replace(/grok\.sessionMeta/g, "grok-local.sessionMeta");
      // Make the editor tab title clearly say it's the dev version
      code = code.replace(/"Grok",/g, "\"Grok (Local Dev)\",");
      fs.writeFileSync("src/sidebar.ts", code);
PATCHEOF

    node /tmp/grok-local-ts-patch.js
    rm -f /tmp/grok-local-ts-patch.js

    echo "==> Rebuilding with local namespace (grok-local.*)"
    npm run build:webview
    npx tsc -p . --skipLibCheck

    OUT_FILE="grok-build-local.vsix"
else
    echo "==> Building webview (React) + TypeScript"

    # Patch primer for published build (source now carries the LOCAL DEV variant
    # so that plain "Run Extension (fast)" dev sessions and --local builds see
    # the dev-appropriate hidden primer; published vsix must get the author/link text).
    cp src/grok-primer.ts src/grok-primer.ts.pub.bak 2>/dev/null || true
    cat > /tmp/grok-published-primer-patch.js << 'PATCHEOF'
      const fs = require("fs");
      let text = fs.readFileSync("src/grok-primer.ts", "utf8");
      text = text.replace(
        /LOCAL DEV BUILD of Grok Build VS Code extension \(completely separate identity from the published version\)\./,
        "This is a Grok Build extension for VS Code developed by Paweł Huryn. The extension is a thin wrapper of Grok Build CLI over ACP with a custom Plan Mode implementation. For more (docs, version history, open source repo, issues): https://marketplace.visualstudio.com/items?itemName=PawelHuryn.grok-vscode-phuryn"
      );
      fs.writeFileSync("src/grok-primer.ts", text);
PATCHEOF
    node /tmp/grok-published-primer-patch.js
    rm -f /tmp/grok-published-primer-patch.js

    npm run build:webview
    npx tsc -p . --skipLibCheck

    # Restore primer so tree stays clean (source of truth for dev is the LOCAL variant)
    [ -f src/grok-primer.ts.pub.bak ] && mv src/grok-primer.ts.pub.bak src/grok-primer.ts || true

    OUT_FILE="grok-build.vsix"
fi

echo "==> Packaging fresh .vsix"
npx @vscode/vsce package --no-dependencies --out "$OUT_FILE"

echo "    Packaged: $OUT_FILE"

echo "==> Installing into VS Code"
code --install-extension "$OUT_FILE" --force

echo
echo "==> Attempting window reload..."
code --command workbench.action.reloadWindow 2>/dev/null || true

echo
echo "✅ Done!"

if $LOCAL_MODE; then
    echo
    echo "IMPORTANT: Installed as COMPLETELY SEPARATE extension:"
    echo "  Name:    Grok Build (Local Dev)"
    echo "  ID:      local-dev.grok-build-local"
    echo "  Commands: grok-local.*  (e.g. Grok: Open → grok-local.open)"
    echo "  View:    grok-local.chat"
    echo
    echo "The original PawelHuryn.grok-vscode-phuryn is untouched and can run alongside it."
    echo "Disable the Marketplace version if you want only the local one active."
else
    echo
    echo "If the window did not reload automatically:"
    echo "   1. Open Command Palette (Ctrl+Shift+P or Cmd+Shift+P)"
    echo "   2. Run:  Developer: Reload Window"
    echo
    echo "Then open 'Grok: Open in Editor Tab' to test the new React UI."
fi
