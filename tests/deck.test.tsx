import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

import Decrypt from '../hooks/decrypt.client'
import { counterOf, glowOf, pathsOf, secretsOf } from '../hooks/glow'
import { cpuPercent, parseProc } from '../hooks/sys'

// The HUD draws in the hint line under the prompt box.
const BAND = {
  plugin: 'cyberdeck',
  component: 'PromptHint',
  requestId: 'hint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const PANE = {
  plugin: 'cyberdeck',
  component: 'Pane',
  requestId: 'ops',
  props: {
    title: 'KERNEL://ops',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

// The k-th read of /proc: each two seconds the CPU is a quarter busy, and eth0
// takes in 4 KiB and sends 2 KiB; loopback traffic is never counted.
const procSample = (k: number) =>
  [
    `cpu  ${100 + 100 * k} 0 ${100 + 100 * k} ${800 + 600 * k} 0 0 0 0 0 0`,
    `cpu0 ${100 + 100 * k} 0 ${100 + 100 * k} ${800 + 600 * k} 0 0 0 0 0 0`,
    'MemTotal:       16000000 kB',
    'MemFree:         1000000 kB',
    'MemAvailable:    8000000 kB',
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    `    lo: ${9000 * k} 1 0 0 0 0 0 0 ${9000 * k} 1 0 0 0 0 0 0`,
    `  eth0: ${1000 + 4096 * k} 5 0 0 0 0 0 0 ${2000 + 2048 * k} 5 0 0 0 0 0 0`,
  ].join('\n')

// Nothing sits beneath the plugin: each hook here stands for the engine.
const engine = (on: On, toasts: string[], rateLimits: SessionRateLimit[] = []) => {
  let reads = 0
  const stdoutOf = (argv: readonly string[]) =>
    argv[0] === 'git' ? 'main\n' : argv[0] === 'date' ? '+0530\n' : procSample(reads++)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'deck' } }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.place', (_, e) => ({ value: { isPlaced: true, requestId: e.id } }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: stdoutOf(e.argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  engineDraws(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 68_000, percent: 34 }, rateLimits, cost: { usd: 0.42 } },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('the deck boots, then shows live telemetry and logs ops', async ($, on) => {
  const toasts: string[] = []
  const clock = mock.clock(on, { now: 3_600_000 })
  engine(on, toasts)
  on('tool.call', (_, e) =>
    e.tool === 'Bash' && e.command === 'npm test' ? { isError: true, result: undefined, text: 'exit 1' } : { result: {} },
  )

  await $.session.start({ cwd: '/home/op/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(440)

  const booting = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await booting.find({ type: 'Text', text: /cold boot/ })).toBeDefined()
  await booting.unmount()

  await clock.advance(3000)
  await $.tool.call({ tool: 'Read', file_path: '/home/op/proj/src/app.ts' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(toasts).toContain('[ INTRUSION DETECTED ] test suite failed — tracing…')

  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: /CYBERDECK/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~\/proj/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⎇ main/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /34%/ })).toBeDefined()
    await ui.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /0x0001 READ +src\/app\.ts/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /0x0002 EXEC +npm test.*✗/ })).toBeDefined()
    await pane.unmount()
  }
})

test('/deck switches themes and says which exist', async ($, on) => {
  const toasts: string[] = []
  mock.clock(on)
  engine(on, toasts)

  expect((await $.command.run({ ...COMMAND, command: 'deck', args: 'theme neon' })).text).toBe(
    '[deck] theme → neon · pick "CYBERDECK Neon" in /theme to recolor the rest of Claude Code',
  )
  expect((await $.command.run({ ...COMMAND, command: 'deck', args: 'theme glacier' })).text).toContain('CYBERDECK Glacier')
  expect((await $.command.run({ ...COMMAND, command: 'deck', args: 'theme blood here' })).text).toContain('this session only')
  expect((await $.command.run({ ...COMMAND, command: 'deck', args: 'theme pink' })).text).toContain('matrix · neon · blood · amber · ghost · glacier')
  expect((await $.command.run({ ...COMMAND, command: 'deck', args: '' })).text).toContain('HUD offline')
  expect((await $.command.run({ ...COMMAND, command: 'deck', args: '' })).text).toContain('HUD online')
})

