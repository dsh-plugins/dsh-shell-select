/**
 * The decision: the one place this plugin can refuse, and the one place it
 * fixes what a call will run.
 *
 * These are the properties that separate this plugin from silently degrading
 * ones, so they are asserted at the strongest point available: a refused call
 * must produce *zero* spawn requests, not a spawn whose failure is converted
 * into a refusal afterwards.
 *
 * The decision resolves its executable through the subprocess seam, so a stubbed
 * seam lets every refusal path be driven deterministically, including the
 * Windows-only confinement refusals.
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { localPlatform } from '../lib/catalog.js'
import { toLinuxPath } from '../lib/dialects.js'
import { ShellSelectionRefusedError } from '../lib/executor.js'
import { shellDescription } from '../lib/tool.js'
import {
  makeContext,
  makeFixture,
  mountExecutor,
  removeFixture,
  stubSandbox,
  stubSubprocess,
  workdirFor,
} from './helpers.mjs'

const fixture = makeFixture('executor')
after(() => { removeFixture(fixture) })

/** This host's real fixture directory, for cases that simulate this host. */
const workdir = join(fixture, 'work')
mkdirSync(workdir, { recursive: true })

/** Executables the stub seam knows, per platform. */
const WINDOWS_EXES = {
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  cmd: 'C:\\Windows\\system32\\cmd.exe',
  'D:\\Git\\bin\\bash.exe': 'D:\\Git\\bin\\bash.exe',
  'wsl.exe': 'C:\\Windows\\System32\\wsl.exe',
  'cmd.exe': 'C:\\Windows\\system32\\cmd.exe',
  'bash.exe': 'D:\\Git\\bin\\bash.exe',
  'pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
}

const POSIX_EXES = { bash: '/bin/bash', zsh: '/usr/bin/zsh', fish: '/usr/bin/fish', sh: '/bin/sh', pwsh: '/opt/pwsh' }

/** The executables the stub seam knows on one platform. */
function exesFor(platform) {
  return platform === 'windows' ? WINDOWS_EXES : POSIX_EXES
}

/**
 * Mount the executor over the stubs.
 *
 * The simulated platform defaults to this host's own, which is what the status
 * surfaces need: they validate the deployment workspace root, and a root only
 * exists on the platform that can stat it.
 * @param config - a partial plugin configuration.
 * @param options - the simulated platform, mode, and seam stubs.
 * @returns the context, executor, and the recorded seam calls.
 */
async function mount(config, options = {}) {
  const platform = options.platform ?? localPlatform()
  const subprocess = stubSubprocess({
    platform,
    defaultShell: options.defaultShell,
    resolvable: options.resolvable ?? exesFor(platform),
    outcome: options.outcome,
    output: options.output,
  })
  const sandbox = options.sandbox ?? stubSandbox()
  const ctx = await makeContext({
    mode: options.mode ?? 'workspace-write',
    workspaceRoot: options.workspaceRoot ?? fixture,
    subprocess,
    sandbox,
  })
  const executor = await mountExecutor(ctx, config)
  return { ctx, executor, subprocess, sandbox }
}

/** A request shaped for the platform under simulation. */
function request(platform, command = 'echo hi') {
  return { command, workdir: workdirFor(platform, workdir) }
}

