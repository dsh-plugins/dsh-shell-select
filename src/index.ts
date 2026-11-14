/**
 * dsh-shell-select — one model-facing `shell` tool over a shell the user
 * selects.
 *
 * The plugin mounts three things and nothing else:
 *
 * 1. {@link ShellSelectExecutor} as `ctx.shell`, replacing whichever local
 *    executor the platform composed. Every route that already goes through that
 *    seam — the shell tool, hook commands, the tmux probe — then uses the
 *    selected shell.
 * 2. The single `shell` tool, which supersedes the shipped `bash`/`pwsh` tools.
 *    The composition patch disables the rows it can address, and a global tool
 *    guard denies the two names wherever a preset re-mounts them, so no second
 *    shell tool competes for the model's attention and none bypasses the
 *    selection.
 * 3. Its settings form, through dsh-loader's config-api: one card of persisted
 *    fields plus two transient panels that report the resolved facts and run a
 *    fixed self-test.
 *
 * The shell is a user setting, so there is no per-call shell argument and the
 * model cannot select a different one. When the selected shell cannot be
 * confined under the session's permission mode, the executor refuses before any
 * process exists.
 *
 * @module dsh-plugin/dsh-shell-select
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostAPI } from '@dsh-plugin/dsh-loader'

import { PLUGIN_ID, PLUGIN_NAME, resolvePluginConfig, type PluginConfig, type ResolvedPluginConfig } from './config.js'
import {
  STATUS_OPERATION_ID,
  STATUS_PANEL_ID,
  TEST_OPERATION_ID,
  TEST_PANEL_ID,
  createConfigTemplate,
} from './config-template.js'
import { ShellSelectExecutor, executorConfig } from './executor.js'
import { buildStatus, formatShellTest, formatStatus, runShellTest } from './status.js'
import { registerShellTool, registerShellToolReplacement } from './tool.js'

export { PLUGIN_ID, PLUGIN_NAME, resolvePluginConfig, type PluginConfig, type ResolvedPluginConfig } from './config.js'
export { createConfigTemplate } from './config-template.js'
export { ShellSelectExecutor, ShellSelectionRefusedError, executorConfig } from './executor.js'
export { registerShellTool, registerShellToolReplacement, shellDescription, SHELL_TOOL_NAME, REPLACED_SHELL_TOOLS } from './tool.js'
export { buildStatus, formatStatus, formatShellTest, runShellTest, probeFacts } from './status.js'
export { buildInvocation, bashArguments, versionArgv, toLinuxPath, testCommand, TEST_MARKER, CMD_COMMAND_ENV } from './dialects.js'
export {
  AUTO_SHELL,
  catalogFor,
  checkConfinement,
  checkIdentity,
  entryClaiming,
  findEntry,
  localPlatform,
  programName,
  VERIFIED_CONFINEMENT_PLATFORMS,
  type CatalogEntry,
  type Dialect,
  type Platform,
} from './catalog.js'
export { SELECTABLE_SHELL_IDS } from './config.js'
export { host, MINIMUM_DSH_VERSION, HOST_ANCHOR_ENV, satisfiesMinimum } from './host.js'

/** Cordis plugin name: the npm package name, exactly. */
export const name = PLUGIN_NAME

/**
 * Services this plugin needs before it applies.
 *
 * `shell` is deliberately absent: this plugin provides it, so listing it would
 * make the plugin wait on itself. `subprocess`, `sandbox`, and `sandboxPolicy`
 * are named here because the executor is constructed inside `apply()` rather
 * than mounted as its own Cordis plugin, and a Cordis context refuses a service
 * it did not inject — an omitted name would surface as a runtime error on the
 * first call instead of as a missing dependency at load.
 */
export const inject = ['subprocess', 'sandbox', 'sandboxPolicy']

/**
 * How long activation waits for the first selection probe before it gives up.
 *
 * Long enough to cover a cold `stat` walk over a network `PATH`, short enough
 * that a seam which never answers cannot look like a slow start.
 */
export const SELECTION_DEADLINE_MS = 5_000

/**
 * Wait for one selection probe, but never longer than `deadlineMs`, and never
 * fatally.
 *
 * The probe only refines the cached description: `describeShell()` reports
 * `pending` until it lands, and every command resolves its own shell on demand.
 * That makes the wait optional — and an optional wait must not decide whether
 * the plugin activates. The host publishes its Web surface only after every
 * entry's `apply` settles, so a subprocess seam that answers late (or never)
 * would otherwise turn one pending description into a boot that never finishes.
 * @param probe - the refresh whose settlement is awaited.
 * @param label - the activation step named in the diagnostic.
 * @param warn - sink for a timeout or failure; `apply` passes its logger.
 * @param deadlineMs - the longest wait, in milliseconds.
 * @param signal - owner disposal; a disposed owner must not log or retain timers.
 * @returns nothing; a timeout or rejection is reported through `warn`.
 */
