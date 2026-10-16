// agentdeck daemon: serves the dashboard page and its data on 127.0.0.1,
// renders one headless-Chrome tab per open pane ("view"), and streams each
// tab's frames as PNG files the terminal draws. One daemon serves every
// session; the first session's mod starts it, the next ones reuse it.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { snapshot } from './collect.mjs'

const PORT = Number(process.env.AGENTDECK_PORT || 47821)
const FPS = 8 // frames written per view per second, at most
const HERE = import.meta.dirname
const PAGE = fs.readFileSync(path.join(HERE, 'dashboard.html'), 'utf8')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-'))
const pushed = { crons: {}, cloud: null } // what the mods send: session crons, cloud routines

const CHROME = [
  process.env.AGENTDECK_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => p && fs.existsSync(p))

// ── Chrome over --remote-debugging-pipe: it exits when we do ──────────────

let chrome = null
let seq = 0
const pending = new Map()
const listeners = new Map() // CDP sessionId → (method, params) => void

function startChrome() {
  if (!CHROME) throw new Error('no Chrome/Chromium found (set AGENTDECK_CHROME)')
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${path.join(TMP, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  let buf = ''
  proc.stdio[4].on('data', chunk => {
    buf += chunk.toString('utf8')
    let i
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result)
      } else if (msg.method) listeners.get(msg.sessionId)?.(msg.method, msg.params)
    }
  })
  proc.on('exit', () => { chrome = null; for (const v of views.values()) v.target = null })
  chrome = proc
}

function cdp(method, params = {}, sessionId) {
  if (!chrome) startChrome()
  const id = ++seq
  chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
  return new Promise((ok, fail) => pending.set(id, { ok, fail }))
}

// ── views: one tab each ────────────────────────────────────────────────────

const views = new Map() // id → { session, width, height, scale, target, cdp, gen, file, subscribers, last, timer }

