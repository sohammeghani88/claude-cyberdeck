import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelEffort, PromptDecoration, Register, Timer } from 'claude-code'

import type { Host, Op, Sys, ThemeName, Usage } from '../types'
import { diffOf, METER_CELLS, meterOf } from './diff'
import { parseNumstat, parseStatus } from './git'
import { counterOf, glowOf, pathsOf, secretsOf } from './glow'
import { CPU_TEMP_PROBE, cpuPercent, gibOf, GPU_PROBE, parseCpuTemp, parseGpu, parseProc } from './sys'
import type { ProcSample } from './sys'

const PANE = 'ops'
const BANNER = 'banner'
const MAX_OPS = 200
// How long the ops pane stays on the log after a turn before the rain starts.
const RAIN_AFTER_MS = 8000
// Longer replies skip the decrypt effect and draw at once.
const DECRYPT_MAX = 3000
const FILE_CYAN = '#00e5ff'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const ops = atom({ plugin: 'cyberdeck', key: 'ops' } as const, [], { shape: 'ops-1' })
const seq = atom({ plugin: 'cyberdeck', key: 'seq' } as const, 0)
const faults = atom({ plugin: 'cyberdeck', key: 'faults' } as const, 0)
const host = atom(
  { plugin: 'cyberdeck', key: 'host' } as const,
  { cwd: '', branch: null, ahead: 0, files: 0, added: 0, removed: 0, offsetMinutes: 0 },
  { shape: 'host-2' },
)
const usage = atom(
  { plugin: 'cyberdeck', key: 'usage' } as const,
  { contextPercent: null, usd: null, startedAt: null, limits: [] },
  { shape: 'usage-2' },
)
const sys = atom(
  { plugin: 'cyberdeck', key: 'sys' } as const,
  { cpu: [], memUsed: 0, memTotal: 0, cpuTemp: null, gpu: null },
  { shape: 'sys-4' },
)
// The session's model by alias and its effort level, as last set or seen.
const model = atom({ plugin: 'cyberdeck', key: 'model' } as const, null)
const effort = atom({ plugin: 'cyberdeck', key: 'effort' } as const, null)
const now = atom({ plugin: 'cyberdeck', key: 'now' } as const, 0)
// How many boot lines are showing; -1 once the deck is up.
const boot = atom({ plugin: 'cyberdeck', key: 'boot' } as const, -1)
// Whether the main loop is mid-turn, and when it last finished one.
const isBusy = atom({ plugin: 'cyberdeck', key: 'isBusy' } as const, false)
const idleSince = atom({ plugin: 'cyberdeck', key: 'idleSince' } as const, 0)
// Replies whose decrypt effect has played out.
const decrypted = atom({ plugin: 'cyberdeck', key: 'decrypted' } as const, [])
const theme = atom({ plugin: 'cyberdeck', key: 'theme' } as const, 'matrix')
const isHidden = atom({ plugin: 'cyberdeck', key: 'isHidden' } as const, false)

type Look = { main: string; accent: string; dim: string; frame: string; warn: string; bad: string; tint: string }

const THEMES: Record<ThemeName, Look> = {
  matrix: { main: '#00ff41', accent: '#b6ff9e', dim: '#00802b', frame: '#00b32c', warn: '#e5ff00', bad: '#ff3355', tint: '#0b1f12' },
  neon: { main: '#00e5ff', accent: '#ff2bd6', dim: '#5b5fc7', frame: '#ff2bd6', warn: '#ffe600', bad: '#ff3864', tint: '#1a1033' },
  blood: { main: '#ff3b3b', accent: '#ff9a3c', dim: '#8b1a1a', frame: '#d7263d', warn: '#ffd23f', bad: '#ffffff', tint: '#2a0b0b' },
  amber: { main: '#ffb000', accent: '#ffd27f', dim: '#996a00', frame: '#cc8a00', warn: '#ffffff', bad: '#ff4d4d', tint: '#2a1d00' },
  ghost: { main: '#e6e6e6', accent: '#ffffff', dim: '#6b6b6b', frame: '#4a4a4a', warn: '#c0c0c0', bad: '#ff5f5f', tint: '#1c1c1c' },
  glacier: { main: '#7dd3fc', accent: '#e0f7ff', dim: '#3b6e8f', frame: '#38bdf8', warn: '#ffe08a', bad: '#ff6b8b', tint: '#0a1a2a' },
}
const THEME_NAMES = Object.keys(THEMES) as ThemeName[]
const isThemeName = (name: string): name is ThemeName => (THEME_NAMES as readonly string[]).includes(name)

const VERBS: Record<string, string> = {
  Read: 'READ', Write: 'WRITE', Edit: 'PATCH', MultiEdit: 'PATCH', NotebookEdit: 'PATCH',
  Bash: 'EXEC', Grep: 'SCAN', Glob: 'PROBE', WebFetch: 'FETCH', WebSearch: 'QUERY',
  Agent: 'SPAWN', Task: 'SPAWN', TodoWrite: 'PLAN', Skill: 'LOAD',
}
const verbOf = (tool: string) => VERBS[tool] ?? (tool.startsWith('mcp__') ? 'RPC' : 'CALL')

// The first of these a tool's input holds is what its log row names.
const TARGET_FIELDS = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'skill']
const targetOf = (input: object) => {
  const fields = input as Record<string, unknown>
  for (const key of TARGET_FIELDS) {
    const value = fields[key]
    if (typeof value === 'string' && value !== '') {
      return key.endsWith('_path') ? value.split('/').slice(-2).join('/') : value.replace(/\s+/g, ' ')
    }
  }

  return ''
}

