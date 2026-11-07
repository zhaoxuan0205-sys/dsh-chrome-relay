#!/usr/bin/env node
// Minimal connectivity check.
//   0 = MCP server starts and lists tools
//   2 = MCP failed to start
//   3 = browser handshake failed (extension not reachable / user declined)
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const launcher = argOf('--launcher', path.join(os.homedir(), '.dsh/bin/browser-bridge-launch.sh'))
const wantBrowser = argv.includes('--browser')

const child = spawn(launcher, ['--extension', '--no-webmcp', '--codegen', 'none'], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
let stderr = ''
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {}
  }
})
child.stderr.on('data', (d) => { stderr += d.toString() })
let id = 0
const rpc = (method, params, ms = 20000) => new Promise((res, rej) => {
  const mid = ++id
  pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 160))) : res(m.result)))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n')
  setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)) } }, ms)
})
const call = async (name, args, ms) => {
  const r = await rpc('tools/call', { name, arguments: args }, ms)
  return (r.content || []).map((c) => c.text || '').join('\n')
}
const finish = (code, msg) => { try { child.kill() } catch {}; console.log(msg); process.exit(code) }

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-chrome-relay-check', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
  const tools = await rpc('tools/list', {})
  console.log('MCP_READY tools=' + (tools.tools || []).length)
  if (!wantBrowser) finish(0, 'RESULT=discovery-ok')
  const tabs = await call('browser_tabs', { action: 'list' }, 120000)
  if (/Extension not found|did not connect|Invalid token|timed out/i.test(tabs)) {
    finish(3, 'RESULT=browser-connect-failed :: ' + tabs.replace(/\s+/g, ' ').slice(0, 200))
  }
  finish(0, 'RESULT=browser-ok')
} catch (e) {
  finish(2, 'RESULT=discovery-failed :: ' + String(e.message).slice(0, 200) + (stderr ? ' | ' + stderr.slice(0, 120) : ''))
}
