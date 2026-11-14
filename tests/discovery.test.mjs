/**
 * Discovery and the working-directory rule.
 *
 * The resolver is a stub so each refusal path can be driven deterministically:
 * what matters here is that a configured path fails *by name* instead of
 * falling back to a search, and that a working directory is validated for
 * shape everywhere and for existence only on the platform that can answer.
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  catalogFor,
  findEntry,
  localPlatform,
} from '../lib/catalog.js'
import {
  inspectCatalog,
  inspectShell,
  requireWorkingDirectory,
  resolveShell,
} from '../lib/discovery.js'
import { makeFixture, removeFixture, stubSubprocess, workdirFor } from './helpers.mjs'

const fixture = makeFixture('discovery')
after(() => { removeFixture(fixture) })

const workdir = join(fixture, 'work')
mkdirSync(workdir, { recursive: true })

/** A context-shaped object the discovery helpers read. */
function resolverFor(subprocess) {
  return { subprocess }
}

describe('resolving a configured executable', () => {
  it('uses the configured path and reports it as configured', async () => {
    const subprocess = stubSubprocess({
      platform: 'posix',
      resolvable: { '/opt/bash': '/opt/bash' },
    })
    const result = await resolveShell(resolverFor(subprocess), {
      entry: findEntry('posix', 'bash'),
      configuredPath: '/opt/bash',
      platform: 'posix',
    })
    assert.deepEqual(result, { path: '/opt/bash', source: 'configured' })
  })

  it('fails by name instead of falling back to discovery', async () => {
    const subprocess = stubSubprocess({ platform: 'posix', resolvable: { bash: '/bin/bash' } })
    await assert.rejects(
      resolveShell(resolverFor(subprocess), {
        entry: findEntry('posix', 'bash'),
        configuredPath: '/nope/bash',
        platform: 'posix',
      }),
      /not an executable file in the execution environment: \/nope\/bash/u,
    )
    // Only the configured path was tried; the discoverable `bash` was not used.
    assert.deepEqual(subprocess.resolutions, ['/nope/bash'])
  })

  it('refuses a configured path that is a different catalog shell', async () => {
    const subprocess = stubSubprocess({
      platform: 'windows',
      resolvable: { 'D:\\Git\\bin\\bash.exe': 'D:\\Git\\bin\\bash.exe' },
    })
    await assert.rejects(
      resolveShell(resolverFor(subprocess), {
        entry: findEntry('windows', 'pwsh'),
        configuredPath: 'D:\\Git\\bin\\bash.exe',
        platform: 'windows',
      }),
      /is not that shell/u,
    )
  })

  it('trims a blank configured path away rather than resolving an empty name', async () => {
    const subprocess = stubSubprocess({ platform: 'posix', resolvable: { bash: '/bin/bash' } })
    const result = await resolveShell(resolverFor(subprocess), {
      entry: findEntry('posix', 'bash'),
      configuredPath: '   ',
      platform: 'posix',
    })
    assert.equal(result.source, 'discovered')
    assert.deepEqual(subprocess.resolutions, ['bash'])
  })
})