const SPINNER: Record<'requesting' | 'responding' | 'thinking' | 'tool-input' | 'tool-use', readonly string[]> = {
  thinking: ['Decrypting thought vectors', 'Running inference', 'Compiling neural lattice', 'Traversing latent space', 'Simulating outcomes'],
  'tool-input': ['Assembling payload', 'Encoding instructions', 'Building exploit chain', 'Staging operands'],
  'tool-use': ['Executing payload', 'Forking processes', 'Tracing syscalls', 'Patching binaries', 'Spawning daemons', 'Resolving symbols'],
  requesting: ['Handshaking', 'Establishing uplink', 'Routing packets', 'Negotiating TLS'],
  responding: ['Transmitting', 'Streaming bytes', 'Decoding response', 'Writing to stdout'],
}

// Transcript rows drawn as one compact line once the call is done; any other
// tool's row (a subagent's progress, a plan) keeps the engine's drawing.
const COMPACT_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])
// Tools that change files, and so move the HUD's git radar.
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const TEST_COMMAND = /\b(pytest|jest|vitest|mocha|rspec|phpunit|unittest)\b|\b(cargo|go|npm|pnpm|yarn|bun|deno|mix|dotnet) (run )?test\b|\bnpm t\b|\bmake test\b/
const BARS = '▁▂▃▄▅▆▇█'
const GLITCH: Record<string, string> = { C: 'Ç', Y: '¥', B: 'ß', E: 'Ξ', R: 'Я', D: 'Ð', K: 'Ҝ' }

// ANSI Shadow letters, six rows each, every row of a letter one width.
const GLYPHS: Record<string, readonly string[]> = {
  C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
  Y: ['██╗   ██╗', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚██╔╝  ', '   ██║   ', '   ╚═╝   '],
  B: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██████╔╝', '╚═════╝ '],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  K: ['██╗  ██╗', '██║ ██╔╝', '█████╔╝ ', '██╔═██╗ ', '██║  ██╗', '╚═╝  ╚═╝'],
}
const BANNER_WORD = [...'CYBERDECK']
// The banner's letters span 73 columns; narrower, it draws one spaced line.
const BANNER_COLUMNS = 76

const hashOf = (seed: string) => {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(hash)
}

// The same seed always picks the same entry, so a redraw never flickers.
const pick = (list: readonly string[], seed: string, fallback: string) => list[hashOf(seed) % list.length] ?? fallback

// A colour `t` of the way from one #rrggbb to another.
const mix = (from: string, to: string, t: number) => {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16)
  const blend = (at: number) =>
    Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * t).toString(16).padStart(2, '0')
  return `#${blend(1)}${blend(3)}${blend(5)}`
}

const pad = (n: number) => String(n).padStart(2, '0')
const clockOf = (ms: number, offsetMinutes: number) => {
  const local = new Date(ms + offsetMinutes * 60_000)
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
}
const durationOf = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${pad(Math.floor(ms / 1000) % 60)}s`
const hexOf = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`
const homeless = (path: string) => path.replace(/^\/(home|Users)\/[^/]+/, '~')
const fit = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)

// Every ninth second the title glitches for one tick.
const glitched = (word: string, at: number) => {
  const second = Math.floor(at / 1000)
  return second % 9 === 0 ? [...word].map((ch, i) => ((i + second) % 3 === 0 ? GLITCH[ch] ?? ch : ch)).join('') : word
}

const bootLines = (place: Host) => [
  'cyberdeck v2.0.77 :: cold boot',
  'mounting neural interface',
  'handshake anthropic://claude',
  'loading toolchain',
  `linking ${homeless(place.cwd) || '~'}${place.branch ? ` ⎇ ${place.branch}` : ''}`,
  'ACCESS GRANTED — systems online',
]

const offsetOf = (stamp: string) => {
  const parts = /^([+-])(\d\d)(\d\d)/.exec(stamp.trim())
  return parts ? (parts[1] === '-' ? -1 : 1) * (Number(parts[2]) * 60 + Number(parts[3])) : 0
}

// A git command's output in the folder; empty where it fails (no repository,
// no commit yet). It takes no lock, so it never blocks the person's own git.
const gitOut = ($: EngineInterface, cwd: string, args: string[]) =>
  $.process.run(['git', '--no-optional-locks', ...args], { cwd }).then(
    ran => (ran.exitCode === 0 ? ran.stdout : ''),
    () => '',
  )

// Refreshes can overlap; only the latest one writes.
let hostRuns = 0

const refreshHost = async ($: EngineInterface, cwd: string) => {
  const run = ++hostRuns
  const branch = await $.process.run(['git', 'branch', '--show-current'], { cwd }).then(
    ran => (ran.exitCode === 0 && ran.stdout.trim() !== '' ? ran.stdout.trim() : null),
    () => null,
  )
  const [status, diff, offsetMinutes] = await Promise.all([
    gitOut($, cwd, ['status', '--porcelain=v2', '--branch']).then(parseStatus),
    gitOut($, cwd, ['diff', '--numstat', 'HEAD']).then(parseNumstat),
    $.process.run(['date', '+%z']).then(ran => offsetOf(ran.stdout), () => 0),
  ])
  const fresh: Host = { cwd, branch, ...status, ...diff, offsetMinutes }
  const was = await read($, host)
  // Every prompt row reads this, so an unchanged value is not written again.
  if (run === hostRuns && (Object.keys(fresh) as Array<keyof Host>).some(key => was[key] !== fresh[key])) {
    await update($, host, () => fresh)
  }
}

