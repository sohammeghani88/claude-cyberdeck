export type ProcSample = { cpuIdle: number; cpuTotal: number; memTotal: number; memAvailable: number }

// /proc/stat and /proc/meminfo, read together by one `cat`.
export const parseProc = (text: string): ProcSample | null => {
  const cpu = /^cpu +([\d ]+)$/m.exec(text)?.[1]
  const memTotal = /^MemTotal:\s+(\d+) kB/m.exec(text)?.[1]
  const memAvailable = /^MemAvailable:\s+(\d+) kB/m.exec(text)?.[1]
  if (cpu === undefined || memTotal === undefined || memAvailable === undefined) return null

  const ticks = cpu.trim().split(/\s+/).map(Number)

  return {
    cpuIdle: (ticks[3] ?? 0) + (ticks[4] ?? 0),
    cpuTotal: ticks.reduce((sum, n) => sum + n, 0),
    memTotal: Number(memTotal) * 1024,
    memAvailable: Number(memAvailable) * 1024,
  }
}

// The busy share of the CPU between two samples, 0 to 100.
export const cpuPercent = (before: ProcSample, after: ProcSample) => {
  const total = after.cpuTotal - before.cpuTotal
  return total > 0 ? Math.round(100 * (1 - (after.cpuIdle - before.cpuIdle) / total)) : 0
}

export const gibOf = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)