async function openTab(v) {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true })
  v.target = { targetId, sessionId }
  listeners.set(sessionId, (method, params) => {
    if (method !== 'Page.screencastFrame') return
    // The screencast only says the page changed; its frames are 1x, so the
    // picture itself is a screenshot at the view's device scale.
    void cdp('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId)
    v.dirty = true
    schedule(v)
  })
  await cdp('Page.enable', {}, sessionId)
  // Headless paints a tab only while it counts as focused; every view is.
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
  await size(v)
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/?view=${encodeURIComponent(v.id)}` }, sessionId)
}

async function size(v) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: false }, v.target.sessionId)
  // Restart the screencast so the next frame has the new size.
  await cdp('Page.stopScreencast', {}, v.target.sessionId).catch(() => {})
  await cdp('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 64, maxHeight: 64 }, v.target.sessionId).catch(() => {})
}

function schedule(v) {
  if (!v.timer && !v.capturing) v.timer = setTimeout(() => void flush(v), Math.max(0, 1000 / FPS - (Date.now() - (v.wroteAt ?? 0))))
}

// Two files take turns, so the terminal never reads one half-written.
async function flush(v) {
  v.timer = null
  if (!v.dirty || !v.target) return
  v.dirty = false
  v.capturing = true
  try {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, v.target.sessionId)
    v.gen++
    v.file = path.join(TMP, `${v.id.replace(/[^\w-]/g, '_')}-${v.gen % 2}.png`)
    fs.writeFileSync(v.file, Buffer.from(data, 'base64'))
    v.wroteAt = Date.now()
    send(v, `frame ${v.gen} ${v.file}`)
  } catch { /* tab closing */ }
  v.capturing = false
  if (v.dirty) schedule(v)
}

const send = (v, line) => { for (const res of v.subscribers) res.write(line + '\n') }

async function upsertView({ id, session, width, height, scale = 2 }) {
  let v = views.get(id)
  const w = Math.round(Math.max(200, Math.min(2000, width)))
  const h = Math.round(Math.max(150, Math.min(2000, height)))
  if (!v) {
    v = { id, session, width: w, height: h, scale, target: null, gen: 0, file: null, subscribers: new Set(), dirty: false, capturing: false, timer: null }
    views.set(id, v)
  }
  const resized = v.width !== w || v.height !== h || v.scale !== scale
  Object.assign(v, { session, width: w, height: h, scale })
  if (!v.target) await openTab(v)
  else if (resized) await size(v)
  return v
}

async function closeView(id) {
  const v = views.get(id)
  if (!v) return
  views.delete(id)
  for (const res of v.subscribers) res.end()
  if (v.target) {
    listeners.delete(v.target.sessionId)
    await cdp('Target.closeTarget', { targetId: v.target.targetId }).catch(() => {})
  }
}

// Pointer positions arrive as fractions of the pane's picture.
async function input(v, e) {
  if (!v.target) return
  const s = v.target.sessionId
  const x = Math.round((e.x ?? 0.5) * v.width)
  const y = Math.round((e.y ?? 0.5) * v.height)
  if (e.type === 'down' || e.type === 'up' || e.type === 'move') {
    const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[e.type]
    // Chrome hit-tests a press where the pointer last moved to.
    if (e.type === 'down') await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, s)
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: e.type === 'move' ? 'none' : 'left', clickCount: 1 }, s)
  } else if (e.type === 'wheel') {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: e.dy ?? 0 }, s)
  } else if (e.type === 'key') {
    await cdp('Runtime.evaluate', { expression: `window.deck && window.deck.key(${JSON.stringify(String(e.key))})` }, s)
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

const body = req => new Promise(ok => {
  let b = ''
  req.on('data', c => { b += c })
  req.on('end', () => { try { ok(JSON.parse(b || '{}')) } catch { ok({}) } })
})

const json = (res, value, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const view = url.searchParams.get('view')
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(PAGE)
    }
    if (url.pathname === '/ping') return json(res, { agentdeck: 1, views: views.size, chrome: CHROME ?? null })
    if (url.pathname === '/api/state') {
      const v = views.get(view)
      return json(res, snapshot(url.searchParams.get('session') || v?.session, pushed))
    }
    if (req.method === 'POST' && url.pathname === '/view') {
      const v = await upsertView(await body(req))
      return json(res, { id: v.id, width: v.width, height: v.height })
    }
    if (req.method === 'DELETE' && url.pathname === '/view') {
      await closeView(view)
      return json(res, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/input') {
      const v = views.get(view)
      if (v) await input(v, await body(req))
      return json(res, { ok: !!v })
    }
    if (req.method === 'POST' && url.pathname === '/push') {
      const p = await body(req)
      if (p.session && Array.isArray(p.crons)) pushed.crons[p.session] = p.crons.map(c => ({ ...c, session: p.sessionName ?? p.session.slice(0, 8) }))
      if (p.cloud) pushed.cloud = { at: Date.now(), ...p.cloud }
      return json(res, { ok: true })
    }
    // The page asks the mod for something only it can do (cloud routines).
    if (req.method === 'POST' && url.pathname === '/ask') {
      const v = views.get(view)
      if (v) send(v, `ask ${(await body(req)).what}`)
      return json(res, { ok: !!v })
    }
    // A pane's frame stream: one line per frame, `frame <gen> <png path>`.
    if (url.pathname === '/frames') {
      const v = views.get(view)
      if (!v) return json(res, { error: 'no such view' }, 404)
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      v.subscribers.add(res)
      if (v.file) res.write(`frame ${v.gen} ${v.file}\n`)
      req.on('close', () => {
        v.subscribers.delete(res)
        // A pane whose session went away leaves no reader: close its tab.
        setTimeout(() => { if (views.get(view) === v && !v.subscribers.size) void closeView(view) }, 10_000)
      })
      return
    }
    json(res, { error: 'not found' }, 404)
  } catch (err) {
    json(res, { error: String(err?.message ?? err) }, 500)
  }
})

server.on('error', err => {
  if (err.code === 'EADDRINUSE') { console.log('agentdeck already running'); process.exit(0) }
  throw err
})
server.listen(PORT, '127.0.0.1', () => console.log(`agentdeck on http://127.0.0.1:${PORT}`))

// With no pane open for a while, nobody needs us.
let idleSince = Date.now()
setInterval(() => {
  if (views.size) idleSince = Date.now()
  else if (Date.now() - idleSince > 120_000) process.exit(0)
}, 10_000).unref()

const bye = () => { chrome?.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(0) }
process.on('SIGTERM', bye)
process.on('SIGINT', bye)
process.on('SIGHUP', bye)
