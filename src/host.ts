/**
 * Runtime resolution of the harness packages this plugin extends.
 *
 * ## Why this module exists
 *
 * A third-party bundle lives in the profile (`<profile>/node_modules/...`)
 * while the harness that loads it lives somewhere else. Node resolves a bare
 * `@deepseek-ai/dsh-*` specifier from the *importing* file, and a profile's
 * `node_modules` tree is not guaranteed to carry the running harness at all —
 * on a launcher-managed installation it carries a junction to an older global
 * `dsh`, so a naive `import '@deepseek-ai/dsh-shell'` silently binds this
 * plugin's `ShellExecutor` base class to a different harness release than the
 * one that calls `apply()`. The failure then surfaces as an unrelated runtime
 * error, because a Cordis service is recognised by identity, not by shape.
 *
 * The one anchor that is always the *running* harness is the entry script Node
 * was started with: `dsh`'s own `bin.js`. Resolving from there yields the exact
 * package instances the host itself imported (Node's ESM cache is URL-keyed),
 * so subclasses, `instanceof`, and `ctx` objects all line up.
 *
 * ## Resolution ladder
 *
 * 1. `DSH_SHELL_SELECT_HOST_ANCHOR` — an explicit file path, for diagnosis and
 *    for embeddings that start Node with a different entry.
 * 2. `process.argv[1]` — the CLI entry (`dsh/lib/bin.js` for `dsh web`), the
 *    canonical case.
 * 3. `process.argv[0]`, then this module's own URL — a packaged application
 *    that boots through a wrapper still resolves through its npm tree.
 * 4. The bare specifier, resolved from this file — correct for a checkout that
 *    declares the harness packages as dev dependencies (this repository's own
 *    suites), and harmless everywhere else because it is tried last.
 *
 * Every candidate is version-gated: a resolution that lands on a harness older
 * than `0.2.2-0` is skipped rather than loaded, which is what makes step 4 safe
 * in a profile whose `node_modules` still points at an old global install.
 *
 * @module dsh-shell-select/host
 */

import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type * as DshBashLocal from '@deepseek-ai/dsh-bash-local'
import type * as DshJobs from '@deepseek-ai/dsh-jobs'
import type * as DshLlm from '@deepseek-ai/dsh-llm'
import type * as DshPwshLocal from '@deepseek-ai/dsh-pwsh-local'
import type * as DshSandbox from '@deepseek-ai/dsh-sandbox'
import type * as DshShell from '@deepseek-ai/dsh-shell'
import type * as DshSubprocess from '@deepseek-ai/dsh-subprocess'
import type * as DshTimeout from '@deepseek-ai/dsh-timeout'
import type * as DshTools from '@deepseek-ai/dsh-tools'

/**
 * The lowest harness release this plugin is written against.
 *
 * `0.2.2-0` admits every 0.2.2 prerelease, which is the shape of the releases
 * that introduced the `resolve()`/`execute()` shell seam and the config-api
 * settings surface this plugin uses.
 */
export const MINIMUM_DSH_VERSION = '0.2.2-0'

/** Environment variable overriding the resolution anchor. */
export const HOST_ANCHOR_ENV = 'DSH_SHELL_SELECT_HOST_ANCHOR'

/**
 * The harness packages this plugin extends, as one object so a caller reads a
 * single `host.` chain instead of nine separate imports.
 *
 * The value types are the packages' own module types, so the runtime objects
 * handed back here are statically indistinguishable from a static import.
 */
