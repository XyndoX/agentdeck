import type { EngineInterface, Register } from 'claude-code'
import type { OverlayProps } from './overlay'

// The pane shows pictures of a dashboard page that a small local daemon
// renders in headless Chrome (daemon/server.mjs). This module starts the
// daemon if no session has yet, asks it for a view the pane's size, follows
// the view's frames, and passes clicks, keys and the wheel back to the page.

const PANE = 'agentdeck'
const PORT = 47821
const BASE = `http://127.0.0.1:${PORT}`
const CSS_PER_COL = 8 // the page's CSS pixels per terminal column
const C = { muted: '#6b6b76', err: '#f07178' }

const S = {
  open: false,
  view: '',
  session: '',
  sessionName: '',
  aspect: 2.1, // a terminal cell's height over its width; `/agentdeck aspect 2.2` tunes it
  size: { cols: 0, rows: 0 },
  frame: null as { file: string; generation: number } | null,
  stream: null as AsyncIterator<unknown> | null,
  watch: null as { cancel: () => void } | null,
  status: 'starting the dashboard…',
}
const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')
const sleep = ($: EngineInterface, ms: number) => new Promise(ok => $.clock.after(ms, () => ok(null)))

const curl = ($: EngineInterface, method: string, path: string, body?: unknown) =>
  $.process.run(['curl', '-sf', '-m', '4', '-X', method, '-H', 'content-type: application/json', '--data-binary', '@-', BASE + path], { stdin: JSON.stringify(body ?? {}), timeoutMs: 6000 })
    .catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))

const ping = async ($: EngineInterface) => (await $.process.run(['curl', '-sf', '-m', '1', `${BASE}/ping`], { timeoutMs: 3000 }).catch(() => ({ exitCode: 1 }))).exitCode === 0

async function ensureDaemon($: EngineInterface) {
  if (await ping($)) return true
  // The child lives as long as this loop: the module's life, or the daemon's.
  void (async () => {
    try {
      const daemon = $.process.spawn({ argv: ['node', `${$.plugin.root}/daemon/server.mjs`], env: { AGENTDECK_PORT: String(PORT) } })
      for await (const { text } of daemon) $.ui.log(`agentdeck daemon: ${text.trim()}`, { to: 'debug' })
    } catch (err) {
      S.status = `could not start the daemon (needs node ≥ 22 on PATH): ${err}`
      redraw($)
    }
  })()
  for (let i = 0; i < 30; i++) {
    await sleep($, 200)
    if (await ping($)) return true
  }
  return false
}

const pixels = () => ({ width: S.size.cols * CSS_PER_COL, height: Math.round(S.size.rows * CSS_PER_COL * S.aspect) })

async function sendView($: EngineInterface) {
  if (!S.size.cols) return false
  const r = await curl($, 'POST', '/view', { id: S.view, session: S.session, scale: 2, ...pixels() })
  return r.exitCode === 0
}

async function connect($: EngineInterface) {
  if (!S.open || S.stream) return
  if (!(await ensureDaemon($))) {
    S.status = 'the dashboard daemon did not start; is node on PATH and Chrome installed?'
    return redraw($)
  }
  if (!(await sendView($))) {
    S.status = 'the daemon refused the view (is Chrome installed? see claude --debug)'
    return redraw($)
  }
  follow($)
  void pushCrons($)
}

// One line per frame: `frame <generation> <png path>`, or `ask <what>`.
function follow($: EngineInterface) {
  const stream = $.process.spawn({ argv: ['curl', '-sN', `${BASE}/frames?view=${encodeURIComponent(S.view)}`] })
  S.stream = stream
  void (async () => {
    let buf = ''
    try {
      for await (const { stream: pipe, text } of stream) {
        if (pipe !== 'stdout') continue
        buf += text
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine($, buf.slice(0, i))
          buf = buf.slice(i + 1)
        }
      }
    } catch { /* curl gone */ }
    if (S.stream !== stream) return
    S.stream = null
    // The daemon went away (the session that started it ended): start again.
    if (S.open) {
      S.status = 'reconnecting…'
      await sleep($, 800)
      void connect($)
    }
  })()
}

function onLine($: EngineInterface, line: string) {
  const [kind, a, ...rest] = line.split(' ')
  if (kind === 'frame') {
    const first = !S.frame
    S.frame = { file: rest.join(' '), generation: Number(a) }
    S.status = ''
    if (first) return redraw($)
    void $.ui.blit({ requestId: PANE, key: 'deck', source: { file: S.frame.file, format: 'png', generation: S.frame.generation } })
      .then(r => { if ('deny' in r && r.deny) redraw($) })
  } else if (kind === 'ask' && a === 'cloud') void pushCloud($)
}

