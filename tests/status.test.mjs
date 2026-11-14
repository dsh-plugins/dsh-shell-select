/**
 * The status facts and the self-test, composed over a stubbed executor.
 *
 * The facts are what a user reads before trusting the setting, so the property
 * asserted here is that the three claims stay apart: whether the binary runs at
 * all, what the catalog expects the sandbox to be able to do with it, and what
 * this machine was actually observed doing.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PROBE_TIMEOUT_MS,
  buildStatus,
  formatShellTest,
  formatStatus,
  probeFacts,
  runShellTest,
} from '../lib/status.js'

/** One catalog row, as `describeCatalog` would return it. */
function row(id, overrides = {}) {
  return {
    id,
    label: id.toUpperCase(),
    dialect: 'bash',
    selected: id === 'bash',
    available: true,
    path: `/bin/${id}`,
    source: 'discovered',
    confineable: true,
    supportsLoginShell: true,
    supportsDistro: false,
    syntax: `${id} syntax`,
    ...overrides,
  }
}

/**
 * A stand-in for the mounted executor.
 * @param options - rows, the platform, and the probe/command answers.
 * @returns the stand-in.
 */
function stubExecutor(options = {}) {
  const probes = []
  const commands = []
  return {
    probes,
    commands,
    selectSettings: options.settings ?? {
      shell: 'bash', executable: '', loginShell: false, wslDistro: '', wslMountRoot: '/mnt',
      enableRunInBackground: true, timeoutMs: 120_000, maxTimeoutMs: 600_000,
      maxOutputBytes: 64_000, maxSpillBytes: 1_000, graceMs: 3_000,
    },
    async executionPlatformNow() { return options.platform ?? 'posix' },
    async describeCatalog() { return options.rows ?? [row('bash'), row('zsh')] },
    async resolveAuto() {
      return options.auto ?? { platform: 'posix', entry: { id: 'bash', label: 'Bash', dialect: 'bash', names: ['bash'], syntax: 's', supportsLoginShell: true }, available: true, path: '/bin/bash', source: 'discovered' }
    },
    async runProbe(argv) {
      probes.push(argv)
      return options.probe?.(argv) ?? { started: true, mode: 'workspace-write', exitCode: 0, stdout: 'v1.0\n', enforcement: 'partial', denied: false }
    },
    async runCommand(request) {
      commands.push(request)
      return options.command?.() ?? {
        ok: true,
        stage: 'ran',
        shell: 'bash',
        executable: '/bin/bash',
        mode: 'workspace-write',
        result: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          timeoutMs: 1_000,
          stdout: { text: 'DSH-SHELL-SELECT-TEST-OK', truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial' },
        },
      }
    },
    describeShell() { return { platform: 'posix', id: 'bash', available: true, syntax: 's', confineable: true } },
  }
}

const policy = { mode: 'workspace-write', workspaceRoot: '/work' }

describe('one probe\u2019s facts', () => {
  it('reads a version from the first non-empty line', () => {
    assert.deepEqual(
      probeFacts({ started: true, exitCode: 0, stdout: '\n  GNU bash 5.2 \nmore', denied: false, enforcement: 'full' }, 'version'),
      { version: 'GNU bash 5.2', observed: 'confirmed' },
    )
  })

  it('reports a non-zero exit as a failure even when it printed something', () => {
    const facts = probeFacts({ started: true, exitCode: 2, stderr: 'Illegal option', denied: false }, 'version')
    assert.equal(facts.version, undefined)
    assert.match(facts.versionError, /exited with code 2: Illegal option/u)
  })

  it('keeps an interpreter answer separate from a version', () => {
    const facts = probeFacts({ started: true, exitCode: 0, stdout: '/bin/dash\n', denied: false, enforcement: 'partial' }, 'interpreter')
    assert.equal(facts.interpreter, '/bin/dash')
    assert.equal(facts.version, undefined)
  })

  it('distinguishes a refusal from a probe that simply did not run', () => {
    assert.equal(probeFacts({ started: false, detail: 'x', refused: true }, 'version').observed, 'refused')
    assert.equal(probeFacts({ started: false, detail: 'x' }, 'version').observed, 'not-run')
    assert.equal(probeFacts({ started: true, runnerFailed: true, detail: 'y' }, 'version').observed, 'runner-failed')
  })

  it('marks a run with no enforcement as observed unconfined', () => {
    assert.equal(probeFacts({ started: true, exitCode: 0, stdout: 'v' }, 'version').observed, 'ran-unconfined')
  })

  it('reports a timeout as such', () => {
    assert.match(probeFacts({ started: true, timedOut: true, exitCode: null }, 'version').versionError,
      new RegExp(`timed out after ${PROBE_TIMEOUT_MS} ms`, 'u'))
  })
})