const refreshUsage = async ($: EngineInterface) => {
  const { context, cost, startedAt, rateLimits } = await $.session.usage()
  const limits = rateLimits.map(limit => {
    const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
    return { kind: limit.kind, percent: limit.percentUsed, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
  })
  const figures: Usage = { contextPercent: context.percent ?? null, usd: cost?.usd ?? null, startedAt, limits }
  await update($, usage, () => figures)
}

const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

// Time left until a window resets: 42m, 2h14m, 3d4h.
const resetOf = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return minutes < 60 ? `${minutes}m`
    : minutes < 1440 ? `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`
    : `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`
}

const heatOf = (percent: number, look: Look) => (percent < 60 ? look.main : percent < 85 ? look.warn : look.bad)

// Warm and hot in °C. An Intel HX CPU throttles at 100°C and runs in the 80s
// and low 90s under load; an NVIDIA laptop GPU holds itself near 87°C.
const CPU_HEAT = [80, 95] as const
const GPU_HEAT = [75, 87] as const
// Fixed, not the theme's: blood's calm is red and its alarm white. Blue to yellow
// stays apart for color-blind eyes, and hot is a block that no palette hides.
const COOL = '#4da6ff'
const WARM = '#ffd23f'
const HOT = '#ff3b3b'

// A reload starts the module over, and drops the old timers with it.
let ticker: Timer | undefined
let booter: Timer | undefined
let lastSample: ProcSample | undefined
// When each reply on screen began decrypting; null for one drawn plainly.
const decrypting = new Map<string, number | null>()

const sampleSystem = async ($: EngineInterface) => {
  const ran = await $.process.run(['cat', '/proc/stat', '/proc/meminfo'])
  const sample = ran.exitCode === 0 ? parseProc(ran.stdout) : null
  if (sample === null) return

  const heat = await $.process.run(CPU_TEMP_PROBE).then(
    probed => (probed.exitCode === 0 ? parseCpuTemp(probed.stdout) : null),
    () => null,
  )

  const before = lastSample
  lastSample = sample
  await update($, sys, (was): Sys => ({
    cpu: before === undefined ? was.cpu : [...was.cpu, cpuPercent(before, sample)].slice(-24),
    memUsed: sample.memTotal - sample.memAvailable,
    memTotal: sample.memTotal,
    cpuTemp: heat,
    gpu: was.gpu,
  }))
}

const sampleGpu = async ($: EngineInterface) => {
  const ran = await $.process.run(GPU_PROBE, { timeoutMs: 5000 })
  const sample = ran.exitCode === 0 ? parseGpu(ran.stdout) : null
  await update($, sys, (was): Sys => {
    if (sample === null) return { ...was, gpu: null }
    const busy = [...(was.gpu?.busy ?? []), sample === 'asleep' ? 0 : sample.busy].slice(-24)

    return sample === 'asleep'
      ? { ...was, gpu: { busy, isAsleep: true, memUsed: 0, memTotal: was.gpu?.memTotal ?? 0, temp: null } }
      : { ...was, gpu: { busy, isAsleep: false, memUsed: sample.memUsed, memTotal: sample.memTotal, temp: sample.temp } }
  })
}

// The aliases the /config Model row offers, and /effort's levels.
const MODELS = ['opus', 'sonnet', 'haiku', 'fable']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_LABELS: Record<string, string> = { medium: 'med' }
const aliasOf = (id: string) => MODELS.find(name => id.includes(name)) ?? id

const switchModel = async ($: EngineInterface, name: string) => {
  const set = await $.config.set({ key: 'model', value: name })
  if (set.deny !== undefined) {
    $.ui.toast(`[deck] model stays: ${set.deny}`)
    return
  }
  await update($, model, () => name)
  $.ui.toast(`[deck] model → ${name}`)
}

// Whether each path a draft named was there, kept briefly so typing stays cheap.
const pathChecks = new Map<string, { exists: boolean; at: number }>()

const fullPathOf = (path: string, cwd: string) => {
  const home = /^\/(?:home|Users)\/[^/]+/.exec(cwd)?.[0]
  return path.startsWith('/') ? path : path.startsWith('~/') && home ? `${home}${path.slice(1)}` : `${cwd}/${path}`
}

// The box's marks from what is known now: glow, a mark after each checked
// path, secrets flagged, a counter at the end. Drawn only, never sent.
const decorationsOf = (text: string, look: Look, cwd: string): PromptDecoration[] => [
  ...glowOf(text, { file: FILE_CYAN, danger: look.bad, action: look.warn, code: look.main, command: look.accent }),
  ...pathsOf(text).flatMap(found => {
    const exists = pathChecks.get(fullPathOf(found.path, cwd))?.exists
    // A bare name may live anywhere in the project, so only its presence is marked.
    if (exists === undefined || (!exists && !found.path.includes('/'))) return []
    return [{ start: found.end, end: found.end, virtualText: exists ? ' ✓' : ' ✗', color: exists ? look.main : look.bad }]
  }),
  ...secretsOf(text).flatMap(({ start, end }) => [
    { start, end, color: look.bad, bold: true, underline: true },
    { start: end, end, virtualText: ' ⚠ secret', color: look.bad, bold: true },
  ]),
  ...(text.trim() === '' ? [] : [{ start: text.length, end: text.length, virtualText: `  ${counterOf(text)}`, color: look.dim }]),
]

