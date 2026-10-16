// What collector/feed.mjs sends, and the coloured text rows the pane draws
// from it (the same row format repograph's canvas draws).

export type Seg = { t: string; c?: string; b?: boolean; bg?: string }

export type Call = { id: string; name: string; tool: string; cat: string; text: string; start: number; end: number; err: boolean; agentId: string }
export type Agent = {
  id: string; type: string; description: string; model: string; parentId: string | null; background: boolean
  status: 'working' | 'waiting' | 'idle' | 'done'; tokensOut: number; firstAt: number; lastAt: number; lastText: string
  calls: number; byCat: Record<string, number>; current: Call | null; last: Call | null
}
export type Session = {
  id: string; pid: number; name: string; cwd: string; kind: string; status: string; since: number; startedAt: number
  agents: number; active: number; current: Call | null; spark: Record<string, number>[]; tokensOut: number; lastAt: number
}
export type Detail = Session & { agentList: Agent[]; events: Call[]; files: { path: string; n: number; at: number; agentId: string }[]; counts: Record<string, number> }
export type Cron = { id: string; prompt: string; schedule: string; recurring?: boolean; session?: string }
export type Cloud = { at?: number; items?: { name: string; schedule: string; enabled: boolean; detail: string }[]; error?: string }
export type Routines = {
  launchd: { label: string; schedule: string; program: string; loaded: boolean; running: boolean; lastExit: number | null; log: string }[]
  scheduled: { name: string; description: string }[]
  jobs: { id: string; state: string; detail: string; needs: string; tokens: number; name: string; live: boolean; at: number }[]
}
export type Snapshot = { now: number; sessionId: string; sessions: Session[]; session: Detail | null; routines: Routines }

export const C = { fg: '#dadada', muted: '#6b6b76', dim: '#8a8a99', hot: '#a882ff', ok: '#98c379', warn: '#e5c07b', err: '#e06c75', sel: '#2e2a3d', white: '#ffffff' }
export const CAT: Record<string, string> = {
  search: '#61afef', crawl: '#53dfdd', edit: '#e5c07b', read: '#8a8fa6', build: '#d19a66', test: '#98c379',
  git: '#e06c75', shell: '#c3a6ff', computer: '#ff79c6', agent: '#a882ff', mcp: '#56b6c2', other: '#6e6e7c',
}
export const STATUS: Record<string, string> = { working: C.hot, busy: C.hot, waiting: C.warn, idle: C.muted, done: C.ok }

export const short = (s: string, n: number) => (n <= 0 ? '' : s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s)
export const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}
export const dur = (ms: number) => (ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : ms < 60e3 ? `${(ms / 1000).toFixed(ms < 10e3 ? 1 : 0)}s` : `${Math.floor(ms / 60e3)}m${String(Math.round((ms % 60e3) / 1000)).padStart(2, '0')}`)
export const model = (m: string) => m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1')
export const agentName = (a: Pick<Agent, 'type'>) => (a.type === 'main' ? 'main' : a.type.replace(/^.*:/, ''))

/** One row `cols` wide: the left segments cut to fit, `right` flush right. */
export function line(left: Seg[], cols: number, right?: Seg, bg?: string): Seg[] {
  const room = cols - (right ? right.t.length + 1 : 0)
  const out: Seg[] = []
  let used = 0
  for (const s of left) {
    if (used >= room) break
    const t = short(s.t, room - used)
    out.push({ ...s, t })
    used += t.length
  }
  const pad = cols - used - (right?.t.length ?? 0)
  if (pad > 0) out.push({ t: ' '.repeat(pad) })
  if (right) out.push(right)
  return bg ? out.map(s => ({ ...s, bg })) : out
}

const BARS = '▁▂▃▄▅▆▇█'
export function spark(bins: Record<string, number>[]): Seg[] {
  const totals = bins.map(b => Object.values(b).reduce((x, y) => x + y, 0))
  const max = Math.max(1, ...totals)
  return bins.map((b, i) => {
    const n = totals[i]!
    if (!n) return { t: '·', c: '#3a3a44' }
    const top = Object.entries(b).sort((x, y) => y[1] - x[1])[0]![0]
    return { t: BARS[Math.min(7, Math.ceil((n / max) * 8) - 1)]!, c: CAT[top] ?? C.dim }
  })
}

export function agentRows(d: Detail, now: number, cols: number, sel: string): Seg[][] {
  return d.agentList.map(a => {
    const call = a.current ?? a.last
    const right = a.current ? { t: dur(now - a.current.start), c: C.hot } : { t: a.lastAt ? ago(a.lastAt, now) : '', c: C.muted }
    return line([
      { t: a.status === 'working' ? '● ' : a.status === 'done' ? '✓ ' : '○ ', c: STATUS[a.status] },
      { t: short(agentName(a), 14).padEnd(15), c: a.status === 'done' ? C.dim : C.fg, b: a.id === sel || a.status === 'working' },
      ...(call ? [{ t: call.tool + ' ', c: CAT[call.cat], b: !!a.current }, { t: call.text, c: a.current ? C.fg : C.muted }] : [{ t: 'no tool calls yet', c: C.muted }]),
    ], cols, right, a.id === sel ? C.sel : undefined)
  })
}

