// Reads what Claude Code already writes to ~/.claude: the live sessions, their
// transcripts and their subagents' transcripts, background jobs, scheduled
// tasks and the user's launchd jobs. Nothing here writes to ~/.claude.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = os.homedir()
const CLAUDE = process.env.AGENTDECK_CLAUDE_DIR || path.join(HOME, '.claude')
const FIRST_READ = 4 << 20 // a transcript's first read takes its last 4 MiB
const KEEP_CALLS = 400 // per agent

// ── tool calls → what kind of work they are ────────────────────────────────

const BUILD = /\b((npm|pnpm|yarn|bun) (run )?build|tsc|make|cmake|cargo (build|check)|xcodebuild|swift build|gradlew?|esbuild|vite build|next build|webpack|go build)\b/
const TEST = /\b((npm|pnpm|yarn|bun) (run )?test|jest|vitest|pytest|go test|cargo test|playwright|gate\.sh|xcodebuild test|swift test|plugin test|node --test|mocha|rspec|phpunit)\b/
const GIT = /^\s*(cd [^&;]+(&&|;)\s*)?(git|gh)\b/

export function category(name, input = {}) {
  const n = name.toLowerCase()
  if (n === 'websearch' || /search_(web|docs|documentation)|web_search|exa|tavily|perplexity/.test(n)) return 'search'
  if (n === 'webfetch' || /navigate|fetch_?url|crawl|scrape|firecrawl|web_fetch/.test(n)) return 'crawl'
  if (/computer|screenshot|click|type_text|press_key|simulator|simpane|take_snapshot|drag|hover|fill_form/.test(n)) return 'computer'
  if (['edit', 'write', 'multiedit', 'notebookedit'].includes(n)) return 'edit'
  if (['read', 'grep', 'glob', 'ls'].includes(n)) return 'read'
  if (['agent', 'task', 'sendmessage', 'workflow'].includes(n)) return 'agent'
  if (n === 'bash' || n === 'powershell') {
    const c = String(input.command ?? '')
    if (TEST.test(c)) return 'test'
    if (BUILD.test(c)) return 'build'
    if (GIT.test(c)) return 'git'
    return 'shell'
  }
  if (n.startsWith('mcp__')) return 'mcp'
  return 'other'
}

const clip = (s, n = 90) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
const short = p => clip(String(p ?? '').replace(HOME, '~').split('/').slice(-3).join('/'), 70)

