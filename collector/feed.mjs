// The mod's data source: prints one JSON snapshot per line, at most once a
// second and only when something changed. `node feed.mjs <sessionId>`
import { snapshot } from './collect.mjs'

const session = process.argv[2] ?? ''
let last = ''
const tick = () => {
  const s = snapshot(session)
  const key = JSON.stringify({ ...s, now: 0 })
  if (key === last && Date.now() % 5000 > 1000) return // a heartbeat every few seconds keeps times fresh
  last = key
  process.stdout.write(JSON.stringify(s) + '\n')
}
tick()
setInterval(tick, 1000)
// The mod kills us on unload; if it dies hard, we notice we were orphaned.
setInterval(() => { if (process.ppid === 1) process.exit(0) }, 5000).unref()
