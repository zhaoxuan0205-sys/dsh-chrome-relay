#!/usr/bin/env node
/**
 * Stdio watchdog in front of @playwright/mcp.
 *
 * Why: when the bound Chrome tab dies (closed / navigated to a login page /
 * extension service worker asleep), @playwright/mcp's pending request never
 * resolves. The MCP client then blocks until its own (often 60s) timeout, and
 * every later call queues behind it — the whole browser toolset looks dead.
 *
 * What this does:
 *   1. enforces a per-call timeout and answers with an actionable error;
 *   2. refuses to drive localhost / file:// (that is what poisoned the link);
 *   3. on a timeout, answers that call with an error but KEEPS the server
 *      alive. Restarting the server would force the user to approve the tab
 *      again, so a single slow call must never trigger a respawn.
 *
 * Env:
 *   DSH_RELAY_TIMEOUT_MS       default 60000 (a slow page must not cost an approval)
 *   DSH_RELAY_INIT_TIMEOUT_MS  default 30000
 */
import { spawn } from 'node:child_process'

const CALL_TIMEOUT = Number(process.env.DSH_RELAY_TIMEOUT_MS || 60000)
const INIT_TIMEOUT = Number(process.env.DSH_RELAY_INIT_TIMEOUT_MS || 30000)
const [, , cli, ...args] = process.argv
if (!cli) {
  console.error('[relay] usage: mcp-watchdog.mjs <cli.js> [args...]')
  process.exit(64)
}

const log = (...a) => console.error('[relay]', ...a)
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

let child = null
let shutdown = false
const pending = new Map() // id -> timer
const abandoned = new Set() // timed-out ids: drop late replies

function failAll(reason) {
  for (const [id, t] of pending) {
    clearTimeout(t)
    write({ jsonrpc: '2.0', id, error: { code: -32001, message: reason } })
  }
  pending.clear()
}

function start() {
  child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'inherit'] })
  log('server started pid=' + child.pid)

  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && abandoned.has(msg.id)) {
          abandoned.delete(msg.id)
          continue
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          clearTimeout(pending.get(msg.id))
          pending.delete(msg.id)
        }
      } catch { /* not json: pass through */ }
      process.stdout.write(line + '\n')
    }
  })

  child.on('exit', (code, sig) => {
    log('server exited code=' + code + ' signal=' + sig)
    child = null
    if (shutdown) return
    failAll('浏览器服务已退出，下一次调用会重新启动它。若反复出现，请在 Chrome 里重新选择标签页。')
  })

  child.on('error', (e) => log('spawn error: ' + e.message))
}

function forward(msg) {
  if (!child) start()
  try {
    child.stdin.write(JSON.stringify(msg) + '\n')
  } catch (e) {
    log('write failed: ' + e.message)
    start()
    child.stdin.write(JSON.stringify(msg) + '\n')
  }
}

const SELF_PAGE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?\//i
const SELF_FILE = /^file:\/\//i

let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { process.stdout.write(line + '\n'); continue }

    if (msg.method === 'tools/call' && msg.id !== undefined) {
      const name = msg.params && msg.params.name
      const url = msg.params && msg.params.arguments && msg.params.arguments.url
      if (name === 'browser_navigate' && typeof url === 'string' && (SELF_PAGE.test(url) || SELF_FILE.test(url))) {
        write({ jsonrpc: '2.0', id: msg.id, error: { code: -32002,
          message: '拒绝驱动本机页面（localhost / file://）。请让用户在扩展里选择要读取的网页标签。' } })
        continue
      }
    }

    if (msg.id === undefined) { forward(msg); continue }

    const limit = msg.method === 'initialize' ? INIT_TIMEOUT : CALL_TIMEOUT
    const timer = setTimeout(() => {
      pending.delete(msg.id)
      abandoned.add(msg.id)
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32001,
        message: '浏览器无响应（' + limit + 'ms）。本次调用已中止，但中继保持连接，不会重新授权。若标签页已失效，请在 Chrome 的 Playwright 扩展里重新选择标签页；仍不行再重启 DSH。' } })
      // Ask the MCP server to cancel the stuck request. This is best-effort:
      // the tab may be truly gone, but it lets later calls run without a restart.
      try {
        child && child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled',
          params: { requestId: msg.id, reason: 'watchdog timeout' } }) + '\n')
      } catch {}
      log('timeout on ' + (msg.method || 'call') + ' id=' + msg.id + ' — keeping server pid=' + (child && child.pid))
    }, limit)

    pending.set(msg.id, timer)
    forward(msg)
  }
})

process.stdin.on('end', () => {
  failAll('输入流已关闭，浏览器调用被中断。')
  shutdown = true
  try { child && child.kill('SIGTERM') } catch {}
  process.exit(0)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { shutdown = true; try { child && child.kill('SIGTERM') } catch {}; process.exit(0) })
}

start()