async function pushCrons($: EngineInterface) {
  try {
    const r = await $.tool.call({ tool: 'CronList' })
    if (!('result' in r) || !r.result || r.isError) return
    const crons = r.result.jobs.map(j => ({ id: j.id, prompt: j.prompt, schedule: j.humanSchedule || j.cron, recurring: j.recurring }))
    await curl($, 'POST', '/push', { session: S.session, sessionName: S.sessionName, crons })
  } catch { /* CronList not offered here */ }
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

// Cloud routines only reach us through the RemoteTrigger tool; asked for from
// the page's refresh button, so a permission prompt only comes when wanted.
async function pushCloud($: EngineInterface) {
  let cloud: { items?: ReturnType<typeof cloudItems>; error?: string }
  try {
    const r = await $.tool.call({ tool: 'RemoteTrigger', action: 'list' })
    if ('deny' in r && r.deny) cloud = { error: `not allowed: ${r.deny}` }
    else if (!r.result || r.isError) cloud = { error: 'RemoteTrigger failed (are you logged in to claude.ai?)' }
    else cloud = r.result.status >= 400 ? { error: `claude.ai answered ${r.result.status}` } : { items: cloudItems(r.result.json) }
  } catch (err) {
    cloud = { error: `RemoteTrigger is not available here: ${err}` }
  }
  await curl($, 'POST', '/push', { cloud })
}

async function openPane($: EngineInterface) {
  S.open = true
  S.session = await $.session.id()
  S.view ||= `${S.session.slice(0, 8)}-${Math.random().toString(36).slice(2, 7)}`
  const stored = (await $.store.get('aspect')) as number | undefined
  if (stored) S.aspect = stored
  await $.ui.open({ id: PANE, title: 'Agent Deck', focus: true, columns: 72 })
  void connect($)
  // A closed pane frees its Chrome tab.
  S.watch ??= $.clock.every(5000, () => void (async () => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) return
    S.open = false
    S.watch?.cancel()
    S.watch = null
    const stream = S.stream
    S.stream = null
    await stream?.return?.(undefined)
    S.frame = null
    await curl($, 'DELETE', `/view?view=${encodeURIComponent(S.view)}`)
  })())
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'agentdeck', description: 'Live agent dashboard in a pane: agent flow, tools, all sessions, routines; args: [aspect <n>]' })
    return r
  })

  on('command.run', { command: 'agentdeck' }, async ($, e) => {
    const [arg, value] = (e.args ?? '').trim().split(/\s+/)
    if (arg === 'aspect') {
      const n = Number(value)
      if (!(n > 1 && n < 4)) return { text: `agentdeck: cell aspect is ${S.aspect}; give a number between 1 and 4, e.g. /agentdeck aspect 2.2` }
      S.aspect = n
      await $.store.set('aspect', n)
      if (S.open) void sendView($)
      return { text: `agentdeck: cell aspect ${n}` }
    }
    await openPane($)
    return { text: 'agentdeck: click the pane to use it. Keys: 1 session · 2 global · 3 routines · esc back to this session' }
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'input' || !e.data || typeof e.data !== 'object') return next(e)
    void curl($, 'POST', `/input?view=${encodeURIComponent(S.view)}`, e.data)
    return {}
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    void curl($, 'POST', `/input?view=${encodeURIComponent(S.view)}`, { type: 'wheel', x: 0.5, y: 0.5, dy: e.by * 60 })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Client, Image } = $.ui.resolve(e)
    const cols = Math.max(30, Math.min(255, (e.props?.bodyColumns ?? 72) - 1))
    const rows = Math.max(10, Math.min(255, e.props?.scroll?.bodyRows ?? 40))
    if (cols !== S.size.cols || rows !== S.size.rows) {
      S.size = { cols, rows }
      if (S.open) void sendView($)
    }
    if (!S.frame) {
      return (
        <Box flexDirection="column" minHeight={rows}>
          <Text color={S.status.startsWith('could') || S.status.startsWith('the ') ? C.err : C.muted}>{S.status || 'waiting for the first frame…'}</Text>
        </Box>
      )
    }
    return (
      <Box key="stage" position="relative" width={cols} height={rows}>
        <Image key="deck" source={{ file: S.frame.file, format: 'png', generation: S.frame.generation }} columns={cols} rows={rows} alt="agentdeck dashboard (needs a kitty-graphics terminal: Ghostty, kitty, WezTerm)" />
        <Box key="hit" position="absolute" top={0} left={0}>
          <Client key="input" module="./overlay.tsx" props={{ cols, rows } satisfies OverlayProps} />
        </Box>
      </Box>
    )
  })
}
