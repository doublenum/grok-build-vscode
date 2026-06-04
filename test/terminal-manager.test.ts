import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { TerminalManager, resolveExitCode, buildKillPlan, augmentCommandWithGrokCoAuthor, GROK_BUILD_CO_AUTHOR } from "../src/terminal-manager";

// Use `node -e` everywhere so tests are deterministic on Windows, macOS, and Linux.
// Quoting strategy: single-quote the outer node script, escape inner single quotes if any.
const nodeEval = (script: string) => `node -e "${script.replace(/"/g, '\\"')}"`;

describe("TerminalManager", () => {
  it("captures stdout from a quick command", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("process.stdout.write('HELLO_TM')") });
    const { exitCode } = await m.waitForExit(terminalId);
    expect(exitCode).toBe(0);
    const r = m.output(terminalId);
    expect(r.output).toContain("HELLO_TM");
    expect(r.exitStatus).toEqual({ exitCode: 0 });
    expect(r.truncated).toBe(false);
    m.release(terminalId);
  });

  it("captures stderr and nonzero exit", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("process.stderr.write('ERR'); process.exit(7)"),
    });
    const r = await m.waitForExit(terminalId);
    expect(r.exitCode).toBe(7);
    const out = m.output(terminalId);
    expect(out.output).toContain("ERR");
    m.release(terminalId);
  });

  it("respects outputByteLimit and sets truncated flag", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("process.stdout.write('a'.repeat(5000))"),
      outputByteLimit: 100,
    });
    await m.waitForExit(terminalId);
    const r = m.output(terminalId);
    expect(r.output.length).toBeLessThanOrEqual(100);
    expect(r.truncated).toBe(true);
    m.release(terminalId);
  });

  // Regression: truncating at a byte boundary must not split a multi-byte UTF-8
  // character into a replacement char (U+FFFD). '✓' is 3 bytes; a 100-byte limit
  // lands mid-character. Pre-fix `Buffer.toString` on the partial slice produced
  // a trailing '�'; a StringDecoder buffers the incomplete bytes instead.
  it("does not emit U+FFFD when truncation splits a multi-byte character", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      // 60 copies of '✓' = 180 bytes; limit 100 cuts mid-character.
      command: nodeEval("process.stdout.write('\\u2713'.repeat(60))"),
      outputByteLimit: 100,
    });
    await m.waitForExit(terminalId);
    const r = m.output(terminalId);
    expect(r.truncated).toBe(true);
    expect(r.output).not.toContain("�");
    expect(/^✓+$/.test(r.output)).toBe(true);
    m.release(terminalId);
  });

  it("returns exitStatus null while still running", () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("setTimeout(()=>{}, 5000)"),
    });
    const r = m.output(terminalId);
    expect(r.exitStatus).toBeNull();
    m.kill(terminalId);
    m.release(terminalId);
  });

  it("injects env from {name,value} pairs", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("process.stdout.write(process.env.GROK_TEST_VAR || '')"),
      env: [{ name: "GROK_TEST_VAR", value: "INJECTED" }],
    });
    await m.waitForExit(terminalId);
    expect(m.output(terminalId).output).toContain("INJECTED");
    m.release(terminalId);
  });

  it("honors cwd", async () => {
    const m = new TerminalManager();
    const tmp = os.tmpdir();
    const { terminalId } = m.create({
      command: nodeEval("process.stdout.write(process.cwd())"),
      cwd: tmp,
    });
    await m.waitForExit(terminalId);
    // On macOS tmpdir() resolves a /private/var symlink; normalize both sides.
    const got = m.output(terminalId).output.trim().toLowerCase();
    expect(got).toContain(tmp.replace(/\\/g, "/").toLowerCase().split("/").pop()!);
  });

  it("waitForExit resolves immediately if already exited", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("process.exit(0)") });
    await m.waitForExit(terminalId);
    const r = await m.waitForExit(terminalId);
    expect(r.exitCode).toBe(0);
    m.release(terminalId);
  });

  it("output() throws on unknown terminalId", () => {
    const m = new TerminalManager();
    expect(() => m.output("nope")).toThrowError(/unknown terminalId/);
  });

  it("kill+release on a missing id is a no-op", () => {
    const m = new TerminalManager();
    expect(() => m.kill("nope")).not.toThrow();
    expect(() => m.release("nope")).not.toThrow();
  });

  it("disposeAll kills outstanding terminals", () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({
      command: nodeEval("setTimeout(()=>{}, 60000)"),
    });
    m.disposeAll();
    expect(() => m.output(terminalId)).toThrow();
  });

  // Regression: a process killed by a signal must not be reported as a clean
  // exit (code 0). The old `code ?? 0` masked signal kills as success, so the
  // agent assumed a command it interrupted had actually succeeded.
  it("reports a non-zero exit code when a running process is killed", async () => {
    const m = new TerminalManager();
    const { terminalId } = m.create({ command: nodeEval("setInterval(()=>{}, 1000)") });
    await new Promise((r) => setTimeout(r, 150)); // let it start
    m.kill(terminalId);
    const { exitCode } = await m.waitForExit(terminalId);
    expect(exitCode).not.toBe(0);
    m.release(terminalId);
  });
});

