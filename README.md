# dsh-claude-code-mods

One real Claude Code mod, three configurations, four executions — an interop probe of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)'s experimental [Claude Code Mods compatibility layer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/claude-code-mods.md), with the full compatibility matrix and the run evidence to back it.

DeepSeek's v0.2.1-alpha.1 release shipped a bridge that runs Claude Code mods inside dsh, framed honestly as verifying that the Claude Code Mods API is "broadly a subset of what DeepSeek Harness plugins can do, rather than ... complete, practical compatibility." Every mod DeepSeek had actually run through that bridge lived in their own repo, and the four real mods in Anthropic's repo were assessed *by reading, not running*. This project is the missing external test: the same ordinary mod under Claude Code (reference) and under the dsh bridge, plus the same job rewritten as a native dsh plugin.

## Verdict

The subset claim **holds for mods that observe, register, and enrich** — tool watching, commands, tools, fs, storage, env, prompt context injection, command runs, the status band all behaved equivalently (both hosts even named a registered tool identically: `mcp__lint-guard__lint_report`).

It **ends at three seams**, all in the "mod shapes execution" category:

1. **`tool.call` argument rewrites are dropped.** The probe hook passed `next({ ...e, command: "echo lint-guard-REWRITTEN-BY-MOD" })`. Claude Code ran the rewritten command (its model noticed on its own). dsh ran the original, exactly as logged — the bridge validates that arguments match the logged call and discards the hook otherwise (`RewriteRefusedError`).
2. **Post-`next()` result rewriting silently no-ops.** Claude Code's tool result is `{ref, result, text}`; appending to `text` worked. dsh returns `{result, isError}` — no text field, so the identical mutation changes nothing, throws nothing.
3. **Ten exercised operations have no implementation.** The nine gap-battery calls (`settings.read`, `fs.ancestors`, `process.spawn`, `session.repo`, `config.list`, `telemetry.log`, `ui.copy`, `prompt.read`, `model.complete`) plus `$.ui.notice`. Eight rejections match the documented wording exactly; `$.model.complete` is a **doc-vs-runtime discrepancy** — the README says it "waits on a logged side-request event," this runtime rejected it outright. And `tool.check`, which fired 3× under Claude Code, never fires under the bridge.

Full row-by-row evidence: **[COMPAT_MATRIX.md](COMPAT_MATRIX.md)**.

## The probe: `lint-guard`

An ordinary eslint wrapper, deliberately boring — that's what makes it a fair test:

- lints a file after every Write/Edit (`tool.call` hook), reports via `ui.log/toast/status`
- registers a `/lint` command and a `lint_report` tool
- injects a one-line context note on `prompt.submit`
- draws findings in the `ui.render` band
- a **gap battery** of documented-unsupported calls, each wrapped so the outcome lands in the trace
- an **args-rewrite probe**: a Bash hook that passes a rewritten `echo` to `next()` — the outcome is visible in the tool output on both hosts

The mod journals its own host-API calls (`name`, ok, duration, result snippet) to `.lint-guard-trace.jsonl` via the mod API's own `$.fs.write`, so both hosts leave the same artifact. The journal covers the *probed* surface: `$.ui.resolve` is called directly in `drawBand`, and `$.plugin.name`/`root` share one entry. The Claude run's trace holds 35 distinct call labels; the dsh run's holds 33.

## The four executions

| # | Configuration | Notes |
|---|---|---|
| 1 | Claude Code 2.1.289, `--plugin-dir`, real model | 58-row trace; $0.14 in tokens; mod pre-validated with `claude plugin validate` |
| 2 | dsh 0.2.1-alpha.1 headless + bridge, scripted model | first attempt: write blocked by dsh's read-before-write policy (`FS_NOT_OBSERVED`) — a harness guard *below* the mods layer |
| 3 | same, read-first scenario | the clean run the matrix is built from |
| 4 | dsh headless, **native plugin** (no bridge) | same lint job via `tools/post-execute` + `ctx.commands`; needed `inject: ['commands']` to boot |