export interface HostModules {
  /** `@deepseek-ai/dsh-shell` — the `ctx.shell` seam and `ShellExecutor`. */
  readonly shell: typeof DshShell
  /** `@deepseek-ai/dsh-bash-local` — the POSIX local executor this plugin extends. */
  readonly bashLocal: typeof DshBashLocal
  /** `@deepseek-ai/dsh-pwsh-local` — the Windows local executor and pwsh discovery. */
  readonly pwshLocal: typeof DshPwshLocal
  /** `@deepseek-ai/dsh-sandbox` — confinement errors, markers, and escalation helpers. */
  readonly sandbox: typeof DshSandbox
  /** `@deepseek-ai/dsh-tools` — `defineTool`, argument errors, and tool contracts. */
  readonly tools: typeof DshTools
  /** `@deepseek-ai/dsh-subprocess` — executable-not-found classification. */
  readonly subprocess: typeof DshSubprocess
  /** `@deepseek-ai/dsh-jobs` — background job registration and errors. */
  readonly jobs: typeof DshJobs
  /** `@deepseek-ai/dsh-llm` — `HarnessError` and the `TOOL_ABORTED` carrier. */
  readonly llm: typeof DshLlm
  /** `@deepseek-ai/dsh-timeout` — the timer bound the executor budgets respect. */
  readonly timeout: typeof DshTimeout
  /** Anchor file the modules were resolved from, for diagnostics. */
  readonly anchor: string
  /** The resolved `@deepseek-ai/dsh-shell` version. */
  readonly dshVersion: string
}

/** One package this plugin needs, with the key it is exposed under. */
const HOST_PACKAGES = {
  shell: '@deepseek-ai/dsh-shell',
  bashLocal: '@deepseek-ai/dsh-bash-local',
  pwshLocal: '@deepseek-ai/dsh-pwsh-local',
  sandbox: '@deepseek-ai/dsh-sandbox',
  tools: '@deepseek-ai/dsh-tools',
  subprocess: '@deepseek-ai/dsh-subprocess',
  jobs: '@deepseek-ai/dsh-jobs',
  llm: '@deepseek-ai/dsh-llm',
  timeout: '@deepseek-ai/dsh-timeout',
} as const

/** One package name from {@link HOST_PACKAGES}. */
type HostPackageKey = keyof typeof HOST_PACKAGES

/**
 * Split a semantic version into its numeric core.
 *
 * Deliberately dependency-free: the only comparison this plugin needs is
 * "is the running harness at least MAJOR.MINOR.PATCH", and pulling in a full
 * semver implementation to answer it would add a runtime dependency to every
 * profile that installs the plugin. Prereleases compare by their numeric core,
 * which is exactly the `>= X.Y.Z-0` semantics: `0.2.2-rc.2` counts as 0.2.2.
 *
 * A leading range operator is tolerated (`>=0.2.2-0`), so a manifest's own
 * `engines.dsh` value can be handed straight to {@link satisfiesMinimum}.
 * @param version - a version string, optionally prefixed by a comparison operator.
 * @returns the numeric triple, or undefined when the string is not a version.
 */
export function versionCore(version: string): readonly [number, number, number] | undefined {
  const match = /^(?:[<>]=?|=|\^|~)?\s*(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version.trim())
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Whether a harness version is new enough for this plugin.
 * @param version - the resolved `@deepseek-ai/dsh-shell` version.
 * @param minimum - the lowest accepted version, `X.Y.Z[-pre]`.
 * @returns whether `version >= minimum` by numeric core.
 */
export function satisfiesMinimum(version: string, minimum: string = MINIMUM_DSH_VERSION): boolean {
  const actual = versionCore(version)
  const floor = versionCore(minimum)
  if (actual === undefined || floor === undefined) return false
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > floor[index]) return true
    if (actual[index] < floor[index]) return false
  }
  return true
}

/**
 * The candidate anchors, most trustworthy first.
 *
 * Duplicates and unreadable paths are dropped: a candidate is only useful if
 * `createRequire` can start a resolution from it.
 * @returns absolute file paths to resolve from.
 */
export function candidateAnchors(): string[] {
  const anchors: string[] = []
  const push = (candidate: string | undefined): void => {
    if (candidate === undefined || candidate.length === 0) return
    try {
      const absolute = resolve(candidate)
      const real = realpathSync(absolute)
      if (!anchors.includes(real)) anchors.push(real)
    } catch {
      // A path that cannot be canonicalized cannot anchor a resolution.
    }
  }
  push(process.env[HOST_ANCHOR_ENV])
  push(process.argv[1])
  push(process.argv[0])
  try {
    push(fileURLToPath(import.meta.url))
  } catch {
    // A non-file module URL cannot anchor a filesystem resolution.
  }
  return anchors
}

