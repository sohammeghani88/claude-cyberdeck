import type { ClientModule } from 'claude-code'

export type DecryptProps = { text: string; isFirst: boolean; colors: { glyph: string; bullet: string } }

type DecryptState = { frame: number }

const GLYPHS = '!<>-_\\/[]{}=+*^?#$%&@0123456789ABCDEF'
const FRAME_MS = 45
// About a second from noise to plain text, whatever the reply's length.
const FRAMES = 22

const noise = (a: number, b: number) => {
  let x = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

const Decrypt: ClientModule<DecryptProps, DecryptState> = (props, surface) => {
  const { Box, Text } = surface.elements

  if (surface.state === undefined) {
    surface.setState({ frame: 0 })
    const stop = surface.every(FRAME_MS, () => {
      const frame = (surface.state?.frame ?? 0) + 1
      surface.setState({ frame })
      // The hooks module then hands the row back to the engine's own drawing.
      if (frame >= FRAMES) {
        stop()
        surface.post({ done: true })
      }
    })
  }

  const frame = surface.state?.frame ?? 0
  const shown = Math.floor((props.text.length * Math.min(frame, FRAMES)) / FRAMES)
  const hidden = [...props.text.slice(shown)]
    .map((ch, i) => (/\s/.test(ch) ? ch : GLYPHS[Math.floor(noise(i, frame) * GLYPHS.length)] ?? '#'))
    .join('')

  return (
    <Box flexDirection="row">
      <Text color={props.colors.bullet}>{props.isFirst ? '● ' : '  '}</Text>
      <Text wrap="wrap">
        {props.text.slice(0, shown)}
        <Text color={props.colors.glyph}>{hidden}</Text>
      </Text>
    </Box>
  )
}

export default Decrypt
