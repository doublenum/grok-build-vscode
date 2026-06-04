// Tighter probe: grok-build only, HARD reasoning task (classic 5-house zebra puzzle),
// extremes + midpoint (none/medium/xhigh), 3 trials each, to see if higher effort
// yields more reasoning tokens once the task is hard enough to differentiate.
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK = path.join(os.homedir(), ".grok", "bin", "grok");
const MODEL = "grok-build";
const EFFORTS = ["none", "medium", "xhigh"];
const TRIALS = 3;
const PROMPT =
  "Do NOT use any tools, files, or commands — reason entirely in your head. " +
  "Solve the classic Zebra Puzzle. Five houses in a row, each a different color " +
  "(red, green, ivory, yellow, blue), with owners of different nationalities " +
  "(Englishman, Spaniard, Ukrainian, Norwegian, Japanese), each drinking a different " +
  "beverage (coffee, tea, milk, orange juice, water), smoking a different brand " +
  "(Old Gold, Kools, Chesterfields, Lucky Strike, Parliaments), and owning a different " +
  "pet (dog, snail, fox, horse, zebra). Clues: 1) The Englishman lives in the red house. " +
  "2) The Spaniard owns the dog. 3) Coffee is drunk in the green house. 4) The Ukrainian " +
  "drinks tea. 5) The green house is immediately to the right of the ivory house. " +
  "6) The Old Gold smoker owns snails. 7) Kools are smoked in the yellow house. " +
  "8) Milk is drunk in the middle house. 9) The Norwegian lives in the first house. " +
  "10) The Chesterfields smoker lives next to the fox owner. 11) Kools are smoked next " +
  "to the horse owner. 12) The Lucky Strike smoker drinks orange juice. 13) The Japanese " +
  "smokes Parliaments. 14) The Norwegian lives next to the blue house. " +
  "Work through it step by step. Then state: who drinks water and who owns the zebra.";

const PER_RUN_TIMEOUT_MS = 120000;

function nowMs() { const [s, ns] = process.hrtime(); return s * 1000 + ns / 1e6; }

function runOne(effort, trial) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-eff2-"));
    fs.writeFileSync(path.join(cwd, "app.js"), "module.exports={}\n");
    const proc = spawn(GROK, ["agent", "--reasoning-effort", effort, "stdio"], { cwd, env: process.env });
    let nextId = 1; const waiters = new Map();
    let thoughtChars = 0, msgChars = 0, promptMeta = null, stopReason = null, started = 0, finished = false;
    const send = (method, params) => { const id = nextId++; proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return new Promise((r) => waiters.set(id, r)); };
    const respond = (id, result) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    const done = (extra) => {
      if (finished) return; finished = true; try { proc.kill(); } catch {}
      resolve({ effort, trial, stopReason,
        reasoningTokens: promptMeta?.reasoningTokens ?? null,
        outputTokens: promptMeta?.outputTokens ?? null,
        totalTokens: promptMeta?.totalTokens ?? null,
        thoughtChars, msgChars, elapsedMs: started ? Math.round(nowMs() - started) : null, ...extra });
    };
    const to = setTimeout(() => done({ error: "timeout" }), PER_RUN_TIMEOUT_MS);
    proc.on("error", (e) => { clearTimeout(to); done({ error: "spawn:" + e.message }); });
    proc.stderr.on("data", () => {});
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return; let m; try { m = JSON.parse(line); } catch { return; }
      if (m.method && m.id != null) {
        if (m.method === "fs/read_text_file") { let c = ""; try { c = fs.readFileSync(m.params.path, "utf8"); } catch {} respond(m.id, { content: c }); }
        else if (m.method === "fs/write_text_file") respond(m.id, {});
        else if (m.method === "session/request_permission") { const opts = m.params?.options || []; const rej = opts.find((o) => /reject/.test(o.optionId || o.kind || "")); respond(m.id, { outcome: { outcome: "selected", optionId: rej?.optionId || (opts[0] && opts[0].optionId) } }); }
        else if (m.method && m.method.startsWith("terminal/")) { if (m.method === "terminal/create") respond(m.id, { terminalId: "stub" }); else if (m.method === "terminal/output") respond(m.id, { output: "", exitStatus: { exitCode: 0 } }); else if (m.method === "terminal/wait_for_exit") respond(m.id, { exitStatus: { exitCode: 0 } }); else respond(m.id, {}); }
        else proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "stub" } }) + "\n");
        return;
      }
      if (m.method === "session/update") {
        const u = m.params?.update;
        if (u?.sessionUpdate === "agent_thought_chunk") thoughtChars += (u.content?.text || "").length;
        else if (u?.sessionUpdate === "agent_message_chunk") msgChars += (u.content?.text || "").length;
        return;
      }
      if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    });
    (async () => {
      try {
        await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
        const ns = await send("session/new", { cwd, mcpServers: [] });
        const sessionId = ns.result?.sessionId; if (!sessionId) return done({ error: "no-session" });
        started = nowMs();
        const pr = await send("session/prompt", { sessionId, prompt: [{ type: "text", text: PROMPT }] });
        if (pr.error) return done({ error: "prompt:" + JSON.stringify(pr.error) });
        stopReason = pr.result?.stopReason ?? null; promptMeta = pr.result?._meta ?? null;
        clearTimeout(to); done({});
      } catch (e) { clearTimeout(to); done({ error: "exc:" + (e && e.message) }); }
    })();
  });
}

(async () => {
  const results = [];
  for (const effort of EFFORTS) {
    for (let t = 1; t <= TRIALS; t++) {
      process.stderr.write(`[run] ${effort} #${t} ... `);
      const r = await runOne(effort, t);
      results.push(r);
      process.stderr.write(`reasoning=${r.reasoningTokens} out=${r.outputTokens} thoughtChars=${r.thoughtChars} ms=${r.elapsedMs} ${r.error ? "ERR:" + r.error : ""}\n`);
      fs.writeFileSync("/tmp/effort-results2.json", JSON.stringify(results, null, 2));
    }
  }
  // averages
  const agg = {};
  for (const e of EFFORTS) {
    const rows = results.filter((r) => r.effort === e && !r.error);
    const avg = (k) => rows.length ? Math.round(rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length) : null;
    agg[e] = { n: rows.length, reasoning: avg("reasoningTokens"), output: avg("outputTokens"), thoughtChars: avg("thoughtChars"), ms: avg("elapsedMs") };
  }
  process.stderr.write("[avg] " + JSON.stringify(agg) + "\n");
  fs.writeFileSync("/tmp/effort-results2.json", JSON.stringify({ runs: results, avg: agg }, null, 2));
  process.stderr.write("[done]\n");
})();
