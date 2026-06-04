# Grok Build for VS Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com) [![Grok Build](https://img.shields.io/badge/xAI-Grok%20Build-000000)](https://x.ai) [![The Product Compass](https://img.shields.io/badge/The%20Product%20Compass-productcompass.pm-FF6B35)](https://www.productcompass.pm)

A thin client for xAI's Grok Build CLI. It drives `grok agent stdio` over the [Agent Client Protocol (ACP)](https://agentclientprotocol.com) from VS Code surfaces (sidebar or full editor tabs). All session state, MCP servers, subagents, memory, and tool execution stay inside the CLI process — the extension is only the surfaces, mandatory ACP handlers, and client-side policy (plan-mode gate, YOLO). Each surface owns an independent session. Kill the extension and the `grok` child dies with it. **Not a terminal launcher and not a re-implementation.**

Works with SuperGrok Heavy subscription or xAI API key (standard Grok). 
**Not affiliated with xAI.**

![Grok Build in the VS Code sidebar (React webview)](docs/screenshots/v1.2.0.png)

![Grok Build alongside VS Code](docs/screenshots/v1.2.0_vscode.png)

---

## Why an extension, not the CLI?

The CLI is the brain (history, memory, MCP servers, subagents, planning, tool execution). The extension exists only to give you **VS Code-native surfaces** and two client-side policies the protocol doesn't fully expose.

