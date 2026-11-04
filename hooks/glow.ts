import type { PromptDecoration } from 'claude-code'

export type GlowColors = { file: string; danger: string; action: string; code: string; command: string }

const FILE_PATTERN = /@?[\w./~-]*[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cpp|hpp|cs|swift|json|ya?ml|toml|md|sh|css|scss|html|sql|lock|env)\b/g

const RULES: ReadonlyArray<{ pattern: RegExp; color: keyof GlowColors }> = [
  {
    pattern: /\b(?:fix|refactor|deploy|build|test|run|debug|optimi[sz]e|ship|hack|add|remove|delete|create|implement|rewrite|migrate|review)\b/gi,
    color: 'action',
  },
  {
    pattern: /\b(?:bugs?|errors?|crash(?:es|ed|ing)?|fail(?:s|ed|ing|ure)?|broken|exceptions?|panic|segfault|leaks?|vuln\w*|urgent|critical|hotfix)\b/gi,
    color: 'danger',
  },
  { pattern: FILE_PATTERN, color: 'file' },
  { pattern: /`[^`\n]+`/g, color: 'code' },
  { pattern: /^\/[\w:-]+/g, color: 'command' },
]

// Key and token formats worth a second look before they reach the model.
const SECRET_PATTERNS = [
  /\bsk-ant-[\w-]{20,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[\w-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[=:]\s*\S{6,}/gi,
]

type Run = { start: number; end: number }

const runsOf = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map(match => {
    const start = match.index ?? 0
    return { start, end: start + match[0].length, found: match[0] }
  })

// Later runs win per style key, so a file name in backticks takes the code colour.
export const glowOf = (text: string, colors: GlowColors): PromptDecoration[] =>
  RULES.flatMap(({ pattern, color }) =>
    runsOf(text, pattern).map(({ start, end }) => ({ start, end, color: colors[color], bold: true })),
  )

export const secretsOf = (text: string): Run[] =>
  SECRET_PATTERNS.flatMap(pattern => runsOf(text, pattern).map(({ start, end }) => ({ start, end })))

// File paths in the draft: `path` as written less a leading @, `end` where it stops.
export const pathsOf = (text: string) =>
  runsOf(text, FILE_PATTERN).map(({ end, found }) => ({ end, path: found.replace(/^@/, '') }))

export const counterOf = (text: string) => {
  const lines = text.split('\n').length
  return `⟨${lines > 1 ? `${lines} ln · ` : ''}${text.length} ch · ~${Math.ceil(text.length / 4)} tok⟩`
}
