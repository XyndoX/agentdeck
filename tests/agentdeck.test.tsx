import { expect, mock, test } from 'claude-code/testing'
import { cloudItems } from '../hooks/register'
import { pickAgents, place } from '../hooks/flow'
import { line, spark, type Agent, type Snapshot } from '../hooks/deck'

const NOW = 1_800_000_000_000
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id, type: 'general-purpose', description: `task ${id}`, model: 'claude-opus-5-5', parentId: 'main', background: false, status: 'done',
  tokensOut: 1200, firstAt: NOW - 60e3, lastAt: NOW - 5e3, lastText: '', calls: 4, byCat: { read: 3, edit: 1 }, current: null, last: null, ...over,
})
const call = (cat: string, tool: string, text: string, agentId: string) => ({ id: `c-${agentId}`, name: tool, tool, cat, text, start: NOW - 3000, end: 0, err: false, agentId })
const SNAP: Snapshot = {
  now: NOW, sessionId: 'home-session',
  sessions: [
    { id: 'home-session', pid: 1, name: 'aisetup-78', cwd: '~/AiSetup', kind: 'interactive', status: 'busy', since: NOW, startedAt: NOW - 1e6, agents: 3, active: 2, current: null, spark: [{ shell: 2 }, {}, { edit: 1 }], tokensOut: 5000, lastAt: NOW },
    { id: 'other-session', pid: 2, name: 'gymothy-f6', cwd: '~/gymothy', kind: 'interactive', status: 'idle', since: NOW, startedAt: NOW - 1e6, agents: 1, active: 0, current: null, spark: [{}, {}, {}], tokensOut: 10, lastAt: NOW - 60e3 },
  ],
  session: {
    id: 'home-session', pid: 1, name: 'aisetup-78', cwd: '~/AiSetup', kind: 'interactive', status: 'busy', since: NOW, startedAt: NOW - 1e6, agents: 3, active: 2, current: null, spark: [], tokensOut: 5000, lastAt: NOW,
    agentList: [
      agent('main', { type: 'main', parentId: null, status: 'working', calls: 30, byCat: { shell: 20, edit: 10 }, current: call('agent', 'Agent', 'Explore: find tests', 'main') }),
      agent('a1', { type: 'Explore', status: 'working', current: call('search', 'WebSearch', '“kitty graphics”', 'a1') }),
      agent('a2', { type: 'inception:l1-forger' }),
    ],
    events: [call('search', 'WebSearch', '“kitty graphics”', 'a1')],
    files: [], counts: { shell: 20, edit: 11, read: 6, search: 1 },
  },
  routines: { launchd: [{ label: 'com.chris.shipcheck', schedule: 'Fri 17:04', program: 'x', loaded: true, running: false, lastExit: 0, log: '' }], scheduled: [], jobs: [] },
}

test('layout, rows and cloud routines', () => {
  const { nodes, hidden } = pickAgents([...SNAP.session!.agentList, ...Array.from({ length: 20 }, (_, i) => agent(`x${i}`))])
  expect(nodes.length).toBe(16)
  expect(hidden).toBe(7)
  expect(nodes.filter(a => a.status === 'working').length).toBe(2) // working ones always drawn
  const pos = place(SNAP.session!.agentList)
  expect(pos.get('main')).toEqual({ x: 0.5, y: 0.5, angle: 0 })
  for (const p of pos.values()) expect(p.x >= 0.05 && p.x <= 0.95 && p.y >= 0.07 && p.y <= 0.93).toBe(true)
  expect(line([{ t: 'abcdefghij' }], 8, { t: '3s' }).map(s => s.t).join('')).toBe('abcd… 3s')
  expect(spark([{ edit: 1 }, {}, { shell: 4 }]).map(s => s.t).join('')).toBe('▂·█')
  const items = cloudItems(JSON.stringify({ data: [{ name: 'Daily news', cron_expression: '0 7 * * *' }, { id: 't2', enabled: false }] }))
  expect(items.map(i => [i.name, i.schedule, i.enabled])).toEqual([['Daily news', '0 7 * * *', true], ['t2', '', false]])
})

test('the side pane paints the agent graph, lists agents and switches sessions', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { TMPDIR: '/tmp/' })
  const spawned: string[][] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'home-session' }))
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'agentdeck', title: 'Agent deck', isShown: true, isFocused: true, isPlaced: true }] }))
  on('tool.call', () => ({ result: { jobs: [] } }) as any)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('process.spawn', async function* (_$: any, e: any) {
    spawned.push(e.argv)
    yield { stream: 'stdout', text: JSON.stringify({ ...SNAP, sessionId: e.argv[2] }) + '\n' }
    return { value: { code: 0, signal: null } }
  } as any)

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'agentdeck', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  await clock.settle()
  expect(spawned[0]!.slice(-2)).toEqual([expect.stringContaining('collector/feed.mjs'), 'home-session'])

  const props = { title: 'Agent deck', isFocused: true, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as any
  const ui = await $.ui.mount({ plugin: 'agentdeck', surface: 'terminal', component: 'Pane', requestId: 'agentdeck', props })
  await clock.settle()
  let shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('"type":"Image"')
  expect(shown).toContain('agentdeck-') // the picture file
  for (const t of ['aisetup-78', 'Explore', 'l1-forger', 'WebSearch', 'kitty graphics']) expect(shown).toContain(t)

  // Sessions tab: two clicks on the other session show its agents.
  await ui.post({ key: '2' }, { in: 'feed' })
  shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('gymothy-f6')
  await ui.post({ click: [3, 2] }, { in: 'list' })
  await ui.post({ click: [3, 2] }, { in: 'list' })
  await clock.settle()
  expect(spawned.at(-1)!.at(-1)).toBe('other-session')

  await ui.post({ key: '3' }, { in: 'feed' })
  shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('com.chris.shipcheck')
})