/**
 * Read one package's own version through a resolver.
 * @param require - the resolver anchored at a candidate.
 * @param name - the package name.
 * @returns the version, or undefined when the manifest is unreachable.
 */
function packageVersion(require: NodeRequire, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    // Packages that do not export `./package.json` still resolve their entry;
    // walk up from it instead of giving up on an otherwise usable anchor.
    try {
      let directory = dirname(require.resolve(name))
      for (let depth = 0; depth < 8; depth += 1) {
        const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
        if (manifest.name === name && typeof manifest.version === 'string') return manifest.version
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
      }
    } catch {
      // Neither shape is readable: this anchor cannot report a version.
    }
    return undefined
  }
}

/**
 * Load every harness package from one anchor, or refuse the anchor.
 *
 * A refusal is silent by design — {@link loadHostModules} reports the anchors
 * it tried once none works, which is the only point where the reason matters.
 * @param anchor - absolute file path to resolve from.
 * @returns the loaded modules, or undefined when this anchor is unusable.
 */
async function loadFrom(anchor: string): Promise<HostModules | undefined> {
  let require: NodeRequire
  try {
    require = createRequire(anchor)
    require.resolve(HOST_PACKAGES.shell)
  } catch {
    return undefined
  }
  const dshVersion = packageVersion(require, HOST_PACKAGES.shell)
  if (dshVersion === undefined || !satisfiesMinimum(dshVersion)) return undefined

  const loaded: Record<string, unknown> = {}
  for (const [key, name] of Object.entries(HOST_PACKAGES) as [HostPackageKey, string][]) {
    try {
      const entry = require.resolve(name)
      loaded[key] = await import(pathToFileURL(entry).href)
    } catch {
      // A harness package this release does not ship (or an anchor that only
      // carries part of the tree) makes the whole anchor unusable: a plugin
      // half-bound to one release and half to another is worse than none.
      return undefined
    }
  }
  return {
    ...(loaded as unknown as Omit<HostModules, 'anchor' | 'dshVersion'>),
    anchor,
    dshVersion,
  }
}

/**
 * The harness modules, resolved once per process.
 *
 * Module top-level await keeps the failure loud at load: a plugin that cannot
 * bind to the running harness must not appear to load and then misbehave on the
 * first command.
 */
export const host: HostModules = await loadHostModules()

/**
 * Resolve the harness modules through the anchor ladder.
 * @returns the modules bound to the running harness.
 * @throws {Error} naming every anchor that was tried.
 */
async function loadHostModules(): Promise<HostModules> {
  const anchors = candidateAnchors()
  for (const anchor of anchors) {
    const modules = await loadFrom(anchor)
    if (modules !== undefined) return modules
  }
  // Last resort: the bare specifier from this file. A checkout that declares
  // the harness as dev dependencies (this repository's suites) resolves here;
  // a profile whose tree is empty or stale does not, and the message below is
  // what the user then reads.
  try {
    const require = createRequire(import.meta.url)
    const version = packageVersion(require, HOST_PACKAGES.shell)
    if (version !== undefined && satisfiesMinimum(version)) {
      const loaded = await loadFrom(import.meta.url)
      if (loaded !== undefined) return loaded
    }
  } catch {
    // Fall through to the diagnostic.
  }
  throw new Error(
    '@dsh-plugin/dsh-shell-select: cannot locate a DeepSeek Harness '
    + `>=${MINIMUM_DSH_VERSION} to bind to. Tried anchors: ${anchors.length === 0 ? '(none)' : anchors.join(', ')}. `
    + `Set ${HOST_ANCHOR_ENV} to the absolute path of the running dsh entry (usually <dsh>/lib/bin.js).`,
  )
}
