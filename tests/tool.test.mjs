/**
 * The model-facing surface: one `shell` tool, and the denial that keeps the
 * shipped `bash`/`pwsh` tools from competing with it.
 *
 * The guard is the part with no equivalent anywhere else in the composition: a
 * preset can re-mount `tool-bash` inside an agent realm where no patch reaches,
 * so the only layer-independent answer is a denial consulted per call.
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { localPlatform } from '../lib/catalog.js'
import {
  REPLACED_SHELL_TOOLS,
  SHELL_TOOL_NAME,
  registerShellTool,
  registerShellToolReplacement,
  shellDescription,
  validateShellArgs,
} from '../lib/tool.js'
import {
  makeContext,
  makeFixture,
  mountExecutor,
  removeFixture,
  stubSandbox,
  stubSubprocess,
  workdirFor,
} from './helpers.mjs'

const fixture = makeFixture('tool')
after(() => { removeFixture(fixture) })

const workdir = join(fixture, 'work')
mkdirSync(workdir, { recursive: true })

/**
 * Build a context that can host the tool: the plugin's own services plus the
 * prompt registry, the environment registry, and a `tools` service.
 *
 * The real `ToolsService` needs `systemPrompt` and a scope; a recording
 * stand-in is enough here, because what this suite asserts is what the plugin
 * registers and what its guard answers — the registry's own dispatch is the
 * harness's test surface, not this plugin's.
 * @param options - the simulated platform and the seam stubs.
 * @returns the context, the executor, and the recorded registrations.
 */
