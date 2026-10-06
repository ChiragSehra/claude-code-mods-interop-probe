// lint-guard — an ordinary eslint wrapper mod, and an interop probe.
//
// Under Claude Code it loads as a plugin (`claude --plugin-dir <this dir>`);
// under the DeepSeek Harness the same module mounts through
// @deepseek-ai/dsh-experimental-claude-code-mods (wrapped by ../index.mjs).
//
// Every host-API call is recorded (name, ok, ms, result preview or error)
// and flushed to .lint-guard-trace.jsonl in the working directory through
// $.fs.write, so both hosts leave a comparable artifact. The trace is
// mirrored into $.store under "lint-guard:trace" after each flush.
//
// The module must stay runtime-portable: it imports nothing, because the
// Claude Code hooks environment has no Node ("no DOM, no Node").

const PREFIX = "[lint-guard]";
const ESLINT_CONFIG = "eslint.config.mjs";

// Module-level state. Claude Code: survives the mod's hot reload. The dsh
// bridge: survives a remount (register re-runs on the same evaluated module).
const findings = { files: 0, problems: 0, errors: 0, last: null };
const seen = { toolCheck: 0, turnStep: 0, agentSpawn: 0, uiRender: 0, promptSubmit: 0 };
const trace = [];

function preview(v) {
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > 240 ? s.slice(0, 237) + "..." : s;
  } catch {
    return String(v);
  }
}

function rec(row) {
  const full = { ts: new Date().toISOString(), ...row };
  trace.push(full);
  return full;
}

// Every $ call in the mod goes through here: the row lands in the trace
// whether the call resolves, rejects, or sits outside the served table.
async function call($, name, fn) {
  const row = rec({ call: name });
  const t0 = Date.now();
  try {
    const v = await fn();
    row.ok = true;
    row.ms = Date.now() - t0;
    if (v !== undefined) row.result = preview(v);
  } catch (e) {
    row.ok = false;
    row.ms = Date.now() - t0;
    row.error = String((e && e.message) || e).slice(0, 300);
  }
  return row;
}

async function flush($) {
  await call($, "fs.write(.lint-guard-trace.jsonl)", () =>
    $.fs.write(".lint-guard-trace.jsonl", trace.map((r) => JSON.stringify(r)).join("\n") + "\n")
  );
  await call($, "store.set(lint-guard:trace)", () =>
    $.store.set("lint-guard:trace", { rows: trace.length, tail: trace.slice(-6).map(preview) })
  );
}

// $.plugin.name / $.plugin.root may be properties or promise-returning
// members depending on the host; accept either.
async function pluginFacts($) {
  const name = await $.plugin.name;
  const root = await $.plugin.root;
  return { name, root };
}

// Runs eslint with the mod's own flat config. The full stdout never enters
// the trace (previews are truncated) — only the parsed summary does.
async function lintPaths($, paths) {
  const cwd = await $.session.cwd();
  const facts = await pluginFacts($);
  const bin = `${cwd}/node_modules/.bin/eslint`;
  const config = `${facts.root}/${ESLINT_CONFIG}`;
  const argv = [bin, "--no-warn-ignored", "-c", config, "--format", "json", ...paths];
  const row = rec({ call: `process.run(eslint ${paths.join(" ")})` });
  const t0 = Date.now();
  let summary = { files: 0, problems: 0, errors: 0, line: "eslint produced no output" };
  try {
    const res = await $.process.run(argv);
    row.ms = Date.now() - t0;
    row.result = preview({ exitCode: res.exitCode, stdoutBytes: (res.stdout ?? "").length, stderr: String(res.stderr ?? "").slice(0, 120) });
    let arr = [];
    try {
      arr = JSON.parse(res.stdout ?? "[]");
    } catch {
      row.parse = "stdout not eslint-json";
    }
    summary.files = arr.length;
    summary.problems = arr.reduce((n, f) => n + (f.errorCount + f.warningCount), 0);
    summary.errors = arr.reduce((n, f) => n + f.errorCount, 0);
    const first = arr
      .flatMap((f) => f.messages)
      .slice(0, 2)
      .map((m) => `${m.ruleId}: ${m.message}`)
      .join("; ");
    summary.line = first || (summary.files ? "clean" : `exit ${res.exitCode}: ${String(res.stderr ?? "").slice(0, 100)}`);
    row.ok = true;
  } catch (e) {
    row.ok = false;
    row.ms = Date.now() - t0;
    row.error = String((e && e.message) || e).slice(0, 300);
    summary.line = `eslint failed to run: ${row.error}`;
  }
  row.summary = summary;
  return { row, summary };
}