describe('discovery', () => {
  it('walks candidates in order and reports the first that resolves', async () => {
    const subprocess = stubSubprocess({ platform: 'posix', resolvable: { sh: '/usr/bin/sh' } })
    const result = await resolveShell(resolverFor(subprocess), {
      entry: findEntry('posix', 'sh'),
      platform: 'posix',
    })
    assert.deepEqual(result, { path: '/usr/bin/sh', source: 'discovered' })
  })

  it('names every probed location when nothing resolves', async () => {
    const subprocess = stubSubprocess({ platform: 'windows', resolvable: {} })
    await assert.rejects(
      resolveShell(resolverFor(subprocess), {
        entry: findEntry('windows', 'pwsh'),
        platform: 'windows',
      }),
      /no PowerShell executable found in the execution environment; set "executable"/u,
    )
  })

  it('reports the failure instead of throwing, for status surfaces', async () => {
    const subprocess = stubSubprocess({ platform: 'posix', resolvable: {} })
    const inspection = await inspectShell(resolverFor(subprocess), {
      entry: findEntry('posix', 'fish'),
      platform: 'posix',
    })
    assert.equal(inspection.available, false)
    assert.match(inspection.detail, /no Fish executable/u)
  })

  it('skips a candidate whose identity check fails, then accepts the next', async () => {
    // A Git-Bash install whose first candidate is the GUI launcher.
    const subprocess = stubSubprocess({
      platform: 'windows',
      resolvable: {
        'D:\\Git\\bin\\bash.exe': 'D:\\Git\\git-bash.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe': 'C:\\Program Files\\Git\\bin\\bash.exe',
      },
    })
    const result = await resolveShell(resolverFor(subprocess), {
      entry: findEntry('windows', 'gitbash'),
      platform: 'windows',
      env: { PATH: 'D:\\Git\\cmd;C:\\Program Files\\Git\\cmd' },
    })
    assert.equal(result.path, 'C:\\Program Files\\Git\\bin\\bash.exe')
  })
})

describe('one status row per catalog entry', () => {
  it('marks the selected row and applies its override to it alone', async () => {
    const subprocess = stubSubprocess({
      platform: 'posix',
      resolvable: { bash: '/bin/bash', '/opt/zsh': '/opt/zsh', fish: '/usr/bin/fish', sh: '/bin/sh', pwsh: '/opt/pwsh' },
    })
    const rows = await inspectCatalog(resolverFor(subprocess), 'posix', {
      selectedId: 'zsh',
      overrideFor: (entry, selected) => selected ? '/opt/zsh' : undefined,
    })
    assert.equal(rows.length, catalogFor('posix').length)
    const zsh = rows.find(row => row.id === 'zsh')
    assert.equal(zsh.selected, true)
    assert.equal(zsh.path, '/opt/zsh')
    assert.equal(zsh.source, 'configured')
    assert.equal(rows.find(row => row.id === 'bash').source, 'discovered')
    // Every row carries the facts the panel needs.
    for (const row of rows) {
      assert.equal(typeof row.confineable, 'boolean')
      assert.equal(typeof row.supportsLoginShell, 'boolean')
      assert.equal(typeof row.supportsDistro, 'boolean')
      assert.ok(row.syntax.length > 0)
    }
  })
})

describe('the working-directory rule', () => {
  it('refuses a missing, empty, or wrong-shaped directory', () => {
    assert.throws(() => requireWorkingDirectory(undefined, 'posix'), /without a working directory/u)
    assert.throws(() => requireWorkingDirectory('', 'posix'), /without a working directory/u)
    assert.throws(() => requireWorkingDirectory('relative/dir', 'posix'), /must be an absolute posix path/u)
    assert.throws(() => requireWorkingDirectory('C:\\work', 'posix'), /must be an absolute posix path/u)
    assert.throws(() => requireWorkingDirectory('/work', 'windows'), /must be an absolute windows path/u)
  })

  it('checks existence only for this host\u2019s own platform', () => {
    const host = localPlatform()
    const real = workdirFor(host, workdir)
    assert.equal(requireWorkingDirectory(real, host), real)
    // A path shaped for the other platform is accepted on shape alone, because a
    // local stat cannot answer for that machine.
    const other = host === 'windows' ? 'posix' : 'windows'
    assert.equal(requireWorkingDirectory(workdirFor(other, workdir), other), workdirFor(other, workdir))
  })

  it('refuses a directory that does not exist on this host', () => {
    assert.throws(
      () => requireWorkingDirectory(join(fixture, 'missing'), localPlatform()),
      /does not exist/u,
    )
  })

  it('refuses a file where a directory is required', () => {
    const platform = localPlatform()
    const file = join(fixture, 'not-a-directory')
    writeFileSync(file, 'x')
    assert.throws(() => requireWorkingDirectory(file, platform), /is not a directory/u)
  })
})
