// Model <-> agent probe (manual; never run by `npm test`).
//
// Documents three facts the sidebar's model/plan handling relies on (verified
// against grok 0.2.22):
//
//   1. Each available model carries `_meta.agentType` in session/new:
//        grok-build            -> agentType "grok-build-plan"
//        grok-composer-2.5-fast-> agentType "cursor"
//      (The CLI exposes NO plan-capability flag — only the agent.)
//
//   2. A model is bound to its agent. BEFORE the first prompt, switching to a
//      different-agent model succeeds. AFTER a prompt locks the agent in, the
//      CLI rejects the switch with a structured error:
//        { code:-32600,
//          message:"Cannot switch to model 'grok-composer-2.5-fast': it requires
//                   agent 'cursor' but the active agent is 'grok-build-plan'...",
//          data:{ code:"MODEL_SWITCH_INCOMPATIBLE_AGENT",
//                 activeAgentType:"grok-build-plan", requiredAgentType:"cursor",
//                 suggestion:"start_new_session" } }
//      -> drives isIncompatibleAgentError() (acp-dispatch.ts) + the restart offer.
//
//   3. Plan mode depends on the agent. On grok-build-plan, set_mode:"plan" sticks.
//      On the cursor agent the CLI emits current_mode_update:"plan" then bounces
//      straight back to "default" — i.e. cursor has no plan mode.
//      -> drives agentSupportsPlan() (plan-gate.ts).
//
// Run: node research/model-agent-probe.cjs   (reads grok from ~/.local/bin/grok)
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK = path.join(os.homedir(), ".local", "bin", "grok");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-model-exp-"));
fs.writeFileSync(path.join(cwd, "app.js"), "module.exports={}\n");
log("cwd: " + cwd);

const proc = spawn(GROK, ["agent", "stdio"], { cwd, env: process.env });
let nextId = 1;
const waiters = new Map();
function log(s) { process.stderr.write("[exp] " + s + "\n"); }
function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => waiters.set(id, res));
}
function respond(id, result) { proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
proc.stderr.on("data", () => {});

const rl = readline.createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method && msg.id != null) {
    if (msg.method === "fs/read_text_file") { let c=""; try{c=fs.readFileSync(msg.params.path,"utf8")}catch{} respond(msg.id,{content:c}); }
    else respond(msg.id, {});
    return;
  }
  if (msg.method === "session/update") {
    const u = msg.params && msg.params.update;
    if (u && u.sessionUpdate === "current_mode_update") log("UPD mode -> " + u.currentModeId);
    return;
  }
  if (msg.id != null) { const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); } }
});

(async () => {
  try {
    await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    const ns = await send("session/new", { cwd, mcpServers: [] });
    const sessionId = ns.result.sessionId;

    log("=== FACT 1: session/new .models (note _meta.agentType) ===");
    log(JSON.stringify(ns.result.models, null, 2));

    log("=== FACT 3: set_mode plan on cursor agent reverts to default ===");
    await send("session/set_model", { sessionId, modelId: "grok-composer-2.5-fast" }); // pre-prompt switch: succeeds
    await send("session/set_mode", { sessionId, modeId: "plan" });
    await new Promise((r) => setTimeout(r, 1200)); // watch for the plan->default bounce above

    log("=== FACT 2: agent locks after a prompt; cross-agent switch then fails ===");
    await send("session/set_model", { sessionId, modelId: "grok-build" });
    await send("session/set_mode", { sessionId, modeId: "default" });
    await send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Say hi in one word." }] });
    const r = await send("session/set_model", { sessionId, modelId: "grok-composer-2.5-fast" });
    log(JSON.stringify(r.error || r.result, null, 2));
  } catch (e) { log("EXC " + (e && e.message)); }
  finally { setTimeout(() => { try { proc.kill(); } catch {} process.exit(0); }, 400); }
})();
setTimeout(() => { try { proc.kill(); } catch {} process.exit(0); }, 120000);