describe("resolveExitCode", () => {
  it("passes through a real exit code, including 0", () => {
    expect(resolveExitCode(0, null)).toBe(0);
    expect(resolveExitCode(7, null)).toBe(7);
  });

  it("maps a signal kill to 128 + signum (SIGTERM -> 143), never 0", () => {
    expect(resolveExitCode(null, "SIGTERM")).toBe(128 + os.constants.signals.SIGTERM);
    expect(resolveExitCode(null, "SIGTERM")).toBe(143);
    expect(resolveExitCode(null, "SIGKILL")).toBe(128 + os.constants.signals.SIGKILL);
    expect(resolveExitCode(null, "SIGTERM")).not.toBe(0);
  });
});

describe("buildKillPlan", () => {
  it("uses taskkill with /T /F (tree + force) on Windows", () => {
    const plan = buildKillPlan(1234, "win32");
    expect(plan.kind).toBe("taskkill");
    if (plan.kind === "taskkill") {
      expect(plan.file).toBe("taskkill");
      expect(plan.args).toContain("/T");
      expect(plan.args).toContain("/F");
      expect(plan.args).toContain("1234");
    }
  });

  it("uses a SIGTERM signal on POSIX", () => {
    const plan = buildKillPlan(1234, "linux");
    expect(plan).toEqual({ kind: "signal", signal: "SIGTERM" });
  });
});

describe("augmentCommandWithGrokCoAuthor", () => {
  it("leaves non-git-commit commands untouched", () => {
    const cmd = "git status && git push origin main";
    expect(augmentCommandWithGrokCoAuthor(cmd)).toBe(cmd);
  });

  it("wraps direct git commit and injects --trailer", () => {
    const cmd = "git commit -m 'feat: add thing'";
    const out = augmentCommandWithGrokCoAuthor(cmd);
    expect(out).not.toBe(cmd);
    expect(out).toContain("git() {");
    expect(out).toContain('--trailer "Co-authored-by: Grok Build <noreply@grok.x.ai>"');
    expect(out).toContain(cmd); // original tail is preserved
  });

  it("wraps compound commands containing git commit (&&, ;)", () => {
    const cmd = "git add -A && git commit -m 'fix: bar' && git push";
    const out = augmentCommandWithGrokCoAuthor(cmd);
    expect(out).toContain("git() {");
    expect(out).toContain('--trailer "Co-authored-by: Grok Build <noreply@grok.x.ai>"');
    expect(out.endsWith(cmd)).toBe(true);
  });

  it("still wraps even if message will be checked at runtime; guard prevents double-trailer at exec time", () => {
    const cmd = "git commit -m 'feat: x\n\nCo-authored-by: Grok Build <noreply@grok.x.ai>'";
    const out = augmentCommandWithGrokCoAuthor(cmd);
    // wrapper is still prepended (runtime guard inside will see the trailer in "$*" and skip --trailer)
    expect(out).toContain("git() {");
    // The constructed command string contains the trailer text twice (once in wrapper, once in original -m),
    // but importantly only *one* `--trailer` flag is injected (the runtime guard suppresses a second).
    const trailerFlagCount = (out.match(/--trailer/g) || []).length;
    expect(trailerFlagCount).toBe(1);
    const grokMentions = (out.match(/Grok Build <noreply@grok.x.ai>/g) || []).length;
    expect(grokMentions).toBe(2);
  });
});

describe("Grok Build co-author trailer (integration)", () => {
  it("agent-driven git commit via TerminalManager receives the co-author trailer", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-coauthor-test-"));
    try {
      // Init a clean git repo in tmp
      execSync("git init -q", { cwd: tmp });
      execSync("git config user.email test@example.com", { cwd: tmp });
      execSync("git config user.name Test", { cwd: tmp });

      // Make a commit so HEAD exists, then a change to commit via the manager
      fs.writeFileSync(path.join(tmp, "README.md"), "init\n");
      execSync("git add README.md && git commit -q -m 'init'", { cwd: tmp });

      fs.writeFileSync(path.join(tmp, "change.txt"), "hello from grok\n");
      execSync("git add change.txt", { cwd: tmp });

      const m = new TerminalManager();
      // Issue a commit exactly as an agent would (the manager will augment the command)
      const commitCmd = `cd "${tmp}" && git commit -m "feat: test co-author injection from grok build"`;
      const { terminalId } = m.create({ command: commitCmd });
      const { exitCode } = await m.waitForExit(terminalId);
      expect(exitCode).toBe(0);

      // Verify the trailer is present in the commit message
      const log = execSync(`git -C "${tmp}" log -1 --format=%B`, { encoding: "utf8" });
      expect(log).toContain("feat: test co-author injection from grok build");
      expect(log).toContain(GROK_BUILD_CO_AUTHOR);
      expect(log).toContain("Co-authored-by: Grok Build");

      m.release(terminalId);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
