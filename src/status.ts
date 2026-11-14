/**
 * Status facts for the settings panel.
 *
 * The panel needs facts the configuration document cannot hold, because they
 * describe the machine rather than the user's choice: which shells resolve to
 * which executable, what version each reports, and whether the selected one can
 * run under the session's permission mode. Those are computed here and served
 * through the config-api operation the panel declares.
 *
 * **Probes run fixed, plugin-owned argv, under the deployment's own confinement.**
 * {@link ./dialects.js} supplies the arguments and `runProbe` spawns them through
 * the same `ctx.sandbox.confine` an ordinary command goes through, so a
 * configurable executable path cannot become an unrestricted execution channel
 * merely because the arguments are fixed. A row whose mode cannot confine it is
 * reported as not probed rather than started unconfined.
 *
 * Three facts are kept apart on purpose, because collapsing them is how a
 * settings card ends up claiming safety it has not observed:
 *
 * - `available` — the executable resolves at all;
 * - `confineable` — what the catalog expects the sandbox to be able to do with
 *   it on this platform, which is a claim, not a measurement;
 * - `confinement.observed` — what this machine actually did when the plugin
 *   asked the sandbox to run it.
 *
 * @module dsh-shell-select/status
 */

import {
  VERIFIED_CONFINEMENT_PLATFORMS,
  catalogFor,
  probeFor,
  type CatalogEntry,
  type Dialect,
  type Platform,
  type ProbeKind,
} from './catalog.js'
import { testCommand, versionArgv } from './dialects.js'
import type { CallSettings, ResolvedPluginConfig } from './config.js'
import type { CatalogRow, ShellInspection } from './discovery.js'
import type { RenderedResult } from './render.js'

/** Deadline for one read-only version probe. */
export const PROBE_TIMEOUT_MS = 10_000

/** How a probe's outcome is classified for the panel. */
export type ProbeObservation = 'confirmed' | 'ran-unconfined' | 'runner-failed' | 'refused' | 'not-run' | 'not-probed'

/** What one probe settled as. */
export interface ProbeOutcome {
  readonly started: boolean
  readonly mode?: string
  readonly detail?: string
  readonly refused?: boolean
  readonly runnerFailed?: boolean
  readonly exitCode?: number | null
  readonly stdout?: string
  readonly stderr?: string
  readonly enforcement?: string
  readonly denied?: boolean
  readonly timedOut?: boolean
}

/** The confinement facts one row carries. */
export interface RowConfinement {
  /** What the catalog expects on this platform: a claim, not a measurement. */
  readonly expected: 'confined' | 'unconfined'
  /** What the probe was observed doing, or why it was not started. */
  readonly observed: ProbeObservation
  /** Whether this platform's confinement claims were measured by this plugin. */
  readonly verified: boolean
  /** The measured reason, when the row's shell cannot be confined. */
  readonly reason?: string
}

/** One completed status row. */
export interface StatusRow extends CatalogRow {
  readonly version?: string
  readonly interpreter?: string
  readonly versionError?: string
  /** Whether the current mode may run this row (availability AND the claim). */
  readonly usableInMode: boolean
  readonly confinement: RowConfinement
}

/** Automatic's own resolution for one configuration. */
export interface AutoRow extends StatusRow {
  /** The executable override this resolution was computed under; `''` for none. */
  readonly executable: string
}

/** The complete status payload the panel renders. */
export interface StatusPayload {
  readonly active: {
    /** The stored `shell` value, which may be `auto`. */
    readonly shell: string
    /** The catalog id the stored value resolves to, when it resolves. */
    readonly selected?: string
    readonly platform: Platform
    readonly mode: string
    readonly workspaceRoot: string
  }
  readonly auto: { readonly saved: AutoRow; readonly withoutOverride: AutoRow }
  /** Whether *any* confinement claim on this platform was measured here. */
  readonly confinementVerified: boolean
  readonly shells: readonly StatusRow[]
}

