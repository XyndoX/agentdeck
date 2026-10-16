// Paints the Agents tab's graph: the main agent in the middle, the agents it
// spawned around it, theirs further out. A node's colour is the work it is
// doing now, its ring the mix of work it has done, and packets run along the
// links of agents at work. Labels are terminal text laid over the picture.
import { agentName, C, CAT, short, type Agent, type Detail } from './deck'
import { Canvas, cellSize, hex } from './paint'

export type Label = { x: number; y: number; text: string; color: string; bold: boolean }
export type Flow = {
  image: { rgba: string; width: number; height: number; key: string }
  labels: Label[]
  hidden: number
  hit: (x: number, y: number) => string // cell coordinates, fractions allowed
}

const MAX_NODES = 16
let picture = { key: '', rgba: '' }

/** Which agents get a node: every working one, then the most recent. */
export function pickAgents(list: Agent[]) {
  const main = list.find(a => a.type === 'main')
  const rest = list.filter(a => a !== main).sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working') || b.lastAt - a.lastAt)
  const kept = rest.slice(0, MAX_NODES - 1)
  const ids = new Set(kept.map(a => a.id))
  // A kept agent whose parent was cut hangs off main.
  return { nodes: [...(main ? [main] : []), ...kept.map(a => ({ ...a, parentId: a.parentId && (ids.has(a.parentId) || a.parentId === 'main') ? a.parentId : 'main' }))], hidden: rest.length - kept.length }
}

/** Positions as fractions of the picture: main centred, rings by depth. */
export function place(nodes: Agent[]) {
  const pos = new Map<string, { x: number; y: number; angle: number }>()
  const main = nodes.find(a => a.type === 'main')
  if (main) pos.set(main.id, { x: 0.5, y: 0.5, angle: 0 })
  const kids = (id: string) => nodes.filter(a => a.type !== 'main' && (a.parentId ?? 'main') === id)
  const first = kids(main?.id ?? 'main')
  first.forEach((a, i) => {
    const angle = -Math.PI / 2 + (i / Math.max(1, first.length)) * Math.PI * 2 + (first.length === 2 ? Math.PI / 2 : 0)
    pos.set(a.id, { x: 0.5 + Math.cos(angle) * 0.3, y: 0.5 + Math.sin(angle) * 0.34, angle })
  })
  // Deeper agents fan out beyond their parent.
  const queue = [...first]
  while (queue.length) {
    const p = queue.shift()!
    const pp = pos.get(p.id)!
    const ks = kids(p.id)
    ks.forEach((a, i) => {
      const angle = pp.angle + (i - (ks.length - 1) / 2) * 0.55
      pos.set(a.id, { x: pp.x + Math.cos(angle) * 0.17, y: pp.y + Math.sin(angle) * 0.2, angle })
      queue.push(a)
    })
  }
  for (const p of pos.values()) {
    p.x = Math.min(0.95, Math.max(0.05, p.x))
    p.y = Math.min(0.93, Math.max(0.07, p.y))
  }
  return pos
}

