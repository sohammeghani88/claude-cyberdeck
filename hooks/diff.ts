export type LineDiff = { added: number; removed: number }

// The cells of an edit's size meter, and the changed lines that fill each one
// past the first: up to 5 lines fills one cell, up to 25 two, up to 100 three.
export const METER_CELLS = 4
const METER_STEPS = [5, 25, 100]

export const meterOf = ({ added, removed }: LineDiff) => 1 + METER_STEPS.filter(step => added + removed > step).length

const linesOf = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// The lines only one side holds once the lines both start and end with are
// set aside: exact for a change in one place, which most cell edits are.
const deltaOf = (before: string, after: string): LineDiff => {
  const a = linesOf(before)
  const b = linesOf(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++

  return { added: b.length - head - tail, removed: a.length - head - tail }
}

// What a finished edit changed, counted from the result its tool stored: the
// patch Edit and Write keep, or the cell sources NotebookEdit keeps. Null
// where the result holds nothing to count, as when the diff timed out.
export const diffOf = (tool: string, output: unknown): LineDiff | null => {
  if (typeof output !== 'object' || output === null) return null
  const result = output as Record<string, unknown>

  if (tool === 'NotebookEdit') {
    const before = typeof result.old_source === 'string' ? result.old_source : null
    const after = typeof result.new_source === 'string' ? result.new_source : ''
    if (result.edit_mode === 'insert') return { added: linesOf(after).length, removed: 0 }
    if (before === null) return null

    return result.edit_mode === 'delete' ? { added: 0, removed: linesOf(before).length } : deltaOf(before, after)
  }

  const patch = result.structuredPatch
  if (Array.isArray(patch) && patch.length > 0) {
    const diff = { added: 0, removed: 0 }
    for (const hunk of patch as ReadonlyArray<{ lines?: unknown }>) {
      for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) diff.added++
        else if (line.startsWith('-')) diff.removed++
      }
    }

    return diff
  }

  // A new file's write keeps no patch: every line it holds is new.
  if (result.type === 'create' && typeof result.content === 'string') {
    return { added: linesOf(result.content).length, removed: 0 }
  }

  return null
}