/** The shell-executor surface the status builder reads. */
export interface StatusExecutor {
  /** The live, resolved configuration. */
  readonly selectSettings: ResolvedPluginConfig
  /** The platform the execution world reports. */
  executionPlatformNow(): Promise<Platform>
  /** Every catalog row on the execution platform, with its resolution. */
  describeCatalog(options?: { env?: Readonly<Record<string, string | undefined>> }): Promise<CatalogRow[]>
  /** Resolve `auto` for one configuration. */
  resolveAuto(options: {
    settings?: ResolvedPluginConfig
    executable?: string
    signal?: AbortSignal
  }): Promise<{ platform: Platform; entry?: CatalogEntry; available?: boolean; path?: string; source?: string; detail?: string }>
  /** Run one plugin-owned argv under the deployment's confinement. */
  runProbe(argv: readonly string[], signal?: AbortSignal): Promise<ProbeOutcome>
  /** Decide and run one command through the normal path. */
  runCommand(request: {
    command: string
    workdir: string
    signal?: AbortSignal
  }): Promise<{ ok: boolean; stage: string; detail?: string; shell?: string; executable?: string; mode?: string; result?: RenderedResult }>
  /** The cached selection, for the failure diagnostic. */
  describeShell(): { readonly id?: string; readonly available: boolean; readonly detail?: string }
}

/**
 * The first non-empty line of a probe's combined output.
 * @param probe - a settled probe.
 * @returns the line, or undefined when the probe printed nothing.
 */
