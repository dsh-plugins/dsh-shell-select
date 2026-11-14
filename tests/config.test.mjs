/**
 * The configuration model and the form derived from it.
 *
 * The two must never disagree: a default the form offers and the executor would
 * read differently is a bug the user sees as "I picked that and it did something
 * else". Every default in the template is therefore asserted against
 * {@link DEFAULT_CONFIG}, and every refusal is asserted to name its field.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AUTO_SHELL } from '../lib/catalog.js'
import {
  DEFAULT_CONFIG,
  DEFAULT_WSL_MOUNT_ROOT,
  PLUGIN_ID,
  PLUGIN_NAME,
  SELECTABLE_SHELL_IDS,
  resolvePluginConfig,
  settingsSnapshot,
} from '../lib/config.js'
import { createConfigTemplate, STATUS_OPERATION_ID, TEST_OPERATION_ID } from '../lib/config-template.js'

/** Every persisted key the template declares, flattened out of its groups. */
function declaredKeys(fields) {
  const keys = []
  for (const field of fields) {
    if (field.type === 'group') keys.push(...declaredKeys(field.fields))
    else keys.push(field.key)
  }
  return keys
}

describe('the configuration model', () => {
  it('defaults to automatic selection and the shipped budgets', () => {
    const resolved = resolvePluginConfig(undefined)
    assert.equal(resolved.shell, AUTO_SHELL)
    assert.equal(resolved.executable, '')
    assert.equal(resolved.loginShell, false)
    assert.equal(resolved.wslMountRoot, DEFAULT_WSL_MOUNT_ROOT)
    assert.equal(resolved.enableRunInBackground, true)
    assert.equal(resolved.timeoutMs, DEFAULT_CONFIG.timeoutMs)
    assert.equal(Object.isFrozen(resolved), true)
  })

  it('offers every catalog id on both platforms, plus auto', () => {
    for (const id of ['pwsh', 'powershell', 'cmd', 'gitbash', 'wsl', 'bash', 'zsh', 'fish', 'sh']) {
      assert.ok(SELECTABLE_SHELL_IDS.includes(id), `${id} is not selectable`)
    }
    assert.equal(SELECTABLE_SHELL_IDS.includes(AUTO_SHELL), false)
    assert.deepEqual([...SELECTABLE_SHELL_IDS].sort(), SELECTABLE_SHELL_IDS)
  })

  it('refuses an unknown shell by name, listing the alternatives', () => {
    assert.throws(() => resolvePluginConfig({ shell: 'nushell' }),
      /unknown shell "nushell"; expected "auto" or one of/u)
  })

  it('refuses a budget that is not a positive finite number', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '120000']) {
      assert.throws(() => resolvePluginConfig({ timeoutMs: value }), /"timeoutMs" must be a positive finite number/u)
    }
  })

  it('refuses a grace period that cannot fit a Node timer', () => {
    assert.throws(() => resolvePluginConfig({ graceMs: 2 ** 31 }), /"graceMs" must be no greater than/u)
  })

  it('refuses a ceiling below the default timeout', () => {
    assert.throws(
      () => resolvePluginConfig({ timeoutMs: 10_000, maxTimeoutMs: 5_000 }),
      /"maxTimeoutMs" \(5000\) must be no smaller than "timeoutMs" \(10000\)/u,
    )
  })

  it('trims the executable and the distro, and restores an empty mount root', () => {
    const resolved = resolvePluginConfig({ executable: '  /opt/bash  ', wslDistro: ' Ubuntu ', wslMountRoot: '  ' })
    assert.equal(resolved.executable, '/opt/bash')
    assert.equal(resolved.wslDistro, 'Ubuntu')
    assert.equal(resolved.wslMountRoot, DEFAULT_WSL_MOUNT_ROOT)
  })

  it('ignores a value of the wrong type where a default is meaningful', () => {
    const resolved = resolvePluginConfig({ loginShell: 'yes', enableRunInBackground: 1, executable: 42 })
    assert.equal(resolved.loginShell, false)
    assert.equal(resolved.enableRunInBackground, true)
    assert.equal(resolved.executable, '')
  })

  it('narrows the per-call snapshot to the fields one call reads', () => {
    const snapshot = settingsSnapshot(resolvePluginConfig({ executable: '/opt/bash', wslDistro: '' }))
    assert.deepEqual(snapshot, {
      shell: AUTO_SHELL,
      loginShell: false,
      executable: '/opt/bash',
      wslDistro: undefined,
      wslMountRoot: DEFAULT_WSL_MOUNT_ROOT,
    })
    assert.equal(Object.isFrozen(snapshot), true)
  })
})

describe('the settings form', () => {
  it('declares the plugin identity the package carries', () => {
    const template = createConfigTemplate()
    assert.equal(template.id, PLUGIN_ID)
    assert.equal(template.packageName, PLUGIN_NAME)
    assert.equal(PLUGIN_NAME, '@dsh-plugin/dsh-shell-select')
    assert.equal(template.id.includes('/'), false)
    assert.ok(template.title.length > 0)
  })

  it('declares every persisted field the model reads', () => {
    const keys = declaredKeys(createConfigTemplate().fields)
    assert.deepEqual(keys, [
      'shell', 'executable', 'loginShell', 'wslDistro', 'wslMountRoot', 'enableRunInBackground',
      'timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'maxSpillBytes', 'graceMs',
    ])
  })

  it('uses the runtime defaults, so the form and the executor cannot disagree', () => {
    const template = createConfigTemplate()
    const flat = new Map()
    const walk = fields => {
      for (const field of fields) {
        if (field.type === 'group') walk(field.fields)
        else flat.set(field.key, field.default)
      }
    }
    walk(template.fields)
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      assert.equal(flat.get(key), value, `${key} default drifted from the runtime model`)
    }
  })

  it('offers auto plus every selectable shell', () => {
    const select = createConfigTemplate().fields.find(field => field.key === 'shell')
    assert.equal(select.type, 'select')
    assert.deepEqual(select.options.map(option => option.value), [AUTO_SHELL, ...SELECTABLE_SHELL_IDS])
    // Every option carries a human label, so none renders as a bare id.
    for (const option of select.options) assert.ok(option.label.length > 0)
  })

  it('declares the two panels and their operations', () => {
    const template = createConfigTemplate()
    assert.deepEqual(template.panels.map(panel => panel.id), ['status', 'test'])
    const status = template.panels.find(panel => panel.id === 'status')
    assert.equal(status.operations[0].id, STATUS_OPERATION_ID)
    assert.equal(status.operations[0].readOnly, true)
    assert.equal(status.operations[0].autoRun, true)
    const test = template.panels.find(panel => panel.id === 'test')
    assert.equal(test.operations[0].id, TEST_OPERATION_ID)
    assert.equal(test.operations[0].readOnly, false)
    assert.equal(test.operations[0].requiresRevision, undefined)
    // The button exists, which is what makes the operation reachable at all.
    assert.ok(test.operations[0].button.label.length > 0)
  })

  it('returns the shell facts beside the test result, since a panel may only refresh itself', () => {
    const test = createConfigTemplate().panels.find(panel => panel.id === 'test')
    const status = createConfigTemplate().panels.find(panel => panel.id === 'status')
    // dsh-loader rejects a refresh that names another panel's operation, so the
    // test returns the facts itself instead of asking for one.
    assert.equal(test.operations[0].refresh, undefined)
    assert.deepEqual(test.operations[0].result.map(view => view.path[0]), ['report', 'status'])
    assert.deepEqual(status.operations[0].result.map(view => view.path[0]), ['report'])
  })
})
