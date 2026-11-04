export type Op = {
  id: string
  seq: number
  at: number
  verb: string
  target: string
  ms: number | null
  isOk: boolean | null
}

export type Host = { cwd: string; branch: string | null; offsetMinutes: number }

// A plan's usage window: `five_hour`, `seven_day` or `spend_limit`; resetsAt in ms.
export type Limit = { kind: string; percent: number; resetsAt: number | null }

export type Usage = { contextPercent: number | null; usd: number | null; startedAt: number | null; limits: Limit[] }

// The machine's live figures: CPU percent per sample, memory in bytes.
export type Sys = { cpu: number[]; memUsed: number; memTotal: number }

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
