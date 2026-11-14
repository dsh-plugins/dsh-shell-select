/**
 * The `ctx.shell` provider for a user-selected shell.
 *
 * The process mechanics — deadlines, bounded and spilled output, the background
 * process handle, process-tree termination — are inherited from the harness's
 * own local executor for the running platform: `@deepseek-ai/dsh-pwsh-local` on
 * Windows, `@deepseek-ai/dsh-bash-local` elsewhere. Those two are deliberate
 * mirrors, so one subclass body drives either. This class replaces exactly two
 * things: **which argv** is built, and **the decision** that refuses a call
 * before any process exists.
 *
 * The decision is asynchronous because finding an executable goes through
 * `ctx.subprocess.resolveExecutable`, the only resolution that is correct in a
 * remote execution world. `resolve()` therefore performs only the defaulting and
 * the per-call policy stamping that must happen synchronously; every refusal
 * lives in {@link ShellSelectExecutor.decide}, ahead of confinement and ahead of
 * the spawn.
 *
 * @module dsh-shell-select/executor
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcess,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxMode,
} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

import {
  AUTO_SHELL,
  catalogFor,
  checkConfinement,
  entryClaiming,
  findEntry,
  localPlatform,
  programName,
  type CatalogEntry,
  type Environment,
  type Platform,
} from './catalog.js'
import {
  DEFAULT_CONFIG,
  PLUGIN_NAME,
  resolvePluginConfig,
  settingsSnapshot,
  type CallSettings,
  type ResolvedPluginConfig,
} from './config.js'
import { buildInvocation, transportEnv } from './dialects.js'
import {
  inspectCatalog,
  inspectShell,
  requireWorkingDirectory,
  resolveShell,
  type CatalogRow,
} from './discovery.js'
import { host } from './host.js'
import type { ProbeOutcome } from './status.js'

/** Deadline for one plugin-owned version probe, in milliseconds. */
const PROBE_TIMEOUT_MS = 10_000

/** Per-stream cap for a probe's output: a version line is all it may return. */
const PROBE_MAX_BYTES = 8_192

/**
 * Symbol key under which a spawn-ready spec carries the decision it was built
 * from.
 *
 * Enumerable on purpose: the background path hands the spec on as
 * `{ ...spec, signal }`, and the spread has to carry the decision with it so
 * the job spawns exactly what was decided rather than deciding again.
 */
const DECIDED = Symbol('dsh-shell-select.decided')

/** The shell facts one decision fixed for one call. */
export interface DecisionShell {
  readonly id: string
  readonly label: string
  readonly dialect: CatalogEntry['dialect']
  readonly platform: Platform
  readonly executable: string
  readonly source: 'configured' | 'discovered'
  readonly workdir: string
  readonly loginShell: boolean
  readonly confineable: boolean
}

/** Everything one call's decision fixed, before any process existed. */
export interface Decision {
  readonly platform: Platform
  readonly entry: CatalogEntry
  readonly executable: string
  readonly source: 'configured' | 'discovered'
  readonly argv: readonly string[]
  readonly settings: CallSettings
  readonly shell: DecisionShell
}

/** A decided spec: the caller's spec plus the decision that built its argv. */
export type DecidedSpec = ShellExecSpec & { readonly [DECIDED]?: Decision }

/**
 * Refusal raised before any process exists, when the selected shell may not run
 * under the mode the caller resolved.
 *
 * A distinct type so the tool layer and the suites can assert the fail-closed
 * path rather than pattern-matching an error message.
 */
export class ShellSelectionRefusedError extends Error {
  /** The catalog id the refusal is about. */
  readonly shellId: string
  /** The sandbox mode the call resolved. */
  readonly mode: string

  /**
   * @param entry - the selected catalog entry.
   * @param mode - the sandbox mode the call resolved.
   * @param reason - the measured reason confinement is impossible.
   */
  constructor(entry: CatalogEntry, mode: string, reason: string) {
    super(
      `dsh-shell-select: refusing to run. The selected shell (${entry.label}) cannot be confined by the `
      + `sandbox on this platform, and this call resolved to "${mode}" mode. ${reason} `
      + 'Select a shell that supports confinement, switch this session to danger-full-access to run '
      + 'deliberately unconfined, or change the session mode. This plugin never falls back to another '
      + 'shell and never silently drops the sandbox.',
    )
    this.name = 'ShellSelectionRefusedError'
    this.shellId = entry.id
    this.mode = mode
  }
}