test('a passing suite and a commit get their own toasts', async ($, on) => {
  const toasts: string[] = []
  mock.clock(on)
  engine(on, toasts)
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: deck"' })

  expect(toasts).toEqual(['[ ACCESS GRANTED ] test suite passed', '[ COMMIT SIGNED ] changes sealed into history'])
})

test('the spinner speaks terminal and the turn line is gone', async ($, on) => {
  mock.clock(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.component === 'Spinner' ? `${e.props.word}${e.props.suffix}` : 'engine'}</Text>
  })

  const spinner = await $.ui.mount({
    plugin: 'cyberdeck',
    component: 'Spinner',
    requestId: 'main',
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
    surface: 'terminal',
  })
  const word = (await spinner.find({ type: 'Text' }))?.text ?? ''
  expect(word).toMatch(/^(Decrypting thought vectors|Running inference|Compiling neural lattice|Traversing latent space|Simulating outcomes) ▌$/)
  await spinner.unmount()

  const line = await $.ui.mount({
    plugin: 'cyberdeck',
    component: 'TurnDuration',
    requestId: 'turn-1',
    props: { word: 'Baked', durationMs: 3200 },
    surface: 'terminal',
  })
  // Nothing is drawn between a reply and the next prompt.
  expect(await line.find({ type: 'Text' })).toBeUndefined()
  await line.unmount()
})

// Stands for the engine's own drawing of every site the deck may pass on.
const engineDraws = (on: On) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.component === 'PromptHint' ? `${e.props.hint} ${e.props.tail ?? ''}` : 'engine'}</Text>
  })

