/**
 * The package contract: what a profile installs, what the host reads, and what
 * the market page shows.
 *
 * These are the fields dsh validates before it activates a bundle and the ones
 * the plugin page renders without activating it, so a wrong path here is a
 * plugin that installs and then never appears — the failure mode with no useful
 * diagnostic from the host side.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Read one JSON file from the package root. */
function json(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'))
}

/** The package manifest. */
const pkg = json('package.json')

describe('package identity', () => {
  it('is the scoped name the executable exports', async () => {
    assert.equal(pkg.name, '@dsh-plugin/dsh-shell-select')
    const entry = await import('../lib/index.js')
    assert.equal(entry.name, pkg.name)
  })

  it('carries a stable X.Y.Z version, which the release workflow rewrites', () => {
    assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)
  })

  it('publishes publicly', () => {
    assert.equal(pkg.publishConfig.access, 'public')
    assert.equal(pkg.license, 'MIT')
  })
})

describe('the bundle declaration', () => {
  it('points dsh.bundle.patch at a file that exists', () => {
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(existsSync(join(root, pkg.dsh.bundle.patch)), true)
  })

  it('declares no client bundle, because dsh-loader owns the settings page', () => {
    assert.equal(pkg.dsh.client, undefined)
    assert.equal(pkg.exports['./client'], undefined)
  })

  it('mounts itself under a stable row id and disables both platform families', async () => {
    const { readFile } = await import('node:fs/promises')
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /- id: shell-select\n {6}name: '@dsh-plugin\/dsh-shell-select'/u)
    for (const id of ['bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh']) {
      assert.match(patch, new RegExp(`- id: ${id}\\n {2}disabled: true`, 'u'), `${id} is not disabled`)
    }
  })
})

describe('entry points', () => {
  it('exposes the built host entry and its types', () => {
    assert.equal(pkg.main, 'lib/index.js')
    assert.equal(pkg.types, 'lib/index.d.ts')
    assert.equal(pkg.exports['.'].default, './lib/index.js')
    assert.equal(pkg.exports['.'].types, './lib/index.d.ts')
    assert.equal(existsSync(join(root, 'lib/index.js')), true)
    assert.equal(existsSync(join(root, 'lib/index.d.ts')), true)
  })

  it('exposes its manifest, so a host can read it without loading the plugin', () => {
    assert.equal(pkg.exports['./package.json'], './package.json')
  })

  it('ships the build output, not the sources', () => {
    for (const entry of ['lib', 'locale', 'docs', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh_CN.md', 'LICENSE']) {
      assert.ok(pkg.files.includes(entry), `${entry} is not shipped`)
    }
    assert.equal(pkg.files.includes('src'), false)
  })
})

describe('display metadata', () => {
  it('ships both locale dictionaries with a title and a description', async () => {
    for (const locale of ['en', 'zh']) {
      const dictionary = json(`locale/${locale}.json`)
      assert.ok(dictionary.meta.title.length > 0, `${locale} has no title`)
      assert.ok(dictionary.meta.description.length > 0, `${locale} has no description`)
    }
    assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  })

  it('ships an icon the plugin page can render', () => {
    assert.equal(pkg.icon, './icon.svg')
    assert.equal(pkg.exports['./icon'], './icon.svg')
    const icon = readFileSync(join(root, 'icon.svg'), 'utf8')
    assert.match(icon, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u)
    assert.match(icon, /<\/svg>\s*$/u)
    // The host refuses an icon above 256 KiB.
    assert.ok(statSync(join(root, 'icon.svg')).size < 256 * 1024)
  })
})

describe('compatibility', () => {
  it('requires a harness release that has the 0.2.2 shell and config surfaces', () => {
    assert.equal(pkg.engines.dsh, '>=0.2.2-0')
  })

  it('admits prereleases of the target release, which is what the launcher ships', async () => {
    const { satisfiesMinimum } = await import('../lib/host.js')
    for (const version of ['0.2.2-rc.2', '0.2.2-alpha.3', '0.2.2', '0.2.3', '0.3.0']) {
      assert.equal(satisfiesMinimum(version, pkg.engines.dsh), true, `${version} was refused`)
    }
    for (const version of ['0.1.6-alpha.1', '0.2.1-rc.4', '0.2.1', '1.0.0-alpha.1'.replace('1.0.0', '0.1.0')]) {
      assert.equal(satisfiesMinimum(version, pkg.engines.dsh), false, `${version} was admitted`)
    }
  })

  it('requires the Node release the harness itself requires', () => {
    assert.equal(pkg.engines.node, '>=24.9.0')
  })

  it('declares dsh-loader as a peer, which is the only runtime dependency it has', () => {
    assert.ok(pkg.peerDependencies['@dsh-plugin/dsh-loader'])
    // No harness package is a runtime dependency: they are resolved from the
    // running installation at load time (see src/host.ts).
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      assert.equal(name.startsWith('@deepseek-ai/'), false, `${name} must not be a runtime dependency`)
    }
  })
})

describe('the repository descriptor', () => {
  it('points at the fork that publishes this package', () => {
    assert.match(pkg.repository.url, /dsh-plugins\/dsh-shell-select/u)
    assert.match(pkg.bugs.url, /dsh-plugins\/dsh-shell-select\/issues/u)
    assert.match(pkg.homepage, /dsh-plugins\/dsh-shell-select/u)
  })

  it('carries the ecosystem topics and a few that describe the feature', () => {
    for (const keyword of ['deepseek-harness', 'dsh', 'dsh-plugin', 'shell']) {
      assert.ok(pkg.keywords.includes(keyword), `${keyword} is missing`)
    }
  })
})
