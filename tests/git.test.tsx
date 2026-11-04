import { expect, mock, test } from 'claude-code/testing'

import { parseNumstat, parseStatus } from '../hooks/git'

// What git printed for a branch one commit ahead of its upstream, with a
// modified file, a staged binary and an untracked file.
const STATUS = [
  '# branch.oid 08415354ef5529a1ba9f234cc3478dc6dcd4eae5',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -0',
  '1 .M N... 100644 100644 100644 4cb29ea38f70d7c61b2a3a25b02e3bdf44905402 4cb29ea38f70d7c61b2a3a25b02e3bdf44905402 a.txt',
  '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 bdc955b7b2e610ad5a72302b139a2e6cb325519a bin.dat',
  '? new.txt',
  '',
].join('\n')
const NUMSTAT = '2\t1\ta.txt\n-\t-\tbin.dat\n'
const CLEAN = '# branch.oid 08415354ef5529a1ba9f234cc3478dc6dcd4eae5\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n'

const HINT = {
  plugin: 'cyberdeck',
  surface: 'terminal',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

test('git output parses into the radar', async () => {
  expect(parseStatus(STATUS)).toEqual({ ahead: 1, files: 3 })
  expect(parseNumstat(NUMSTAT)).toEqual({ added: 2, removed: 1 })
  expect(parseStatus(CLEAN)).toEqual({ ahead: 0, files: 0 })
  // Outside a repository git fails and the deck reads nothing.
  expect(parseStatus('')).toEqual({ ahead: 0, files: 0 })
  expect(parseNumstat('')).toEqual({ added: 0, removed: 0 })
})

test('the radar sits beside the branch and moves when a file is edited', async ($, on) => {
  // The engine's side: a clock and store in memory, git and date answering
  // for a repository that starts clean, and a plain hint line under the prompt.
  const clock = mock.clock(on)
  mock.store(on)
  const repo = { status: CLEAN, numstat: '' }
  on('process.run', (_, e) => {
    const command = e.argv.join(' ')
    const stdout = command.includes('--show-current')
      ? 'main\n'
      : command.includes(' status ')
        ? repo.status
        : command.includes(' diff ')
          ? repo.numstat
          : '+0530\n'

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'deck' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>? for shortcuts</Text>
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  // The boot sequence plays out before the deck comes up.
  await clock.advance(10_000)
  const ui = await $.ui.mount(HINT)
  const radar = async () => {
    const header = (await ui.find({ type: 'Text', text: /◢◤/ }))?.text ?? ''
    return header.slice(header.indexOf('⎇'))
  }
  expect(await radar()).toBe('⎇ main')

  repo.status = STATUS
  repo.numstat = NUMSTAT
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.txt', old_string: 'two', new_string: 'TWO' })
  await clock.settle()

  expect(await radar()).toBe('⎇ main ↑1 ✎3 +2 −1')
  await ui.unmount()
})
