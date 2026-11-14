/**
 * The catalog: identity, confinement claims, and the `auto` preference order.
 *
 * Everything here is a pure function of `(platform, environment)`, so a
 * simulated Windows composition is exercised on this POSIX host and the other
 * way round.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AUTO_SHELL,
  VERIFIED_CONFINEMENT_PLATFORMS,
  catalogFor,
  checkConfinement,
  checkIdentity,
  entryClaiming,
  findEntry,
  localPlatform,
  probeFor,
  programName,
} from '../lib/catalog.js'
import { versionArgv } from '../lib/dialects.js'

describe('catalog shape', () => {
  it('puts PowerShell first on Windows and bash first on POSIX', () => {
    assert.equal(catalogFor('windows')[0].id, 'pwsh')
    assert.equal(catalogFor('posix')[0].id, 'bash')
  })

  it('gives every entry a unique id, a label, a syntax note, and at least one name', () => {
    for (const platform of ['windows', 'posix']) {
      const ids = new Set()
      for (const entry of catalogFor(platform)) {
        assert.equal(ids.has(entry.id), false, `${entry.id} is duplicated on ${platform}`)
        ids.add(entry.id)
        assert.ok(entry.label.length > 0, `${entry.id} has no label`)
        assert.ok(entry.syntax.length > 0, `${entry.id} has no syntax note`)
        assert.ok(entry.names.length > 0, `${entry.id} claims no program name`)
        assert.ok(entry.candidates(undefined).length > 0, `${entry.id} probes nothing`)
      }
    }
  })

  it('marks only the two shells whose Windows confinement was measured as unconfineable', () => {
    const unconfineable = catalogFor('windows')
      .filter(entry => (entry.confineable ?? { confined: true }).confined === false)
      .map(entry => entry.id)
    assert.deepEqual(unconfineable.sort(), ['gitbash', 'wsl'])
    assert.equal(VERIFIED_CONFINEMENT_PLATFORMS.includes('windows'), true)
    assert.equal(VERIFIED_CONFINEMENT_PLATFORMS.includes('posix'), false)
  })

  it('reports this host\u2019s own platform', () => {
    assert.equal(localPlatform(), process.platform === 'win32' ? 'windows' : 'posix')
  })

  it('refuses an unknown platform by name', () => {
    assert.throws(() => catalogFor('plan9'), /unknown platform/u)
  })
})

describe('program names and identity', () => {
  it('takes the last segment for either separator', () => {
    assert.equal(programName('C:\\Program Files\\Git\\bin\\bash.exe'), 'bash.exe')
    assert.equal(programName('/usr/local/bin/zsh'), 'zsh')
    assert.equal(programName('bash'), 'bash')
  })

  it('finds entries by id, and nothing for an id this platform lacks', () => {
    assert.equal(findEntry('windows', 'gitbash').label, 'Git Bash')
    assert.equal(findEntry('posix', 'cmd'), undefined)
  })

  it('claims a program name exactly once, and refuses an ambiguous one', () => {
    assert.equal(entryClaiming('posix', 'sh').id, 'sh')
    assert.equal(entryClaiming('posix', 'dash').id, 'sh')
    assert.equal(entryClaiming('posix', 'BASH').id, 'bash')
    assert.equal(entryClaiming('posix', 'unknown-shell'), undefined)
  })

  it('refuses an override that resolved to a different catalog shell', () => {
    const entry = findEntry('windows', 'pwsh')
    const verdict = checkIdentity(entry, 'C:\\Windows\\system32\\cmd.exe', 'windows')
    assert.equal(verdict.ok, false)
    assert.match(verdict.detail, /that is Command Prompt/u)
  })

  it('accepts an unknown program name, which is how a relocated install works', () => {
    const entry = findEntry('posix', 'bash')
    assert.deepEqual(checkIdentity(entry, '/opt/custom/bin/my-bash', 'posix'), { ok: true })
  })

  it('applies the entry\u2019s own acceptance guard', () => {
    const entry = findEntry('windows', 'gitbash')
    assert.equal(checkIdentity(entry, 'D:\\Git\\bin\\bash.exe', 'windows').ok, true)
    assert.equal(checkIdentity(entry, 'D:\\Git\\git-bash.exe', 'windows').ok, false)
  })
})

describe('confinement decisions', () => {
  it('allows an unconfineable shell only under danger-full-access', () => {
    const entry = findEntry('windows', 'gitbash')
    assert.equal(checkConfinement(entry, 'danger-full-access').ok, true)
    const refused = checkConfinement(entry, 'workspace-write')
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /MSYS2/u)
  })

  it('allows a confineable shell under every mode', () => {
    const entry = findEntry('posix', 'bash')
    assert.deepEqual(checkConfinement(entry, 'read-only'), { ok: true, confined: true })
    assert.deepEqual(checkConfinement(entry, 'danger-full-access'), { ok: true, confined: false })
  })
})

describe('probe selection', () => {
  it('uses the dialect\u2019s version query by default', () => {
    const entry = findEntry('posix', 'bash')
    const probe = probeFor(entry, '/bin/bash', versionArgv)
    assert.equal(probe.kind, 'version')
    assert.deepEqual([...probe.argv], ['/bin/bash', '--version'])
  })

  it('honours an entry that declares its own interpreter query', () => {
    const entry = findEntry('posix', 'sh')
    const probe = probeFor(entry, '/bin/sh', versionArgv)
    assert.equal(probe.kind, 'interpreter')
    assert.deepEqual([...probe.argv], ['/bin/sh', '-c', 'echo "$0"'])
  })
})

describe('candidate enumeration', () => {
  it('derives Git for Windows install roots from PATH, keeping both bash locations', () => {
    const entry = findEntry('windows', 'gitbash')
    const candidates = entry.candidates({ PATH: 'D:\\Git\\cmd;C:\\Tools\\git\\mingw64\\bin' })
    assert.deepEqual(candidates.slice(0, 3), [
      'D:\\Git\\bin\\bash.exe',
      'D:\\Git\\usr\\bin\\bash.exe',
      'C:\\Tools\\git\\bin\\bash.exe',
    ])
    // The bare name is probed last, so an unusual install still has one chance.
    assert.equal(candidates.at(-1), 'bash.exe')
  })

  it('excludes the WSL launcher and Store shims from the Git Bash scan', () => {
    const entry = findEntry('windows', 'gitbash')
    const candidates = entry.candidates({
      PATH: 'C:\\Windows\\system32;C:\\Windows\\System32\\OpenSSH;C:\\Windows\\system32\\WindowsApps',
    })
    assert.deepEqual(candidates, ['bash.exe'])
  })

  it('reads this process\u2019s environment when no explicit one is given', () => {
    // The fallback is what makes discovery work at all for a shell whose install
    // root is only knowable from PATH; without it PATH-derived candidates are
    // empty and every such shell reports "not installed".
    const entry = findEntry('windows', 'gitbash')
    const withProcessEnv = entry.candidates(undefined)
    assert.ok(withProcessEnv.length >= 1)
    // Every Windows candidate is a Windows path, never a host-dependent join.
    for (const candidate of withProcessEnv) {
      assert.equal(/^[A-Za-z]:[\\/]/u.test(candidate) || candidate === 'bash.exe', true, candidate)
    }
  })

  it('prefers %ComSpec% for cmd, then the bare name', () => {
    const entry = findEntry('windows', 'cmd')
    assert.deepEqual(entry.candidates({ ComSpec: 'D:\\Windows\\system32\\cmd.exe' }),
      ['D:\\Windows\\system32\\cmd.exe', 'cmd.exe'])
    assert.deepEqual(entry.candidates({}), ['cmd.exe'])
  })
})

describe('the automatic value', () => {
  it('is not a catalog id, so no platform claims it', () => {
    assert.equal(AUTO_SHELL, 'auto')
    for (const platform of ['windows', 'posix']) {
      assert.equal(findEntry(platform, AUTO_SHELL), undefined)
    }
  })
})