function noteFindings(summary) {
  findings.files = summary.files;
  findings.problems = summary.problems;
  findings.errors = summary.errors;
  findings.last = summary.line;
}

async function drawBand($, e) {
  const { Box, Text } = $.ui.resolve(e);
  const color = findings.errors > 0 ? "yellow" : "green";
  return Box({
    flexDirection: "row",
    paddingX: 1,
    children: [
      Text({ color, bold: true, children: `${PREFIX} ${findings.problems} finding(s)` }),
      Text({ dimColor: true, children: findings.last ? `  last: ${String(findings.last).slice(0, 60)}` : "" }),
    ],
  });
}

export function register(on, options) {
  const opts = options || {};
  const runGaps = opts.gaps !== false;

  // ---- silent observers: events the bridge documents as never raised ----
  on("tool.check", async ($, e, next) => {
    seen.toolCheck += 1;
    rec({ event: "tool.check[observed]", n: seen.toolCheck, preview: preview(e).slice(0, 200) });
    return next(e);
  });
  // (turn.step is also a silent-event probe candidate, but it streams —
  // Claude Code requires an async-generator hook for it — and a generator
  // hook risks the bridge mount, so it is left to the matrix's by-reading row.)
  on("agent.spawn", async ($, e, next) => {
    seen.agentSpawn += 1;
    rec({ event: "agent.spawn[observed]", n: seen.agentSpawn });
    return next(e);
  });

  // ---- prompt enrichment ----
  on("prompt.submit", async ($, e, next) => {
    seen.promptSubmit += 1;
    rec({ event: "prompt.submit", text: String(e.text ?? "").slice(0, 160) });
    const context = [...(e.context ?? []), `${PREFIX} watching src/**/*.js; files written or edited are linted automatically`];
    return next({ ...e, context });
  });

  // ---- session lifecycle ----
  on("session.start", async ($, e, next) => {
    rec({ event: "session.start", opts: preview(opts) });

    await call($, "plugin.name/root", async () => preview(await pluginFacts($)));
    await call($, "env.get(LINT_GUARD_PATTERN)", () => $.env.get("LINT_GUARD_PATTERN"));
    await call($, "command.register(lint)", () =>
      $.command.register({ name: "lint", description: "Run eslint over the workspace and report findings" })
    );
    await call($, "tool.register(lint_report)", () =>
      $.tool.register({
        name: "lint_report",
        description: "Returns the eslint findings lint-guard recorded most recently",
        inputSchema: { type: "object", properties: {} },
      })
    );
    await call($, "command.list", () => $.command.list());
    await call($, "tool.list", async () => (await $.tool.list()).length);
    await call($, "session.id", () => $.session.id());
    await call($, "session.cwd", () => $.session.cwd());
    await call($, "session.model", () => $.session.model());
    await call($, "session.version", () => $.session.version());
    await call($, "session.usage", () => $.session.usage());
    await call($, "session.messages", async () => (await $.session.messages()).length);

    await flush($); // checkpoint before probes that may hang or reject

    await call($, "fs.exists(src)", () => $.fs.exists("src"));

    if (runGaps) {
      // ---- documented-gap battery: members the bridge says it does not serve.
      // Each is wrapped; whatever the host does lands in the trace. $.model.complete
      // goes last: under the bridge it waits on a side-request event, and a hang
      // costs this hook its 10s budget, which is itself the finding.
      await call($, "GAP settings.read", () => $.settings.read());
      await call($, "GAP fs.ancestors", () => $.fs.ancestors({ names: [ESLINT_CONFIG] }));
      await call($, "GAP process.spawn", () => $.process.spawn(["/usr/bin/true"]));
      await call($, "GAP session.repo", () => $.session.repo());
      await call($, "GAP config.list", () => $.config.list());
      await call($, "GAP telemetry.log", () => $.telemetry.log("lint-guard probe"));
      await call($, "GAP ui.copy", () => $.ui.copy("lint-guard probe"));
      await call($, "GAP prompt.read", () => $.prompt.read());
      await call($, "GAP model.complete", () =>
        $.model.complete({ model: "haiku", prompt: "Reply with the single word OK", maxTokens: 8 })
      );
    }

    // Self-test of the command surface: `$.command.run` queues `/lint` and it
    // executes once the session is idle, raising our command.run hook. Fired
    // without await so session.start settles first.
    call($, "command.run(lint) [queued self-test]", () => $.command.run({ command: "lint" })).then((row) => {
      rec({ call: "command.run(lint) [settled]", ok: row.ok, result: row.result, error: row.error });
    });

    await flush($);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    rec({ event: "turn.complete", preview: preview(e).slice(0, 200), seen: { ...seen } });
    await call($, "session.usage", () => $.session.usage());
    await flush($);
    return { text: `${PREFIX} findings so far: ${findings.problems}` };
  });

  on("session.end", async ($, e, next) => {
    rec({ event: "session.end", seen: { ...seen }, findings: { ...findings } });
    await call($, "store.set(lint-guard:findings)", () => $.store.set("lint-guard:findings", { ...findings }));
    await flush($);
    return next(e);
  });

  // ---- the mod's actual job: lint after every Write/Edit ----
  on("tool.call", { tool: ["Write", "Edit"] }, async ($, e, next) => {
    const result = await next(e);
    const file = e.file_path ?? (e.input && e.input.file_path) ?? null;
    rec({ event: "tool.call[post-lint]", tool: e.tool, file, resultKeys: result && typeof result === "object" ? Object.keys(result) : typeof result });

    if (file) {
      const { summary } = await lintPaths($, [file]);
      noteFindings(summary);
      await call($, "store.set(lint-guard:findings)", () => $.store.set("lint-guard:findings", { ...findings }));
      await call($, "ui.log", () => $.ui.log(`${PREFIX} ${file}: ${summary.problems} finding(s)`));
      await call($, "ui.toast", () => $.ui.toast(`${PREFIX} lint: ${summary.problems} finding(s)`));
      await call($, "ui.status", () => $.ui.status(`${PREFIX} ${summary.problems} finding(s)`));

      // Rewrite the tool result the host is about to record: append our line
      // to whichever text-ish field the result carries. A frozen result (the
      // event is deeply frozen; the result may be too) is recorded, not fatal.
      let rewrote = null;
      try {
        if (result && typeof result === "object") {
          for (const k of ["output", "text", "content"]) {
            if (typeof result[k] === "string") {
              result[k] += `\n${PREFIX} eslint after edit: ${summary.line}`;
              rewrote = k;
              break;
            }
          }
        }
      } catch (err) {
        rec({ call: "tool.result-rewrite", ok: false, error: `result frozen: ${err}` });
      }
      if (rewrote) rec({ call: "tool.result-rewrite", ok: true, field: rewrote });
    }

    await flush($);
    return result;
  });

  // ---- interop probe: does the host apply argument rewrites passed to next? ----
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (String(e.command ?? "") !== "echo lint-guard-probe") return next(e);
    await call($, "ui.notice", () => $.ui.notice(e.tool_use_id, `${PREFIX} checked`));
    const result = await next({ ...e, command: "echo lint-guard-REWRITTEN-BY-MOD" });
    rec({ probe: "bash-args-rewrite", expectedIfApplied: "lint-guard-REWRITTEN-BY-MOD", result: preview(result) });
    await flush($);
    return result;
  });

  // ---- the mod-registered tool, served by us ----
  on("tool.call", { tool: /lint_report$/ }, async ($, e, next) => {
    rec({ event: "tool.call[own tool]", tool: e.tool });
    return { result: { ...findings } };
  });

  // ---- /lint ----
  on("command.run", { command: "lint" }, async ($, e, next) => {
    rec({ event: "command.run", command: e.command, args: preview(e.args ?? null) });
    const { summary } = await lintPaths($, ["src"]);
    noteFindings(summary);
    const report = [
      `lint-guard report — ${new Date().toISOString()}`,
      `files: ${summary.files}  problems: ${summary.problems} (errors: ${summary.errors})`,
      `last: ${summary.line}`,
      `events seen: ${JSON.stringify(seen)}`,
      "",
    ].join("\n");
    await call($, "fs.write(.lint-guard-report.txt)", () => $.fs.write(".lint-guard-report.txt", report));
    await flush($);
    return { text: `${PREFIX} ${summary.files} file(s), ${summary.problems} finding(s)` };
  });

  // ---- the band above the prompt ----
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    seen.uiRender += 1;
    if (findings.problems === 0 && findings.last === null) return next(e); // nothing to hold: yield the band
    rec({ event: "ui.render[band]", n: seen.uiRender });
    return drawBand($, e);
  });
}
