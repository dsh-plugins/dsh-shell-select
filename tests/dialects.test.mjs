/**
 * Argument dialects: one command text in, one argv out.
 *
 * Every case asserts the whole argv, because the risk this module carries is a
 * shell receiving its command through the wrong convention — a `cmd.exe` flag on
 * a bash call, or a command concatenated into a string that then needs a second
 * round of quoting.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CMD_COMMAND_ENV,
  POWERSHELL_ENCODING_PREAMBLE,
  bashArguments,
  buildInvocation,
  testCommand,
  toLinuxPath,
  transportEnv,
  versionArgv,
  TEST_MARKER,
} from '../lib/dialects.js'

describe('bash family', () => {
  it('passes the command as one argv element', () => {
    assert.deepEqual(buildInvocation('bash', { executable: '/bin/bash', command: 'echo hi' }).argv,
      ['/bin/bash', '-c', 'echo hi'])
  })

  it('adds the login flag before -c, never --rcfile', () => {
    assert.deepEqual(bashArguments('ls', true), ['-l', '-c', 'ls'])
    assert.deepEqual(bashArguments('ls', false), ['-c', 'ls'])
  })

  it('keeps quoting inside the command untouched', () => {
    const command = 'printf "%s\\n" "a b"'
    assert.deepEqual(buildInvocation('bash', { executable: 'bash', command }).argv, ['bash', '-c', command])
  })
})

describe('PowerShell', () => {
  it('pins UTF-8 before the command on the same line', () => {
    const argv = buildInvocation('powershell', { executable: 'pwsh', command: 'Get-Location' }).argv
    assert.deepEqual(argv.slice(0, 5), ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    assert.equal(argv[5], `${POWERSHELL_ENCODING_PREAMBLE}Get-Location`)
    // The preamble must not introduce a newline: PowerShell error line numbers
    // are reported against the text the model wrote.
    assert.equal(argv[5].includes('\n'), false)
  })
})

describe('cmd.exe', () => {
  it('routes the command through the environment transport', () => {
    const invocation = buildInvocation('cmd', { executable: 'cmd.exe', command: 'dir "C:\\a b"' })
    assert.deepEqual(invocation.argv, ['cmd.exe', '/d', '/q', '/c', `%${CMD_COMMAND_ENV}%`])
    assert.deepEqual(invocation.env, { [CMD_COMMAND_ENV]: 'dir "C:\\a b"' })
  })

  it('reports the transport env from the command alone', () => {
    assert.deepEqual(transportEnv('cmd', 'echo hi'), { [CMD_COMMAND_ENV]: 'echo hi' })
    for (const dialect of ['bash', 'powershell', 'wsl']) {
      assert.equal(transportEnv(dialect, 'echo hi'), undefined)
    }
  })
})

describe('WSL', () => {
  it('translates the working directory into the mount namespace', () => {
    assert.equal(toLinuxPath('D:\\work\\sub', '/mnt'), '/mnt/d/work/sub')
    assert.equal(toLinuxPath('C:/', '/mnt'), '/mnt/c')
    assert.equal(toLinuxPath('C:\\', '/custom'), '/custom/c')
  })

  it('refuses a path with no drive letter rather than guessing a directory', () => {
    assert.throws(() => toLinuxPath('\\\\server\\share\\x', '/mnt'), /only drive-letter paths/u)
  })

  it('names the distribution only when one is configured', () => {
    const without = buildInvocation('wsl', {
      executable: 'wsl.exe', command: 'pwd', windowsCwd: 'C:\\w', mountRoot: '/mnt',
    }).argv
    assert.deepEqual(without, ['wsl.exe', '--cd', '/mnt/c/w', '-e', 'bash', '-c', 'pwd'])
    const withDistro = buildInvocation('wsl', {
      executable: 'wsl.exe', command: 'pwd', windowsCwd: 'C:\\w', mountRoot: '/mnt', distro: 'Ubuntu',
    }).argv
    assert.deepEqual(withDistro, ['wsl.exe', '-d', 'Ubuntu', '--cd', '/mnt/c/w', '-e', 'bash', '-c', 'pwd'])
  })

  it('carries the login flag into the inner bash', () => {
    const argv = buildInvocation('wsl', {
      executable: 'wsl.exe', command: 'pwd', windowsCwd: 'C:\\w', mountRoot: '/mnt', loginShell: true,
    }).argv
    assert.deepEqual(argv.slice(-3), ['-l', '-c', 'pwd'])
  })
})

describe('version queries and the self-test', () => {
  it('asks each family its own question', () => {
    assert.deepEqual(versionArgv('bash', '/bin/bash'), ['/bin/bash', '--version'])
    assert.deepEqual(versionArgv('cmd', 'cmd.exe'), ['cmd.exe', '/d', '/q', '/c', 'ver'])
    assert.deepEqual(versionArgv('wsl', 'wsl.exe'), ['wsl.exe', '--version'])
    assert.deepEqual(versionArgv('powershell', 'pwsh').slice(-1),
      ['$PSVersionTable.PSVersion.ToString()'])
  })

  it('refuses an unknown dialect', () => {
    assert.throws(() => versionArgv('nushell', 'nu'), /unknown dialect/u)
    assert.throws(() => buildInvocation('nushell', { executable: 'nu', command: 'ls' }), /unknown dialect/u)
  })

  it('prints only its own marker, and takes no input', () => {
    assert.equal(testCommand(), `echo ${TEST_MARKER}`)
  })
})