- **Full editor tabs** — "Grok: Open in Editor Tab" (also in the gear menu) opens the chat in a movable, resizable editor group exactly like Claude Code. Sidebar and every tab are independent sessions (separate `GrokSidebar` + ACP client each). The React webview UI is shared for visual consistency.
- **VS Code diff editor for proposed edits** — click "open diff →" on a permission card to see the exact change before approving
- **Active editor and selection as first-class context** — chips render as `@/path/to/file` references so the CLI reads the live file, not a paste-frozen copy
- **Permission cards** with **Allow always / Allow once / Reject** instead of `[y/N]` terminal prompts
- **Client-side Plan mode enforcement** — the extension blocks workspace writes and non-allowlisted commands until you approve (because the CLI's `exit_plan_mode` response is currently unreliable). Approve/Reject/Cancel with optional comment; the verdict is forwarded in the next user message.
- **YOLO mode toggled in-process** — no CLI restart, the session is untouched
- **Model picker that adapts to each agent** — switch between **Grok Build** and Cursor's **Composer 2.5**; the extension keeps the Plan-mode and reasoning-effort controls honest per model (see Known limits), since the two run on different CLI agents
- **Session history** — clock icon lists past sessions saved by the CLI in `~/.grok/sessions/`; resume, rename, or delete
- **Slash autocomplete sourced live from the CLI** via `available_commands_update`
- **Side-by-side with other AI tools** — drag to the secondary side bar, or live in full editor tabs

Trade-off: this is a UI shell, not a replacement. Install the `grok` CLI first; the extension is useless without it.

---

## Quick start

> **Platforms:** macOS, Linux, and Windows. The `grok` CLI now ships a native Windows build, so the extension runs natively on all three — no WSL required. (WSL2 + Remote-WSL still works fine if you prefer it.)

**1. Install the CLI.**

macOS / Linux / WSL:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://x.ai/cli/install.ps1 | iex
```

**Then sign in:**

```bash
grok /login
```

`grok /login` opens a browser and completes OAuth in one step. Alternatively, get an API key at [console.x.ai](https://console.x.ai) and set `XAI_API_KEY` in your shell or a workspace `.env` (the extension auto-loads it). With a subscription you get **Grok Build**; with an API key you also get **grok-4.20** (3 variants), **grok-4.3**, and **grok-imagine** (3 options).

**2. Install the extension.**

From the VS Code Marketplace: search for **Grok Build** by *PawelHuryn*, or install from the command line:

```bash
code --install-extension PawelHuryn.grok-vscode-phuryn
```

Or build from source:

```bash
git clone https://github.com/phuryn/grok-build-vscode.git
cd grok-build-vscode
npm install
./scripts/install.sh        # Windows: pwsh scripts\install.ps1
```

Reload VS Code (**Ctrl+Shift+P → Developer: Reload Window**) and click the Grok icon in the activity bar.

> **Tip:** Right-click the Grok icon → **Move To → Secondary Side Bar** to park Grok on the right alongside other AI tools.
>
> ![Right-click the Grok icon → Move To → Secondary Side Bar](docs/screenshots/side.png)

**Uninstall:** `./scripts/uninstall.sh` (Windows: `pwsh scripts\uninstall.ps1`) or `code --uninstall-extension PawelHuryn.grok-vscode-phuryn`.

---

## Key concepts

### Thin client over ACP

The extension is deliberately thin. It speaks JSON-RPC over `grok agent stdio`'s stdin/stdout and implements every mandatory server→client handler. The CLI owns the agent, the plan, the memory, the MCP servers, and the tool execution. The extension only supplies VS Code surfaces (sidebar + editor tabs) and two client-side policies: the Plan mode gate and YOLO auto-approval.

### Where state lives

| Lives in the CLI | Lives in the extension |
|---|---|
| Conversation history, memory, `~/.grok/` | Chips list (active editor + drag-added files) |
| MCP servers, subagents, plugins | YOLO flag (auto-approval) |
| Tool execution, model state | Plan-mode gate (mirror of YOLO — workspace-write block + read-only command allowlist), per-plan verdict log |
| Plan text on disk (`~/.grok/sessions/<…>/plan.md`) | Webview UI state, popovers, slash filter, pending diff per `toolCallId` |

Restarting the session (the **+** button) kills the CLI child and spawns a fresh one. Memory persisted by the CLI in `~/.grok/` survives.

### Modes

| Mode | Behaviour |
|---|---|
| **Agent** (default) | CLI acts directly and **may** ask for permission on a write or shell action it judges sensitive — when it does, a card appears in chat |
| **YOLO** | Extension auto-responds "allow always" to any `session/request_permission` the CLI raises. The CLI process and its session are untouched, no restart |
| **Plan** | The agent drafts a plan first and *cannot* write to the workspace or run anything outside a read-only allowlist until you approve. Approve / Reject / Cancel from the chat card, each with an optional free-form comment forwarded to grok |

### File chips

The active editor file is added as an **implicit** chip automatically (toggle via `grok.includeActiveFileByDefault`). Drag from the Explorer, right-click → **Grok: Send File**, press **Alt+G**, or click the **+** button in the bottom toolbar → *Upload from computer* to add **explicit** chips. Chips are sent to the agent as `@/path/to/file` references — the CLI resolves them, so content stays current and doesn't bloat chat history. Hold **Shift** while dragging to embed the file content inline as a fenced code block instead.

### Session history

Click the clock icon in the top bar to see all sessions saved by the CLI for the current project (grok writes them to `~/.grok/sessions/<urlencoded-cwd>/`). Click a row to resume — the extension calls `session/load` and grok replays the conversation. Hover a row to rename (pencil) or delete (trash). Names default to the first message sent in that session; rename overrides live in VS Code's `globalState` and never touch grok's files.

### Permission cards with diff preview

For `kind:"edit"` tool calls, the card shows a `path — N → M lines` summary and an "open diff →" button. Clicking it opens VS Code's native diff editor against the proposed new content. Note: the actual write only happens *after* you approve, via `fs/write_text_file`. See [Known limits](#known-limits) for the v1.0 caveat on what the diff is actually diffed against.

---

## Architecture

```
VS Code webview ──postMessage──► extension host ──JSON-RPC over stdin/stdout──► grok agent stdio
                                                  ◄── session/update (message chunks, thought chunks, tool calls, mode changes)
                                                  ◄── fs/read_text_file, fs/write_text_file
                                                  ◄── terminal/create, terminal/output, terminal/wait_for_exit, terminal/kill, terminal/release
                                                  ◄── session/request_permission
                                                  ◄── x.ai/exit_plan_mode
```

### How a session starts

When the panel opens (or you click **+** for a new session):

1. Locate the `grok` binary: `grok.cliPath` setting → `~/.grok/bin/grok` → `PATH`.
2. Spawn `grok agent stdio` as a background child — visible in `ps` / Activity Monitor, never opens a terminal window.
3. Send `initialize` → `session/new` → `session/set_model` over stdio.
4. If `grok.defaultEffort` is set, forward it as `--reasoning-effort <value>` before the `stdio` subcommand (values match grok's accepted set: `none`/`minimal`/`low`/`medium`/`high`/`xhigh`).
5. Stream `session/update` notifications (messages, thoughts, tool calls, permission requests) back to the chat.

### Module map (core)

| File | Role |
|---|---|
| [src/extension.ts](src/extension.ts) | Entry point — registers commands, keybindings, output channel |
| [src/sidebar.ts](src/sidebar.ts) | One independent controller + session per surface (sidebar or editor tab) |
| [src/acp.ts](src/acp.ts) | ACP client — spawns CLI, manages session lifecycle |
| [src/grok-primer.ts](src/grok-primer.ts) | Hidden v4 system prompt injected on every session start (explains plan verdict markers to the CLI) |
| [src/plan-gate.ts](src/plan-gate.ts) | Client-side Plan mode enforcement (workspace-write block + read-only allowlist) |
| Pure modules (`acp-dispatch`, `chips`, `prompt-builder`, `slash-filter`, `cli-locator`, `sessions`, `plan-restore`, `plan-review`, `file-ref`, `webview-helpers`) | No `vscode` import, no spawn — fully unit-testable under Vitest |

The React webview (`webview/` + Vite) is the runtime UI for both sidebar and editor tabs (built to `out/webview`). Legacy `media/chat.{js,css}` powers only the DOM test harness.

### Design choices worth knowing

- **Pure modules split for testability.** `acp-dispatch`, `chips`, `prompt-builder`, `slash-filter`, `cli-locator`, `sessions`, `webview-helpers` (and the plan-gate / plan-restore logic) have no `vscode` import and no spawn — they run under Vitest in a plain Node process. This is why 256 fast, hermetic tests is the floor.
- **YOLO is client-side only.** It's a single `autoApprove` flag in [src/sidebar.ts](src/sidebar.ts) — toggling Agent ↔ YOLO doesn't restart the CLI or even send a message. Whenever the CLI does raise a permission request, the extension just answers "allow always" automatically.
- **Cross-platform without per-OS branches.** [src/terminal-manager.ts](src/terminal-manager.ts) uses `spawn(cmd, { shell: true })` so Node picks `cmd.exe` or `/bin/sh`. [src/cli-locator.ts](src/cli-locator.ts) prefers `HOME`/`USERPROFILE` env over `os.homedir()` so tests can override paths.
- **Streaming is rAF-coalesced.** `agent_message_chunk` and `agent_thought_chunk` buffer into a raw string and re-render at most once per animation frame — keeps long responses smooth even under fast chunk rates.
- **`available_commands_update` drives slash autocomplete.** No hardcoded command list; the CLI tells the extension what's available, so plugin/skill installs surface immediately.

---

## Usage

### Sending a prompt

Type in the composer and press **Enter** (or **Ctrl/Cmd+Enter** if `grok.useCtrlEnterToSend` is on). The agent streams its response; while it reasons, a "Thinking..." line shows, which resolves to "Thought for *N*s" on completion. Click the line to expand or collapse the full reasoning trace (collapsed by default).

### Slash commands

Type `/` to open autocomplete. Commands are sourced live from the CLI — the list reflects your installed `grok` version. See [docs/SLASH-COMMANDS.md](docs/SLASH-COMMANDS.md) for a reference snapshot.

### Tool calls

Each action appears in chat:
- **Single call** — flat row: "Read sidebar.ts lines 1–120", "Edit package.json", "Run npm test"
- **Multiple calls** — collapsed group ("Read, Edit +2") that expands on click

### Reasoning effort

Click the **gear** icon → effort dots to pick a reasoning-effort level (`none` → `xhigh`). It's forwarded to the CLI as `--reasoning-effort`; changing it restarts the session (with an optional *Summarize & Restart* to carry context forward). Some subscription tiers may still reject effort at the backend.

### Model picker

Click the model name in the gear popover. The list comes from `session/new`'s response — switching is live via `session/set_model`, no restart.

### Context donut

The bottom-toolbar donut shows `usedK/maxK` tokens, updated after each prompt. When it fills, `/compact` compresses the conversation or click **+** for a fresh session.

### Gear popover

| Section | What |
|---|---|
| Model and Effort | Model picker + reasoning effort dots |
| Session | Compact conversation (sends `/compact`) |
| Config | Open global `~/.grok/config.toml`, project `.grok/config.toml`, `grok mcp list` |
| Debug | Show extension logs (every ACP message in/out) |

### MCP servers

MCP servers are configured in the CLI (`~/.grok/config.toml` global, `.grok/config.toml` project) — the extension picks up whatever the CLI loads. Add a server with the CLI:

```bash
grok mcp add playwright --command npx --args @playwright/mcp@latest
```

Or edit the config files directly via gear → *Open global config* / *Open project config*. Click the new-session button in the sidebar to reload.

![Markdown rendering, message actions, and YOLO mode](docs/screenshots/v1.1.0_more.png)

---

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `grok.cliPath` | `""` | Path to the `grok` binary. Empty = auto-discover (`~/.grok/bin/grok` → PATH). |
| `grok.defaultModel` | `""` | Model ID for new sessions. Empty = CLI default. |
| `grok.defaultEffort` | `""` | Reasoning effort forwarded as `--reasoning-effort` to `grok agent stdio` (`none` / `minimal` / `low` / `medium` / `high` / `xhigh`). Empty = CLI default. Changing it restarts the session. |
| `grok.includeActiveFileByDefault` | `true` | Auto-add the active editor as a context chip. |
| `grok.useCtrlEnterToSend` | `false` | When true, Enter inserts a newline and Ctrl/Cmd+Enter sends. |

---

## Commands & keybindings

VS Code commands (not Grok slash commands). Open with **Ctrl+Shift+P** / **Cmd+Shift+P** and type "Grok".

| Command | What it does |
|---|---|
| `Grok: Open` | Open the Grok sidebar |
| `Grok: Open in Editor Tab` | Open Grok in a full movable editor panel (independent session) |
| `Grok: New Session` | Start a fresh session |
| `Grok: Pick Model` | Open the model picker |
| `Grok: Toggle Plan / Agent Mode` | Open the mode picker (Agent / Plan / YOLO) |
| `Grok: Send File` | Add the selected file to context |
| `Grok: Send Selection` | Send the current text selection to Grok |
| `Grok: Insert @-Mention` | Insert an `@`-mention for the active file into the composer |
| `Grok: Show Logs` | Open the Grok output channel (ACP messages, errors) |

**Keybindings**

| Key | Action |
|---|---|
| `Ctrl+;` / `Cmd+;` | Open Grok sidebar |
| `Alt+G` | Insert `@`-mention for the active file (when editor focused) |

---

## Development

```bash
npm install
npm run build:webview   # React UI (required for sidebar + editor tabs)
npm test                # 256 tests (pure + DOM), ~2s, vitest — all grok-free
npm run compile
```

The split into pure modules (`acp-dispatch`, `chips`, `prompt-builder`, etc.) exists so protocol and policy logic can be tested without VS Code or the real CLI. 256 tests is the floor — every change must keep them green.

See [TESTS.md](TESTS.md) for coverage details and the planned `@vscode/test-electron` integration suite. Smoke-test the packaged `.vsix` against a real `grok` binary for end-to-end flows.

**Smoke testing against a real CLI:** install the VSIX into VS Code, open the panel, and run a few prompts that exercise reads, writes, terminal, and permission flow. The pure tests cover protocol regressions; smoke testing covers integration with the actual `grok` binary.

**Repo conventions:**
- Direct-to-`main`, no feature branches
- Commits explain the *why*, not the *what*
- No speculative abstractions; no comments restating well-named code
- 256 tests is the floor

**Publishing:** user-initiated version bump in `package.json`, then `npm test && npm run publish`.

---

## Known limits

- **Plan mode verdict workaround.** The CLI's `exit_plan_mode` tool currently reports "approved" for any client reply. The extension therefore sends a hidden v4 primer on every session start and reads the user's real choice (`[Plan approved|rejected|cancelled]`) from the follow-up message. Client-side `plan-gate.ts` still enforces the write/command blocks until the user acts.
- **Composer (Cursor agent) constraints.** Composer 2.5 runs on a different CLI agent than Grok Build, so: switching to or from it needs a fresh session (the CLI rejects a mid-session swap once a prompt has locked the agent in — the extension offers a one-click restart), and it supports neither Plan mode nor reasoning effort. Rather than show dead controls, the extension greys out the effort dots and offers a plan-capable restart instead of a fake Plan toggle. Verified against grok 0.2.22 (`research/model-agent-probe*.cjs`, `research/effort-behavior-probe*.cjs`).
- **React test surface gap.** The runtime UI is the React webview (both sidebar and editor tabs). Most DOM tests still exercise the legacy `media/` harness. New React-specific coverage is thin (`tool-io.dom.test.ts`, `markdown.test.ts`).
- **Diff preview semantics.** The diff editor compares the proposed old and new text against each other, not against the file on disk. The write happens later via `fs/write_text_file`.
- **No subagent inspector.** Subagent messages render inline as tool cards.
- **No worktree UI.** Planned but not yet implemented.

---

## License

MIT
