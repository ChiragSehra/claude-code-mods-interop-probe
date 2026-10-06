// lint-guard-native — the same mod's two features as a plain DeepSeek Harness
// plugin, for the port-delta column of the interop probe: lint after every
// write/edit (tools/post-execute) and a /lint command (ctx.commands).
// No Claude Code mods bridge involved.
import type { Context } from '@deepseek-ai/cordis'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

export const name = 'lint-guard-native'
// Cordis requires declared service dependencies; ctx.commands throws without it.
export const inject = ['commands']

// eslint argv is fixed; the only variable is the lint target, passed as one
// argv element (no shell involved). The guard rejects anything path-unlike.
function lintArgv(target: string): string[] {
  if (!/^[\w./-]+$/.test(target)) throw new Error(`lint skipped: unexpected target ${target}`)
  return ['--no-warn-ignored', '-c', './mod/lint-guard/eslint.config.mjs', '--format', 'json', target]
}

async function lint(target: string): Promise<string> {
  try {
    const { stdout } = await execFile('./node_modules/.bin/eslint', lintArgv(target), { cwd: process.cwd(), timeout: 20000 })
    return summarize(stdout)
  } catch (e) {
    const err = e as { stdout?: string; message?: string }
    if (err.stdout) return summarize(err.stdout) // eslint exits 1 when it finds problems
    return `eslint failed to run: ${String(err.message ?? e).slice(0, 120)}`
  }
}

function summarize(stdout: string): string {
  try {
    const arr = JSON.parse(stdout) as Array<{ errorCount: number; warningCount: number; messages: Array<{ ruleId: string | null; message: string }> }>
    const problems = arr.reduce((n, f) => n + f.errorCount + f.warningCount, 0)
    const first = arr
      .flatMap((f) => f.messages)
      .slice(0, 2)
      .map((m) => `${m.ruleId}: ${m.message}`)
      .join('; ')
    return `${arr.length} file(s), ${problems} finding(s)${first ? ` — ${first}` : ''}`
  } catch {
    return 'eslint produced no parseable output'
  }
}

interface Exec {
  name?: string
  arguments?: Record<string, unknown>
}

interface Downstream {
  kind: string
  content?: Array<{ type: string; text: string }>
  additionalContexts?: unknown[]
}

export function apply(ctx: Context): void {
  // Attach a lint line to the result of every write/edit the session performs.
  ctx.on('tools/post-execute', async (exec: Exec, _result: unknown, next: () => Promise<Downstream>) => {
    const downstream = await next()
    if (downstream.kind !== 'accept') return downstream
    const tool = String(exec.name ?? '')
    if (!/write|edit|str_replace/i.test(tool)) return downstream
    const args = exec.arguments ?? {}
    const file = String(args.file_path ?? args.path ?? '')
    if (!file) return downstream
    const line = await lint(file)
    return {
      ...downstream,
      kind: 'accept',
      content: [...(downstream.content ?? []), { type: 'text', text: `[lint-guard] eslint after edit: ${line}` }],
    }
  })

  // The /lint command, native form.
  ctx.commands.register({
    name: 'lint',
    description: 'Run eslint over the workspace and report findings',
    handler: async () => {
      const line = await lint('src')
      return { text: `[lint-guard] ${line}` }
    },
  })
}