export function feedRows(d: Detail, now: number, cols: number, n: number): Seg[][] {
  const names = new Map(d.agentList.map(a => [a.id, agentName(a)]))
  return d.events.slice(0, n).map(e => line([
    { t: '▍', c: CAT[e.cat] },
    { t: short(e.tool, 9).padEnd(10), c: CAT[e.cat], b: !e.end },
    { t: short(names.get(e.agentId) ?? '', 10) + ' ', c: C.muted },
    { t: e.text, c: e.err ? C.err : e.end ? C.dim : C.fg },
  ], cols, e.end ? { t: dur(e.end - e.start), c: C.muted } : { t: '● ' + dur(now - e.start), c: C.hot }))
}

/** Two rows per session; the one shown in the Agents tab is marked. */
export function sessionRows(ss: Session[], now: number, cols: number, shown: string, home: string, cursor: number): Seg[][] {
  return ss.flatMap((s, i) => {
    const bg = i === cursor ? C.sel : undefined
    const busy = s.status === 'busy'
    const sp = spark(cols < 60 ? s.spark.slice(-12) : s.spark)
    const head = line([
      { t: busy ? '● ' : '○ ', c: busy ? C.hot : C.muted },
      { t: s.name, c: s.id === shown ? C.white : C.fg, b: s.id === shown || busy },
      { t: s.id === home ? '  (this)' : '', c: C.hot },
      { t: s.kind === 'bg' ? '  bg' : '', c: C.muted },
    ], Math.max(10, cols - sp.length - 1), { t: `${s.active}/${s.agents} `, c: s.active ? C.hot : C.muted })
    const now_ = s.current
      ? [{ t: '  ' + s.current.tool + ' ', c: CAT[s.current.cat], b: true }, { t: s.current.text, c: C.fg }]
      : [{ t: `  ${s.cwd}`, c: C.muted }, { t: s.lastAt ? ` · ${ago(s.lastAt, now)} ago` : '', c: C.muted }]
    return [[...head, { t: ' ' }, ...sp].map(x => (bg ? { ...x, bg } : x)), line(now_, cols, undefined, bg)]
  })
}

export function routineRows(r: Routines, crons: Cron[], cloud: Cloud | null, now: number, cols: number): Seg[][] {
  const rows: Seg[][] = []
  const head = (t: string, hint = '') => { rows.push([]); rows.push(line([{ t, c: C.hot, b: true }], cols, hint ? { t: hint, c: C.muted } : undefined)) }
  const row = (dot: string, color: string, name: string, when: string, sub: string) => {
    rows.push(line([{ t: dot + ' ', c: color }, { t: name, c: C.fg, b: true }], cols, when ? { t: when, c: C.dim } : undefined))
    if (sub) rows.push(line([{ t: '  ' + sub, c: C.muted }], cols))
  }
  head('Cloud routines', cloud?.at ? `${ago(cloud.at, now)} ago · r refresh` : 'r to load')
  if (cloud?.items?.length) for (const t of cloud.items) row(t.enabled ? '●' : '○', t.enabled ? C.ok : C.muted, t.name, t.schedule, t.detail)
  else rows.push(line([{ t: cloud?.error ?? (cloud ? 'none' : 'not loaded yet: press r (asks RemoteTrigger)'), c: cloud?.error ? C.err : C.muted }], cols))
  head('Loops & crons', 'this session')
  if (crons.length) for (const c of crons) row('●', C.ok, short(c.prompt || c.id, 40), c.schedule, c.recurring === false ? 'once' : '')
  else rows.push(line([{ t: 'none (/loop, CronCreate)', c: C.muted }], cols))
  head('Background jobs', 'claude --bg')
  if (r.jobs.length) for (const j of r.jobs.slice(0, 10)) row(j.state === 'blocked' ? '●' : j.live ? '●' : '○', j.state === 'blocked' ? C.err : j.state === 'working' || j.state === 'running' ? C.hot : j.live ? C.ok : C.muted, j.name, j.state, `${j.needs ? 'needs: ' + j.needs : j.detail} · ${ago(j.at, now)} ago`)
  else rows.push(line([{ t: 'none', c: C.muted }], cols))
  head('Scheduled tasks', '~/.claude/scheduled-tasks')
  if (r.scheduled.length) for (const t of r.scheduled) row('●', C.ok, t.name, '', t.description)
  else rows.push(line([{ t: 'none', c: C.muted }], cols))
  head('launchd', '~/Library/LaunchAgents')
  if (r.launchd.length) for (const j of r.launchd) row('●', j.running ? C.hot : !j.loaded ? C.muted : j.lastExit === 0 ? C.ok : C.err, j.label, j.schedule, `${j.loaded ? (j.running ? 'running' : `last exit ${j.lastExit}`) : 'not loaded'}${j.log ? ' · ' + j.log : ''}`)
  else rows.push(line([{ t: 'none of your own', c: C.muted }], cols))
  return rows.slice(1)
}
