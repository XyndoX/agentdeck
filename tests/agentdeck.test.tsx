import { expect, mock, test } from 'claude-code/testing'
import { cloudItems } from '../hooks/register'

test('cloud routines from RemoteTrigger list JSON', () => {
  const items = cloudItems(JSON.stringify({ data: [{ id: 't1', name: 'Daily news', cron_expression: '0 7 * * *', enabled: true, next_run_at: '2026-10-17T07:00Z' }, { id: 't2', enabled: false }] }))
  expect(items.map(i => i.name)).toEqual(['Daily news', 't2'])
  expect(items[0]!.schedule).toBe('0 7 * * *')
  expect(items[1]!.enabled).toBe(false)
  expect(cloudItems('[]')).toEqual([])
})

test('the pane starts a view, draws its frames and passes clicks to the page', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  const posts: { path: string; body: any }[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: '7099d47b-aaaa-bbbb-cccc-000000000000' }))
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'agentdeck', title: 'Agent Deck', isShown: true, isFocused: true, isPlaced: true }] }))
  on('tool.call', () => ({ result: { jobs: [{ id: 'c1', cron: '*/5 * * * *', humanSchedule: 'every 5 min', prompt: '/babysit' }] } }))
  on('process.run', (_$: any, e: any) => {
    const argv = e.argv as string[]
    const url = argv[argv.length - 1]!
    if (url.endsWith('/ping')) return { value: { exitCode: 0, stdout: '{"agentdeck":1}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    posts.push({ path: url.replace('http://127.0.0.1:47821', ''), body: JSON.parse(e.init?.stdin ?? '{}') })
    return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: 'frame 3 /tmp/agentdeck-x/v-1.png\n' }
    return { value: { code: 0, signal: null } }
  } as any)

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as any)
  const props = { title: 'Agent Deck', isFocused: true, bodyColumns: 73, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as any
  const ui = await $.ui.mount({ plugin: 'agentdeck', surface: 'terminal', component: 'Pane', requestId: 'agentdeck', props })
  const res = await $.command.run({ command: 'agentdeck', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  expect(JSON.stringify(res)).toContain('1 session')
  await clock.settle()

  const view = posts.find(p => p.path === '/view')
  expect(view?.body.session).toBe('7099d47b-aaaa-bbbb-cccc-000000000000')
  expect(view?.body.width).toBe(72 * 8)
  expect(view?.body.height).toBe(Math.round(40 * 8 * 2.1))
  expect(posts.find(p => p.path === '/push')?.body.crons[0].schedule).toBe('every 5 min')

  const shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('"type":"Image"')
  expect(shown).toContain('/tmp/agentdeck-x/v-1.png')

  await ui.post({ type: 'down', x: 0.25, y: 0.5 }, { in: 'input' })
  await clock.settle()
  const input = posts.filter(p => p.path.startsWith('/input')).at(-1)
  expect(input?.body).toEqual({ type: 'down', x: 0.25, y: 0.5 })
})