export function summary(name, input = {}) {
  switch (name) {
    case 'Bash': return clip(input.description || input.command)
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return short(input.file_path || input.notebook_path)
    case 'Grep': return clip(`/${input.pattern}/ ${input.path ? short(input.path) : ''}`)
    case 'Glob': return clip(input.pattern)
    case 'WebSearch': return clip(`“${input.query}”`)
    case 'WebFetch': return clip(String(input.url ?? '').replace(/^https?:\/\//, ''))
    case 'Agent': case 'Task': return clip(`${input.subagent_type || 'agent'}: ${input.description || ''}`)
    case 'Skill': return clip(input.skill)
    case 'TodoWrite': return `${(input.todos ?? []).length} todos`
  }
  if (name.startsWith('mcp__')) {
    const tool = name.split('__').slice(2).join('__')
    const arg = input.url || input.query || input.uid || input.text || input.path || ''
    return clip(`${tool}${arg ? ' ' + arg : ''}`)
  }
  const first = Object.values(input).find(v => typeof v === 'string')
  return clip(first ?? '')
}

export const toolLabel = name => name.startsWith('mcp__') ? name.split('__').slice(1, 3).join(' · ').replace(/^claude_ai_|^plugin_[^_]+_/, '') : name

// ── one transcript, read incrementally ─────────────────────────────────────

function newAgent(id) {
  return { id, calls: new Map(), order: [], model: '', tokensOut: 0, firstAt: 0, lastAt: 0, lastText: '', files: new Map() }
}

/** Folds transcript lines into an agent record. Exported for the tests. */
export function fold(agent, lines) {
  for (const line of lines) {
    if (!line) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    const at = Date.parse(d.timestamp ?? '') || 0
    if (at) {
      agent.firstAt ||= at
      agent.lastAt = Math.max(agent.lastAt, at)
    }
    const m = d.message
    if (!m || !Array.isArray(m.content)) continue
    if (d.type === 'assistant') {
      if (m.model && m.model !== '<synthetic>') agent.model = m.model
      agent.tokensOut += m.usage?.output_tokens ?? 0
      for (const b of m.content) {
        if (b.type === 'text' && b.text?.trim()) agent.lastText = clip(b.text, 160)
        if (b.type !== 'tool_use' || agent.calls.has(b.id)) continue
        const input = b.input ?? {}
        const call = { id: b.id, name: b.name, cat: category(b.name, input), text: summary(b.name, input), start: at, end: 0, err: false }
        agent.calls.set(b.id, call)
        agent.order.push(b.id)
        if (call.cat === 'edit') {
          const f = input.file_path || input.notebook_path
          if (f) agent.files.set(f, { path: f, n: (agent.files.get(f)?.n ?? 0) + 1, at })
        }
        if (agent.order.length > KEEP_CALLS) agent.calls.delete(agent.order.shift())
      }
    } else if (d.type === 'user') {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue
        const call = agent.calls.get(b.tool_use_id)
        if (call && !call.end) {
          call.end = at || call.start
          call.err = !!b.is_error
        }
      }
    }
  }
  return agent
}

const tails = new Map() // file → { offset, rest, agent }

function readAgent(file, id) {
  let t = tails.get(file)
  let size
  try { size = fs.statSync(file).size } catch { return t?.agent ?? null }
  if (!t || size < t.offset) {
    t = { offset: Math.max(0, size - FIRST_READ), rest: '', agent: newAgent(id), skipFirst: size > FIRST_READ }
    tails.set(file, t)
  }
  if (size > t.offset) {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - t.offset)
    fs.readSync(fd, buf, 0, buf.length, t.offset)
    fs.closeSync(fd)
    t.offset = size
    const lines = (t.rest + buf.toString('utf8')).split('\n')
    t.rest = lines.pop() ?? ''
    if (t.skipFirst) { lines.shift(); t.skipFirst = false } // cut mid-line
    fold(t.agent, lines)
  }
  return t.agent
}

// ── sessions ───────────────────────────────────────────────────────────────

const alive = pid => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

const transcriptOf = new Map()
function findTranscript(sessionId, cwd) {
  if (transcriptOf.has(sessionId)) return transcriptOf.get(sessionId)
  const projects = path.join(CLAUDE, 'projects')
  const guess = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
  let found = fs.existsSync(guess) ? guess : null
  if (!found) {
    for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
      const f = path.join(projects, dir.name, `${sessionId}.jsonl`)
      if (dir.isDirectory() && fs.existsSync(f)) { found = f; break }
    }
  }
  if (found) transcriptOf.set(sessionId, found)
  return found
}

function liveSessions() {
  const dir = path.join(CLAUDE, 'sessions')
  const out = []
  for (const f of safeList(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (s.sessionId && alive(s.pid)) out.push(s)
    } catch { /* being written */ }
  }
  return out
}

const safeList = dir => { try { return fs.readdirSync(dir) } catch { return [] } }

function sessionAgents(s) {
  const file = findTranscript(s.sessionId, s.cwd ?? '')
  if (!file) return []
  const main = readAgent(file, 'main')
  if (!main) return []
  const agents = [{ ...main, type: 'main', description: s.name || 'main', parentId: null, background: false }]
  const sub = path.join(path.dirname(file), s.sessionId, 'subagents')
  for (const f of safeList(sub)) {
    if (!f.endsWith('.jsonl')) continue
    const id = f.slice('agent-'.length, -'.jsonl'.length)
    const a = readAgent(path.join(sub, f), id)
    if (!a) continue
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(path.join(sub, `agent-${id}.meta.json`), 'utf8')) } catch {}
    agents.push({ ...a, type: meta.agentType || 'agent', description: meta.description || '', spawnCall: meta.toolUseId, parentId: null, background: meta.requestShape === 'background' })
  }
  // A subagent's parent is the agent whose Agent call started it.
  for (const a of agents) {
    if (!a.spawnCall) continue
    const parent = agents.find(p => p.calls.has(a.spawnCall))
    a.parentId = parent?.id ?? 'main'
    a.returned = !!parent?.calls.get(a.spawnCall)?.end && !a.background
  }
  return agents
}