export async function awaitSelection(
  probe: Promise<unknown>,
  label: string,
  warn: (message: string) => void,
  deadlineMs: number = SELECTION_DEADLINE_MS,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return
  const budget = Math.max(1, Math.trunc(deadlineMs))
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled: (() => void) | undefined
  try {
    await Promise.race([
      probe,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`the ${label} selection probe did not settle within ${String(budget)} ms`))
        }, budget)
        if (signal) timer.unref()
      }),
      ...(signal ? [new Promise<void>(resolve => {
        cancelled = () => resolve()
        signal.addEventListener('abort', cancelled, { once: true })
      })] : []),
    ])
  } catch (error) {
    if (signal?.aborted) return
    const detail = error instanceof Error ? error.message : String(error)
    warn(`dsh-select: ${detail}; the tool keeps the pending selection and resolves a shell on demand`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (cancelled) signal?.removeEventListener('abort', cancelled)
  }
}

/** The subset of the dsh-loader host API this plugin uses. */
type DshLoaderApi = Pick<HostAPI, 'config'>

/**
 * Mount the executor, the tool, and the settings form.
 * @param ctx - plugin context.
 * @param config - the composition entry, when a patch supplies one.
 */
export function apply(ctx: Context, config: PluginConfig | undefined): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-shell-select: background probes')

  // The executor must exist before anything reads `ctx.shell`; its own budgets
  // come from the resolved entry, and the live configuration replaces them once
  // the form below has registered.
  let current: ResolvedPluginConfig = resolvePluginConfig(config)
  const executor = new ShellSelectExecutor(ctx, executorConfig(current), () => current)
  // Activation must not wait for the selection probe. The executor already
  // published a provisional selection synchronously, the tool reports it as
  // `pending`, and every call resolves its own shell — so the wait is optional,
  // and an optional wait must not hold the host's boot (see `awaitSelection`).
  void awaitSelection(executor.ready, 'mount', message => { ctx.logger?.warn?.(message) }, SELECTION_DEADLINE_MS, lifetime.signal)

  ctx.effect(() => () => { /* the executor is owned by this context */ }, 'dsh-shell-select: executor')

  // Registered on the plugin's own (deployment-plane) context so the denial
  // covers every agent scope, including the shell tools a preset re-mounts.
  ctx.inject(['tools'], scope => {
    scope.effect(() => registerShellToolReplacement(scope), 'dsh-shell-select: replace bash/pwsh')
  })

  ctx.inject(['shell', 'tools', 'systemPrompt', 'shellEnv', 'sandboxPolicy'], scope => {
    registerShellTool(scope, {
      executor,
      backgroundEnabled: () => current.enableRunInBackground,
    })
  })

  ctx.inject(['dshLoader'], scope => {
    let disposed = false
    scope.effect(() => () => { disposed = true })
    // Cordis also waits for injected child fibers at boot. Keep settings I/O
    // out of their apply promises, not just out of the parent apply promise.
    void (async () => {
      const loader = (scope as Context & { dshLoader: DshLoaderApi }).dshLoader
      const handle = await loader.config.register<PluginConfig>(
        { effect: fn => scope.effect(() => fn() ?? (() => {})) },
        createConfigTemplate(),
      )
      if (disposed) return
      const applySnapshot = (): void => {
        // The new configuration is in force synchronously; only the cached
        // description trails, so a save never makes a page wait on the seam.
        current = resolvePluginConfig(handle.get().value)
        void awaitSelection(executor.bindSettings(() => current), 'configuration change', message => {
          if (!disposed) scope.logger?.warn?.(message)
        }, SELECTION_DEADLINE_MS, lifetime.signal)
      }
      applySnapshot()
      scope.effect(() => handle.watch(applySnapshot), 'dsh-shell-select: configuration changes')

      /**
       * The panel's operation context carries the committed configuration, so the
       * facts describe what a command would run right now rather than what the form
       * is staging.
       */
      const policy = (): { mode: string; workspaceRoot: string } => scope.sandboxPolicy.resolve()

      handle.registerOperation(STATUS_OPERATION_ID, async () => ({
        value: { report: formatStatus(await buildStatus(executor, policy())) },
      }))
      handle.registerOperation(TEST_OPERATION_ID, async () => {
        // The self-test re-reads the facts as part of its own result: an operation
        // may only refresh read operations in its own panel, and a user who just ran
        // a test wants to see the state it ran against.
        const tested = await runShellTest(executor, policy())
        return {
          value: {
            report: formatShellTest(tested),
            status: formatStatus(await buildStatus(executor, policy())),
          },
        }
      })

      scope.logger?.info?.(`dsh-select: mounted settings form ${PLUGIN_ID} (${STATUS_PANEL_ID}/${TEST_PANEL_ID} panels)`)
    })().catch(error => {
      if (!disposed) scope.logger?.warn?.(`dsh-select: settings unavailable: ${String(error)}`)
    })
  })
}

export default { name, inject, apply }