const BASH_ROW = {
  plugin: 'cyberdeck',
  component: 'ToolUse',
  requestId: 'toolu_1',
  surface: 'terminal',
  props: {
    tool_use_id: 'toolu_1',
    tool: 'Bash',
    input: { command: 'npm test' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  },
} as const

test('the top of the transcript, prompts and tool rows look the part', async ($, on) => {
  const toasts: string[] = []
  mock.clock(on)
  engine(on, toasts)
  await $.session.start({ cwd: '/home/op/proj', surface: 'terminal', isInteractive: true })

  const banner = await $.ui.mount({
    plugin: 'cyberdeck',
    component: 'Placed',
    requestId: 'banner',
    surface: 'terminal',
    props: { id: 'banner', plugin: 'cyberdeck' },
  })
  expect(await banner.find({ type: 'Text', text: /██████╗/ })).toBeDefined()
  expect(await banner.find({ type: 'Text', text: /NEURAL UPLINK ESTABLISHED.*⎇ main/ })).toBeDefined()
  await banner.unmount()

  const prompt = await $.ui.mount({
    plugin: 'cyberdeck',
    component: 'UserMessage',
    requestId: 'msg_1',
    surface: 'terminal',
    props: { text: 'fix the login bug', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await prompt.find({ type: 'Text', text: '▌' })).toBeDefined()
  expect(await prompt.find({ type: 'Text', text: ' ❯ ' })).toBeDefined()
  expect(await prompt.find({ type: 'Text', text: 'fix the login bug' })).toBeDefined()
  await prompt.unmount()

  const done = await $.ui.mount(BASH_ROW)
  expect((await done.find({ type: 'Text' }))?.text).toBe('▸ EXEC  npm test ✓')
  await done.unmount()

  const running = await $.ui.mount({ ...BASH_ROW, props: { ...BASH_ROW.props, isRunning: true } })
  expect((await running.find({ type: 'Text' }))?.text).toBe('engine')
  await running.unmount()

  const hint = await $.ui.mount({
    plugin: 'cyberdeck',
    component: 'PromptHint',
    surface: 'terminal',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  })
  // The engine's own hint line stays on top, the deck in its frame below it.
  expect(await hint.find({ type: 'Text', text: /\? for shortcuts/ })).toBeDefined()
  expect(await hint.find({ type: 'Text', text: /> ▌|cold boot|CYBERDECK/ })).toBeDefined()
  await hint.unmount()

  const output = await $.ui.mount({
    plugin: 'cyberdeck',
    component: 'CommandOutput',
    requestId: 'out_1',
    surface: 'terminal',
    props: { command: 'deck', args: '', text: '[deck] HUD online.', isErrored: false },
  })
  expect((await output.find({ type: 'Text' }))?.text).toBe('[deck] HUD online.')
  await output.unmount()
})

test('/deck offline hands every row back to the engine', async ($, on) => {
  const toasts: string[] = []
  mock.clock(on)
  engine(on, toasts)
  await $.command.run({ ...COMMAND, command: 'deck', args: '' })

  const row = await $.ui.mount(BASH_ROW)
  expect((await row.find({ type: 'Text' }))?.text).toBe('engine')
  await row.unmount()

  const prompt = await $.ui.mount({
    plugin: 'cyberdeck',
    component: 'UserMessage',
    surface: 'terminal',
    props: { text: 'hi', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await prompt.find({ type: 'Text' }))?.text).toBe('engine')
  await prompt.unmount()
})

const TURN = { answer: 'done', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' } as const
const FULLSCREEN = { columns: 100, rows: 40, isFullscreen: true }

test('the HUD reads the machine: CPU and RAM beside the context', async ($, on) => {
  const clock = mock.clock(on, { now: 7_200_000 })
  engine(on, [])
  await $.session.start({ cwd: '/home/op/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(4500)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ctx .* 34%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cpu .* 25%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ram .* 50% 7\.6\/15\.3G/ })).toBeDefined()
  // Only what a coder glances at: no cost, uptime, op count, disk or network.
  expect(await ui.find({ type: 'Text', text: /\$|OPS|UP |DSK|NET/ })).toBeUndefined()
  await ui.unmount()
})

test('the HUD shows plan limits with their reset times', async ($, on) => {
  const clock = mock.clock(on, { now: 3_600_000 })
  engine(on, [], [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(3_600_000 + 8_040_000).toISOString() },
    { kind: 'seven_day', percentUsed: 91 },
  ])
  await $.session.start({ cwd: '/home/op/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(3500)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /5h .* 24% ↻ 2h1\dm/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /7d .* 91%/ })).toBeDefined()
  await ui.unmount()
})

test('the HUD switches model and effort with one click each', async ($, on) => {
  const toasts: string[] = []
  const sets: unknown[] = []
  const runs: string[] = []
  mock.clock(on, { now: 3_600_000 })
  engine(on, toasts)
  on('config.set', (_, e) => (sets.push(e.value), { value: e.value }))
  on('command.run', { command: 'effort' }, (_, e) => (runs.push(e.args), { text: `Set effort level to ${e.args}` }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  for (const key of ['model-opus', 'model-sonnet', 'model-haiku', 'model-fable', 'effort-low', 'effort-medium', 'effort-high', 'effort-xhigh', 'effort-max']) {
    expect(await ui.find({ type: 'Button', key })).toBeDefined()
  }

  await ui.press({ key: 'model-sonnet' })
  await ui.press({ key: 'effort-high' })

  expect(sets).toEqual(['sonnet'])
  expect(runs).toEqual(['high'])
  expect(toasts).toEqual(['[deck] model → sonnet', '[deck] effort → high'])
  await ui.unmount()
})

test('the ops pane logs while a turn runs and rains once idle', async ($, on) => {
  const clock = mock.clock(on, { now: 3_600_000 })
  engine(on, [])
  await $.session.start({ cwd: '/home/op/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(9000)

  const busy = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await busy.find({ type: 'Text', text: /KERNEL:\/\/ops/ })).toBeDefined()
  await busy.unmount()

  await $.turn.complete(TURN)
  await clock.advance(9000)

  const idle = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await idle.find({ type: 'Text', text: /MATRIX:\/\/idle/ })).toBeDefined()
  expect(await idle.find({ type: 'Client', key: 'rain' })).toBeDefined()

  // The rain draws glyphs, and each frame falls on from the last.
  await idle.resize({ columns: 30, rows: 12, in: 'rain' })
  await idle.advance(700)
  const early = JSON.stringify(await idle.drawn({ in: 'rain' }))
  await idle.advance(700)
  const later = JSON.stringify(await idle.drawn({ in: 'rain' }))
  expect(await idle.find({ type: 'Text', text: /[0-9A-FλΣΩΨπΔΦ@#$%&*+=<>:;|]/, in: 'rain' })).toBeDefined()
  expect(later).not.toBe(early)
  await idle.unmount()
})

test('the decrypt client scrambles, resolves to the text, then says so', async ($, on) => {
  // The terminal's element table, taken from a drawing of the test's own.
  let elements: unknown
  on('ui.render', { component: 'Pane', requestId: 'grab' }, ($, e) => {
    const table = $.ui.resolve(e)
    elements = table

    return <table.Text>grabbed</table.Text>
  })
  await (await $.ui.mount({ ...PANE, requestId: 'grab', surface: 'terminal' })).unmount()

  // The module is driven by hand here: its timers fire as frames, its posts are kept.
  let state: unknown
  const timers: (() => void)[] = []
  const posts: unknown[] = []
  const surface = {
    elements: elements as Parameters<typeof Decrypt>[1]['elements'],
    get state() {
      return state as { frame: number } | undefined
    },
    setState: (next: { frame: number }) => {
      state = next
    },
    columns: 60,
    rows: 2,
    every: (_ms: number, fn: () => void) => {
      timers.push(fn)
      return () => void timers.splice(timers.indexOf(fn), 1)
    },
    onPointer: () => () => undefined,
    onKey: () => () => undefined,
    post: (data: unknown) => void posts.push(data),
  }
  const props = { text: 'Access granted.', isFirst: true, colors: { glyph: 'green', bullet: 'cyan' } }

  const first = JSON.stringify(Decrypt(props, surface))
  for (let frame = 0; frame < 30; frame += 1) for (const fire of [...timers]) fire()
  const last = JSON.stringify(Decrypt(props, surface))

  expect(first).not.toContain('Access granted.')
  expect(last).toContain('Access granted.')
  expect(posts).toEqual([{ done: true }])
  expect(timers).toEqual([])
})

test('a new reply decrypts in fullscreen; history and the main screen draw plainly', async ($, on) => {
  const clock = mock.clock(on, { now: 3_600_000 })
  engine(on, [])
  await $.session.start({ cwd: '/home/op/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })

  const reply = { surface: 'terminal', component: 'AssistantMessage', props: { text: 'Fixed it.', isFirstOfReply: true } } as const
  expect(await $.ui.render({ ...reply, requestId: 'msg_new', viewport: FULLSCREEN })).toMatchObject({ type: 'Client' })
  expect(await $.ui.render({ ...reply, requestId: 'msg_main', viewport: { columns: 100, rows: 40 } })).toMatchObject({ type: 'Text' })

  await $.turn.complete(TURN)
  await clock.advance(5000)
  expect(await $.ui.render({ ...reply, requestId: 'msg_old', viewport: FULLSCREEN })).toMatchObject({ type: 'Text' })
})

test('prompt glow marks actions, danger words, files and code', async () => {
  const colors = { file: 'cyan', danger: 'red', action: 'yellow', code: 'green', command: 'magenta' }
  const runs = glowOf('fix the login bug in src/auth.ts, then run `npm test`', colors)

  expect(runs).toContainEqual({ start: 0, end: 3, color: 'yellow', bold: true })
  expect(runs).toContainEqual({ start: 14, end: 17, color: 'red', bold: true })
  expect(runs).toContainEqual({ start: 21, end: 32, color: 'cyan', bold: true })
  expect(runs).toContainEqual({ start: 43, end: 53, color: 'green', bold: true })
  expect(glowOf('/deck theme neon', colors)).toContainEqual({ start: 0, end: 5, color: 'magenta', bold: true })
  expect(glowOf('hello there', colors)).toEqual([])
})

test('/proc parses into the figures the HUD shows', async () => {
  const before = parseProc(procSample(0))
  const after = parseProc(procSample(1))

  expect(before).toMatchObject({ memTotal: 16_384_000_000, memAvailable: 8_192_000_000 })
  expect(before && after ? cpuPercent(before, after) : null).toBe(25)
  expect(parseProc('not proc')).toBe(null)
})

test('the prompt box counts, finds paths and flags secrets', async () => {
  expect(counterOf('fix the bug')).toBe('⟨11 ch · ~3 tok⟩')
  expect(counterOf('line one\nline two')).toBe('⟨2 ln · 17 ch · ~5 tok⟩')

  expect(pathsOf('look at @src/auth.ts and README.md please')).toEqual([
    { end: 20, path: 'src/auth.ts' },
    { end: 34, path: 'README.md' },
  ])

  const draft = 'use key sk-ant-api03-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok'
  expect(secretsOf(draft)).toEqual([
    { start: 8, end: 43 },
    { start: 48, end: 88 },
  ])
  expect(secretsOf('password = hunter2hunter')).toEqual([{ start: 0, end: 24 }])
  expect(secretsOf('fix the login bug in src/auth.ts')).toEqual([])
})