/** The local executor class this platform seats under the selector. */
type PlatformExecutorConstructor = new (ctx: Context, config: unknown) => import('@deepseek-ai/dsh-bash-local').LocalBashExecutor

/** The local executor this platform inherits its process mechanics from. */
const PLATFORM_BASE = (
  process.platform === 'win32' ? host.pwshLocal.PwshLocalExecutor : host.bashLocal.LocalBashExecutor
) as unknown as PlatformExecutorConstructor

/**
 * Wrap one resolved number as the readonly reference the local executors read.
 *
 * The inherited executors take their budgets through `Volatile.get()` because
 * the schema marks them volatile (a settings write replaces the reference, not
 * the executor). This plugin's budgets arrive from dsh-loader's form instead of
 * from the Cordis entry, so it builds the same reference shape here — one
 * description of the value, read the same way by the same code.
 * @param value - the resolved budget.
 * @returns the reference.
 */
function budget(value: number): { get: () => number } {
  return { get: () => value }
}

/**
 * The composition configuration the inherited executor's schema resolves.
 * @param values - the resolved plugin configuration.
 * @returns the entry to construct the executor with.
 */
export function executorConfig(values: ResolvedPluginConfig): Record<string, unknown> {
  return {
    cwd: { get: () => undefined },
    // Skip the Windows parent's synchronous PATH/filesystem scan. Our argv()
    // resolves the selected executable through subprocess before every spawn;
    // this placeholder is never used to execute a command.
    pwshPath: { get: () => 'pwsh' },
    timeoutMs: budget(values.timeoutMs),
    maxTimeoutMs: budget(values.maxTimeoutMs),
    maxOutputBytes: budget(values.maxOutputBytes),
    maxSpillBytes: budget(values.maxSpillBytes),
    graceMs: budget(values.graceMs),
  }
}

/**
 * Shell executor over the harness's own local process machinery.
 *
 * Registered as `ctx.shell`. Tool calls pass the calling session's resolved
 * policy; lower-level callers fall back to the deployment policy.
 *
 * Constructed by this plugin's `apply()` on its own context rather than mounted
 * as a separate Cordis plugin, so the *plugin's* `inject` list is what guarantees
 * `subprocess`, `sandbox`, and `sandboxPolicy` exist. `static inject` remains as
 * documentation for anyone who mounts the class directly; it is inert here.
 */
export class ShellSelectExecutor extends PLATFORM_BASE {
  /** Services the inherited process mechanics and the decision need. */
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  // Cordis hands services through a Proxy, so ECMAScript `#private` members
  // cannot be read from an instance method (a getter's `this` is the proxy, not
  // the instance). Internal state is therefore plain, documented fields.

  /**
   * The currently authoritative configuration: the dsh-loader config-api
   * snapshot once the plugin mounts one, otherwise the composition entry.
   */
  shellSettings: () => ResolvedPluginConfig

  /**
   * Last known selection facts, for the synchronous surfaces — the model-facing
   * description and the tool's per-call metadata.
   *
   * Owned by {@link ShellSelectExecutor.refreshSelection} alone: execution never
   * writes it and never reads it, so a stale entry can make the description
   * briefly wrong but can never make a command run through a shell the user did
   * not select, and can never make a result report one either.
   */
  selection: {
    platform: Platform
    entry?: CatalogEntry
    available?: boolean
    path?: string
    detail?: string
    pending?: boolean
  } = { platform: localPlatform(), entry: undefined, pending: true }

  /**
   * Id of the newest selection refresh. A refresh publishes only while it is
   * still the newest, so two overlapping refreshes cannot let an older, slower
   * answer overwrite a newer one.
   */
  selectionGeneration = 0

  /**
   * Resolves once the first {@link ShellSelectExecutor.refreshSelection} settles.
   *
   * The constructor seeds a provisional selection so the label and syntax are
   * never empty, then refines it asynchronously because finding an executable
   * goes through the subprocess seam. Consumers that need the settled answer
   * rather than the provisional one await this.
   */
  ready: Promise<unknown> = Promise.resolve()

  /** Per-process confinement facts retained until settlement, keyed by handle. */
  processFacts = new Map<ShellProcess, {
    mode: SandboxMode
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureRules: readonly RunnerFailureRule[]
    runnerProgram: string | undefined
    workdir: string
  }>()

