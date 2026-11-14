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

import { apply, awaitSelection } from '../lib/index.js'
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
})

describe('plugin activation', () => {
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
