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

// The CPU package's temperature: Intel's coretemp or AMD's k10temp, in millidegrees.
export const CPU_TEMP_PROBE = [
  'sh',
  '-c',
  'for h in /sys/class/hwmon/hwmon*; do case "$(cat "$h/name" 2>/dev/null)" in' +
    ' coretemp|k10temp|zenpower) exec cat "$h/temp1_input";; esac; done; exit 1',
]

// Whole degrees Celsius from the probe's millidegrees.
export const parseCpuTemp = (text: string) => {
  const milli = Number(text.trim())
  return text.trim() !== '' && Number.isFinite(milli) ? Math.round(milli / 1000) : null
}

export type GpuSample = { busy: number; memUsed: number; memTotal: number; temp: number | null }

// An NVIDIA GPU asleep in runtime D3 is left asleep, as nvidia-smi would wake it.
export const GPU_PROBE = [
  'sh',
  '-c',
  'for s in /sys/bus/pci/drivers/nvidia/*/power/runtime_status; do' +
    ' [ "$(cat "$s" 2>/dev/null)" = suspended ] && echo asleep && exit 0; done;' +
    ' exec nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
]

// The probe's first GPU: `busy, used MiB, total MiB, °C`, or `asleep`.
export const parseGpu = (text: string): GpuSample | 'asleep' | null => {
  if (text.trim() === 'asleep') return 'asleep'
  const [busy, memUsed, memTotal, temp] = (text.split('\n')[0] ?? '').split(',').map(field => Number(field.trim()))
  if (busy === undefined || memUsed === undefined || memTotal === undefined) return null
  if (![busy, memUsed, memTotal].every(Number.isFinite)) return null

  return {
    busy,
    memUsed: memUsed * 1024 ** 2,
    memTotal: memTotal * 1024 ** 2,
    temp: temp !== undefined && Number.isFinite(temp) ? temp : null,
  }
}