function firstLine(probe: ProbeOutcome): string | undefined {
  return `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0)
}

/**
 * Turn one probe outcome into a row's reported facts.
 *
 * A non-zero exit is a failure even when the probe printed something: `dash`
 * answers `--version` with "Illegal option" on stderr and exit 2, and reporting
 * that as a version would describe the plugin's mistake as the shell's version.
 * @param probe - the outcome from {@link runProbe}.
 * @param kind - `'version'` or `'interpreter'`, the answer the entry asked for.
 * @returns the reported fields: one of `version`, `interpreter`, or `versionError`,
 *   plus what the machine was observed to do.
 */
export function probeFacts(probe: ProbeOutcome, kind: ProbeKind): {
  version?: string
  interpreter?: string
  versionError?: string
  observed: ProbeObservation
} {
  if (probe.started !== true) {
    return {
      versionError: probe.detail ?? 'the probe did not run',
      observed: probe.refused === true ? 'refused' : 'not-run',
    }
  }
  if (probe.runnerFailed === true) {
    return {
      versionError: `the sandbox runner could not start this shell: ${probe.detail ?? 'unknown reason'}`,
      observed: 'runner-failed',
    }
  }
  // A confined run reports its enforcement; an unconfined one reports nothing.
  const observed: ProbeObservation = probe.denied === undefined && probe.enforcement === undefined ? 'ran-unconfined' : 'confirmed'
  if (probe.timedOut === true) {
    return { versionError: `the probe timed out after ${PROBE_TIMEOUT_MS} ms`, observed }
  }
  const line = firstLine(probe)
  if (probe.exitCode !== 0) {
    return {
      versionError: `exited with code ${String(probe.exitCode)}${line === undefined ? '' : `: ${line}`}`,
      observed,
    }
  }
  if (line === undefined) return { versionError: 'no output', observed }
  return kind === 'interpreter' ? { interpreter: line, observed } : { version: line, observed }
}

/**
 * Probe one resolvable row under the session's confinement.
 * @param executor - the mounted shell-select executor.
 * @param entry - the catalog entry behind the row, which owns the probe query.
 * @param row - the catalog row to probe.
 * @param policy - the resolved sandbox policy.
 * @param signal - cancellation for all probes.
 * @returns the row's probe facts.
 */
async function probeRow(
  executor: StatusExecutor,
  entry: CatalogEntry,
  row: CatalogRow,
  policy: { mode: string },
  signal: AbortSignal,
): Promise<{ version?: string; interpreter?: string; versionError?: string; observed: ProbeObservation }> {
  if (!row.confineable && policy.mode !== 'danger-full-access') {
    return {
      versionError: `not probed: ${row.label} cannot be confined under "${policy.mode}", `
        + 'and this plugin never runs a probe unconfined',
      observed: 'not-probed',
    }
  }
  if (row.available !== true) {
    return { versionError: row.detail ?? 'not found', observed: 'not-probed' }
  }
  const probe = probeFor(entry, row.path as string, versionArgv)
  return probeFacts(await executor.runProbe(probe.argv, signal), probe.kind)
}

/**
 * Complete one row: whether the current mode allows it, what confinement was
 * expected, and what this machine was observed doing with it.
 *
 * Shared by the catalog rows and by Automatic's own resolution, so the facts a
 * user reads for "Automatic" come from the same code as the facts for a shell
 * they picked by name.
 * @param executor - the mounted shell-select executor.
 * @param entries - catalog entries by id, each owning its probe query.
 * @param row - the row to complete.
 * @param policy - the resolved sandbox policy.
 * @param platformVerified - whether this platform's confinement claims were measured here.
 * @returns the row with its usability, confinement, and probe facts.
 */
async function rowFacts(
  executor: StatusExecutor,
  entries: ReadonlyMap<string, CatalogEntry>,
  row: CatalogRow,
  policy: { mode: string },
  platformVerified: boolean,
): Promise<StatusRow> {
  // Facts the panel must not conflate: whether the binary runs at all, whether
  // the catalog expects the sandbox to be able to confine it, and whether this
  // machine was observed doing so. `usableInMode` answers only the second
  // combined with availability, so it stays a statement of expectation.
  const usableInMode = row.available === true && (row.confineable || policy.mode === 'danger-full-access')
  const confinement = {
    // The catalog's claim for this platform, and whether that claim was
    // measured here rather than reasoned about.
    expected: (row.confineable ? 'confined' : 'unconfined') as 'confined' | 'unconfined',
    verified: platformVerified,
    ...row.confineReason === undefined ? {} : { reason: row.confineReason },
  }
  if (row.available !== true) {
    // The row's own diagnostic *is* the answer here: nothing was probed, and the
    // reason it cannot be is what the panel has to show.
    return {
      ...row,
      versionError: row.detail ?? 'not found',
      usableInMode,
      confinement: { ...confinement, observed: 'not-probed' },
    }
  }
  const entry = entries.get(row.id)
  const probe = entry === undefined
    ? { versionError: 'this shell is not in the catalog', observed: 'not-probed' as const }
    : await probeRow(executor, entry, row, policy, AbortSignal.timeout(PROBE_TIMEOUT_MS))
  return { ...row, ...probe, usableInMode, confinement: { ...confinement, observed: probe.observed } }
}

/**
 * The row Automatic resolves to for one configuration.
 *
 * `auto` has no catalog row of its own, so its row is assembled from the
 * resolution the executor performs for it and completed the same way a catalog
 * row is. The executable override is a parameter rather than a read of the
 * configuration, because the configurations a panel can be describing differ
 * exactly there: what a shell switch leaves staged is the saved configuration
 * with the override removed.
 * @param executor - the mounted shell-select executor.
 * @param entries - catalog entries by id, each owning its probe query.
 * @param policy - the resolved sandbox policy.
 * @param platformVerified - whether this platform's confinement claims were measured here.
 * @param settings - the configuration snapshot the resolution answers for.
 * @param executable - the executable override to resolve under; `''` for none.
 * @returns the resolved row, tagged with the override it was resolved under, or
 *   the diagnostic for a machine where nothing resolves.
 */
async function automaticRow(
  executor: StatusExecutor,
  entries: ReadonlyMap<string, CatalogEntry>,
  policy: { mode: string },
  platformVerified: boolean,
  settings: ResolvedPluginConfig,
  executable: string,
): Promise<AutoRow> {
  const resolution = await executor.resolveAuto({ settings, executable })
  const entry = resolution.entry
  if (entry === undefined) {
    const detail = resolution.detail ?? 'no shell resolved'
    return {
      executable,
      id: '',
      label: 'Automatic',
      dialect: 'bash' as Dialect,
      selected: false,
      available: false,
      detail,
      confineable: false,
      confineReason: detail,
      supportsLoginShell: false,
      supportsDistro: false,
      syntax: '',
      usableInMode: false,
      confinement: { expected: 'unconfined', observed: 'not-probed', verified: platformVerified, reason: detail },
    }
  }
  const capability = entry.confineable ?? { confined: true }
  const base: CatalogRow = {
    id: entry.id,
    label: entry.label,
    dialect: entry.dialect,
    selected: false,
    available: resolution.available === true,
    ...resolution.available === true
      ? { path: resolution.path, source: resolution.source as 'configured' | 'discovered' }
      : { detail: resolution.detail ?? 'not found' },
    confineable: capability.confined,
    ...capability.confined ? {} : { confineReason: capability.reason },
    supportsLoginShell: entry.supportsLoginShell === true,
    supportsDistro: entry.supportsDistro === true,
    syntax: entry.syntax,
  }
  return { executable, ...await rowFacts(executor, entries, base, policy, platformVerified) }
}

/** The sandbox policy facts the status builder reads. */
export interface PolicyFacts {
  readonly mode: string
  readonly workspaceRoot: string
}

/**
 * Assemble the panel's status payload.
 * @param executor - the mounted shell-select executor.
 * @param policy - the deployment's resolved sandbox policy.
 * @returns the active selection, Automatic's own resolution, the resolved mode,
 *   and one row per catalog entry.
 */
export async function buildStatus(executor: StatusExecutor, policy: PolicyFacts): Promise<StatusPayload> {
  const platform = await executor.executionPlatformNow()
  const settings = executor.selectSettings
  const rows = await executor.describeCatalog()
  const entries = new Map(catalogFor(platform).map(entry => [entry.id, entry]))
  const platformVerified = VERIFIED_CONFINEMENT_PLATFORMS.includes(platform)
  // Probes run in parallel: each is an independent short-lived process, and the
  // panel is opened on demand rather than in any hot path.
  const probed = await Promise.all(rows.map(async row => rowFacts(executor, entries, row, policy, platformVerified)))
  // `auto` is resolved for itself rather than read off the selected row: the
  // configuration may select a shell `auto` would never choose. Two
  // configurations are resolved because a panel can be describing either — the
  // one the document holds, and the one a shell switch leaves staged, which is
  // the saved configuration with the executable override removed, since
  // clearing that override is what a save then stores.
  const executableText = settings.executable.trim()
  const saved = await automaticRow(executor, entries, policy, platformVerified, settings, executableText)
  const withoutOverride = executableText.length === 0
    ? saved
    : await automaticRow(executor, entries, policy, platformVerified, settings, '')
  return {
    active: {
      shell: settings.shell,
      ...rows.find(row => row.selected === true) === undefined
        ? {}
        : { selected: rows.find(row => row.selected === true)?.id },
      platform,
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
    },
    auto: { saved, withoutOverride },
    // A platform-level statement: whether *any* confinement claim here was
    // measured by this plugin. Per-shell observation rides on each row.
    confinementVerified: platformVerified,
    shells: probed,
  }
}

/**
 * Render one status payload as the text the panel shows.
 *
 * The facts are the fields above, not a second source of truth: a line here
 * states one of them, and a missing value is left out rather than guessed.
 * @param status - the payload {@link buildStatus} produced.
 * @returns the label lines a `textarea` result displays.
 */
export function formatStatus(status: StatusPayload): string {
  const row = (item: StatusRow): string => {
    const target = item.available === true ? item.path : item.detail ?? 'not found'
    const answer = item.version ?? item.interpreter
    // Three different verdicts, three different words: an uninstalled shell is
    // not "blocked by the mode", and a shell the mode refuses is not missing.
    const verdict = item.available !== true
      ? 'not installed'
      : item.usableInMode ? `usable in "${status.active.mode}"` : `blocked by "${status.active.mode}"`
    return [
      `${item.available === true ? '✓' : '✗'} ${item.label} — ${target}`,
      ...answer === undefined ? [] : [`  ${item.version === undefined ? 'interpreter' : 'version'}: ${answer}`],
      ...item.versionError === undefined ? [] : [`  ${item.versionError}`],
      `  ${item.confineable ? 'confineable' : 'unconfineable'} · observed: ${item.confinement.observed} · ${verdict}`,
    ].join('\n')
  }
  return [
    `platform: ${status.active.platform}`,
    `mode: ${status.active.mode}`,
    `workspace: ${status.active.workspaceRoot}`,
    `saved: ${status.active.shell}${status.active.selected === undefined ? '' : ` → ${status.active.selected}`}`,
    `automatic: ${status.auto.saved.label}`
      + `${status.auto.saved.available === true ? ` (${String(status.auto.saved.path)})` : ' (unresolved)'}`,
    '',
    ...status.shells.map(row),
  ].join('\n')
}

/**
 * The result of the panel's "Test shell" operation.
 */
export interface ShellTestResult {
  readonly ok: boolean
  /** `ran` when the fixed command settled; `refused` or `selection` on the two failure paths. */
  readonly stage: 'ran' | 'refused' | 'selection'
  readonly shell?: string
  readonly executable?: string
  readonly mode?: string
  readonly exitCode?: number | null
  readonly stdout?: string
  readonly stderr?: string
  readonly detail?: string
  readonly sandbox?: { mode: string; denied: boolean; enforcement?: string; runnerFailed?: boolean }
}

/**
 * Run the panel's "Test shell" action.
 *
 * The command is a module constant, so this action carries no input. It runs
 * through the executor's normal decide/execute path, which means it reports the
 * same refusal a model call would get when the shell cannot be confined — the
 * test never demonstrates a capability the tool itself would not grant.
 *
 * It runs in the deployment's workspace root, the directory the sandbox grants,
 * rather than wherever the host process happens to sit: the same directory the
 * version probes use, and the one this action is meaningful in.
 * @param executor - the mounted shell-select executor.
 * @param policy - the deployment's resolved sandbox policy.
 * @returns the test outcome, including the resolved mode and sandbox facts.
 */
export async function runShellTest(executor: StatusExecutor, policy: PolicyFacts): Promise<ShellTestResult> {
  const outcome = await executor.runCommand({
    command: testCommand(),
    workdir: policy.workspaceRoot,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  if (outcome.result === undefined) {
    return {
      ok: false,
      // Two different failures with two different remedies: the selection could
      // not be resolved to a runnable shell at all, or it resolved and the
      // sandbox refused to run it.
      stage: outcome.stage === 'refused' ? 'refused' : 'selection',
      ...outcome.shell === undefined ? {} : { shell: outcome.shell },
      ...outcome.detail === undefined ? {} : { detail: outcome.detail },
    }
  }
  const result = outcome.result
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    stage: 'ran',
    // From the decision that produced the process, not from a separate read of
    // the selection.
    ...outcome.shell === undefined ? {} : { shell: outcome.shell },
    ...outcome.executable === undefined ? {} : { executable: outcome.executable },
    ...outcome.mode === undefined ? {} : { mode: outcome.mode },
    exitCode: result.exitCode,
    stdout: result.stdout.text.trim(),
    stderr: result.stderr.text.trim(),
    ...result.sandbox === undefined ? {} : {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...result.sandbox.enforcement === undefined ? {} : { enforcement: result.sandbox.enforcement },
        ...result.sandbox.runnerFailed === undefined ? {} : { runnerFailed: result.sandbox.runnerFailed },
      },
    },
  }
}

/**
 * Render the panel's "Test shell" result as one text block.
 * @param result - the outcome {@link runShellTest} produced.
 * @returns the report the `textarea` result displays.
 */
export function formatShellTest(result: ShellTestResult): string {
  if (result.stage !== 'ran') {
    return [
      `stage: ${result.stage}`,
      ...result.shell === undefined ? [] : [`shell: ${result.shell}`],
      ...result.detail === undefined ? [] : [`detail: ${result.detail}`],
    ].join('\n')
  }
  return [
    `${result.ok ? '✓' : '✗'} ${result.shell ?? '(unknown shell)'} — exit ${String(result.exitCode)}`,
    ...result.executable === undefined ? [] : [`executable: ${result.executable}`],
    ...result.mode === undefined ? [] : [`mode: ${result.mode}`],
    ...result.sandbox === undefined ? [] : [`sandbox: ${result.sandbox.mode}${result.sandbox.denied ? ' (denied)' : ''}`],
    ...result.stdout === undefined || result.stdout.length === 0 ? [] : [`stdout: ${result.stdout}`],
    ...result.stderr === undefined || result.stderr.length === 0 ? [] : [`stderr: ${result.stderr}`],
  ].join('\n')
}

/** Re-exported so callers do not have to reach into the discovery module. */
export type { CatalogRow, ShellInspection, CallSettings }