function agentStatus(a, s, now) {
  const open = [...a.calls.values()].some(c => !c.end && now - c.start < 30 * 60e3)
  if (a.type === 'main') return s.status === 'busy' ? 'working' : open ? 'waiting' : 'idle'
  if (a.returned) return 'done'
  if (open || now - a.lastAt < 20e3) return 'working'
  return now - a.lastAt < 5 * 60e3 ? 'idle' : 'done'
}

const CATS = ['search', 'crawl', 'edit', 'read', 'build', 'test', 'git', 'shell', 'computer', 'agent', 'mcp', 'other']

function spark(agents, now, span = 10 * 60e3, buckets = 24) {
  const bins = Array.from({ length: buckets }, () => ({}))
  for (const a of agents) for (const c of a.calls.values()) {
    const i = Math.floor((c.start - (now - span)) / (span / buckets))
    if (i >= 0 && i < buckets) bins[i][c.cat] = (bins[i][c.cat] ?? 0) + 1
  }
  return bins
}

const callOut = (c, agentId) => ({ ...c, agentId, tool: toolLabel(c.name) })

function sessionSummary(s, now) {
  const agents = sessionAgents(s)
  const current = agents.flatMap(a => [...a.calls.values()].filter(c => !c.end).map(c => callOut(c, a.id))).sort((x, y) => y.start - x.start)[0] ?? null
  const statuses = agents.map(a => agentStatus(a, s, now))
  return {
    id: s.sessionId, pid: s.pid, name: s.name || s.sessionId.slice(0, 8), cwd: (s.cwd ?? '').replace(HOME, '~'), kind: s.kind, status: s.status,
    since: s.statusUpdatedAt || s.startedAt, startedAt: s.startedAt,
    agents: agents.length, active: statuses.filter(x => x === 'working').length,
    current, spark: spark(agents, now), tokensOut: agents.reduce((n, a) => n + a.tokensOut, 0),
    lastAt: Math.max(0, ...agents.map(a => a.lastAt)),
  }
}

function sessionDetail(s, now) {
  const agents = sessionAgents(s)
  const counts = {}
  const out = agents.map(a => {
    const calls = [...a.calls.values()]
    const byCat = {}
    for (const c of calls) {
      byCat[c.cat] = (byCat[c.cat] ?? 0) + 1
      counts[c.cat] = (counts[c.cat] ?? 0) + 1
    }
    const open = calls.filter(c => !c.end).sort((x, y) => y.start - x.start)[0]
    const last = calls[calls.length - 1]
    return {
      id: a.id, type: a.type, description: a.description, model: a.model, parentId: a.parentId, background: a.background,
      status: agentStatus(a, s, now), tokensOut: a.tokensOut, firstAt: a.firstAt, lastAt: a.lastAt, lastText: a.lastText,
      calls: calls.length, byCat, current: open ? callOut(open, a.id) : null, last: last ? callOut(last, a.id) : null,
      lane: calls.filter(c => (c.end || now) > now - 5 * 60e3).map(c => ({ cat: c.cat, start: c.start, end: c.end, err: c.err })),
    }
  })
  const events = agents.flatMap(a => [...a.calls.values()].slice(-60).map(c => callOut(c, a.id))).sort((x, y) => y.start - x.start).slice(0, 60)
  const files = agents.flatMap(a => [...a.files.values()].map(f => ({ ...f, path: f.path.replace(HOME, '~'), agentId: a.id }))).sort((x, y) => y.at - x.at).slice(0, 30)
  return { ...sessionSummary(s, now), agentList: out, events, files, counts }
}

// ── routines ───────────────────────────────────────────────────────────────

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' } }

function describeCalendar(c) {
  const list = Array.isArray(c) ? c : [c]
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return list.slice(0, 3).map(x => {
    const t = x.Hour != null ? `${String(x.Hour).padStart(2, '0')}:${String(x.Minute ?? 0).padStart(2, '0')}` : x.Minute != null ? `:${String(x.Minute).padStart(2, '0')} hourly` : ''
    return `${x.Weekday != null ? days[x.Weekday % 7] + ' ' : x.Day != null ? `day ${x.Day} ` : 'daily '}${t}`.trim()
  }).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '')
}