describe('deciding a call', () => {
  it('builds bash argv from the selected entry and records the decision', async () => {
    const { executor, subprocess } = await mount({ shell: 'bash' }, { platform: 'posix' })
    const spec = executor.resolve(request('posix'))
    const decided = await executor.decide(spec)
    assert.deepEqual(decided.decision.argv, ['/bin/bash', '-c', 'echo hi'])
    assert.equal(decided.decision.shell.id, 'bash')
    assert.equal(decided.decision.shell.executable, '/bin/bash')
    assert.equal(decided.decision.shell.workdir, workdirFor('posix', workdir))
    assert.equal(decided.decision.shell.confineable, true)
    // A decision is not a spawn.
    assert.equal(subprocess.spawns.length, 0)
  })

  it('translates the working directory for a WSL call', async () => {
    // The translation is a pure function of the two strings. When this host is
    // Windows the path also has to exist, so the case uses the real fixture
    // directory and derives the expected Linux path from it.
    const windowsWorkdir = workdirFor('windows', workdir)
    const { executor } = await mount(
      { shell: 'wsl', wslMountRoot: '/mnt' },
      { platform: 'windows', mode: 'danger-full-access' },
    )
    const decided = await executor.decide(executor.resolve({ command: 'pwd', workdir: windowsWorkdir }))
    assert.deepEqual(decided.decision.argv.slice(0, 4),
      ['C:\\Windows\\System32\\wsl.exe', '--cd', toLinuxPath(windowsWorkdir, '/mnt'), '-e'])
    assert.deepEqual(decided.decision.argv.slice(-3), ['bash', '-c', 'pwd'])
  })

  it('transports a cmd command through the environment', async () => {
    const { executor } = await mount(
      { shell: 'cmd' },
      { platform: 'windows', resolvable: WINDOWS_EXES },
    )
    const decided = await executor.decide(executor.resolve({ command: 'dir "C:\\a b"', workdir: workdirFor('windows', workdir) }))
    assert.deepEqual(decided.decision.argv, ['C:\\Windows\\system32\\cmd.exe', '/d', '/q', '/c', '%DSH_SHELL_SELECT_COMMAND%'])
    assert.equal(decided.spec.env?.DSH_SHELL_SELECT_COMMAND, 'dir "C:\\a b"')
  })

  it('carries the decision forward, so a later configuration change cannot alter a decided call', async () => {
    const { executor } = await mount({ shell: 'bash' }, { platform: 'posix' })
    const decided = await executor.decide(executor.resolve(request('posix')))
    // The spec it returns is already decided: deciding again returns the same facts.
    const again = await executor.decideFor(decided.spec)
    assert.equal(again.decision, decided.decision)
  })

  it('logs in only when the configuration asks for it', async () => {
    const plain = await mount({ shell: 'bash' }, { platform: 'posix' })
    assert.deepEqual((await plain.executor.decide(plain.executor.resolve(request('posix')))).decision.argv,
      ['/bin/bash', '-c', 'echo hi'])
    const login = await mount({ shell: 'bash', loginShell: true }, { platform: 'posix' })
    assert.deepEqual((await login.executor.decide(login.executor.resolve(request('posix')))).decision.argv,
      ['/bin/bash', '-l', '-c', 'echo hi'])
  })
})

describe('refusals happen before any process exists', () => {
  it('refuses an unconfineable shell under a confined mode, and spawns nothing', async () => {
    const { executor, subprocess } = await mount(
      { shell: 'gitbash' },
      { platform: 'windows', resolvable: WINDOWS_EXES, mode: 'workspace-write' },
    )
    await assert.rejects(
      executor.decide(executor.resolve({ command: 'ls', workdir: workdirFor('windows', workdir) })),
      (error) => {
        assert.equal(error instanceof ShellSelectionRefusedError, true)
        assert.equal(error.shellId, 'gitbash')
        assert.equal(error.mode, 'workspace-write')
        assert.match(error.message, /cannot be confined/u)
        return true
      },
    )
    assert.equal(subprocess.spawns.length, 0)
  })

  it('runs the same shell once the mode is danger-full-access', async () => {
    const { executor } = await mount(
      { shell: 'gitbash' },
      { platform: 'windows', resolvable: WINDOWS_EXES, mode: 'danger-full-access' },
    )
    const decided = await executor.decide(executor.resolve({ command: 'ls', workdir: workdirFor('windows', workdir) }))
    assert.deepEqual(decided.decision.argv, ['D:\\Git\\bin\\bash.exe', '-c', 'ls'])
  })

  it('refuses a shell this platform does not have, naming it and the alternatives', async () => {
    const { executor } = await mount({ shell: 'cmd' }, { platform: 'posix' })
    await assert.rejects(
      executor.decide(executor.resolve(request('posix'))),
      /the selected shell "cmd" does not exist on posix\. Available: bash, zsh, fish, sh, pwsh/u,
    )
  })

  it('refuses an auto selection that resolved nothing, with its own wording', async () => {
    const { executor } = await mount({ shell: 'auto' }, { platform: 'posix', resolvable: {} })
    await assert.rejects(
      executor.decide(executor.resolve(request('posix'))),
      /no shell in the posix catalog resolved in the execution environment/u,
    )
  })

  it('refuses a login flag on a dialect that has none', async () => {
    const { executor } = await mount({ shell: 'bash', loginShell: true }, {
      platform: 'windows',
      resolvable: WINDOWS_EXES,
      mode: 'danger-full-access',
    })
    // Windows `pwsh` is not a bash-family shell, so the flag is a configuration error.
    const { executor: pwsh } = await mount({ shell: 'pwsh', loginShell: true }, {
      platform: 'windows',
      resolvable: WINDOWS_EXES,
    })
    await assert.rejects(pwsh.decide(pwsh.resolve({ command: 'x', workdir: 'C:\\w' })),
      /"loginShell" applies to bash-family shells only/u)
    assert.ok(executor !== undefined)
  })

  it('refuses a mount root that is not an absolute Linux path', async () => {
    const { executor } = await mount(
      { shell: 'wsl', wslMountRoot: 'mnt' },
      { platform: 'windows', resolvable: WINDOWS_EXES, mode: 'danger-full-access' },
    )
    await assert.rejects(
      executor.decide(executor.resolve({ command: 'ls', workdir: 'C:\\w' })),
      /"wslMountRoot" must be an absolute Linux path/u,
    )
  })

  it('refuses a working directory that does not exist on this host', async () => {
    const platform = localPlatform()
    const { executor } = await mount(
      { shell: platform === 'windows' ? 'pwsh' : 'bash' },
      platform === 'windows' ? { platform, resolvable: WINDOWS_EXES } : { platform },
    )
    const shellWorkdir = platform === 'windows' ? 'C:\\fixtures\\gone' : join(fixture, 'gone')
    await assert.rejects(
      executor.decide(executor.resolve({ command: 'x', workdir: shellWorkdir })),
      platform === 'windows' ? /must be an absolute windows path|does not exist/u : /does not exist/u,
    )
  })

  it('refuses a configured executable that names a different shell', async () => {
    const { executor, subprocess } = await mount(
      { shell: 'pwsh', executable: 'D:\\Git\\bin\\bash.exe' },
      { platform: 'windows', resolvable: WINDOWS_EXES },
    )
    await assert.rejects(
      executor.decide(executor.resolve({ command: 'x', workdir: workdirFor('windows', workdir) })),
      /is not that shell/u,
    )
    assert.equal(subprocess.spawns.length, 0)
  })
})

