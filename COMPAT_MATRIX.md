# Claude Code Mods ↔ DeepSeek Harness: one real mod, three configurations (four executions), the boundary mapped

**Probe:** `lint-guard` — an ordinary eslint-wrapper mod (lint after every Write/Edit, a `/lint` command, a context-injected prompt, a band drawing, plus a deliberate battery of documented-gap probes). The same hooks module (`mod/lint-guard/hooks/lint-guard.mjs`) runs in the first two configurations (Claude Code reference, dsh bridge); the third configuration is a native-plugin rewrite of the same job. Three configurations, four executions. Every probed host-API call is traced in-band to `.lint-guard-trace.jsonl` via `$.fs.write` — with two known exceptions: `$.ui.resolve`'s element constructors are called directly in `drawBand` (not through the trace wrapper), and `$.plugin.name`/`$.plugin.root` share one trace entry — cross-checked against the host's own records (Claude Code stream-json; dsh's raw `session.v4.jsonl` and the scripted model's wire log).

**Date:** 2026-10-06 · **Reference host:** Claude Code 2.1.289 (docs the bridge targets: 2.1.287) · **Bridge:** `@deepseek-ai/dsh-experimental-claude-code-mods` 0.2.1-alpha.1 on the `dsh` 0.2.1-alpha.1 headless profile · **Model under dsh:** a local scripted Anthropic-Messages server behind the runtime's own `dsh-llm-deepseek-api-key` adapter (`baseURL` override), so the dsh runs are deterministic and free. **Model under Claude Code:** the account's first-party route (real model; the reference run cost $0.1434 in tokens).

## Verdict up front

The subset claim **holds for the served surface and fails at three specific, load-bearing seams** — all three confirmed with the same mod code on both hosts:

1. **`tool.call` argument rewrites are silently dropped.** The mod passed `next({ ...e, command: "echo lint-guard-REWRITTEN-BY-MOD" })` to a harmless `echo`. Claude Code **ran the rewritten command** (stdout: `lint-guard-REWRITTEN-BY-MOD` — the model even noticed: *"Something, most likely the lint-guard plugin, rewrote either the command or its output"*). dsh **ran the original as logged** (stdout: `lint-guard-probe`). The bridge source confirms the mechanism: `validateNext` throws `RewriteRefusedError("rewrote the arguments of X; argument rewrites need the pre-tool input rewrite mechanism")`, and the hook's continuation is discarded — the hook's trace rows never persist.
2. **Post-`next()` result rewriting doesn't transfer.** Claude Code's tool result is `{ref, result, text}`; the mod appended its lint line to `text` and the rewrite landed. dsh's `next()` returns `{result, isError}` (no text-ish field), so the identical mutation is a **silent no-op** — no error, no report. (The bridge's own result-rewrite mechanism exists but speaks its own shape; a CC-shaped rewrite pattern degrades quietly.)
3. **Ten distinct API operations the probe exercises have no implementation.** The nine gap-battery calls — `settings.read`, `fs.ancestors`, `process.spawn`, `session.repo`, `config.list`, `telemetry.log`, `ui.copy`, `prompt.read`, `model.complete` — all rejected on the bridge with the documented wording `no implementation for <name>`; a tenth unserved call, `$.ui.notice`, was incurred on the rewrite-test path. For eight of the nine battery calls that rejection is exactly what the compatibility page promises; `$.model.complete` is a **doc-vs-runtime discrepancy** — the README says it "waits on a logged side-request event", while this runtime rejected it outright. (Under Claude Code the same calls returned live data — settings, config rows, prompt box — or answered: `$.model.complete` → `"OK"` with usage; `$.process.spawn` exists in 2.1.289.) Events `tool.check` (fired **3×** under CC, **0×** under dsh), `turn.step`, `agent.spawn` register silently and never fire under the bridge.