describe('the status payload', () => {
  it('reports the active selection, the mode, and one row per entry', async () => {
    const status = await buildStatus(stubExecutor(), policy)
    assert.equal(status.active.shell, 'bash')
    assert.equal(status.active.selected, 'bash')
    assert.equal(status.active.platform, 'posix')
    assert.equal(status.active.mode, 'workspace-write')
    assert.equal(status.shells.length, 2)
    assert.equal(status.confinementVerified, false)
  })

  it('probes each resolvable row once and folds the answer in', async () => {
    const executor = stubExecutor()
    const status = await buildStatus(executor, policy)
    // Two catalog rows plus Automatic's own resolution, which is a different
    // question and is probed as such.
    assert.equal(executor.probes.length, 3)
    assert.equal(status.shells[0].version, 'v1.0')
    assert.equal(status.shells[0].confinement.observed, 'confirmed')
    assert.equal(status.shells[0].usableInMode, true)
  })

  it('reports an unconfineable row as not probed rather than unconfined', async () => {
    const executor = stubExecutor({
      rows: [row('gitbash', { confineable: false, confineReason: 'restricted token', path: 'D:\\Git\\bin\\bash.exe' })],
      platform: 'windows',
      auto: { platform: 'windows', available: false, detail: 'nothing resolved' },
    })
    const status = await buildStatus(executor, { mode: 'workspace-write', workspaceRoot: 'C:\\work' })
    assert.equal(executor.probes.filter(argv => argv[0] === 'D:\\Git\\bin\\bash.exe').length, 0)
    assert.equal(status.shells[0].confinement.observed, 'not-probed')
    assert.equal(status.shells[0].usableInMode, false)
    assert.match(status.shells[0].versionError, /cannot be confined under "workspace-write"/u)
  })

  it('marks an unconfineable row usable under danger-full-access', async () => {
    const executor = stubExecutor({
      rows: [row('gitbash', { confineable: false, path: 'D:\\Git\\bin\\bash.exe' })],
      platform: 'windows',
      auto: { platform: 'windows', available: false, detail: 'nothing resolved' },
    })
    const status = await buildStatus(executor, { mode: 'danger-full-access', workspaceRoot: 'C:\\work' })
    assert.equal(status.shells[0].usableInMode, true)
    assert.equal(executor.probes.filter(argv => argv[0] === 'D:\\Git\\bin\\bash.exe').length, 1)
  })

  it('reports an unresolvable row without probing it', async () => {
    const executor = stubExecutor({
      rows: [row('fish', { available: false, path: undefined, detail: 'no Fish executable found' })],
    })
    const status = await buildStatus(executor, policy)
    // The unresolvable row is never probed; only Automatic's own resolution is.
    assert.equal(executor.probes.filter(argv => argv[0] === '/bin/fish').length, 0)
    assert.equal(status.shells[0].confinement.observed, 'not-probed')
    assert.equal(status.shells[0].versionError, 'no Fish executable found')
  })

  it('resolves automatic for the saved configuration and for the override-free one', async () => {
    const seen = []
    const executor = stubExecutor({
      settings: {
        shell: 'auto', executable: '/opt/bash', loginShell: false, wslDistro: '', wslMountRoot: '/mnt',
        enableRunInBackground: true, timeoutMs: 1, maxTimeoutMs: 1, maxOutputBytes: 1, maxSpillBytes: 1, graceMs: 1,
      },
    })
    const original = executor.resolveAuto.bind(executor)
    executor.resolveAuto = async options => {
      seen.push(options.executable)
      return original(options)
    }
    const status = await buildStatus(executor, policy)
    assert.deepEqual(seen, ['/opt/bash', ''])
    assert.equal(status.auto.saved.executable, '/opt/bash')
    assert.equal(status.auto.withoutOverride.executable, '')
  })

  it('reports automatic as unresolved, with its diagnostic, when nothing resolves', async () => {
    const executor = stubExecutor({ auto: { platform: 'posix', available: false, detail: 'nothing resolved' } })
    const status = await buildStatus(executor, policy)
    assert.equal(status.auto.saved.available, false)
    assert.equal(status.auto.saved.detail, 'nothing resolved')
    assert.equal(status.auto.saved.confinement.observed, 'not-probed')
  })
})