export function flow(d: Detail, now: number, cols: number, rows: number, sel: string, hover: string): Flow {
  const { nodes, hidden } = pickAgents(d.agentList)
  const pos = place(nodes)
  const { cw, ch } = cellSize(cols, rows, 1 << 18) // small enough to repaint a few times a second
  const W = cols * cw
  const H = rows * ch
  const at = (id: string) => { const p = pos.get(id); return p ? [p.x * W, p.y * H] as const : undefined }
  const maxCalls = Math.max(1, ...nodes.map(a => a.calls))
  const radius = (a: Agent) => cw * (0.55 + 0.75 * Math.sqrt(a.calls / maxCalls)) * (a.type === 'main' ? 1.35 : 1)
  const colour = (a: Agent) => a.status === 'working' ? CAT[a.current?.cat ?? 'agent'] ?? C.hot : a.status === 'done' ? '#5a6b5a' : a.status === 'waiting' ? C.warn : '#55556a'
  const working = nodes.some(a => a.status === 'working')
  const phase = working ? Math.floor(now / 120) % 1000 : 0

  const key = `${nodes.map(a => `${a.id}:${a.status}:${a.current?.cat}:${a.calls}`).join(',')}|${W}x${H}|${sel}|${hover}|${phase}`
  if (picture.key !== key) {
    const c = new Canvas(W, H)
    const lw = Math.max(1, cw / 7)
    // Links, then packets on the busy ones.
    for (const a of nodes) {
      if (a.type === 'main') continue
      const pa = at(a.parentId ?? 'main'), pb = at(a.id)
      if (!pa || !pb) continue
      const busy = a.status === 'working'
      c.line({ x0: pa[0], y0: pa[1], x1: pb[0], y1: pb[1], c: hex(busy ? C.hot : '#8a8a99'), a: busy ? 0.75 : a.status === 'done' ? 0.18 : 0.3, w: busy ? lw * 1.8 : lw })
      if (!busy) continue
      for (const k of [0, 0.5]) {
        const t = ((now / 1600 + k + a.id.length * 0.13) % 1)
        // Out along the link is the task, back is the result.
        const [x, y] = k === 0 ? [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t] : [pb[0] + (pa[0] - pb[0]) * t, pb[1] + (pa[1] - pb[1]) * t]
        c.dot({ x, y, r: lw * 1.6, c: hex(k === 0 ? C.hot : CAT[a.current?.cat ?? 'agent'] ?? C.fg), a: 0.95, halo: true })
      }
    }
    for (const a of nodes) {
      const p = at(a.id)
      if (!p) continue
      const r = radius(a)
      // The ring: what kind of work this agent has done, in proportion.
      const total = Object.values(a.byCat).reduce((x, y) => x + y, 0)
      if (total) {
        const ring = r + cw * 0.35
        const steps = Math.max(24, Math.round(ring * 1.6))
        const parts = Object.entries(a.byCat).sort((x, y) => y[1] - x[1])
        for (let s = 0; s < steps; s++) {
          const f = s / steps
          let acc = 0
          let cat = parts[0]![0]
          for (const [k, n] of parts) { acc += n / total; if (f < acc) { cat = k; break } }
          const ang = -Math.PI / 2 + f * Math.PI * 2
          c.dot({ x: p[0] + Math.cos(ang) * ring, y: p[1] + Math.sin(ang) * ring, r: lw * 0.9, c: hex(CAT[cat] ?? C.dim), a: a.status === 'done' ? 0.45 : 0.9 })
        }
      }
      c.dot({ x: p[0], y: p[1], r, c: hex(colour(a)), a: a.status === 'done' ? 0.6 : 1, halo: a.status === 'working' })
      if (a.id === sel || a.id === hover) c.dot({ x: p[0], y: p[1], r: r + cw * 0.85, c: hex(C.white), a: 0.85, ring: true })
    }
    picture = { key, rgba: c.base64() }
  }

  // Labels beside each node: its name, and for one at work what it runs now.
  const taken = new Set<string>()
  const labels: Label[] = []
  const free = (x: number, y: number, n: number) => y >= 0 && y < rows && x >= 0 && x + n <= cols && ![...Array(n).keys()].some(i => taken.has(`${x + i},${y}`))
  const take = (x: number, y: number, n: number) => { for (let i = 0; i < n; i++) taken.add(`${x + i},${y}`) }
  const order = [...nodes].sort((a, b) => Number(b.id === sel) - Number(a.id === sel) || Number(b.status === 'working') - Number(a.status === 'working'))
  for (const a of order) {
    const p = at(a.id)
    if (!p) continue
    const cx = Math.floor(p[0] / cw)
    const cy = Math.floor(p[1] / ch)
    const gap = Math.ceil((radius(a) + cw * 0.6) / cw) + 1
    const name = short(agentName(a), 18)
    const what = short(a.current ? `${a.current.tool} ${a.current.text}` : a.type === 'main' ? '' : a.description, Math.max(8, Math.floor(cols / 2.4)))
    const right = p[0] < W * 0.62
    for (const side of right ? [1, -1] : [-1, 1]) {
      const width = Math.max(name.length, what.length)
      const x = side > 0 ? cx + gap : cx - gap - width + 1
      if (!free(x, cy, name.length) || (what && !free(x, cy + 1, what.length))) continue
      take(x, cy, name.length)
      labels.push({ x, y: cy, text: name, color: a.status === 'working' || a.id === sel ? C.white : a.status === 'done' ? C.dim : C.fg, bold: a.type === 'main' || a.id === sel })
      if (what) {
        take(x, cy + 1, what.length)
        labels.push({ x, y: cy + 1, text: what, color: a.current ? CAT[a.current.cat] ?? C.fg : C.muted, bold: false })
      }
      break
    }
  }

  const hit = (x: number, y: number) => {
    let best = ''
    let bestD = Infinity
    for (const a of nodes) {
      const p = at(a.id)
      if (!p) continue
      const dist = Math.hypot(p[0] - x * cw, p[1] - y * ch)
      if (dist < bestD && dist < Math.max(radius(a) + cw, cw * 2.5)) { best = a.id; bestD = dist }
    }
    return best
  }
  return { image: { rgba: picture.rgba, width: W, height: H, key: picture.key }, labels, hidden, hit }
}