  /**
   * @param ctx - plugin context carrying subprocess, sandbox, and sandbox policy.
   * @param config - the inherited executor's budgets, as the composition entry
   *   or as {@link executorConfig} built them.
   * @param settings - the live configuration source; omitted when the executor
   *   is mounted as a Cordis plugin, in which case its entry is the source.
   */
  constructor(ctx: Context, config: unknown, settings?: () => ResolvedPluginConfig) {
    super(ctx, config)
    this.shellSettings = settings ?? (() => resolvePluginConfig(config))
    // Seed the entry from the configuration and the local platform so a first
    // read already knows the label, the syntax, and the confinement facts. Only
    // the resolved executable waits for the seam.
    this.selection = { platform: localPlatform(), entry: this.provisionalEntry(localPlatform()), pending: true }
    this.ready = this.refreshSelection()
  }

  /**
   * Replace the configuration source, then re-resolve the cached selection.
   *
   * dsh-loader's config-api hands out a handle whose `get()` is the committed
   * document; the plugin mounts that thunk here so every later read — the
   * description, the panel, a command — sees the same values.
   * @param settings - the live configuration source.
   * @returns the settled selection facts.
   */
  bindSettings(settings: () => ResolvedPluginConfig): Promise<unknown> {
    this.shellSettings = settings
    this.ready = this.refreshSelection()
    return this.ready
  }

  /** The configured default mode — the capability fact the tool layer reads. */
  override get sandboxMode(): SandboxMode {
    return this.ctx.sandboxPolicy.defaultMode
  }

  /**
   * The current configuration: the live user layer resolved over the composition
   * entry and the schema defaults.
   */
  get selectSettings(): ResolvedPluginConfig {
    return this.shellSettings()
  }

  /** The platform word the execution world reports, defaulting to the local process. */
  get executionPlatform(): Platform {
    return this.selection.platform
  }

