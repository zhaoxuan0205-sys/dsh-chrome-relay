#!/usr/bin/env node
// Evaluate an expression inside the tab the user approved.
//   node bin/eval.mjs [--url <url>] --js "<expression>"
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const url = argOf('--url')
const js = argOf('--js')
const launcher = argOf('--launcher', path.join(os.homedir(), '.dsh/bin/browser-bridge-launch.sh'))
if (!js) { console.log('usage: node bin/eval.mjs [--url <url>] --js "<expression>"'); process.exit(64) }

const child = spawn(launcher, ['--extension', '--no-webmcp', '--codegen', 'none'], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {}
  }
})
let id = 0
const rpc = (method, params, ms = 120000) => new Promise((res, rej) => {
  const mid = ++id
  pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 160))) : res(m.result)))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n')
  setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)) } }, ms)
})
const call = async (name, args, ms) => {
  const r = await rpc('tools/call', { name, arguments: args }, ms)
  return (r.content || []).map((c) => c.text || '').join('\n')
}
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-chrome-relay-eval', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
  if (url) { await call('browser_navigate', { url }); await new Promise((r) => setTimeout(r, 2500)) }
  console.log(await call('browser_evaluate', { function: js }))
  child.kill()
} catch (e) {
  console.log('FAIL :: ' + String(e.message).slice(0, 200))
  child.kill()
  process.exit(2)
}