const every = s => s % 86400 === 0 ? `every ${s / 86400}d` : s % 3600 === 0 ? `every ${s / 3600}h` : s % 60 === 0 ? `every ${s / 60}m` : `every ${s}s`

export function launchdJobs() {
  const dir = path.join(HOME, 'Library', 'LaunchAgents')
  const status = new Map()
  for (const line of sh('launchctl', ['list']).split('\n').slice(1)) {
    const [pid, exit, label] = line.split('\t')
    if (label) status.set(label, { pid: pid === '-' ? null : Number(pid), exit: Number(exit) })
  }
  const out = []
  for (const f of safeList(dir)) {
    if (!f.endsWith('.plist')) continue
    let p
    try { p = JSON.parse(sh('plutil', ['-convert', 'json', '-o', '-', path.join(dir, f)])) } catch { continue }
    const prog = [p.Program, ...(p.ProgramArguments ?? [])].filter(Boolean).join(' ')
    const bin = [p.Program, ...(p.ProgramArguments ?? [])].filter(Boolean).slice(0, 2).join(' ')
    if (!bin.includes(HOME) || bin.includes(`${HOME}/Library/`)) continue // vendor agents
    const st = status.get(p.Label)
    const schedule = p.StartCalendarInterval ? describeCalendar(p.StartCalendarInterval) : p.StartInterval ? every(p.StartInterval) : p.KeepAlive ? 'always on' : p.RunAtLoad ? 'at login' : 'on demand'
    out.push({
      label: p.Label, schedule, program: clip(prog.replace(new RegExp(HOME, 'g'), '~'), 80),
      loaded: !!st, running: !!st?.pid, lastExit: st?.exit ?? null,
      log: p.StandardOutPath ? lastLine(p.StandardOutPath) : '',
    })
  }
  return out
}

function lastLine(file) {
  try {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(size, 2048))
    fs.readSync(fd, buf, 0, buf.length, size - buf.length)
    fs.closeSync(fd)
    return clip(buf.toString('utf8').trim().split('\n').pop(), 100)
  } catch { return '' }
}

function scheduledTasks() {
  const dir = path.join(CLAUDE, 'scheduled-tasks')
  return safeList(dir).map(name => {
    let description = ''
    try {
      const md = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8')
      description = clip(md.match(/^description:\s*(.*)$/m)?.[1] ?? '', 120)
    } catch {}
    return { name, description }
  })
}

function backgroundJobs(live) {
  const dir = path.join(CLAUDE, 'jobs')
  const out = []
  for (const id of safeList(dir)) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(dir, id, 'state.json'), 'utf8'))
      const mtime = fs.statSync(path.join(dir, id, 'state.json')).mtimeMs
      const session = live.find(s => s.sessionId.startsWith(id))
      out.push({ id, state: st.state, detail: clip(st.detail, 120), needs: clip(st.needs, 140), tokens: st.tokens ?? 0, name: session?.name ?? id, live: !!session, at: mtime })
    } catch {}
  }
  return out.sort((a, b) => b.at - a.at)
}

let routinesCache = { at: 0, value: null }
export function routines(live, pushed) {
  const now = Date.now()
  if (!routinesCache.value || now - routinesCache.at > 15e3) {
    routinesCache = { at: now, value: { launchd: launchdJobs(), scheduled: scheduledTasks() } }
  }
  return {
    ...routinesCache.value,
    jobs: backgroundJobs(live),
    crons: Object.values(pushed.crons).flat(),
    cloud: pushed.cloud,
  }
}

// ── the whole picture ──────────────────────────────────────────────────────

export function snapshot(sessionId, pushed = { crons: {}, cloud: null }) {
  const now = Date.now()
  const live = liveSessions()
  const sessions = live.map(s => sessionSummary(s, now)).sort((a, b) => (b.status === 'busy') - (a.status === 'busy') || b.lastAt - a.lastAt)
  const s = live.find(x => x.sessionId === sessionId)
  return { now, sessionId, sessions, session: s ? sessionDetail(s, now) : null, routines: routines(live, pushed), cats: CATS }
}