async function mountPlugin(options = {}) {
  const platform = options.platform ?? localPlatform()
  const subprocess = stubSubprocess({
    platform,
    resolvable: options.resolvable ?? (platform === 'windows'
      ? { 'C:\\Program Files\\PowerShell\\7\\pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'D:\\Git\\bin\\bash.exe': 'D:\\Git\\bin\\bash.exe' }
      : { bash: '/bin/bash' }),
    output: options.output,
  })
  const sandbox = options.sandbox ?? stubSandbox()
  const ctx = await makeContext({
    mode: options.mode ?? 'workspace-write',
    workspaceRoot: fixture,
    subprocess,
    sandbox,
  })
  const registrations = { tools: [], guards: [], sections: [] }
  await ctx.plugin({
    name: 'stub-host',
    apply(context) {
      context.provide('systemPrompt', {
        getSectionOrder: () => 10,
        section: section => { registrations.sections.push(section); return () => {} },
      })
      context.provide('shellEnv', { collect: () => ({}) })
      context.provide('tools', {
        register: definition => { registrations.tools.push(definition); return () => {} },
        guard: judge => { registrations.guards.push(judge); return () => {} },
      })
      context.provide('jobs', {
        start: spec => { registrations.jobSpec = spec; registrations.jobsStarted = (registrations.jobsStarted ?? 0) + 1; return 'shell-0001' },
      })
    },
  })
  const executor = await mountExecutor(ctx, options.config ?? {})
  return { ctx, executor, registrations, sandbox, subprocess }
}

describe('the replacement guard', () => {
  it('denies the two shipped names and names the replacement', async () => {
    const { ctx, registrations } = await mountPlugin({ platform: 'posix' })
    registerShellToolReplacement(ctx)
    assert.equal(registrations.guards.length, 1)
    const judge = registrations.guards[0]
    for (const name of ['bash', 'pwsh']) {
      const verdict = judge({ name })
      assert.equal(typeof verdict, 'string')
      assert.match(verdict, new RegExp(`"${name}" is not available`, 'u'))
      assert.match(verdict, /the "shell" tool is the only route/u)
    }
  })

  it('leaves every other tool alone', async () => {
    const { ctx, registrations } = await mountPlugin({ platform: 'posix' })
    registerShellToolReplacement(ctx)
    for (const name of ['fs_read', 'run_code', 'job_output', SHELL_TOOL_NAME]) {
      assert.equal(registrations.guards[0]({ name }), undefined)
    }
    assert.deepEqual([...REPLACED_SHELL_TOOLS], ['bash', 'pwsh'])
  })
})

describe('the tool definition', () => {
  it('registers exactly one tool, named shell', async () => {
    const { ctx, executor, registrations } = await mountPlugin({ platform: 'posix' })
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    assert.equal(registrations.tools.length, 1)
    assert.equal(registrations.tools[0].name, SHELL_TOOL_NAME)
  })

  it('re-reads its description from the live selection', async () => {
    const { ctx, executor, registrations } = await mountPlugin({ platform: 'posix' })
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    const definition = registrations.tools[0]
    const first = definition.description
    assert.match(first, /invoked as \/bin\/bash \(posix\)/u)
    // The property is a getter, so a re-read is a fresh computation.
    assert.equal(definition.description, first)
  })

  it('advertises run_in_background only when the configuration allows it', async () => {
    const enabled = await mountPlugin({ platform: 'posix' })
    registerShellTool(enabled.ctx, { executor: enabled.executor, backgroundEnabled: () => true })
    assert.ok(enabled.registrations.tools[0].parameters.properties.run_in_background)

    const disabled = await mountPlugin({ platform: 'posix' })
    registerShellTool(disabled.ctx, { executor: disabled.executor, backgroundEnabled: () => false })
    assert.equal(disabled.registrations.tools[0].parameters.properties.run_in_background, undefined)
  })

  it('registers cross-call guidance in the prompt', async () => {
    const { ctx, executor, registrations } = await mountPlugin({ platform: 'posix' })
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    const section = registrations.sections.find(entry => entry.name === `tool:${SHELL_TOOL_NAME}`)
    assert.ok(section)
    assert.match(section.text, /\[exit code: N\] marker on every shell result/u)
  })

  it('presents a foreground call as a terminal that names the shell', async () => {
    const { ctx, executor, registrations } = await mountPlugin({ platform: 'posix' })
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    const definition = registrations.tools[0]
    const view = definition.presentCall({ command: 'ls', description: 'List files' })
    assert.equal(view.card, 'terminal')
    assert.equal(view.title, 'ls')
    assert.match(view.description, /List files — Bash — \/bin\/bash/u)
  })

  it('presents a background call as a generic card', async () => {
    const { ctx, executor, registrations } = await mountPlugin({ platform: 'posix' })
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    const view = registrations.tools[0].presentCall({ command: 'sleep 1', description: 'Wait', run_in_background: true })
    assert.equal(view.card, 'generic')
    assert.equal(view.kind, 'execute')
    assert.equal(view.rawInput, 'sleep 1')
  })
})

describe('running through the tool', () => {
  it('treats empty optional arguments as omitted and ignores inactive branch arguments', async () => {
    const { ctx, executor, registrations } = await mountPlugin({ mode: 'danger-full-access' })
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    const tool = registrations.tools[0]
    const args = { command: 'echo hi', description: 'Echo a greeting' }
    const call = { callId: 'optional', rootCallId: 'optional', signal: new AbortController().signal }
    const expected = await tool.execute(args, call)
    const empty = { ...args, timeoutMs: '', workdir: '', run_in_background: '', sandbox_permissions: '', justification: '' }
    assert.deepEqual(validateJsonSchemaValue(tool.parameters, empty), [])
    assert.ok(validateJsonSchemaValue(tool.parameters, { ...args, timeoutMs: ' ' }).length > 0)
    const result = await tool.execute(empty, call)
    assert.equal(result.timeoutMs, expected.timeoutMs)
    assert.deepEqual(result.shell, expected.shell)
    assert.deepEqual(result.sandbox, expected.sandbox)
    assert.deepEqual(tool.presentCall(empty), tool.presentCall(args))
    const detached = await tool.execute({ ...empty, run_in_background: true, timeoutMs: -1, justification: 'Unused' }, call)
    assert.equal(detached.kind, 'background')
  })

  it('runs a foreground command and reports the decision\u2019s own shell facts', async () => {
    const { ctx, executor, registrations } = await mountPlugin({
      platform: 'posix',
      output: { stdout: 'hi\n' },
    })
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    const value = await registrations.tools[0].execute(
      { command: 'echo hi', description: 'Echo a greeting', workdir: workdirFor('posix', workdir) },
      { callId: 'c1', rootCallId: 'c1', signal: new AbortController().signal, agent: undefined, deferContext() {}, concludeTurn() {} },
    )
    assert.equal(value.kind, 'foreground')
    assert.equal(value.exitCode, 0)
    assert.equal(value.shell.shell, 'bash')
    assert.equal(value.shell.executable, '/bin/bash')
    assert.equal(value.stdout.text, 'hi\n')
  })

  it('ignores a narrower target and its reason, keeping the standing mode', async () => {
    const { ctx, executor, registrations, sandbox } = await mountPlugin({
      platform: 'posix',
      mode: 'danger-full-access',
    })
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    const execute = registrations.tools[0].execute
    const args = {
      command: 'echo hi',
      description: 'Echo a greeting',
      workdir: workdirFor('posix', workdir),
      sandbox_permissions: 'workspace-write',
    }
    const call = { callId: 'narrower', rootCallId: 'narrower', signal: new AbortController().signal, agent: undefined }
    for (const reason of [undefined, '', '  ', 'The command writes a workspace file.']) {
      const value = await execute({ ...args, ...(reason === undefined ? {} : { justification: reason }) }, call)
      assert.equal(value.sandbox.mode, 'danger-full-access')
    }
    assert.equal(sandbox.calls.length, 0)
  })

  it('keeps validation for equal, unsupported, and genuinely wider targets', async () => {
    const { ctx, executor, registrations, subprocess } = await mountPlugin({
      platform: 'posix',
      mode: 'danger-full-access',
    })
    const session = { header: { cwd: workdirFor('posix', workdir) } }
    const resolve = ctx.sandboxPolicy.resolve.bind(ctx.sandboxPolicy)
    ctx.sandboxPolicy.resolve = request => resolve(request?.session === session ? { mode: 'read-only' } : request)
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    const execute = registrations.tools[0].execute
    const args = { command: 'echo hi', description: 'Echo a greeting' }
    const call = { callId: 'mode-check', rootCallId: 'mode-check', signal: new AbortController().signal, agent: undefined }
    const reason = 'The command writes a workspace file.'
    await assert.rejects(execute({ ...args, sandbox_permissions: 'danger-full-access', justification: '' }, call), /invalid justification/u)
    await assert.rejects(execute({ ...args, sandbox_permissions: 'unsupported', justification: reason }, call), {
      code: 'INVALID_ARGS',
    })
    const widerCall = { ...call, agent: { session } }
    await assert.rejects(execute({ ...args, sandbox_permissions: 'workspace-write' }, widerCall), /requires a justification/u)
    await assert.rejects(execute({ ...args, sandbox_permissions: 'workspace-write', justification: reason }, widerCall), {
      code: 'SANDBOX_ESCALATION_UNAVAILABLE',
    })
    assert.equal(subprocess.spawns.length, 0)
  })

  it('registers a background job and returns its id', async () => {
    const { ctx, executor, registrations } = await mountPlugin({ platform: 'posix' })
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    const value = await registrations.tools[0].execute(
      {
        command: 'sleep 60',
        description: 'Wait a minute',
        run_in_background: true,
        workdir: workdirFor('posix', workdir),
      },
      { callId: 'c2', rootCallId: 'c2', signal: new AbortController().signal, agent: undefined, deferContext() {}, concludeTurn() {} },
    )
    assert.equal(value.kind, 'background')
    assert.equal(value.jobId, 'shell-0001')
    assert.equal(registrations.jobsStarted, 1)
    assert.equal(registrations.jobSpec.kind, 'shell')
    assert.equal(registrations.jobSpec.label, 'sleep 60')
  })

  it('refuses a refused selection before it creates a job', async () => {
    const { ctx, executor, registrations } = await mountPlugin({
      platform: 'windows',
      mode: 'workspace-write',
      config: { shell: 'gitbash' },
    })
    registerShellTool(ctx, { executor, backgroundEnabled: () => true })
    await assert.rejects(
      registrations.tools[0].execute(
        { command: 'ls', description: 'List', run_in_background: true, workdir: 'C:\\fixtures\\work' },
        { callId: 'c3', rootCallId: 'c3', signal: new AbortController().signal, agent: undefined, deferContext() {}, concludeTurn() {} },
      ),
      /cannot be confined/u,
    )
    assert.equal(registrations.jobsStarted, undefined)
  })

  it('refuses run_in_background when the configuration disabled it', async () => {
    const { ctx, executor, registrations } = await mountPlugin({ platform: 'posix' })
    registerShellTool(ctx, { executor, backgroundEnabled: () => false })
    await assert.rejects(
      registrations.tools[0].execute(
        { command: 'ls', description: 'List', run_in_background: true },
        { callId: 'c4', rootCallId: 'c4', signal: new AbortController().signal, agent: undefined, deferContext() {}, concludeTurn() {} },
      ),
      /run_in_background is disabled for this deployment/u,
    )
  })
})

describe('argument validation', () => {
  it('refuses an empty command or description', () => {
    assert.throws(() => validateShellArgs('', 'x', undefined, undefined, undefined), /invalid command/u)
    assert.throws(() => validateShellArgs('  ', 'x', undefined, undefined, undefined), /invalid command/u)
    assert.throws(() => validateShellArgs('ls', '', undefined, undefined, undefined), /invalid description/u)
  })

  it('refuses a non-positive timeout', () => {
    assert.throws(() => validateShellArgs('ls', 'List', 0, undefined, undefined), /invalid timeoutMs/u)
    assert.throws(() => validateShellArgs('ls', 'List', Number.NaN, undefined, undefined), /invalid timeoutMs/u)
    assert.doesNotThrow(() => validateShellArgs('ls', 'List', 1000, undefined, undefined))
  })

  it('refuses an escalation without its justification, and the reverse', () => {
    assert.throws(() => validateShellArgs('ls', 'List', undefined, 'danger-full-access', undefined))
    assert.throws(() => validateShellArgs('ls', 'List', undefined, undefined, 'because'))
    assert.doesNotThrow(() => validateShellArgs('ls', 'List', undefined, 'danger-full-access', 'because'))
  })
})

describe('the description', () => {
  it('states the shell, the statelessness, and the sandbox marker', () => {
    const text = shellDescription(
      { platform: 'posix', id: 'bash', label: 'Bash', available: true, executable: '/bin/bash', syntax: 'SYNTAX', confineable: true },
      true,
      [],
    )
    assert.match(text, /invoked as \/bin\/bash \(posix\)/u)
    assert.match(text, /fresh, stateless process/u)
    assert.match(text, /\[sandbox: file access denied under <mode> mode\]/u)
    assert.match(text, /SYNTAX/u)
  })

  it('describes a pending resolution without claiming failure', () => {
    const text = shellDescription(
      { platform: 'posix', id: 'bash', label: 'Bash', available: false, pending: true, syntax: 'S', confineable: true },
      true,
      [],
    )
    assert.match(text, /The shell for this session is Bash \(posix\)/u)
    assert.equal(/WARNING/u.test(text), false)
  })
})
