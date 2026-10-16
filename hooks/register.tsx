import type { EngineInterface, Register, RenderChildren } from 'claude-code'
import { agentName, agentRows, ago, C, feedRows, line, routineRows, sessionRows, short, type Cloud, type Cron, type Seg, type Snapshot } from './deck'
import { flow, type Flow } from './flow'
import type { CanvasProps } from './canvas'
import type { OverlayProps } from './overlay'

// A side pane in three tabs. Agents: the agent graph painted in pixels, the
// agents as rows and the live tool feed. Sessions: every live session on the
// machine. Routines: cloud routines, loops, background jobs, scheduled tasks,
// launchd. The data comes from collector/feed.mjs, which reads ~/.claude.

const PANE = 'agentdeck'
const ANIM_MS = 350 // packets move while an agent works
type Tab = 'agents' | 'sessions' | 'routines'

const S = {
  open: false,
  tab: 'agents' as Tab,
  home: '', // this session
  shown: '', // the session the Agents tab shows
  snap: null as Snapshot | null,
  error: '',
  feed: null as AsyncIterator<unknown> | null,
  feedFor: '',
  sel: '', // an agent
  hover: '',
  cursor: 0, // Sessions tab
  top: 0, // Sessions / Routines scroll
  crons: [] as Cron[],
  cloud: null as Cloud | null,
  drawn: null as Flow | null,
  listed: [] as string[], // the agent rows on screen, top down
  box: { cols: 60, rows: 12 },
  anim: null as { cancel: () => void } | null,
  watch: null as { cancel: () => void } | null,
}
const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

// ── data ───────────────────────────────────────────────────────────────────

function follow($: EngineInterface) {
  if (S.feed && S.feedFor === S.shown) return
  void S.feed?.return?.(undefined)
  const session = S.shown
  const feed = $.process.spawn({ argv: ['node', `${$.plugin.root}/collector/feed.mjs`, session] })
  S.feed = feed
  S.feedFor = session
  void (async () => {
    let buf = ''
    try {
      for await (const { stream, text } of feed) {
        if (stream === 'stderr') { $.ui.log(`agentdeck feed: ${text.trim()}`, { to: 'debug' }); continue }
        buf += text
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          try { S.snap = JSON.parse(buf.slice(0, i)) as Snapshot; S.error = '' } catch { /* a cut line */ }
          buf = buf.slice(i + 1)
        }
        animate($)
        redraw($)
      }
    } catch (err) {
      S.error = `the collector did not start (needs node ≥ 22 on PATH): ${err}`
      redraw($)
    }
    if (S.feed === feed) S.feed = null
  })()
}

// Packets only move while someone works and the graph is on screen.
function animate($: EngineInterface) {
  const busy = S.open && S.tab === 'agents' && !!S.snap?.session?.agentList.some(a => a.status === 'working')
  if (busy && !S.anim) S.anim = $.clock.every(ANIM_MS, () => redraw($))
  else if (!busy && S.anim) { S.anim.cancel(); S.anim = null }
}

async function loadCrons($: EngineInterface) {
  try {
    const r = await $.tool.call({ tool: 'CronList' })
    if ('result' in r && r.result && !r.isError) S.crons = r.result.jobs.map(j => ({ id: j.id, prompt: j.prompt, schedule: j.humanSchedule || j.cron, recurring: j.recurring }))
  } catch { /* not offered in this session */ }
}

type Trigger = Record<string, unknown>
export function cloudItems(json: string) {
  const data = JSON.parse(json) as unknown
  const list = (Array.isArray(data) ? data : [data].flatMap(d => Object.values((d ?? {}) as Record<string, unknown>)).find(Array.isArray) ?? []) as Trigger[]
  return list.map(t => ({
    name: String(t.name ?? t.title ?? t.id ?? 'routine'),
    schedule: String(t.cron_expression ?? t.schedule ?? t.cron ?? ''),
    enabled: t.enabled !== false,
    detail: [t.next_run_at && `next ${t.next_run_at}`, t.last_run_at && `last ${t.last_run_at}`, t.description].filter(Boolean).join(' · ').slice(0, 160),
  }))
}