describe('automatic resolution', () => {
  it('prefers the POSIX login shell when it is installed', async () => {
    const { executor } = await mount(
      { shell: 'auto' },
      { platform: 'posix', defaultShell: '/usr/bin/zsh' },
    )
    const resolution = await executor.resolveAuto()
    assert.equal(resolution.entry.id, 'zsh')
  })

  it('falls through to the next catalog entry when the preference is not installed', async () => {
    const { executor } = await mount(
      { shell: 'auto' },
      { platform: 'posix', defaultShell: '/usr/bin/fish', resolvable: { bash: '/bin/bash' } },
    )
    const resolution = await executor.resolveAuto()
    assert.equal(resolution.entry.id, 'bash')
  })

  it('ignores %ComSpec% on Windows, keeping catalog order', async () => {
    const { executor } = await mount(
      { shell: 'auto' },
      { platform: 'windows', defaultShell: 'C:\\Windows\\system32\\cmd.exe', resolvable: WINDOWS_EXES },
    )
    const resolution = await executor.resolveAuto()
    assert.equal(resolution.entry.id, 'pwsh')
  })

  it('lets an explicit executable name its own dialect under auto', async () => {
    const { executor } = await mount(
      { shell: 'auto', executable: 'D:\\Git\\bin\\bash.exe' },
      { platform: 'windows', resolvable: WINDOWS_EXES },
    )
    const resolution = await executor.resolveAuto({ executable: 'D:\\Git\\bin\\bash.exe' })
    assert.equal(resolution.entry.id, 'gitbash')
  })

  it('answers with the diagnostic, not an entry, when nothing resolves', async () => {
    const { executor } = await mount({ shell: 'auto' }, { platform: 'posix', resolvable: {} })
    const resolution = await executor.resolveAuto()
    assert.equal(resolution.entry, undefined)
    assert.match(resolution.detail, /no shell in the posix catalog resolved/u)
  })
})

describe('the model-facing description', () => {
  it('names the resolved shell, its executable, and its syntax', async () => {
    const { executor } = await mount({ shell: 'bash' }, { platform: 'posix' })
    await executor.refreshSelection()
    const text = shellDescription(executor.describeShell(), true, [])
    assert.match(text, /The shell for this session is Bash, invoked as \/bin\/bash \(posix\)/u)
    assert.match(text, /POSIX shell syntax/u)
    assert.match(text, /run_in_background: true/u)
  })

  it('warns, rather than describing a shell nothing would run, when resolution failed', async () => {
    const { executor } = await mount({ shell: 'auto' }, { platform: 'posix', resolvable: {} })
    const text = shellDescription(executor.describeShell(), false, [])
    assert.match(text, /WARNING: the configured shell is not available/u)
    assert.match(text, /Background execution is not available/u)
    assert.equal(text.includes('Attempting a command the sandbox may deny'), false)
  })

  it('adds the escalation paragraph only where escalation is advertised', async () => {
    const { executor } = await mount({ shell: 'bash' }, { platform: 'posix' })
    await executor.refreshSelection()
    const describe = executor.describeShell()
    assert.equal(shellDescription(describe, true, []).includes('sandbox_permissions'), false)
    assert.match(shellDescription(describe, true, ['workspace-write', 'danger-full-access']),
      /sandbox_permissions/u)
  })
})

