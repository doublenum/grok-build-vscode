// Behavioral probe: does --reasoning-effort actually change model behavior?
// For each model x each effort level, respawn `grok agent --reasoning-effort <e> stdio`,
// send ONE identical tool-free reasoning prompt, and measure:
//   - reasoningTokens / outputTokens / totalTokens from the session/prompt result _meta
//   - thought-chunk char count (the visible reasoning trace) as a backup signal
//   - wall-clock ms for the turn
// Runs sequentially to avoid rate-limit noise. Writes JSON to /tmp/effort-results.json.
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK = path.join(os.homedir(), ".grok", "bin", "grok");
const MODELS = ["grok-build", "grok-composer-2.5-fast"];
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const PROMPT =
  "Do NOT use any tools, do NOT read or write any files, do NOT run any commands. " +
  "Reason purely in your head. Logic puzzle: Three friends — Alice, Bob, Carol — " +
  "each own a different pet (cat, dog, fish) and live in a different colored house " +
  "(red, green, blue). Clues: (1) Alice does not live in the red house. " +
  "(2) The dog owner lives in the green house. (3) Bob owns the fish. " +
  "(4) Carol does not live in the blue house. Work out who owns which pet and lives " +
  "in which house. Show your step-by-step reasoning, then state the final answer.";

const PER_RUN_TIMEOUT_MS = 90000;

function nowMs() {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

function runOne(model, effort) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-eff-"));
    fs.writeFileSync(path.join(cwd, "app.js"), "module.exports={}\n");
    const args = effort
      ? ["agent", "--reasoning-effort", effort, "stdio"]
      : ["agent", "stdio"];
    const proc = spawn(GROK, args, { cwd, env: process.env });

    let nextId = 1;
    const waiters = new Map();
    let thoughtChars = 0;
    let thoughtChunks = 0;
    let msgChars = 0;
    let toolCalls = 0;
    let promptMeta = null;
    let stopReason = null;
    let started = 0;
    let finished = false;

    const send = (method, params) => {
      const id = nextId++;
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((r) => waiters.set(id, r));
    };
    const respond = (id, result) =>
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    const respondErr = (id) =>
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "stubbed" } }) + "\n",
      );

    const done = (extra) => {
      if (finished) return;
      finished = true;
      try { proc.kill(); } catch {}
      resolve({
        model,
        effort,
        stopReason,
        reasoningTokens: promptMeta?.reasoningTokens ?? null,
        outputTokens: promptMeta?.outputTokens ?? null,
        totalTokens: promptMeta?.totalTokens ?? null,
        inputTokens: promptMeta?.inputTokens ?? null,
        thoughtChars,
        thoughtChunks,
        msgChars,
        toolCalls,
        elapsedMs: started ? Math.round(nowMs() - started) : null,
        ...extra,
      });
    };

    const to = setTimeout(() => done({ error: "timeout" }), PER_RUN_TIMEOUT_MS);

    proc.on("error", (e) => { clearTimeout(to); done({ error: "spawn:" + e.message }); });
    proc.stderr.on("data", () => {});

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let m;
      try { m = JSON.parse(line); } catch { return; }

      // server -> client requests: stub everything so the turn can proceed
      if (m.method && m.id != null) {
        if (m.method === "fs/read_text_file") {
          let c = "";
          try { c = fs.readFileSync(m.params.path, "utf8"); } catch {}
          respond(m.id, { content: c });
        } else if (m.method === "fs/write_text_file") {
          respond(m.id, {});
        } else if (m.method === "session/request_permission") {
          // reject so the model can't perform side effects; counts as a tool attempt
          toolCalls++;
          const opts = m.params?.options || [];
          const rej = opts.find((o) => /reject/.test(o.optionId || o.kind || ""));
          respond(m.id, { outcome: { outcome: "selected", optionId: rej?.optionId || (opts[0] && opts[0].optionId) } });
        } else if (m.method && m.method.startsWith("terminal/")) {
          toolCalls++;
          if (m.method === "terminal/create") respond(m.id, { terminalId: "stub" });
          else if (m.method === "terminal/output") respond(m.id, { output: "", exitStatus: { exitCode: 0 } });
          else if (m.method === "terminal/wait_for_exit") respond(m.id, { exitStatus: { exitCode: 0 } });
          else respond(m.id, {});
        } else {
          respondErr(m.id);
        }
        return;
      }

      // notifications
      if (m.method === "session/update") {
        const u = m.params?.update;
        if (u) {
          if (u.sessionUpdate === "agent_thought_chunk") {
            const t = u.content?.text || "";
            thoughtChars += t.length;
            thoughtChunks++;
          } else if (u.sessionUpdate === "agent_message_chunk") {
            msgChars += (u.content?.text || "").length;
          } else if (u.sessionUpdate === "tool_call") {
            toolCalls++;
          }
        }
        return;
      }

      // responses to our requests
      if (m.id != null && waiters.has(m.id)) {
        waiters.get(m.id)(m);
        waiters.delete(m.id);
      }
    });

    (async () => {
      try {
        await send("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        });
        const ns = await send("session/new", { cwd, mcpServers: [] });
        const sessionId = ns.result?.sessionId;
        if (!sessionId) return done({ error: "no-session" });
        if (model !== "grok-build") {
          const sw = await send("session/set_model", { sessionId, modelId: model });
          if (sw.error) return done({ error: "set_model:" + JSON.stringify(sw.error) });
        }
        started = nowMs();
        const pr = await send("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: PROMPT }],
        });
        if (pr.error) return done({ error: "prompt:" + JSON.stringify(pr.error) });
        stopReason = pr.result?.stopReason ?? null;
        promptMeta = pr.result?._meta ?? null;
        clearTimeout(to);
        done({});
      } catch (e) {
        clearTimeout(to);
        done({ error: "exc:" + (e && e.message) });
      }
    })();
  });
}

(async () => {
  const results = [];
  for (const model of MODELS) {
    for (const effort of EFFORTS) {
      process.stderr.write(`[run] ${model} / ${effort} ... `);
      const r = await runOne(model, effort);
      results.push(r);
      process.stderr.write(
        `reasoning=${r.reasoningTokens} out=${r.outputTokens} thoughtChars=${r.thoughtChars} ms=${r.elapsedMs} ${r.error ? "ERR:" + r.error : ""}\n`,
      );
      fs.writeFileSync("/tmp/effort-results.json", JSON.stringify(results, null, 2));
    }
  }
  process.stderr.write("[done] wrote /tmp/effort-results.json\n");
})();
