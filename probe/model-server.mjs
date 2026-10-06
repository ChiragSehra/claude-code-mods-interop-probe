// Scripted Anthropic-Messages-compatible model server for the dsh run.
// The dsh-llm-deepseek adapter speaks the Messages protocol at {baseURL}/v1/messages;
// this server answers it deterministically:
//   beat 0 -> tool_use block: `read` (satisfies dsh's read-before-write policy)
//   beat 1 -> tool_use block: `write` (rewrites src/payment.js so total uses rate)
//   beat 2 -> tool_use block: `bash` (runs exactly: echo lint-guard-probe)
//   beat 3 -> text: task complete
//   later  -> text: "Noted." (e.g. a turn triggered by the queued /lint command)
// Every request and response lands in runs/model-server-wire.jsonl (the wire-level
// half of the dsh run's evidence).
import http from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'

const PORT = 8931
const LOG = new URL('./runs/model-server-wire.jsonl', import.meta.url).pathname
mkdirSync(new URL('./runs', import.meta.url).pathname, { recursive: true })

const NEW_TOTAL = `var rate = 0.1;

function total(a, b) {
  return (a + b) * (1 + rate);
}

module.exports = { total, rate };
`

const conversations = new Map()
let msgCounter = 0

function log(row) {
  appendFileSync(LOG, JSON.stringify(row) + '\n')
}

function keyOf(body) {
  return JSON.stringify(body.messages?.[0] ?? {}).slice(0, 120)
}

function planToolCall(body, n) {
  const tools = body.tools ?? []
  const names = tools.map((t) => t?.name ?? '')
  if (names.length === 0) return { noTools: true }
  const plan = [
    { want: 'read', fill: (p) => (/path|file/i.test(p) ? 'src/payment.js' : 'probe') },
    { want: 'write', fill: (p) => (/path|file/i.test(p) ? 'src/payment.js' : /content|text|new/i.test(p) ? NEW_TOTAL : 'probe') },
    { want: 'bash', fill: (p) => (/command/i.test(p) ? 'echo lint-guard-probe' : 'probe') },
  ][n] ?? { want: 'bash', fill: (p) => (/command/i.test(p) ? 'echo lint-guard-probe' : 'probe') }
  const tool =
    tools.find((t) => t?.name === plan.want) ??
    tools.find((t) => new RegExp(`(^|_|\\.)${plan.want}$|${plan.want}$`, 'i').test(t?.name ?? '') && !/todo/i.test(t?.name ?? ''))
  if (!tool) return { error: `no ${plan.want}-like tool in requested tools: ${names.join(', ')}` }
  const params = tool.input_schema ?? {}
  const required = params.required ?? Object.keys(params.properties ?? {})
  const input = {}
  for (const prop of required) input[prop] = plan.fill(prop)
  log({ event: 'tool-call-planned', tool: tool.name, input })
  return { name: tool.name, input }
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function messageSSE(body) {
  const key = keyOf(body)
  const n = conversations.get(key) ?? 0
  conversations.set(key, n + 1)
  const lastText = JSON.stringify(body.messages?.[body.messages.length - 1] ?? {}).slice(0, 200)
  log({ event: 'request', beat: n, model: body.model, stream: body.stream, toolCount: body.tools?.length ?? 0, lastMessage: lastText })
  const id = 'msg_probe_' + (++msgCounter)
  const out = []
  out.push(sse('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model: body.model ?? 'scripted-1', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  }))
  let stopReason = 'end_turn'
  if (n <= 2) {
    const call = planToolCall(body, n)
    if (call.noTools) {
      out.push(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      out.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ready.' } }))
      out.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
    } else if (call.error) {
      out.push(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      out.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `probe server error: ${call.error}` } }))
      out.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
    } else {
      out.push(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_probe_1', name: call.name, input: {} } }))
      out.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }))
      out.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
      stopReason = 'tool_use'
    }
  } else if (n === 3) {
    out.push(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    out.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done. src/payment.js now prices in the rate.' } }))
    out.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  } else {
    out.push(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    out.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Noted.' } }))
    out.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
  }
  out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } }))
  out.push(sse('message_stop', { type: 'message_stop' }))
  log({ event: 'response', beat: n, stopReason })
  return out.join('')
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    log({ event: 'http', method: req.method, url: req.url, bytes: raw.length, headers: { betas: req.headers['anthropic-beta'] ?? null, auth: req.headers['x-api-key'] ? 'present' : req.headers['authorization'] ? 'bearer' : 'none' } })
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch {}
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.end(messageSSE(body))
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`scripted Messages model on http://127.0.0.1:${PORT}/v1`))
