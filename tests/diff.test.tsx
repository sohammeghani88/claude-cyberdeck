import { expect, test } from 'claude-code/testing'

import { diffOf, meterOf } from '../hooks/diff'

// A finished call's compact row, as the terminal asks the deck to draw it.
const rowOf = (tool: string, input: object, output: unknown, isErrored = false) =>
  ({
    plugin: 'cyberdeck',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'toolu_1',
    props: { tool_use_id: 'toolu_1', tool, input, output, isRunning: false, isErrored, isInterrupted: false },
  }) as const

// Three lines out and twelve in, between two lines of context.
const PATCH = [
  {
    oldStart: 10,
    oldLines: 5,
    newStart: 10,
    newLines: 14,
    lines: [' const user = load()', '-if (!token.valid) {', '-  deny()', '-}', ...Array.from({ length: 12 }, (_, i) => `+  check(${i})`), ' return user'],
  },
]

test("an edit's row shows the lines it added and removed, and its size", async $ => {
  const ui = await $.ui.mount(rowOf('Edit', { file_path: '/repo/src/auth.ts' }, { filePath: '/repo/src/auth.ts', structuredPatch: PATCH }))

  expect((await ui.find({ type: 'Text', text: /PATCH/ }))?.text).toBe('▸ PATCH src/auth.ts +12 −3 ▰▰▱▱')
  await ui.unmount()
})

test("a new file's row counts every line it holds as added", async $ => {
  const output = { type: 'create', filePath: '/repo/src/new.ts', content: 'a\nb\nc\n', structuredPatch: [], originalFile: null }
  const ui = await $.ui.mount(rowOf('Write', { file_path: '/repo/src/new.ts' }, output))

  expect((await ui.find({ type: 'Text', text: /WRITE/ }))?.text).toBe('▸ WRITE src/new.ts +3 ▰▱▱▱')
  await ui.unmount()
})

test('a write with no diff to count keeps the tick', async $ => {
  // An update whose diff timed out stores an empty patch.
  const output = { type: 'update', filePath: '/repo/src/big.ts', content: 'x', structuredPatch: [], originalFile: 'y' }
  const ui = await $.ui.mount(rowOf('Write', { file_path: '/repo/src/big.ts' }, output))

  expect((await ui.find({ type: 'Text', text: /WRITE/ }))?.text).toBe('▸ WRITE src/big.ts ✓')
  await ui.unmount()
})

test('a failed edit shows the fault, not a size', async $ => {
  const ui = await $.ui.mount(rowOf('Edit', { file_path: '/repo/src/auth.ts' }, 'String to replace not found in file.', true))

  expect((await ui.find({ type: 'Text', text: /PATCH/ }))?.text).toBe('▸ PATCH src/auth.ts ✗ fault')
  await ui.unmount()
})

test("a notebook edit's row names the notebook and counts the cell's lines", async $ => {
  const output = { edit_mode: 'replace', old_source: 'import os\nx = 1\nprint(x)', new_source: 'import os\nx = 2\nprint(x)', notebook_path: '/repo/nb/run.ipynb' }
  const ui = await $.ui.mount(rowOf('NotebookEdit', { notebook_path: '/repo/nb/run.ipynb', new_source: '' }, output))

  expect((await ui.find({ type: 'Text', text: /PATCH/ }))?.text).toBe('▸ PATCH nb/run.ipynb +1 −1 ▰▱▱▱')
  await ui.unmount()
})

test('the counts skip what is not a changed line', async () => {
  const lines = [' a', '-b', '+c', '\\ No newline at end of file']

  expect(diffOf('Edit', { structuredPatch: [{ lines }] })).toEqual({ added: 1, removed: 1 })
  expect(diffOf('Edit', 'an error the model read')).toBeNull()
  expect(diffOf('NotebookEdit', { edit_mode: 'insert', new_source: 'a\nb\n' })).toEqual({ added: 2, removed: 0 })
  expect(diffOf('NotebookEdit', { edit_mode: 'delete', old_source: 'a\nb\nc', new_source: '' })).toEqual({ added: 0, removed: 3 })
})

test('the meter fills a cell past 5, 25 and 100 changed lines', async () => {
  const cells = [1, 5, 6, 25, 26, 100, 101, 5000].map(lines => meterOf({ added: lines, removed: 0 }))

  expect(cells).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
  expect(meterOf({ added: 12, removed: 3 })).toBe(2)
})
