import type { ClientModule } from 'claude-code'

// An empty box over the dashboard picture: it reports where a press starts and
// ends (as fractions of the box) and the keys, so the mod can click the page.
export type OverlayProps = { cols: number; rows: number }

const Overlay: ClientModule<OverlayProps> = (props, surface) => {
  const { Box } = surface.elements
  surface.onPointer(e => {
    const at = { x: (e.fine?.x ?? e.x + 0.5) / props.cols, y: (e.fine?.y ?? e.y + 0.5) / props.rows }
    if (e.type === 'down' && (e.button ?? 'left') === 'left') surface.post({ type: 'down', ...at })
    else if (e.type === 'up') surface.post({ type: 'up', ...at })
  })
  surface.onKey(e => surface.post({ type: 'key', key: e.key }))
  return <Box width={props.cols} height={props.rows} />
}

export default Overlay