// Looks up the paths the cache lacks or holds stale, then repaints the box if
// an answer changed. A stat takes too long to wait for between two keys.
const checkPaths = async ($: EngineInterface, text: string, look: Look, cwd: string) => {
  let isChanged = false
  for (const found of pathsOf(text)) {
    const full = fullPathOf(found.path, cwd)
    const at = await $.clock.now()
    const cached = pathChecks.get(full)
    if (cached !== undefined && at - cached.at < 5000) continue
    const exists = await $.fs.stat(full).then(() => true, () => false)
    pathChecks.set(full, { exists, at })
    isChanged ||= cached?.exists !== exists
  }
  if (isChanged) await $.prompt.paint({ text, decorations: decorationsOf(text, look, cwd) })
}

// A level clicked while a reply runs: Claude Code queues the /effort it runs
// until the reply ends, so until then the deck sends the level itself.
let pendingEffort: string | undefined

const switchEffort = async ($: EngineInterface, level: string) => {
  pendingEffort = level
  await update($, effort, () => level)
  $.ui.toast(`[deck] effort → ${level}`)
  await $.command.run({ command: 'effort', args: level }).finally(() => {
    if (pendingEffort === level) pendingEffort = undefined
  })
}

const startBoot = async ($: EngineInterface) => {
  booter?.cancel()
  await update($, boot, () => 0)
  const total = bootLines(await read($, host)).length
  booter = $.clock.every(220, () => void stepBoot($, total))
}

// Hold the last line a moment before the deck comes up.
const stepBoot = async ($: EngineInterface, total: number) => {
  const step = await update($, boot, was => (was < 0 || was >= total + 4 ? -1 : was + 1))
  if (step < 0) booter?.cancel()
}