describe('rendering the facts', () => {
  it('states the platform, the mode, and one block per shell', async () => {
    const text = formatStatus(await buildStatus(stubExecutor(), policy))
    assert.match(text, /platform: posix/u)
    assert.match(text, /mode: workspace-write/u)
    assert.match(text, /✓ BASH — \/bin\/bash/u)
    assert.match(text, /version: v1\.0/u)
    assert.match(text, /confineable · observed: confirmed · usable in "workspace-write"/u)
  })

  it('marks a failed row with its reason rather than a version', async () => {
    const text = formatStatus(await buildStatus(stubExecutor({
      rows: [row('fish', { available: false, path: undefined, detail: 'no Fish executable found' })],
    }), policy))
    assert.match(text, /✗ FISH — no Fish executable found/u)
  })
})

describe('the self-test', () => {
  it('runs the fixed command in the deployment workspace root', async () => {
    const executor = stubExecutor()
    const result = await runShellTest(executor, policy)
    assert.equal(executor.commands.length, 1)
    assert.equal(executor.commands[0].workdir, '/work')
    assert.match(executor.commands[0].command, /^echo DSH-SHELL-SELECT-TEST-OK$/u)
    assert.equal(result.ok, true)
    assert.equal(result.stage, 'ran')
    assert.equal(result.shell, 'bash')
    assert.equal(result.sandbox.enforcement, 'partial')
  })

  it('reports a refusal as the refusal stage, with its detail', async () => {
    const result = await runShellTest(stubExecutor({
      command: () => ({ ok: false, stage: 'refused', shell: 'gitbash', detail: 'cannot be confined' }),
    }), policy)
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'refused')
    assert.equal(result.detail, 'cannot be confined')
  })

  it('reports a selection failure as its own stage', async () => {
    const result = await runShellTest(stubExecutor({
      command: () => ({ ok: false, stage: 'selection', detail: 'does not exist on posix' }),
    }), policy)
    assert.equal(result.stage, 'selection')
  })

  it('renders a run with its exit status and streams', async () => {
    const text = formatShellTest(await runShellTest(stubExecutor(), policy))
    assert.match(text, /✓ bash — exit 0/u)
    assert.match(text, /executable: \/bin\/bash/u)
    assert.match(text, /mode: workspace-write/u)
    assert.match(text, /sandbox: workspace-write/u)
    assert.match(text, /stdout: DSH-SHELL-SELECT-TEST-OK/u)
  })

  it('renders a refusal with its stage and detail', () => {
    const text = formatShellTest({ ok: false, stage: 'refused', shell: 'gitbash', detail: 'cannot be confined' })
    assert.match(text, /stage: refused/u)
    assert.match(text, /shell: gitbash/u)
    assert.match(text, /detail: cannot be confined/u)
  })

  it('marks a non-zero exit as a failure without calling it an error', async () => {
    const result = await runShellTest(stubExecutor({
      command: () => ({
        ok: true,
        stage: 'ran',
        shell: 'bash',
        executable: '/bin/bash',
        mode: 'workspace-write',
        result: {
          exitCode: 1, signal: null, timedOut: false, timeoutMs: 1_000,
          stdout: { text: '', truncated: false }, stderr: { text: 'boom', truncated: false },
        },
      }),
    }), policy)
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 1)
    assert.match(formatShellTest(result), /✗ bash — exit 1/u)
    assert.match(formatShellTest(result), /stderr: boom/u)
  })
})
