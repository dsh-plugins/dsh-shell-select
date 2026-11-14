/**
 * Activation must survive a selection probe that does not answer.
 *
 * The host publishes its Web surface only after every entry's `apply` settles.
 * A plugin whose `apply` waits for a host probe therefore turns a slow — or
 * wedged — `subprocess` seam into a boot that never finishes, with no diagnostic
 * anywhere: the exact failure these cases pin down.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import plugin, { apply, awaitSelection } from '../lib/index.js'
import { executorConfig } from '../lib/executor.js'
import { resolvePluginConfig } from '../lib/config.js'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { makeContext, stubSubprocess } from './helpers.mjs'

/** Collect the messages a probe reports instead of logging them. */
function collector() {
  const messages = []
  return { messages, warn: message => { messages.push(message) } }
}

/** Let one macrotask pass, so a released probe can settle. */
function tick(ms = 20) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

describe('selection probe deadlines', () => {
  it('gives up on a probe that never settles and reports why', async () => {
    const { messages, warn } = collector()
    const started = Date.now()
    await awaitSelection(new Promise(() => {}), 'mount', warn, 25)
    assert.ok(Date.now() - started < 1_000, 'the deadline did not bound the wait')
    assert.equal(messages.length, 1)
    assert.match(messages[0], /mount selection probe did not settle within 25 ms/u)
    assert.match(messages[0], /pending selection/u)
  })

  it('does not report a probe that settles', async () => {
    const { messages, warn } = collector()
    await awaitSelection(Promise.resolve('settled'), 'mount', warn, 1_000)
    assert.deepEqual(messages, [])
  })

  it('reports a failing probe instead of rejecting', async () => {
    const { messages, warn } = collector()
    await awaitSelection(Promise.reject(new Error('seam refused')), 'mount', warn, 1_000)
    assert.equal(messages.length, 1)
    assert.match(messages[0], /seam refused/u)
  })

  it('cancels an outstanding observer on owner disposal without warning', async () => {
    const { messages, warn } = collector()
    const controller = new AbortController()
    const pending = awaitSelection(new Promise(() => {}), 'mount', warn, 25, controller.signal)
    controller.abort()
    await pending
    await tick(40)
    assert.deepEqual(messages, [])
  })
})

describe('plugin activation', () => {
  it('provides shell before loader and agent services exist, even when loader needs shell', async () => {
    const ctx = await makeContext()
    let settingsMounted = false
    const handle = {
      get: () => ({ value: { shell: 'bash' }, revision: 0 }),
      watch: () => () => {}, registerOperation: () => () => {},
    }
    await ctx.plugin({
      name: 'loader-that-waits-for-shell', inject: ['shell'],
      apply(scope) {
        scope.provide('dshLoader', {
          dshVersion: '0.2.2', config: { register: async () => { settingsMounted = true; return handle } },
        })
      },
    })
    await ctx.plugin(plugin)
    await tick()
    assert.ok(ctx.get('shell'), 'shell must not wait for loader/tools/systemPrompt/shellEnv')
    assert.equal(settingsMounted, true, 'the dependent loader must start after shell is provided')
    await ctx.fiber.dispose()
  })

  it('does not wait for settings I/O to provide shell or finish activation', async () => {
    const ctx = await makeContext()
    await ctx.plugin({ apply(scope) {
      scope.provide('dshLoader', { config: { register: () => new Promise(() => {}) } })
    } })
    await Promise.race([
      ctx.plugin(plugin),
      tick(500).then(() => { throw new Error('activation waited for settings') }),
    ])
    assert.ok(ctx.get('shell'))
    await ctx.fiber.dispose()
  })

  it('never scans local PATH in the Windows parent constructor', { skip: process.platform !== 'win32' }, async () => {
    const ctx = await makeContext()
    const original = fs.lstatSync
    let scans = 0
    fs.lstatSync = () => { scans += 1; throw new Error('PATH is unavailable') }
    syncBuiltinESMExports()
    try {
      const { ShellSelectExecutor } = await import('../lib/executor.js')
      const settings = resolvePluginConfig()
      const executor = new ShellSelectExecutor(ctx, executorConfig(settings), () => settings)
      await executor.ready
      assert.equal(scans, 0)
    } finally {
      fs.lstatSync = original
      syncBuiltinESMExports()
      await ctx.fiber.dispose()
    }
  })

  it('does not wait for a selection probe that is still running', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const subprocess = stubSubprocess()
    subprocess.terminalEnvironment = async () => {
      await gate
      return { platform: 'posix' }
    }
    const ctx = await makeContext({ subprocess })

    const handle = {
      get: () => ({ value: {}, revision: 0 }),
      watch: () => () => {},
      registerOperation: () => () => {},
    }
    const warnings = []
    await ctx.plugin({
      name: 'stub-dsh-loader',
      apply(context) {
        context.provide('dshLoader', {
          dshVersion: '0.2.2',
          config: { register: async () => handle },
        })
        context.provide('tools', { guard: () => () => {} })
        context.provide('logger', { info() {}, warn: message => { warnings.push(message) } })
      },
    })

    const started = Date.now()
    await apply(ctx, undefined)
    const elapsed = Date.now() - started

    assert.ok(elapsed < 500, `apply waited ${String(elapsed)} ms for a probe it does not need`)
    assert.deepEqual(warnings, [], 'a probe that is merely slow must not warn yet')

    // The probe settles after activation returned, which is what proves the
    // ordering: `apply` cannot have been waiting for it.
    release()
    await tick()
    await ctx.fiber.dispose()
  })
})
