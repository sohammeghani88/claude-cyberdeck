export type Op = {
  id: string
  seq: number
  at: number
  verb: string
  target: string
  ms: number | null
  isOk: boolean | null
}

// The folder's git radar beside it: commits ahead of the upstream, changed
// paths, and the lines added and removed since the last commit.
export type Host = {
  cwd: string
  branch: string | null
  ahead: number
  files: number
  added: number
  removed: number
  offsetMinutes: number
}

// A plan's usage window: `five_hour`, `seven_day` or `spend_limit`; resetsAt in ms.
export type Limit = { kind: string; percent: number; resetsAt: number | null }

export type Usage = { contextPercent: number | null; usd: number | null; startedAt: number | null; limits: Limit[] }

// The NVIDIA GPU's busy percent per sample (0 while it sleeps), its memory in
// bytes, and its temperature in °C (null while it sleeps).
export type Gpu = { busy: number[]; isAsleep: boolean; memUsed: number; memTotal: number; temp: number | null }

// The machine's live figures: CPU percent per sample, memory in bytes, CPU
// temperature in °C (null where no sensor answers); gpu null where no NVIDIA GPU answers.
export type Sys = { cpu: number[]; memUsed: number; memTotal: number; cpuTemp: number | null; gpu: Gpu | null }

export type ThemeName = 'matrix' | 'neon' | 'blood' | 'amber' | 'ghost' | 'glacier'

declare module 'claude-code' {
  interface PluginState {
    cyberdeck: {
      ops: Shaped<Op[]>
      seq: number
      faults: number
      host: Shaped<Host>
      usage: Shaped<Usage>
      sys: Shaped<Sys>
      now: number
      boot: number
      isBusy: boolean
      idleSince: number
      decrypted: string[]
      model: string | null
      effort: string | null
      theme: ThemeName
      isHidden: boolean
    }
  }
}
