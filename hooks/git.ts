// `git status --porcelain=v2 --branch`: how many commits the branch leads its
// upstream by, then a line for each changed, unmerged or untracked path.
export const parseStatus = (text: string) => {
  const status = { ahead: 0, files: 0 }
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.ab ')) {
      status.ahead = Number(/\+(\d+)/.exec(line)?.[1] ?? 0)
    } else if (/^[12u?] /.test(line)) {
      status.files++
    }
  }

  return status
}

// `git diff --numstat HEAD`: the lines added and removed in each tracked file
// since the last commit, `-` for a binary file's.
export const parseNumstat = (text: string) => {
  const lines = { added: 0, removed: 0 }
  for (const line of text.split('\n')) {
    const [plus, minus] = line.split('\t')
    if (minus === undefined) continue
    lines.added += Number(plus) || 0
    lines.removed += Number(minus) || 0
  }

  return lines
}