// Only on `r`: RemoteTrigger may ask for permission, so it runs when asked.
async function loadCloud($: EngineInterface) {
  S.cloud = { ...(S.cloud ?? {}), error: undefined }
  try {
    const r = await $.tool.call({ tool: 'RemoteTrigger', action: 'list' })
    if ('deny' in r && r.deny) S.cloud = { at: Date.now(), error: `not allowed: ${r.deny}` }
    else if (!r.result || r.isError) S.cloud = { at: Date.now(), error: 'RemoteTrigger failed (logged in to claude.ai?)' }
    else S.cloud = r.result.status >= 400 ? { at: Date.now(), error: `claude.ai answered ${r.result.status}` } : { at: Date.now(), items: cloudItems(r.result.json) }
  } catch (err) {
    S.cloud = { at: Date.now(), error: `RemoteTrigger is not available here: ${err}` }
  }
  redraw($)
}

function show($: EngineInterface, session: string) {
  S.shown = session
  S.sel = ''
  S.tab = 'agents'
  follow($)
}

async function key($: EngineInterface, k: string) {
  const ss = S.snap?.sessions ?? []
  if (k === '1') S.tab = 'agents'
  else if (k === '2') S.tab = 'sessions'
  else if (k === '3') S.tab = 'routines'
  else if (k === 'tab') S.tab = S.tab === 'agents' ? 'sessions' : S.tab === 'sessions' ? 'routines' : 'agents'
  else if (k === 'escape') { if (S.sel) S.sel = ''; else show($, S.home) }
  else if (k === 'r' && S.tab === 'routines') { void loadCrons($); void loadCloud($) }
  else if (S.tab === 'sessions' && (k === 'up' || k === 'k')) S.cursor = Math.max(0, S.cursor - 1)
  else if (S.tab === 'sessions' && (k === 'down' || k === 'j')) S.cursor = Math.min(ss.length - 1, S.cursor + 1)
  else if (S.tab === 'sessions' && k === 'return' && ss[S.cursor]) show($, ss[S.cursor]!.id)
  else if (S.tab === 'agents' && (k === 'up' || k === 'down')) {
    const list = S.snap?.session?.agentList ?? []
    const i = list.findIndex(a => a.id === S.sel)
    S.sel = list[Math.max(0, Math.min(list.length - 1, i + (k === 'up' ? -1 : 1)))]?.id ?? ''
  }
  animate($)
  redraw($)
}

async function openPane($: EngineInterface, tab?: Tab) {
  S.home ||= await $.session.id()
  S.shown ||= S.home
  if (tab) S.tab = tab
  S.open = true
  await $.ui.open({ id: PANE, title: 'Agent deck', focus: true, rows: 40, columns: 80 })
  follow($)
  void loadCrons($)
  S.watch ??= $.clock.every(5000, () => void (async () => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) return
    // Closed: stop reading and painting until it opens again.
    S.open = false
    S.watch?.cancel()
    S.watch = null
    animate($)
    const feed = S.feed
    S.feed = null
    await feed?.return?.(undefined)
  })())
}

// The picture goes to the terminal as a file it reads itself (two take turns),
// as in repograph; without a shell it goes inline.
const RUN_ID = Math.random().toString(36).slice(2, 8)
const pic = { key: '', ready: null as null | { file: string; width: number; height: number; generation: number }, gen: 0, inline: false, writing: false }
async function ensurePicture($: EngineInterface, img: Flow['image']) {
  if (pic.key === img.key || pic.inline || pic.writing) return
  pic.writing = true
  const gen = pic.gen + 1
  try {
    const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/$/, '')
    const file = `${tmp}/agentdeck-${RUN_ID}-${gen % 2}.rgba`
    const r = await $.process.run(['/bin/sh', '-c', 'base64 -d > "$1"', 'sh', file], { stdin: img.rgba, timeoutMs: 10_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr)
    pic.key = img.key
    pic.gen = gen
    pic.ready = { file, width: img.width, height: img.height, generation: gen }
  } catch {
    pic.inline = true
  } finally {
    pic.writing = false
  }
  redraw($)
}