describe('status facts', () => {
  // The probe and the self-test validate the deployment workspace root, and a
  // root only exists on the platform that can stat it. So these cases run as
  // this host, with a shell this host actually has.
  const native = localPlatform() === 'windows'
    ? { shell: 'pwsh', executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', probe: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'x'] }
    : { shell: 'bash', executable: '/bin/bash', probe: ['/bin/bash', '--version'] }

  it('reports one row per catalog entry, with the selected one marked', async () => {
    const { executor } = await mount({ shell: 'zsh' }, { platform: 'posix' })
    const rows = await executor.describeCatalog()
    assert.equal(rows.length, 5)
    assert.deepEqual(rows.filter(row => row.selected).map(row => row.id), ['zsh'])
    assert.equal(rows.find(row => row.id === 'bash').path, '/bin/bash')
  })

  it('probes under the sandbox and reports what it was observed doing', async () => {
    const { executor, sandbox } = await mount({ shell: native.shell })
    const probe = await executor.runProbe(native.probe)
    assert.equal(probe.started, true)
    assert.equal(probe.mode, 'workspace-write')
    assert.equal(probe.enforcement, 'partial')
    // The probe went through ctx.sandbox.confine, not around it.
    assert.equal(sandbox.calls.length, 1)
    assert.deepEqual(sandbox.calls[0].argv, native.probe)
  })

  it('runs a probe unconfined only under danger-full-access', async () => {
    const { executor, sandbox } = await mount({ shell: native.shell }, { mode: 'danger-full-access' })
    const probe = await executor.runProbe(native.probe)
    assert.equal(probe.started, true)
    assert.equal(probe.denied, undefined)
    assert.equal(sandbox.calls.length, 0)
  })

  it('reports a refused probe instead of running it unconfined', async () => {
    const sandbox = stubSandbox({ confine: () => Promise.reject(new Error('no backend')) })
    const { executor } = await mount({ shell: native.shell }, { sandbox })
    const probe = await executor.runProbe(native.probe)
    assert.equal(probe.started, false)
    assert.match(probe.detail, /no backend/u)
  })

  it('reports the probe\u2019s exit facts when the sandbox settles', async () => {
    const { executor } = await mount({ shell: native.shell }, {
      output: { stdout: 'some version line\n' },
    })
    const probe = await executor.runProbe(native.probe)
    assert.equal(probe.exitCode, 0)
    assert.equal(probe.stdout, 'some version line\n')
    assert.equal(probe.denied, false)
  })

  it('runs the self-test through the normal path and reports the shell that ran', async () => {
    const { executor } = await mount({ shell: native.shell }, {
      output: { stdout: 'DSH-SHELL-SELECT-TEST-OK\n' },
    })
    const outcome = await executor.runCommand({ command: 'echo x', workdir })
    assert.equal(outcome.stage, 'ran')
    assert.equal(outcome.shell, native.shell)
    assert.equal(outcome.executable, native.executable)
    assert.equal(outcome.mode, 'workspace-write')
    assert.equal(outcome.result.stdout.text, 'DSH-SHELL-SELECT-TEST-OK\n')
  })

  it('reports the refusal stage when the selection cannot be confined', async () => {
    const { executor } = await mount(
      { shell: 'wsl' },
      { platform: 'windows', mode: 'workspace-write' },
    )
    const outcome = await executor.runCommand({ command: 'echo x', workdir: workdirFor('windows', workdir) })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.stage, 'refused')
    assert.match(outcome.detail, /cannot be confined/u)
  })

  it('reports the selection stage when the shell does not exist here', async () => {
    const { executor } = await mount({ shell: 'cmd' }, { platform: 'posix' })
    const outcome = await executor.runCommand({ command: 'echo x', workdir: workdirFor('posix', workdir) })
    assert.equal(outcome.stage, 'selection')
    assert.match(outcome.detail, /does not exist on posix/u)
  })
})