const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, now, () => at)
  const second = Math.floor(at / 1000)
  if (second % 5 === 0) await refreshUsage($)
  if (second % 2 === 0 && !(await read($, isHidden))) await sampleSystem($)
  // Each nvidia-smi call keeps the GPU up a while, so it is asked less often.
  if (second % 10 === 0 && !(await read($, isHidden))) await sampleGpu($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deck',
      description: 'CYBERDECK: /deck toggles the HUD · /deck theme <matrix|neon|blood|amber|ghost|glacier> [here] · /deck ops · /deck boot',
    })
    const saved = await $.store.get('theme')
    if (typeof saved === 'string' && isThemeName(saved)) await update($, theme, () => saved)
    const at = await $.clock.now()
    await update($, now, () => at)
    await update($, idleSince, () => at)
    await refreshHost($, e.cwd).catch(() => undefined)
    await refreshUsage($).catch(() => undefined)
    const modelRow = await $.config.list().then(rows => rows.find(row => row.key === 'model'), () => undefined)
    if (typeof modelRow?.value === 'string') {
      const alias = aliasOf(modelRow.value)
      await update($, model, () => alias)
    }
    ticker?.cancel()
    ticker = $.clock.every(1000, () => void tick($).catch(() => undefined))
    // At a session's start the transcript is empty, so this row is its top.
    await $.ui.place({ id: BANNER }).catch(() => undefined)
    await startBoot($)

    return next(e)
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const [verb = '', arg = '', scope = ''] = (e.args ?? '').trim().split(/\s+/)

    if (verb === 'theme') {
      if (!isThemeName(arg)) {
        return { text: `[deck] unknown theme "${arg}". available: ${THEME_NAMES.join(' · ')}` }
      }
      await update($, theme, () => arg)
      if (scope === 'here') {
        return { text: `[deck] theme → ${arg} for this session only; new sessions keep the default` }
      }
      await $.store.set('theme', arg)

      const label = `${arg[0]?.toUpperCase() ?? ''}${arg.slice(1)}`

      return { text: `[deck] theme → ${arg} · pick "CYBERDECK ${label}" in /theme to recolor the rest of Claude Code` }
    }

    if (verb === 'ops') {
      const shown = await $.ui.open({ id: PANE, title: 'KERNEL://ops' })

      return { text: shown.isPlaced ? '[deck] ops log attached.' : '[deck] ops log queued: it opens once the terminal is wide enough.' }
    }

    if (verb === 'boot') {
      await update($, isHidden, () => false)
      await startBoot($)

      return { text: '[deck] rebooting…' }
    }

    if (verb !== '') {
      return { text: `[deck] unknown command "${verb}". try: /deck · /deck theme <name> · /deck ops · /deck boot` }
    }

    const hidden = await update($, isHidden, was => !was)

    return { text: hidden ? '[deck] HUD offline. /deck to reconnect.' : '[deck] HUD online.' }
  })

  // A typed /effort or /model moves the HUD's switches at once.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const ran = await next(e)
    const level = (e.args ?? '').trim()
    if (EFFORTS.includes(level)) await update($, effort, () => level)

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const ran = await next(e)
    const name = (e.args ?? '').trim()
    if (name !== '') {
      const alias = aliasOf(name)
      await update($, model, () => alias)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const started = await $.clock.now()
    const number = await update($, seq, n => n + 1)
    const op: Op = { id, seq: number, at: started, verb: verbOf(String(e.tool)), target: targetOf(e), ms: null, isOk: null }
    await update($, ops, list => [...list, op].slice(-MAX_OPS))

    const ran = await next(e)
    const ms = (await $.clock.now()) - started
    const isOk = ran.deny === undefined && ran.isError !== true
    await update($, ops, list => list.map(one => (one.id === id ? { ...one, ms, isOk } : one)))
    if (!isOk) await update($, faults, n => n + 1)
    if (isOk && EDIT_TOOLS.has(String(e.tool))) await refreshHost($, (await read($, host)).cwd).catch(() => undefined)

    if (e.tool === 'Bash' && ran.deny === undefined) {
      if (TEST_COMMAND.test(e.command)) {
        $.ui.toast(isOk ? '[ ACCESS GRANTED ] test suite passed' : '[ INTRUSION DETECTED ] test suite failed — tracing…')
      } else if (isOk && /\bgit\s+commit\b/.test(e.command)) {
        $.ui.toast('[ COMMIT SIGNED ] changes sealed into history')
      } else if (isOk && /\bgit\s+push\b/.test(e.command)) {
        $.ui.toast('[ UPLINK ] payload pushed to remote')
      }
      if (/\bgit\b/.test(e.command)) await refreshHost($, (await read($, host)).cwd).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Each request names the model and effort it really runs on, whoever set them.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const seen = { model: aliasOf(e.model), effort: e.effort }
      await update($, model, () => seen.model)
      // A clicked level not yet applied rides on this request instead of the old one.
      if (pendingEffort !== undefined && seen.effort !== undefined && seen.effort !== pendingEffort) {
        return yield* next({ ...e, effort: pendingEffort as ModelEffort })
      }
      if (typeof seen.effort === 'string') await update($, effort, () => String(seen.effort))
    }

    return yield* next(e)
  })

  // A subagent's turns run beside the main one; only the main loop's count.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, isBusy, () => true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, isBusy, () => false)
      await update($, idleSince, () => at)
      // A reply may have changed files through the shell too.
      await refreshHost($, (await read($, host)).cwd).catch(() => undefined)
    }

    return done
  })

  // Each key the person types: the marks ride on the box the editor shows next.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (await read($, isHidden)) {
      return box
    }

    const look = THEMES[await read($, theme)]
    const cwd = (await read($, host)).cwd
    const decorations = decorationsOf(box.text, look, cwd)
    void checkPaths($, box.text, look, cwd).catch(() => undefined)

    return { ...box, decorations: [...(box.decorations ?? []), ...decorations] }
  }).catch(($, e, next) => next(e))

  // A draft that arrives some other way (history, a clear) is painted after.
  on('prompt.change', async ($, e, next) => {
    const changed = await next(e)
    if (!(await read($, isHidden))) {
      const look = THEMES[await read($, theme)]
      const cwd = (await read($, host)).cwd
      void $.prompt.paint({ text: changed.text, decorations: decorationsOf(changed.text, look, cwd) }).catch(() => undefined)
      void checkPaths($, changed.text, look, cwd).catch(() => undefined)
    }

    return changed
  })

  on('ui.message', { component: 'AssistantMessage' }, async ($, e, next) => {
    const isDone = typeof e.data === 'object' && e.data !== null && 'done' in e.data
    if (isDone) await update($, decrypted, list => [...list.filter(id => id !== e.requestId), e.requestId].slice(-100))

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Only the fullscreen transcript redraws a row once it is printed; on the
    // main screen a row is drawn once, and a half-decrypted frame would stay.
    const started = decrypting.get(e.requestId)
    const isEligible = e.surface === 'terminal' && e.viewport?.isFullscreen === true && !e.props.isSummary && e.props.text.length <= DECRYPT_MAX
    if (!isEligible || started === null || (await read($, isHidden))) {
      return next(e)
    }

    // Read on first sight too, so the client's "done" redraws the row at once.
    const at = await read($, now)
    const done = await read($, decrypted)
    if (started === undefined) {
      // A reply first drawn mid-turn, or just after one, is new; any other is history.
      const isLive = (await read($, isBusy)) || at - (await read($, idleSince)) < 3000
      decrypting.set(e.requestId, isLive ? at : null)
      if (!isLive) return next(e)
    } else if (done.includes(e.requestId) || at - started > 6000) {
      // Played out, or its client never said so: the engine draws it from here.
      decrypting.set(e.requestId, null)
      return next(e)
    }

    const { Client } = $.ui.resolve(e)
    const look = THEMES[await read($, theme)]

    return (
      <Client
        key="decrypt"
        module="./decrypt.client.tsx"
        width="100%"
        props={{ text: e.props.text, isFirst: e.props.isFirstOfReply, colors: { glyph: look.main, bullet: look.accent } }}
      />
    )
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    // The desktop's word says what the step does; only the terminal's is flavour.
    if (e.surface !== 'terminal' || (await read($, isHidden))) {
      return next(e)
    }

    const word = pick(SPINNER[e.props.mode], e.props.word, e.props.word)

    return next({ ...e, props: { ...e.props, word, suffix: ' ▌' } })
  })

  // The line after each reply is left out: the reply runs straight into the
  // next prompt. ctrl+o, and a line still waiting on agents, keep the engine's.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded || e.props.waitingFor || (await read($, isHidden))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'Placed', props: { plugin: 'cyberdeck', id: BANNER } }, async ($, e, next) => {
    if (await read($, isHidden)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const look = THEMES[await read($, theme)]
    const place = await read($, host)
    const colors = BANNER_WORD.map((_, i) => mix(look.main, look.accent, i / (BANNER_WORD.length - 1)))
    const rows = GLYPHS.C?.map((_, row) => row) ?? []

    return (
      <Box flexDirection="column" marginY={1}>
        {(e.viewport?.columns ?? 80) >= BANNER_COLUMNS ? (
          rows.map(row => (
            <Text>
              {BANNER_WORD.map((ch, i) => <Text color={colors[i]}>{GLYPHS[ch]?.[row] ?? ''}</Text>)}
            </Text>
          ))
        ) : (
          <Text weight="bold">
            {BANNER_WORD.map((ch, i) => <Text color={colors[i]}>{`${ch} `}</Text>)}
          </Text>
        )}
        <Text wrap="truncate">
          <Text color={look.dim}>░▒▓ </Text>
          <Text color={look.main} weight="bold">NEURAL UPLINK ESTABLISHED</Text>
          <Text color={look.dim}> ▓▒░  </Text>
          <Text color={look.accent}>{homeless(place.cwd) || '~'}</Text>
          <Text color={look.dim}>{`${place.branch ? ` ⎇ ${place.branch}` : ''} · /deck for controls`}</Text>
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    // ctrl+o shows the engine's full row; other senders keep their labels.
    if (e.surface !== 'terminal' || e.props.isExpanded || e.props.origin.kind !== 'composer' || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const look = THEMES[await read($, theme)]

    // A coloured edge and a tinted wash across the row, so the person's turns
    // stand apart from the replies at a glance.
    return (
      <Box flexDirection="row" width="100%" backgroundColor={look.tint}>
        <Text color={look.main} backgroundColor={look.tint}>▌</Text>
        <Text color={look.main} backgroundColor={look.tint} weight="bold"> ❯ </Text>
        <Text color={look.accent} backgroundColor={look.tint} wrap="wrap">{e.props.text}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    // While it runs the engine's row shows its live output; ctrl+o shows all.
    const isCompact = e.surface === 'terminal' && !e.props.isRunning && !e.props.isExpanded && COMPACT_TOOLS.has(e.props.tool)
    if (!isCompact || (await read($, isHidden))) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)
    const look = THEMES[await read($, theme)]
    const input = e.props.input
    const target = typeof input === 'object' && input !== null ? targetOf(input) : ''
    // A finished edit shows the lines it added and removed, and a size meter.
    const diff = diffOf(e.props.tool, e.props.output)
    const filled = diff === null ? 0 : meterOf(diff)

    return (
      <Text wrap="truncate">
        <Text color={look.accent}>▸ </Text>
        <Text color={look.main} weight="bold">{`${verbOf(e.props.tool).padEnd(5)} `}</Text>
        <Text>{`${target} `}</Text>
        {e.props.isInterrupted ? (
          <Text color={look.warn}>⊘ interrupted</Text>
        ) : e.props.isErrored ? (
          <Text color={look.bad}>✗ fault</Text>
        ) : diff !== null && diff.added + diff.removed > 0 ? (
          <Text>
            {diff.added > 0 && <Text color={look.main}>{`+${diff.added} `}</Text>}
            {diff.removed > 0 && <Text color={look.bad}>{`−${diff.removed} `}</Text>}
            <Text color={look.main}>{'▰'.repeat(filled)}</Text>
            <Text color={look.dim}>{'▱'.repeat(METER_CELLS - filled)}</Text>
          </Text>
        ) : (
          <Text color={look.main}>✓</Text>
        )}
      </Text>
    )
  })

  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) => {
    if (await read($, isHidden)) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)
    const look = THEMES[await read($, theme)]

    return (
      <Text>
        <Text color={look.dim}>[ sys ] </Text>
        <Text color={look.main}>{e.props.text}</Text>
        {e.props.command !== null && <Text color={look.accent}>{` ${e.props.command}`}</Text>}
      </Text>
    )
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'deck' } }, async ($, e, next) => {
    if (e.props.isErrored) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)
    const look = THEMES[await read($, theme)]

    return (
      <Text>
        <Text color={look.accent} weight="bold">[deck] </Text>
        <Text color={look.main}>{e.props.text.replace(/^(cyberdeck: )?\[deck\] /, '')}</Text>
      </Text>
    )
  })

  // The HUD sits under the prompt box: the engine's own hint line (shortcuts,
  // esc to interrupt), then the deck in its frame.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || (await read($, isHidden))) {
      return next(e)
    }

    const hint = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const look = THEMES[await read($, theme)]
    const at = await read($, now)
    const place = await read($, host)
    const step = await read($, boot)
    // The deck spans the screen: the hint's indent takes two columns, the
    // frame's borders and padding four more.
    const width = Math.max(24, (e.viewport?.columns ?? 100) - 2)
    const inner = width - 4
    const isBlinkOn = Math.floor(at / 1000) % 2 === 0
    let rows

    if (step >= 0) {
      const lines = bootLines(place)
      rows = lines.slice(0, step).map((line, i) =>
        i === 0 ? (
          <Text color={look.dim} wrap="truncate">{`> ${line}`}</Text>
        ) : i === lines.length - 1 ? (
          <Text color={look.accent} weight="bold" wrap="truncate">{`> ${line}`}</Text>
        ) : (
          <Text wrap="truncate">
            <Text color={look.main}>{`> ${line} `}</Text>
            <Text color={look.dim}>{'.'.repeat(Math.max(3, inner - line.length - 10))}</Text>
            <Text color={look.main} weight="bold"> [ OK ]</Text>
          </Text>
        ),
      )
      if (step < lines.length) rows.push(<Text color={look.main}>{'> ▌'}</Text>)
    } else {
      const meter = await read($, usage)
      const machine = await read($, sys)
      const activeModel = await read($, model)
      const activeEffort = await read($, effort)
      const ctx = meter.contextPercent === null ? null : Math.round(meter.contextPercent)
      const ram = machine.memTotal === 0 ? null : Math.round((100 * machine.memUsed) / machine.memTotal)
      const cpuNow = machine.cpu.at(-1) ?? 0
      const gpu = machine.gpu
      const gpuNow = gpu?.busy.at(-1) ?? 0
      const vram = gpu === null || gpu.memTotal === 0 || gpu.isAsleep ? null : Math.round((100 * gpu.memUsed) / gpu.memTotal)
      // Padded alike, so the RAM and VRAM gauges line up.
      const ramUsed = ram === null ? '' : ` ${gibOf(machine.memUsed)}/${gibOf(machine.memTotal)}G`
      const vramUsed = vram === null || gpu === null ? '' : ` ${gibOf(gpu.memUsed)}/${gibOf(gpu.memTotal)}G`
      const usedWidth = Math.max(ramUsed.length, vramUsed.length)
      // A temperature takes six cells beside its percent, kept blank where the other has one.
      const tempWidth = machine.cpuTemp === null && (gpu?.temp ?? null) === null ? 0 : 6
      const tempOf = (temp: number | null, heat: readonly [number, number]) =>
        temp === null
          ? <Text>{' '.repeat(tempWidth)}</Text>
          : temp < heat[0] ? <Text color={COOL}>{` ${String(temp).padStart(3)}°C`}</Text>
          : temp < heat[1] ? <Text color={WARM}>{` ${String(temp).padStart(3)}°C`}</Text>
          : [<Text>{' '}</Text>, <Text backgroundColor={HOT} color="#000000" weight="bold">{`${String(temp).padStart(3)}°C`}</Text>]
      // Three columns share each row; a bar takes what its column's words leave.
      const column = Math.floor(inner / 3)
      const barOf = (words: number) => Math.max(6, Math.min(24, column - words))
      const trailWidth = barOf(10 + tempWidth)
      const trailOf = (samples: number[]) =>
        [
          ...Array<number | null>(Math.max(0, trailWidth - samples.length)).fill(null),
          ...samples.slice(-trailWidth),
        ].map(percent =>
          percent === null
            ? <Text color={look.dim}>▁</Text>
            : <Text color={heatOf(percent, look)}>{BARS[Math.min(7, Math.floor((percent / 100) * 8))] ?? '█'}</Text>,
        )
      const gaugeOf = (percent: number | null, width: number) => {
        if (percent === null) return <Text color={look.dim}>{`${'▱'.repeat(width)}  --%`}</Text>
        const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

        return (
          <Text>
            <Text color={heatOf(percent, look)}>{'▰'.repeat(filled)}</Text>
            <Text color={look.dim}>{'▱'.repeat(width - filled)}</Text>
            <Text color={heatOf(percent, look)}>{` ${String(Math.round(percent)).padStart(3)}%`}</Text>
          </Text>
        )
      }
      const limits = meter.limits.slice(0, 3)
      // The live choice is a solid block; the others are dim, one click away.
      const pillOf = (key: string, label: string, isOn: boolean, onPress: () => void) => (
        <Button key={key} label={label} plain onPress={onPress}>
          {isOn
            ? <Text backgroundColor={look.main} color="#000000" weight="bold">{` ${label} `}</Text>
            : <Text color={look.dim}>{` ${label} `}</Text>}
        </Button>
      )

      rows = [
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate">
            <Text color={look.accent} weight="bold">{`◢◤ ${glitched('CYBERDECK', at)} `}</Text>
            <Text color={look.accent}>{` ${homeless(place.cwd) || '~'}`}</Text>
            {place.branch !== null && <Text color={look.dim}>{` ⎇ ${place.branch}`}</Text>}
            {place.ahead > 0 && <Text color={look.warn}>{` ↑${place.ahead}`}</Text>}
            {place.files > 0 && <Text color={look.accent}>{` ✎${place.files}`}</Text>}
            {place.added > 0 && <Text color={look.main}>{` +${place.added}`}</Text>}
            {place.removed > 0 && <Text color={look.bad}>{` −${place.removed}`}</Text>}
          </Text>
          <Text>
            {e.props.isWorking
              ? <Text color={look.bad} weight="bold">{isBlinkOn ? '● live' : '○ live'}</Text>
              : <Text color={look.dim}>○ idle</Text>}
            <Text color={look.main}>{`  ${clockOf(at, place.offsetMinutes)}`}</Text>
          </Text>
        </Box>,
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate">
            <Text color={look.dim}>ctx </Text>
            {gaugeOf(ctx, barOf(10))}
          </Text>
          <Box flexDirection="column">
            <Text wrap="truncate">
              <Text color={look.dim}>cpu </Text>
              {trailOf(machine.cpu)}
              <Text color={heatOf(cpuNow, look)}>{` ${String(cpuNow).padStart(3)}%`}</Text>
              {tempOf(machine.cpuTemp, CPU_HEAT)}
            </Text>
            {gpu !== null && (
              <Text wrap="truncate">
                <Text color={look.dim}>gpu </Text>
                {trailOf(gpu.busy)}
                {gpu.isAsleep
                  ? <Text color={look.dim}>  zzz</Text>
                  : <Text color={heatOf(gpuNow, look)}>{` ${String(gpuNow).padStart(3)}%`}</Text>}
                {tempOf(gpu.temp, GPU_HEAT)}
              </Text>
            )}
          </Box>
          <Box flexDirection="column" alignItems="flex-end">
            <Text wrap="truncate">
              <Text color={look.dim}>ram </Text>
              {gaugeOf(ram, barOf(20))}
              <Text color={look.dim}>{ramUsed.padStart(usedWidth)}</Text>
            </Text>
            {gpu !== null && (
              <Text wrap="truncate">
                <Text color={look.dim}>vram </Text>
                {gaugeOf(vram, barOf(20))}
                <Text color={look.dim}>{vramUsed.padStart(usedWidth)}</Text>
              </Text>
            )}
          </Box>
        </Box>,
        limits.length === 0 ? (
          <Text color={look.dim} wrap="truncate">
            limits  5h --   7d --   (plan usage shows after the next reply; none on API-key billing)
          </Text>
        ) : (
          <Box flexDirection="row" justifyContent="space-between">
            {limits.map(limit => (
              <Text wrap="truncate">
                <Text color={look.dim}>{`${LIMIT_LABELS[limit.kind] ?? limit.kind} `}</Text>
                {gaugeOf(limit.percent, barOf(20))}
                <Text color={look.dim}>{limit.resetsAt === null ? '' : ` ↻ ${resetOf(limit.resetsAt - at)}`}</Text>
              </Text>
            ))}
          </Box>
        ),
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text color={look.dim}>model </Text>
            {MODELS.map(name => pillOf(`model-${name}`, name, activeModel === name, () => void switchModel($, name)))}
          </Box>
          <Box flexDirection="row">
            <Text color={look.dim}>effort </Text>
            {EFFORTS.map(level =>
              pillOf(`effort-${level}`, EFFORT_LABELS[level] ?? level, activeEffort === level, () => void switchEffort($, level)),
            )}
          </Box>
        </Box>,
      ]
    }

    return (
      <Box flexDirection="column">
        {hint}
        <Box flexDirection="column" width={width} borderStyle="round" borderColor={look.frame} paddingX={1}>
          {rows}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const look = THEMES[await read($, theme)]
    const list = await read($, ops)
    const place = await read($, host)
    const total = await read($, seq)
    const lost = await read($, faults)
    const at = await read($, now)
    const divider = <Text color={look.dim} wrap="truncate">{'─'.repeat(e.props.bodyColumns)}</Text>
    // time 8 · addr 6 · verb 5 · status and duration 9, with the gaps between.
    const targetWidth = Math.max(8, e.props.bodyColumns - 32)
    const rowOf = (op: Op) => (
      <Text wrap="truncate">
        <Text color={look.dim}>{`${clockOf(op.at, place.offsetMinutes)} `}</Text>
        <Text color={look.accent}>{`${hexOf(op.seq)} `}</Text>
        <Text color={look.main} weight="bold">{`${op.verb.padEnd(5)} `}</Text>
        <Text color={look.main}>{`${fit(op.target, targetWidth)} `}</Text>
        {op.isOk === null ? (
          <Text color={look.warn}>⟳ running</Text>
        ) : (
          <Text color={op.isOk ? look.main : look.bad}>{`${op.isOk ? '✓' : '✗'} ${durationOf(op.ms ?? 0).padStart(6)}`}</Text>
        )}
      </Text>
    )

    // Idle a while: the rain takes the pane, the newest ops under it. The next
    // turn unmounts it and the full log comes back.
    const isIdle = !(await read($, isBusy)) && at - (await read($, idleSince)) >= RAIN_AFTER_MS
    if (e.surface === 'terminal' && isIdle && !(await read($, isHidden))) {
      const { Client } = $.ui.resolve(e)
      const recent = list.slice(-3)
      const rainRows = Math.max(3, e.props.scroll.bodyRows - 2 - recent.length)
      const colors = { head: mix(look.accent, '#ffffff', 0.6), bright: look.accent, main: look.main, dim: look.dim }

      return (
        <Box flexDirection="column">
          <Text wrap="truncate">
            <Text color={look.accent} weight="bold">MATRIX://idle</Text>
            <Text color={look.dim}>  screensaver · wakes on the next op</Text>
          </Text>
          <Client
            key="rain"
            module="./rain.client.tsx"
            width={e.props.bodyColumns}
            height={rainRows}
            props={{ columns: e.props.bodyColumns, rows: rainRows, colors }}
          />
          {divider}
          {recent.map(rowOf)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={look.accent} weight="bold">KERNEL://ops</Text>
          <Text color={look.dim}>{`  ${total} ops · ${lost} faults · uplink `}</Text>
          <Text color={look.main}>● stable</Text>
        </Text>
        {divider}
        {list.length === 0 && <Text color={look.dim}>{'> no ops yet. waiting for the first syscall…'}</Text>}
        {list.slice(-Math.max(1, e.props.scroll.bodyRows - 2)).map(rowOf)}
      </Box>
    )
  })
}