  /**
   * The executable override in force for one entry.
   *
   * The `executable` override names one shell — the selected one — so it is
   * applied to the selected entry and to no other row.
   * @param entry - the catalog entry being resolved.
   * @param settings - the settings snapshot in force.
   * @param selected - whether the entry is the one the configuration selects.
   * @returns the explicit path, or undefined for discovery.
   */
  overrideFor(entry: CatalogEntry, settings: CallSettings | ResolvedPluginConfig, selected: boolean): string | undefined {
    if (!selected) return undefined
    const value = 'executable' in settings ? settings.executable : undefined
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  /**
   * The entry the configuration names, read without touching the execution world.
   * @param platform - the platform to look the entry up on.
   * @param settings - the configuration snapshot to answer for.
   * @returns the entry, or undefined when the configuration names one this
   *   platform lacks.
   */
  provisionalEntry(platform: Platform, settings: ResolvedPluginConfig = this.selectSettings): CatalogEntry | undefined {
    const requested = settings.shell
    if (requested !== AUTO_SHELL) return findEntry(platform, requested)
    // `auto` cannot be answered synchronously: the platform's own default shell
    // comes from the seam. The first catalog entry is the provisional answer.
    return catalogFor(platform)[0]
  }

  /** Ask the execution world for its platform, falling back to the local process. */
  async executionPlatformNow(): Promise<Platform> {
    try {
      const environment = await this.ctx.subprocess.terminalEnvironment()
      return environment.platform as Platform
    } catch {
      // A provider that cannot answer keeps the local process's platform, which
      // is the same answer the shipped local providers give.
      return localPlatform()
    }
  }

  /**
   * The diagnostic for a selection that resolved to no catalog entry.
   *
   * A named shell that this platform lacks and an `auto` selection that found
   * nothing installed are different problems with different remedies, so they
   * get different sentences: telling a user that a shell named "auto" does not
   * exist on Windows describes the setting rather than the machine.
   * @param platform - the execution platform.
   * @param settings - the configuration snapshot the answer is for.
   * @returns the message a refusal or the cached description reports.
   */
  unresolvedSelection(platform: Platform, settings: ResolvedPluginConfig | CallSettings = this.selectSettings): string {
    const requested = settings.shell
    const known = catalogFor(platform).map(candidate => candidate.id).join(', ')
    if (requested === AUTO_SHELL) {
      return `no shell in the ${platform} catalog resolved in the execution environment `
        + `(tried: ${known}); set "shell" to one of them, or "executable" to an explicit path`
    }
    return `the selected shell ${JSON.stringify(requested)} does not exist on ${platform}. Available: ${known}`
  }

  /**
   * Resolve the selected catalog entry, following `auto` when the configuration
   * asks for the platform's own default.
   *
   * `auto` must not change behavior for someone who installs this plugin onto a
   * working deployment, which is what fixes how it resolves:
   *
   * - On POSIX, `ctx.subprocess.terminalEnvironment().defaultShell` is the
   *   user's own login shell (`$SHELL`), a real preference, so a catalog entry
   *   matching its program name wins.
   * - On Windows the same field is `%ComSpec%`, which names the command
   *   interpreter rather than a preference — every Windows host reports
   *   `cmd.exe`. Preferring it would contradict the shell the harness's own
   *   Windows executor resolves (PowerShell) and would silently downgrade an
   *   existing deployment to cmd. Catalog order is the preference order there.
   *
   * Either way the first entry that actually resolves is the answer, so an
   * uninstalled preference is skipped rather than refused.
   * @param platform - the execution platform.
   * @param signal - cancellation of the entry probes.
   * @param settings - the configuration snapshot this resolution answers for.
   * @returns the entry, or undefined when the configuration names one this
   *   platform lacks.
   */
  async resolveEntry(
    platform: Platform,
    signal: AbortSignal | undefined,
    settings: ResolvedPluginConfig | CallSettings = this.selectSettings,
  ): Promise<CatalogEntry | undefined> {
    const requested = settings.shell
    if (requested !== AUTO_SHELL) return findEntry(platform, requested)
    const entries = catalogFor(platform)
    const configured = 'executable' in settings ? settings.executable : undefined

    // An explicit executable under `auto` names its own dialect: a user with
    // `/opt/custom/bash` means bash, not whichever row happens to lead the
    // catalog. Without this, `auto` plus an override would pair the override
    // with the wrong argument dialect.
    if (typeof configured === 'string' && configured.length > 0) {
      const claimed = entryClaiming(platform, programName(configured))
      if (claimed !== undefined) return claimed
    }

    // POSIX only: there the execution world's `defaultShell` is the user's own
    // login shell (`$SHELL`), which is a real preference and wins — provided it
    // is installed, since an uninstalled preference must fall through to one
    // that works rather than produce an entry every call would refuse.
    //
    // On Windows the same field is `%ComSpec%`, which identifies the command
    // interpreter rather than a preference — every Windows host reports
    // cmd.exe. Preferring it would contradict the shell the harness itself
    // ships with (PowerShell), and would silently change behavior for anyone
    // installing this plugin onto a working deployment. There, catalog order is
    // the preference order, and the catalog puts PowerShell first because that
    // is what the harness's Windows executor resolves.
    if (platform === 'posix') {
      let defaultShell: string | undefined
      try {
        defaultShell = (await this.ctx.subprocess.terminalEnvironment(signal)).defaultShell
      } catch {
        // A provider that cannot report a default leaves the resolution to the
        // availability walk below.
        defaultShell = undefined
      }
      if (typeof defaultShell === 'string' && defaultShell.length > 0) {
        const preferred = entryClaiming(platform, programName(defaultShell))
        if (preferred !== undefined) {
          const inspection = await inspectShell(this.resolver(), {
            entry: preferred, configuredPath: undefined, env: undefined, signal, platform,
          })
          if (inspection.available === true) return preferred
        }
      }
    }

    for (const entry of entries) {
      const inspection = await inspectShell(this.resolver(), {
        entry, configuredPath: undefined, env: undefined, signal, platform,
      })
      if (inspection.available === true) return entry
    }
    return undefined
  }

  /** The `{ subprocess }` slice the discovery helpers take. */
  resolver(): { subprocess: Context['subprocess'] } {
    return { subprocess: this.ctx.subprocess }
  }

  /**
   * Resolve `auto` for one configuration: the shell this machine picks when the
   * selection is left to it.
   *
   * A different question from which entry the configuration selects, and
   * answered separately, because an explicit selection may name a shell `auto`
   * would never choose. The answer depends on the executable override in force —
   * an override naming a shell claims that shell under `auto` (see
   * {@link ShellSelectExecutor.resolveEntry}) — so the caller names the override
   * it is asking about instead of this method deciding which one is meant.
   * @param options - the configuration snapshot the resolution answers for, the
   *   executable override to resolve under (`''` for none, which is the one the
   *   saved configuration itself carries when omitted), and cancellation.
   * @returns the entry `auto` resolves to with its resolution, or the diagnostic
   *   for a machine where the catalog resolves nothing.
   */
  async resolveAuto(options: {
    settings?: ResolvedPluginConfig
    executable?: string
    signal?: AbortSignal
  } = {}): Promise<{
    platform: Platform
    entry?: CatalogEntry
    available?: boolean
    path?: string
    source?: string
    detail?: string
  }> {
    const source = options.settings ?? this.selectSettings
    const settings: CallSettings = {
      shell: AUTO_SHELL,
      loginShell: source.loginShell,
      executable: options.executable ?? source.executable,
      wslDistro: source.wslDistro,
      wslMountRoot: source.wslMountRoot,
    }
    const platform = await this.executionPlatformNow()
    const entry = await this.resolveEntry(platform, options.signal, settings)
    if (entry === undefined) {
      return { platform, available: false, detail: this.unresolvedSelection(platform, settings) }
    }
    const inspection = await inspectShell(this.resolver(), {
      entry,
      configuredPath: this.overrideFor(entry, settings, true),
      env: undefined,
      signal: options.signal,
      platform,
    })
    return { platform, entry, ...inspection }
  }

  /**
   * Refresh the cached selection facts from the execution world.
   *
   * Overlapping refreshes are expected — a configuration write during a first
   * read, or several writes in quick succession — so each call carries a
   * generation and only the newest publishes. An older refresh that settles
   * later leaves the newer facts in place instead of overwriting them.
   * @returns the published cache entry.
   */
  async refreshSelection(): Promise<typeof this.selection> {
    const generation = ++this.selectionGeneration
    const settings = settingsSnapshot(this.selectSettings)
    const platform = await this.executionPlatformNow()
    const entry = await this.resolveEntry(platform, undefined, settings)
    const next = entry === undefined
      ? { platform, detail: this.unresolvedSelection(platform, settings) }
      : { platform, entry, ...await inspectShell(this.resolver(), {
        entry,
        configuredPath: this.overrideFor(entry, settings, true),
        env: undefined,
        platform,
      }) }
    if (generation === this.selectionGeneration) this.selection = next
    return this.selection
  }

  /**
   * Describe the selection for the model-facing description and the tool's
   * per-call metadata. Synchronous, from the cache.
   * @returns the selected shell's identity, executable, syntax, and confinement facts.
   */
  describeShell(): {
    platform: Platform
    id?: string
    label?: string
    dialect?: CatalogEntry['dialect']
    available: boolean
    executable?: string
    detail?: string
    pending?: boolean
    syntax: string
    confineable: boolean
    confineReason?: string
  } {
    const { platform, entry, available, path, detail, pending } = this.selection
    if (entry === undefined) {
      return { platform, available: false, detail: detail ?? 'no shell selected', syntax: '', confineable: false }
    }
    const capability = entry.confineable ?? { confined: true }
    return {
      platform,
      id: entry.id,
      label: entry.label,
      dialect: entry.dialect,
      available: available === true,
      // Absent means "not resolved yet", which is a different fact from
      // "resolved and unusable": the first is transient, the second is a refusal.
      ...available === true ? { executable: path } : available === false ? { detail } : { pending: pending === true },
      syntax: entry.syntax,
      confineable: capability.confined,
      ...capability.confined ? {} : { confineReason: capability.reason },
    }
  }

  /**
   * Re-read every catalog entry on the execution platform, for the status panel.
   * @param options - optional environment for candidate enumeration.
   * @returns the fresh catalog rows.
   */
  async describeCatalog(options: { env?: Environment } = {}): Promise<CatalogRow[]> {
    const platform = await this.executionPlatformNow()
    const settings = settingsSnapshot(this.selectSettings)
    const selected = await this.resolveEntry(platform, undefined, settings)
    return inspectCatalog(this.resolver(), platform, {
      selectedId: selected?.id,
      overrideFor: (entry, isSelected) => this.overrideFor(entry, settings, isSelected),
      env: options.env,
    })
  }

  /**
   * Resolve a request into a spec: the inherited defaulting, the per-call
   * sandbox policy, and the shell facts the chosen dialect needs.
   *
   * Deliberately free of refusals. Every check that can fail lives in
   * {@link ShellSelectExecutor.decide}, because finding an executable is
   * asynchronous.
   * @param request - the caller's request.
   * @returns the spec to hand to `decide`/`execute`.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const base = super.resolve(request)
    return { ...base, sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }

  /**
   * Decide one call, before confinement and before any process exists.
   *
   * Everything the call depends on is fixed here, from ONE configuration
   * snapshot: the entry, the executable, the working-directory validation, the
   * refusal for an unenforceable mode, the launch options, and the argv. Callers
   * that need the facts before the process starts — the tool's per-call
   * metadata — take them from this decision, and `execute` reuses the marked
   * spec rather than deciding again, so the facts and the process can never
   * disagree.
   *
   * Order is deliberate: the platform and the entry decide whether the request
   * is even expressible, confinement decides whether it may run, and only then
   * are the working directory and the executable resolved.
   * @param spec - the spec about to run.
   * @returns the frozen decision and the spawn-ready spec carrying it.
   * @throws {ShellSelectionRefusedError} when the mode cannot be enforced for this shell.
   * @throws {Error} when the selection, the working directory, or the executable is unusable.
   */
  async decide(spec: ShellExecSpec): Promise<{ decision: Decision; spec: DecidedSpec }> {
    const settings = settingsSnapshot(this.selectSettings)
    const platform = await this.executionPlatformNow()
    const entry = await this.resolveEntry(platform, spec.signal, settings)
    if (entry === undefined) {
      throw new Error(`dsh-shell-select: ${this.unresolvedSelection(platform, settings)}`)
    }
    if (settings.loginShell && entry.dialect !== 'bash' && entry.dialect !== 'wsl') {
      throw new Error(
        `dsh-shell-select: "loginShell" applies to bash-family shells only; ${entry.label} uses the `
        + `${entry.dialect} dialect`,
      )
    }
    if (entry.dialect === 'wsl' && !settings.wslMountRoot.startsWith('/')) {
      throw new Error(
        'dsh-shell-select: "wslMountRoot" must be an absolute Linux path, got '
        + `${JSON.stringify(settings.wslMountRoot)}`,
      )
    }
    const policy = spec.sandboxPolicy
    if (policy === undefined) {
      throw new Error('dsh-shell-select: refusing to run without a resolved sandbox policy')
    }
    const confinement = checkConfinement(entry, policy.mode)
    if (!confinement.ok) throw new ShellSelectionRefusedError(entry, policy.mode, confinement.reason)
    requireWorkingDirectory(spec.workdir, platform)
    const resolved = await resolveShell(this.resolver(), {
      entry,
      configuredPath: this.overrideFor(entry, settings, true),
      env: undefined,
      signal: spec.signal,
      platform,
    })
    const invocation = buildInvocation(entry.dialect, {
      executable: resolved.path,
      command: spec.command,
      ...entry.dialect === 'wsl' ? {
        windowsCwd: spec.workdir,
        mountRoot: settings.wslMountRoot,
        distro: settings.wslDistro,
      } : {},
      loginShell: settings.loginShell,
    })
    // The decision stamps the transport environment because only it knows the
    // resolved entry, and `resolve()` cannot: choosing a shell may require
    // probing the execution world. Stamping here keeps one home for the fact.
    const transport = transportEnv(entry.dialect, spec.command)
    const spawnSpec: DecidedSpec = {
      ...spec,
      ...transport === undefined ? {} : { env: { ...spec.env, ...transport } },
    }
    const capability = entry.confineable ?? { confined: true }
    const decision = Object.freeze({
      platform,
      entry,
      executable: resolved.path,
      source: resolved.source,
      argv: invocation.argv,
      settings,
      shell: Object.freeze({
        id: entry.id,
        label: entry.label,
        dialect: entry.dialect,
        platform,
        executable: resolved.path,
        source: resolved.source,
        workdir: spec.workdir,
        loginShell: settings.loginShell,
        confineable: capability.confined,
      }),
    })
    return { decision, spec: { ...spawnSpec, [DECIDED]: decision } }
  }

  /**
   * The decision a spec carries, or a fresh one when it carries none.
   *
   * `execute` is reachable without a prior `decide` — another caller may hold
   * only the seam's `resolve` — so it goes through here. A spec that already
   * carries a decision is used exactly as decided: a configuration write between
   * the decision and the spawn changes the next call, not this one.
   * @param spec - a spec from {@link ShellSelectExecutor.resolve}, decided or not.
   * @returns the decision and the spawn-ready spec.
   */
  async decideFor(spec: ShellExecSpec): Promise<{ decision: Decision; spec: DecidedSpec }> {
    const carried = (spec as DecidedSpec)[DECIDED]
    return carried === undefined ? await this.decide(spec) : { decision: carried, spec }
  }

  /**
   * Decorate the handle's foreground projection in place, memoized once. The
   * handle keeps its identity (never wrapped in a second object) because the
   * per-process facts and `onProcessDone` key on the exact instance.
   * @param execution - the handle to decorate.
   * @param map - the result projection to apply.
   * @param mapError - the rejection projection to apply, when one is needed.
   * @returns the same handle.
   */
  private static decorateResult(
    execution: ShellExecution,
    map: (result: ShellRunResult) => ShellRunResult,
    mapError?: (error: unknown) => never,
  ): ShellExecution {
    const base = execution.result.bind(execution)
    let decorated: Promise<ShellRunResult> | undefined
    execution.result = (): Promise<ShellRunResult> => {
      decorated ??= base().then(map, mapError)
      return decorated
    }
    return execution
  }

  /**
   * Run one command, confined unless the mode is `danger-full-access`.
   * @param spec - a spec from {@link ShellSelectExecutor.resolve}.
   * @returns the live process handle, whose `result()` carries the sandbox facts.
   */
  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const { decision, spec: decidedSpec } = await this.decideFor(spec)
    const policy = decidedSpec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') {
      return ShellSelectExecutor.decorateResult(
        await this.executeArgv(decidedSpec, decision.argv),
        result => ({ ...result, sandbox: { mode, denied: false } }),
      )
    }
    let confined: ConfinedArgv | undefined
    const execution = await this.executeArgv(decidedSpec, async signal => {
      const prepared = await this.ctx.sandbox.confine(decision.argv, { ...policy, mode: mode as ConfinedSandboxMode }, signal)
      signal.throwIfAborted()
      confined = prepared
      return prepared.argv
    }, (process) => {
      const facts = confined as ConfinedArgv
      this.processFacts.set(process, {
        mode,
        enforcement: facts.enforcement,
        denialSignatures: facts.denialSignatures,
        runnerFailureRules: facts.runnerFailureRules,
        runnerProgram: facts.argv[0],
        workdir: decidedSpec.workdir,
      })
    })
    return ShellSelectExecutor.decorateResult(execution, (result) => {
      if (confined === undefined) return { ...result, sandbox: { mode, denied: false } }
      const { enforcement, denialSignatures, runnerFailureRules } = confined
      // Runner failure outranks denial because the command did not run. Carry
      // the matched fatal line, not an informational line that preceded it.
      const runnerFailure = host.sandbox.classifyRunnerFailure(result.exitCode, result.stderr.text, runnerFailureRules)
      if (runnerFailure !== undefined) {
        throw new host.sandbox.SandboxUnavailableError(mode as ConfinedSandboxMode, runnerFailure.detail)
      }
      return {
        ...result,
        sandbox: {
          mode,
          denied: host.sandbox.matchesSignature(result.exitCode, result.stderr.text, denialSignatures),
          enforcement,
        },
      }
    }, (error) => {
      // An upstream abort remains cancellation even when it prevents spawn.
      if (decidedSpec.signal?.aborted === true) decidedSpec.signal.throwIfAborted()
      if (confined !== undefined && host.sandbox.isRunnerSpawnFailure(error, confined.argv[0], decidedSpec.workdir)) {
        throw new host.sandbox.SandboxUnavailableError(mode as ConfinedSandboxMode, String(error))
      }
      throw error
    })
  }

  /**
   * Run one plugin-owned argv — a version probe — for the status panel.
   *
   * The probe is not special-cased past the sandbox: it goes through the same
   * `ctx.sandbox.confine` an ordinary command does, under the deployment's own
   * resolved policy, and when the mode cannot confine the executable it is
   * refused and reported rather than started unconfined. That keeps a
   * configurable executable path from becoming an unrestricted execution
   * channel just because the arguments are fixed.
   *
   * `danger-full-access` is the one case with no confinement to apply, exactly
   * as for an ordinary command: the user chose unconfined execution for this
   * deployment.
   * @param argv - the fixed argv to run; never carries caller or model input.
   * @param signal - cancellation for the probe.
   * @returns the settled facts: the exit status, the output, and what was observed.
   */
  async runProbe(argv: readonly string[], signal?: AbortSignal): Promise<ProbeOutcome> {
    const platform = await this.executionPlatformNow()
    const policy = this.ctx.sandboxPolicy.resolve()
    // The sandbox grants access to the policy's workspace, so that is where a
    // probe runs. A workspace that does not exist is reported, never replaced
    // with another directory.
    let workdir: string
    try {
      workdir = requireWorkingDirectory(policy.workspaceRoot, platform)
    } catch (error) {
      return { started: false, detail: `probe not run: ${error instanceof Error ? error.message : String(error)}` }
    }
    const probeSpec = this.resolve({
      command: '',
      workdir,
      timeoutMs: PROBE_TIMEOUT_MS,
      stdoutMaxBytes: PROBE_MAX_BYTES,
      ...signal === undefined ? {} : { signal },
    })
    let result: ShellRunResult
    let confined: ConfinedArgv | undefined
    try {
      if (policy.mode === 'danger-full-access') {
        result = await (await this.executeArgv(probeSpec, argv)).result()
      } else {
        result = await (await this.executeArgv(probeSpec, async innerSignal => {
          const prepared = await this.ctx.sandbox.confine(argv, { ...policy, mode: policy.mode as ConfinedSandboxMode }, innerSignal)
          innerSignal.throwIfAborted()
          confined = prepared
          return prepared.argv
        })).result()
      }
    } catch (error) {
      // fail closed: a probe the policy cannot confine is reported, not run.
      return {
        started: false,
        mode: policy.mode,
        detail: error instanceof Error ? error.message : String(error),
        ...error instanceof host.sandbox.SandboxUnavailableError ? { refused: true } : {},
      }
    }
    const facts = confined
    if (facts !== undefined) {
      const runnerFailure = host.sandbox.classifyRunnerFailure(result.exitCode, result.stderr.text, facts.runnerFailureRules)
      if (runnerFailure !== undefined) {
        return {
          started: true,
          mode: policy.mode,
          runnerFailed: true,
          enforcement: facts.enforcement,
          detail: runnerFailure.detail,
        }
      }
    }
    return {
      started: true,
      mode: policy.mode,
      exitCode: result.exitCode,
      stdout: result.stdout.text.replace(/\0/gu, ''),
      stderr: result.stderr.text.replace(/\0/gu, ''),
      ...facts === undefined ? {} : {
        enforcement: facts.enforcement,
        denied: host.sandbox.matchesSignature(result.exitCode, result.stderr.text, facts.denialSignatures),
      },
      ...result.timedOut ? { timedOut: true } : {},
    }
  }

  /**
   * Decide and run one command through the normal path, for the status panel's
   * "Test shell" action.
   *
   * The two failure stages are kept apart because they have different remedies:
   * the selection could not be resolved at all (`selection`), or it resolved and
   * the sandbox refused to run it (`refused`).
   * @param request - the command, its working directory, and cancellation.
   * @returns the decision facts and the settled result, or the failure stage.
   */
  async runCommand(request: { command: string; workdir: string; signal?: AbortSignal }): Promise<{
    ok: boolean
    stage: string
    detail?: string
    shell?: string
    executable?: string
    mode?: string
    result?: ShellRunResult
  }> {
    try {
      const spec = this.resolve({
        command: request.command,
        workdir: request.workdir,
        ...request.signal === undefined ? {} : { signal: request.signal },
      })
      const decided = await this.decide(spec)
      const result = await (await this.execute(decided.spec)).result()
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        stage: 'ran',
        shell: decided.decision.shell.id,
        executable: decided.decision.shell.executable,
        mode: decided.spec.sandboxPolicy?.mode,
        result,
      }
    } catch (error) {
      return {
        ok: false,
        stage: error instanceof ShellSelectionRefusedError ? 'refused' : 'selection',
        shell: this.describeShell().id,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Stamp per-process sandbox facts before `done` settles.
   * @param proc - the settled process handle.
   * @param stderr - the process's retained stderr tail.
   * @param providerRejected - whether the subprocess promise rejected without an outcome.
   * @param providerError - the provider rejection reason, which may itself be undefined.
   */
  protected override onProcessDone(
    proc: ShellProcess,
    stderr: string,
    providerRejected: boolean,
    providerError?: unknown,
  ): void {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      const runnerFailed = providerRejected
        ? host.sandbox.isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir)
        : host.sandbox.classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined
      proc.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && host.sandbox.matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      }
    }
    super.onProcessDone(proc, stderr, providerRejected, providerError)
  }
}

export { DEFAULT_CONFIG, PLUGIN_NAME }
export default ShellSelectExecutor