// ── hooks ──────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'agentdeck', description: 'Agent deck: your agents, all sessions and routines in a side pane; args: [agents|sessions|routines]' })
    return r
  })

  on('command.run', { command: 'agentdeck' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    await openPane($, arg === 'sessions' || arg === 'routines' || arg === 'agents' ? arg : undefined)
    return { text: 'agentdeck: click the pane, then 1 agents · 2 sessions · 3 routines' }
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || !['graph', 'agents', 'feed', 'list'].includes(String(e.element)) || !e.data || typeof e.data !== 'object') return next(e)
    const data = e.data as { key?: string; press?: [number, number]; click?: [number, number]; hover?: [number, number] | null }
    if (typeof data.key === 'string') await key($, data.key)
    else if (data.press && e.element === 'graph') {
      const id = S.drawn?.hit(data.press[0], data.press[1]) ?? ''
      S.sel = id && id !== S.sel ? id : ''
      redraw($)
    } else if ('hover' in data && e.element === 'graph') {
      const id = data.hover ? (S.drawn?.hit(data.hover[0], data.hover[1]) ?? '') : ''
      if (id !== S.hover) { S.hover = id; redraw($) }
    } else if (data.click && e.element === 'agents') {
      const row = Math.floor(data.click[1])
      const a = S.snap?.session?.agentList.find(x => x.id === S.listed[row])
      S.sel = a && a.id !== S.sel ? a.id : ''
      redraw($)
    } else if (data.click && e.element === 'list' && S.tab === 'sessions') {
      const i = Math.floor((S.top + data.click[1]) / 2)
      const s = S.snap?.sessions[i]
      if (s && i === S.cursor) show($, s.id)
      else if (s) S.cursor = i
      redraw($)
    }
    return {}
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (S.tab !== 'agents') { S.top = Math.max(0, S.top + Math.sign(e.by) * 2); redraw($) }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button, Client, Image } = $.ui.resolve(e)
    const cols = Math.max(30, (e.props?.bodyColumns ?? 80) - 1)
    const height = Math.max(14, e.props?.scroll?.bodyRows ?? 36)
    const snap = S.snap
    const now = snap?.now ?? Date.now()
    const working = snap?.session?.agentList.filter(a => a.status === 'working').length ?? 0
    const busy = snap?.sessions.filter(s => s.status === 'busy').length ?? 0
    const tab = (id: Tab, label: string, k: string) => (
      <Button key={`tab-${id}`} plain dimColor={S.tab !== id} label={S.tab === id ? `[ ${label} ]` : `  ${label}  `} onPress={() => void key($, k)} />
    )
    const header = (
      <Box flexDirection="row">
        {tab('agents', working ? `Agents ${working}` : 'Agents', '1')}
        {tab('sessions', snap ? `Sessions ${busy}/${snap.sessions.length}` : 'Sessions', '2')}
        {tab('routines', 'Routines', '3')}
        <Box flexGrow={1} />
        {S.tab === 'routines' ? <Button key="reload" plain dimColor label="↻" onPress={() => void key($, 'r')} /> : <Text color={snap ? C.ok : C.muted}>{snap ? '●' : '○'}</Text>}
      </Box>
    )
    const frame = (...body: RenderChildren[]) => (
      <Box flexDirection="column" minHeight={height}>
        {header}
        {body}
      </Box>
    )
    const rowsOf = (key: string, rows: Seg[][]) => <Client key={key} module="./canvas.tsx" props={{ rows } satisfies CanvasProps} />
    const hint = (t: string) => <Text color={C.muted} wrap="truncate-end">{t}</Text>

    if (!snap) return frame(<Text color={S.error ? C.err : C.muted}>{S.error || 'Reading your sessions…'}</Text>)

    if (S.tab === 'sessions') {
      const view = Math.max(2, height - 2)
      const all = sessionRows(snap.sessions, now, cols, S.shown, S.home, S.cursor)
      S.top = Math.max(0, Math.min(S.top, Math.max(0, all.length - view)))
      if (S.cursor * 2 < S.top) S.top = S.cursor * 2
      if (S.cursor * 2 + 2 > S.top + view) S.top = S.cursor * 2 + 2 - view
      return frame(rowsOf('list', all.slice(S.top, S.top + view)), <Box flexGrow={1} />, hint('↑↓ pick · enter or click twice: show its agents · esc: this session'))
    }

    if (S.tab === 'routines') {
      const view = Math.max(2, height - 2)
      const all = routineRows(snap.routines, S.crons, S.cloud, now, cols)
      S.top = Math.max(0, Math.min(S.top, Math.max(0, all.length - view)))
      return frame(rowsOf('list', all.slice(S.top, S.top + view)), <Box flexGrow={1} />, hint('r: reload cloud routines and loops · wheel: scroll'))
    }

    // Agents tab.
    const d = snap.session
    if (!d) return frame(<Text color={C.muted}>{S.shown === S.home ? 'This session shows up after its first prompt.' : 'That session has ended.'}</Text>, <Box flexGrow={1} />, hint('2: sessions · esc: this session'))
    const busyNow = d.status === 'busy'
    const title = (
      <Box flexDirection="row">
        <Text color={busyNow ? C.hot : C.muted}>{busyNow ? '● ' : '○ '}</Text>
        <Text bold color={C.white} wrap="truncate-end">{d.name}</Text>
        <Text color={C.muted} wrap="truncate-start">{`  ${d.cwd}`}</Text>
        <Box flexGrow={1} />
        <Text color={C.muted}>{`${d.agentList.length} agents · ${d.agentList.reduce((n, a) => n + a.calls, 0)} calls`}</Text>
        {S.shown !== S.home ? <Button key="home" plain dimColor label="  ⌂" onPress={() => void key($, 'escape')} /> : null}
      </Box>
    )
    const agentsN = Math.min(d.agentList.length, Math.max(2, Math.floor(height / 6)))
    const graphRows = Math.max(8, Math.min(28, Math.floor((height - 6 - agentsN) * 0.6)))
    const feedN = Math.max(2, height - 6 - agentsN - graphRows)
    S.box = { cols, rows: graphRows }
    if (S.sel && !d.agentList.some(a => a.id === S.sel)) S.sel = ''
    const f = flow(d, Date.now(), cols, graphRows, S.sel, S.hover)
    S.drawn = f
    void ensurePicture($, f.image)
    const source = pic.inline ? { rgba: f.image.rgba, width: f.image.width, height: f.image.height } : pic.ready ? { ...pic.ready, format: 'rgba' as const } : null
    const sel = d.agentList.find(a => a.id === S.sel)
    const detail = sel
      ? line([{ t: '▸ ', c: C.hot }, { t: agentName(sel) + ' ', c: C.white, b: true }, { t: sel.description ? sel.description + ' · ' : '', c: C.fg }, { t: sel.lastText, c: C.dim }], cols, { t: `${Math.round(sel.tokensOut / 100) / 10}k tok · ${ago(sel.firstAt, now)}`, c: C.muted })
      : line([{ t: f.hidden ? `+${f.hidden} older agents not drawn · ` : '', c: C.muted }, { t: 'click a node or row for details', c: C.muted }], cols)
    // The agent list keeps the selected and the working ones in view.
    const rows = agentRows(d, now, cols, S.sel)
    const order = d.agentList.map((a, i) => ({ a, i })).sort((x, y) => Number(y.a.id === S.sel) - Number(x.a.id === S.sel) || Number(y.a.status === 'working') - Number(x.a.status === 'working') || x.i - y.i).slice(0, agentsN).sort((x, y) => x.i - y.i)
    S.listed = order.map(o => o.a.id)
    return frame(
      title,
      <Box key="stage" position="relative" width={cols} height={graphRows}>
        {source ? <Image key="flow-image" source={source} columns={cols} rows={graphRows} alt="agent graph" /> : <Box width={cols} height={graphRows} />}
        {f.labels.map((l, i) => (
          <Box key={`l${i}`} position="absolute" top={l.y} left={l.x}>
            <Text color={l.color} bold={l.bold}>{l.text}</Text>
          </Box>
        ))}
        <Box key="hit" position="absolute" top={0} left={0}>
          <Client key="graph" module="./overlay.tsx" props={{ cols, rows: graphRows } satisfies OverlayProps} />
        </Box>
      </Box>,
      rowsOf('detail', [detail]),
      rowsOf('agents', order.map(o => rows[o.i]!)),
      <Text color={C.muted} wrap="truncate-end">{`─ live ${'─'.repeat(Math.max(0, cols - 7))}`}</Text>,
      rowsOf('feed', feedRows(d, now, cols, feedN)),
      <Box flexGrow={1} />,
      hint(`1 agents · 2 sessions · 3 routines · ↑↓ agent · esc ${S.shown !== S.home ? 'this session' : 'clear'} · ${short(d.id, 8)}`),
    )
  })
}