Runs 2–4 use a scripted Anthropic-Messages server on localhost (`model-server.mjs`) behind the runtime's own `dsh-llm-deepseek-api-key` adapter via a `baseURL` override — deterministic and free, so every host difference is the harness, not the model.

## Repo layout

```
COMPAT_MATRIX.md            ← the deliverable: row-by-row matrix + run ledger + repro recipe
probe/
  mod/lint-guard/           ← the mod; same hooks module for Claude Code and the dsh bridge
    .claude-plugin/ hooks/  ←   Claude Code packaging (plugin.json, hooks.json)
    index.mjs               ←   dsh side: defineMod wrapper
    eslint.config.mjs       ←   the rules the mod enforces
  native/lint-guard-native.ts ← the same job as a plain dsh plugin (no bridge)
  model-server.mjs          ← scripted Messages-protocol model server (port 8931)
  lint-guard.patch.yml      ← dsh overlay: bridge + mod + scripted model route
  native.patch.yml          ← dsh overlay: native plugin + scripted model route
  src/payment.js            ← the file the agent rewrites in every run
  workspace/                ← working directory for the Claude Code reference run
  runs/                     ← all captured evidence (traces, raw session logs, wire log)
```

## Reproducing

Prerequisites: Node 20+, npm, pnpm on PATH (`dsh plugin add` shells out to it), and Claude Code 2.1.289+ authenticated for the reference run.

```sh
# 0. install (dsh CLI + bridge wrapper + eslint)
cd probe && npm install && cd workspace && npm install && cd ..

# 1. one-time: install the bridge into dsh's headless profile
./node_modules/.bin/dsh plugin --profile headless add \
  @deepseek-ai/dsh-experimental-claude-code-mods@0.2.1-alpha.1

# 2. start the scripted model (restart before each run — beats are stateful)
node model-server.mjs &

# 3. dsh bridge run
rm -f .lint-guard-trace.jsonl runs/model-server-wire.jsonl
DEEPSEEK_API_KEY=probe-key ./node_modules/.bin/dsh --profile headless \
  --patch ./lint-guard.patch.yml \
  "Rewrite src/payment.js so that total returns (a + b) * (1 + rate). Then run exactly: echo lint-guard-probe. Then stop."

# 4. Claude Code reference run (from probe/workspace/)
cd workspace && rm -f .lint-guard-trace.jsonl && claude -p \
  "Small task: use the Edit tool to change src/payment.js so that total returns (a + b) * (1 + rate). Then run exactly this Bash command: echo lint-guard-probe — nothing else. Then stop." \
  --plugin-dir ../mod/lint-guard --allowedTools "Edit Write Bash" \
  --output-format stream-json --verbose --max-turns 6

# 5. native-port run (no bridge)
cd .. && DEEPSEEK_API_KEY=probe-key ./node_modules/.bin/dsh --profile headless \
  --patch ./native.patch.yml \
  "Rewrite src/payment.js so that total returns (a + b) * (1 + rate). Then stop."
```

Artifacts to compare afterwards: `.lint-guard-trace.jsonl` in whichever directory the run used (dsh's session cwd is the launch directory; Claude Code's is where you invoked it), the raw dsh session under `~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`, and `runs/model-server-wire.jsonl` for the wire-level view.

## Caveats

- Tested against bridge `@deepseek-ai/dsh-experimental-claude-code-mods` 0.2.1-alpha.1 and Claude Code 2.1.289 (the bridge's docs target 2.1.287). Both move fast; expect drift.
- Claude Code's reference run used the account's first-party model, so run 1 is the only non-deterministic one. The audited behaviors (rewrite applied, result shape, event firing) were stable and are backed by the captured stream in `probe/runs/`.
- The dsh runs change host state once: the bridge package is added to `~/.dsh/profiles/headless`. Remove it with `dsh plugin --profile headless remove` if you want the profile pristine.

## See also

- The bridge's own compatibility page (the map this probe tested): [`docs/subsystems/claude-code-mods.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/claude-code-mods.md) in the deepseek-harness repo
- Anthropic's mods announcement and reference: [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/) · [mods API reference](https://code.claude.com/docs/en/plugins/mods/reference)