Everything else the mod did — registration, commands, tools, fs, store, env, prompt enrichment, command runs, ui.log/toast/status, the band — behaved equivalently. For an ordinary mod that *observes* and *registers*, portability is real. The moment a mod **shapes execution** (rewrites args, rewrites results in CC's shape, reads settings, or draws beyond the band), you're on the bridge's side of the boundary.

## Run ledger

| Run | Host | Scenario | Evidence |
|---|---|---|---|
| 1 | Claude Code 2.1.289, `claude -p --plugin-dir`, real model | Read → Edit → Bash echo | `runs/cc-reference-trace.jsonl`, `runs/cc-reference-stream.jsonl` (58-row trace; hooks validated by `claude plugin validate` before the run) |
| 2–3 | dsh 0.2.1-alpha.1 headless + bridge, scripted Messages model | Read → Write → Bash echo (run 2's blind write was blocked by `FS_NOT_OBSERVED` — itself a finding) | `runs/dsh-run3-trace.jsonl`, `runs/dsh-run3-session-v4.jsonl`, `runs/model-server-wire.jsonl` |
| 4 | dsh headless, **native plugin**, no bridge | Read → Write → Bash | `runs/native-session-v4.jsonl` |

## Compatibility matrix

Legend: ✅ equivalent behavior · ⚠️ works with a documented difference · 🔴 fails / silently degrades · ➖ not exercised headless.

### Packaging & loading

| Claude Code | dsh bridge | Verdict |
|---|---|---|
| `.claude-plugin/plugin.json` + `hooks/hooks.json` naming the hooks module | Not read; a `defineMod({name, version, root, userConfig, register})` wrapper (`index.mjs`) mounts via the cordis patch list after the bridge | ⚠️ one extra 12-line wrapper file; `plugin.json` kept only for the CC side |
| `userConfig` schema in `plugin.json` (typed defaults; validator demands `title`) | Defaults re-declared in `defineMod`'s `userConfig`; overlay `config:` merges | ⚠️ defaults live in two places |
| `claude plugin validate` reads manifest + hooks source statically (it caught two real errors pre-flight: missing `userConfig.title`, and `turn.step` requiring an async-generator hook) | No equivalent; a `register` that throws fails the mount; unknown-but-known event names warn at load | ⚠️ pre-flight validation lost |
| `.mjs` hooks module | Same module loads via the launcher's tsx transpile; plain `.mjs` wrapper avoids the "built install doesn't transpile `.ts`" edge | ✅ |
| Loading cost: `--plugin-dir`, `lint-guard@inline` in the tool list | Mounted as `claude-code-mod-lint-guard` patch entry | ✅ |

### Events

| Event | Claude Code (observed) | dsh bridge (observed) | Verdict |
|---|---|---|---|
| `session.start` | Fired once before first prompt | Fired, awaited before first turn | ✅ |
| `prompt.submit` + context injection | Fired; context line applied per reference docs (not visible in `-p` transcript) | Fired; the injected line **visible in the raw session log** riding the user message | ✅ |
| `tool.call` (matcher `Write`/`Edit`/`Write`-shaped) | Fired around the Edit; result was `{ref, result, text}` | Fired around the Write; result was `{result, isError}` | ⚠️ fires on both; **result shape differs** (below) |
| `tool.call` args rewrite via `next({...e})` | **Applied** — command ran rewritten; model noticed | **Dropped** — original ran as logged; hook discarded (`RewriteRefusedError`) | 🔴 hard edge #1 |
| Post-`next` result rewrite | Worked (append to `text`) | Silent no-op (no `text` field on dsh's result object) | 🔴 hard edge #2 |
| `command.run` (registered command) | Queued `$.command.run` self-test settled with the command's `{text}` | Same — settled with `{text}`; also visible as `command/run`/`command/done` in the raw log | ✅ (caveat: on abrupt headless exit a queued command can race teardown — one run logged `command/done` `kind:"error"` "owner disposed during setup" *after* the handler had done its work) |
| `tool.check` | **Fired 3×** (once per tool call, payload `{tool, input, tool_use_id}`) | Registered, **never fired** (0 in `seen` counters across runs) | 🔴 hard edge #3 (silent — no deny/observe hook runs) |
| `turn.complete` (`{text}` line, `session.usage`) | Fired; `{text}` returned; usage had `{tokens: 24835, window: 1000000, percent: 2}` | Turn ended (`turn/end` in raw log) but the hook's rows never persisted — headless process exit races the hook's flush | ⚠️/➖ operational (see below) |
| `session.end` | Fired; hooks had 1.5 s budget; final flush landed | No `agent/disposed` in the raw log — **never observed firing** on abrupt headless exit | ⚠️/➖ operational |
| `ui.render` (`AbovePrompt` band) | 0 renders in `-p` mode (no TUI) | **2 renders headless** — the band exists session-side even with no Web client | ⚠️ dsh renders *more* here; drawing APIs (Box/Text/`$.ui.resolve`) accepted on both |
| `turn.step`, `agent.spawn` | turn.step needs an async-generator hook (validator-enforced); agent.spawn not exercised (no subagents) | Register, never fire (per docs; not directly observable in this scenario) | 🔴 by design, silent |

### `$` members

Counting distinct wrapper-recorded call labels across the full traces: **35 in the Claude run, 33 in the dsh run**. (The raw invocation count is slightly higher: `$.ui.resolve` is called directly in `drawBand` and `$.plugin.name`/`$.plugin.root` share one trace entry.)

| Call | Claude Code | dsh bridge | Verdict |
|---|---|---|---|
| `$.plugin.name/root` | Mod dir | Mod dir (from `defineMod`) | ✅ |
| `$.env.get` (string-literal names) | Value | Value | ✅ |
| `$.command.register` / `$.command.list` / `$.command.run` | Registered; listed; queued run settled | Same (list shows dsh's own builtin set) | ✅ |
| `$.tool.register` → `mcp__lint-guard__lint_report` | **Exact same name on both hosts** | Same | ✅ |
| `$.tool.list` | 26 tools | 25 tools | ✅ |
| `$.session.id/cwd/model/messages` | id/cwd/model/0 msgs | id/cwd/model/0 msgs; `cwd` = launch dir on both | ✅ |
| `$.session.version` | `{version: "2.1.289", builtAt…}` | `{version: "claude-code-mods/0.1", engine: "deepseek-harness"}` — **the bridge names itself** | ⚠️ version-conditional code will see a different shape |
| `$.session.usage` | `{context: {tokens, window: 1000000, percent}, rateLimits, cost}` | `{context: {window: 0}, rateLimits: []}` — window stayed 0, no tokens/percent/cost even with a catalog-model `contextWindow` configured | ⚠️ token-forecast UIs (Token Weather!) degrade to "unknown" |
| `$.fs.exists/list/write` | Worked | Worked (4 MiB cap; `stat.mtimeMs` is 0 per docs, not exercised) | ✅ |
| `$.store.set` (per-plugin 4 MiB) | Worked | Worked (`claude_code_mods` storage domain) | ✅ |
| `$.ui.log / toast / status` | Accepted | Accepted | ✅ |
| `$.ui.notice` | Accepted (with `tool_use_id`) | 🔴 not served — rejecting is documented; incurred on the discarded args-rewrite hook path, so the rejection string did not reach the dsh trace | 🔴 |
| `$.fs.write` as the trace instrument | Whole-file replace, worked | Same | ✅ |
| **Gap battery** | | | |
| `$.settings.read` | Returned the full merged settings | `no implementation for settings.read` | 🔴 |
| `$.fs.ancestors` | Host-check rejection: names must be `.md` files (my `.mjs` name) | `no implementation for fs.ancestors` | 🔴 both, differently |
| `$.process.spawn` | **Exists in 2.1.289**, returned `{result:{}}` | `no implementation for process.spawn` (only `$.process.run`) | 🔴 |
| `$.session.repo` | Returned `null` (not a git repo) | `no implementation for session.repo` | 🔴 |
| `$.config.list` | Returned config rows | `no implementation for config.list` | 🔴 |
| `$.telemetry.log` | Host-check rejection (needs `{to, event, props}` entry shape) | `no implementation for telemetry.log` | 🔴 both, differently |
| `$.ui.copy` | Host-check rejection (needs `{text, surface}`) | `no implementation for ui.copy` | 🔴 both, differently |
| `$.prompt.read` | Returned `{text, cursor}` | `no implementation for prompt.read` | 🔴 |
| `$.model.complete` | **Answered "OK"** (`{isAnswered: true, usage…}`, a real side-request) | `no implementation for model.complete` — **doc-vs-runtime discrepancy**: the README says it "waits on a logged side-request event", not that it rejects | 🔴 |

## Port delta: the same job as a native dsh plugin

`native/lint-guard-native.ts` (~100 lines, no bridge): `ctx.on('tools/post-execute')` attaches the eslint line to every write/edit result, `ctx.commands.register` provides `/lint`. **It worked on the first concept** — the raw log shows the lint line attached to the write's result: `[lint-guard] eslint after edit: 1 file(s), 1 finding(s) — no-var: Unexpected var, use let or const instead.`

What the port teaches about the delta:

- **Cordis is explicit where mods are ambient.** First boot failed with `cannot get property "commands" without inject` — native plugins must declare `export const inject = ['commands']`. The bridge hides all of this behind `defineMod`.
- **The native surface is *stronger* at the seams the bridge refuses.** The args-rewrite the bridge rejects (`RewriteRefusedError`) is a native plugin's ordinary `tools/pre-execute` waterfall; result replacement is a native `tools/post-execute` accept-with-content — the port used it directly.
- **What's missing natively in my port**: the band (`ui.render` is bridge-provided; natively it's the client-UI packages), `$.store`/`$.state` (storage domains + projections), and the trace instrument (the mod's `$.fs.write` trick works natively too, but nothing hands you an event journal).

## Operational findings (headless, both hosts)

- **dsh's fs-observation-policy sits *below* the mods layer.** A blind `write` to an existing file is rejected `FS_NOT_OBSERVED` ("file has not been read — read the file, then retry") regardless of any mod. Run 2's write failed this way; run 3's read-first scenario succeeded. Claude Code's model chose to read first on its own.
- **Headless exit races mod flushes.** On both hosts, `turn.complete`/`session.end` rows written near process exit can be lost from an in-band trace file (last-flush-wins). dsh's raw `session.v4.jsonl` (the "session-level raw logs" from the release notes) is the durable record — `turn/end`, every tool call/result, command runs, and the injected context line are all there. The mod trace + raw log together are the real instrument.
- **The stale-ecosystem tax is real.** `@deepseek-ai/dsh-llm-pi-ai` 0.0.1-rc.1 (published Aug 13) no longer imports against the 0.2.1 runtime — two of its peer packages aren't even on npm (404; `dsh-environment` vs today's `dsh-launch-environment`). The runtime's own `dsh-llm-deepseek-api-key` adapter with a `baseURL` override was the working route. `dsh plugin add` also enforces a version-risk policy (`allow-version --accept-risk`) and pnpm supply-chain approvals — expect friction mixing ecosystem packages across release trains.

## Repro

```sh
cd probe
node model-server.mjs &                                  # scripted Messages model on :8931
npm i                                                    # dsh CLI + bridge wrapper deps
# one-time: dsh plugin --profile headless add @deepseek-ai/dsh-experimental-claude-code-mods@0.2.1-alpha.1
DEEPSEEK_API_KEY=probe-key ./node_modules/.bin/dsh --profile headless --patch ./lint-guard.patch.yml \
  "Rewrite src/payment.js so that total returns (a + b) * (1 + rate). Then run exactly: echo lint-guard-probe. Then stop."
# reference run:
cd workspace && claude -p "<same task>" --plugin-dir ../mod/lint-guard --allowedTools "Edit Write Bash" \
  --output-format stream-json --verbose
# native port:
DEEPSEEK_API_KEY=probe-key ./node_modules/.bin/dsh --profile headless --patch ./native.patch.yml "<task>"
```

## The bet, answered

For the mod this probe represents — an ordinary linter wrapper that observes tools, registers a command and a tool, enriches prompts, and draws a band — **the compat layer delivered a working port with exactly three behavioral landmines, all in the "shapes execution" category, and none silent except the result-shape mismatch.** "Roughly a subset" is an honest label: the served surface is real and the failure mode for unserved surface is loud and named. But plugin portability as a *bet an integration rides on* hinges on what your mod does with `tool.call`: if it only observes, the subset is wide enough to build on; if it rewrites arguments (guardrails, wrappers, policy mods like Blast Radius's deny path aside), the subset ends there today — and the bridge's own docs point at a proposal (`2026-06-30-pre-tool-input-rewrite`) as the future mechanism. Until that lands, the first hard edge of the interop story is exactly where this probe found it.
