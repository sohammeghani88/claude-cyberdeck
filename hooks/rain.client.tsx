import type { ClientModule } from 'claude-code'

export type RainProps = {
  columns: number
  rows: number
  colors: { head: string; bright: string; main: string; dim: string }
}

type Drop = { y: number; speed: number; length: number }
type RainState = { frame: number; drops: Drop[] }
type Level = 'head' | 'bright' | 'main' | 'dim'

const GLYPHS = '0123456789ABCDEFλΣΩΨπΔΦ@#$%&*+=<>:;|'
const FRAME_MS = 70

// Cheap deterministic noise in [0, 1), so one frame always draws the same way.
const noise = (a: number, b: number) => {
  let x = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

const dropFor = (column: number, frame: number, rows: number): Drop => ({
  y: -Math.floor(noise(column, frame) * rows),
  speed: 0.35 + noise(column, frame + 1) * 0.65,
  length: 4 + Math.floor(noise(column, frame + 2) * Math.max(4, rows * 0.6)),
})

const levelOf = (drop: Drop, row: number): Level | null => {
  const depth = drop.y - row
  if (depth < 0 || depth >= drop.length) return null
  return depth < 1 ? 'head' : depth < 3 ? 'bright' : depth < drop.length * 0.55 ? 'main' : 'dim'
}

const step = (state: RainState, columns: number, rows: number): RainState => {
  const frame = state.frame + 1
  const drops = Array.from({ length: columns }, (_, column) => {
    const drop = state.drops[column] ?? dropFor(column, frame, rows)
    const y = drop.y + drop.speed
    return y - drop.length > rows ? dropFor(column, frame, rows) : { ...drop, y }
  })
  return { frame, drops }
}

const Rain: ClientModule<RainProps, RainState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const columns = surface.columns || props.columns
  const rows = surface.rows || props.rows

  if (surface.state === undefined) {
    surface.setState({ frame: 0, drops: Array.from({ length: columns }, (_, column) => dropFor(column, 0, rows)) })
    surface.every(FRAME_MS, () => {
      const was = surface.state
      if (was !== undefined) surface.setState(step(was, surface.columns || columns, surface.rows || rows))
    })
  }

  const view = surface.state ?? { frame: 0, drops: [] }
  const lines = Array.from({ length: rows }, (_, row) => {
    const runs: { level: Level | null; text: string }[] = []
    for (let column = 0; column < columns; column += 1) {
      const drop = view.drops[column]
      const level = drop === undefined ? null : levelOf(drop, row)
      // Glyphs flicker every third frame, each column on its own beat.
      const glyph = level === null ? ' ' : GLYPHS[Math.floor(noise(column * 31 + row, Math.floor(view.frame / 3) + column) * GLYPHS.length)] ?? '0'
      const last = runs.at(-1)
      if (last !== undefined && last.level === level) last.text += glyph
      else runs.push({ level, text: glyph })
    }
    return runs
  })

  return (
    <Box flexDirection="column">
      {lines.map(runs => (
        <Text wrap="truncate">
          {runs.map(({ level, text }) =>
            level === null ? text
            : level === 'head' ? <Text color={props.colors.head} weight="bold">{text}</Text>
            : <Text color={props.colors[level]}>{text}</Text>,
          )}
        </Text>
      ))}
    </Box>
  )
}

export default Rain
