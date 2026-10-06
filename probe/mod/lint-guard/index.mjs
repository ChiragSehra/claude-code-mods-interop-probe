// lint-guard mounted as a DeepSeek Harness plugin through the experimental
// Claude Code mods bridge. Same hooks module the Claude Code reference run
// loads from hooks/hooks.json.
import { defineMod } from '@deepseek-ai/dsh-experimental-claude-code-mods'
import { register } from './hooks/lint-guard.mjs'

export default defineMod({
  name: 'lint-guard',
  version: '0.1.0',
  root: new URL('.', import.meta.url).pathname,
  userConfig: { pattern: 'src/**/*.js', gaps: true },
  register,
})
