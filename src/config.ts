/**
 * The plugin's configuration model.
 *
 * One schema, two consumers: {@link resolvePluginConfig} is what the executor
 * reads on every call, and `createConfigTemplate` (./config-template.ts) is the
 * form dsh-loader renders and writes. Both are derived from the defaults below,
 * so a field never carries a different default in the form than at runtime.
 *
 * @module dsh-shell-select/config
 */

import { AUTO_SHELL, catalogFor, type Platform } from './catalog.js'
import { host } from './host.js'

/** Stable plugin id: the npm package name and the Cordis plugin name. */
export const PLUGIN_NAME = '@dsh-plugin/dsh-shell-select'

/**
 * Short kebab-case id for identifiers that cannot carry a scoped npm name: the
 * config-api template id (its directory under `<profile>/config/`) and the
 * routing id the operations live under. Stable across package renames.
 */
export const PLUGIN_ID = 'dsh-shell-select'

/** Default SIGTERM→SIGKILL grace period; mirrors the local executors'. */
export const DEFAULT_GRACE_MS = 3_000

/** Default per-stream spill cap; mirrors the local executors'. */
export const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Default foreground timeout, matching the shipped shell tools. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Default upper bound for a per-call timeout override. */
export const DEFAULT_MAX_TIMEOUT_MS = 600_000

/** Default per-stream in-memory output cap. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64_000

/** The mount root a WSL distribution maps Windows drives under by default. */
export const DEFAULT_WSL_MOUNT_ROOT = '/mnt'

/**
 * Every shell id selectable on some platform; the configuration accepts each.
 *
 * The list is platform-independent because a configuration document travels
 * between machines: a value naming a shell this host lacks is reported as such
 * when it is resolved, which is a clearer answer than refusing to store it.
 */
export const SELECTABLE_SHELL_IDS: readonly string[] = Object.freeze(
  [...new Set([...catalogFor('windows' as Platform), ...catalogFor('posix' as Platform)].map(entry => entry.id))].sort(),
)

/** The plugin configuration, exactly as the form persists it. */
export interface PluginConfig {
  /** Which catalog entry every command runs through; `auto` follows the platform's default shell. */
  shell: string
  /** Explicit shell executable. Wins over discovery for the selected entry. */
  executable: string
  /** Run a bash-family shell as a login shell. */
  loginShell: boolean
  /** WSL distribution name; empty uses the distribution's default. */
  wslDistro: string
  /** Mount root the distribution maps Windows drives under. */
  wslMountRoot: string
  /** Advertise `run_in_background` on the shell tool; disabled calls are also rejected. */
  enableRunInBackground: boolean
  /** Default foreground timeout in milliseconds. */
  timeoutMs: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs: number
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes: number
  /** Grace period for kill escalation and inherited pipes. */
  graceMs: number
}

/** The frozen, validated configuration every call reads. */
export interface ResolvedPluginConfig extends PluginConfig {
  readonly shell: string
  readonly executable: string
  readonly loginShell: boolean
  readonly wslDistro: string
  readonly wslMountRoot: string
  readonly enableRunInBackground: boolean
  readonly timeoutMs: number
  readonly maxTimeoutMs: number
  readonly maxOutputBytes: number
  readonly maxSpillBytes: number
  readonly graceMs: number
}

/** The values a fresh installation starts from. */
export const DEFAULT_CONFIG: Readonly<PluginConfig> = Object.freeze({
  shell: AUTO_SHELL,
  executable: '',
  loginShell: false,
  wslDistro: '',
  wslMountRoot: DEFAULT_WSL_MOUNT_ROOT,
  enableRunInBackground: true,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: DEFAULT_MAX_TIMEOUT_MS,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  maxSpillBytes: DEFAULT_MAX_SPILL_BYTES,
  graceMs: DEFAULT_GRACE_MS,
})

/**
 * Read one stored value as display text.
 * @param value - the stored value.
 * @param fallback - the value to use when nothing usable is stored.
 * @returns the string.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Read one stored value as a boolean.
 * @param value - the stored value.
 * @param fallback - the value to use when nothing usable is stored.
 * @returns the boolean.
 */
function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Read one stored value as a positive finite number.
 * @param value - the stored value.
 * @param fallback - the value to use when nothing usable is stored.
 * @param field - field name used in the diagnostic.
 * @param maximum - an inclusive upper bound, when the field has one.
 * @returns the number.
 * @throws {Error} when the stored value is present but unusable.
 */
function positive(value: unknown, fallback: number, field: string, maximum?: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`dsh-shell-select: "${field}" must be a positive finite number, got ${JSON.stringify(value)}`)
  }
  if (maximum !== undefined && value > maximum) {
    throw new Error(`dsh-shell-select: "${field}" must be no greater than ${maximum}, got ${value}`)
  }
  return value
}

/**
 * Validate one stored section into the frozen runtime shape.
 *
 * Every refusal names the field, because the caller is a settings panel or a
 * single command: an unexplained rejection is the least useful answer either
 * consumer can give.
 * @param value - the stored configuration, possibly partial or foreign.
 * @returns the frozen configuration.
 * @throws {Error} naming the first field that cannot be used.
 */
export function resolvePluginConfig(value: unknown): ResolvedPluginConfig {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof PluginConfig, unknown>>
  const shell = text(input.shell, DEFAULT_CONFIG.shell)
  if (shell !== AUTO_SHELL && !SELECTABLE_SHELL_IDS.includes(shell)) {
    throw new Error(
      `dsh-shell-select: unknown shell ${JSON.stringify(shell)}; expected "auto" or one of `
      + `${SELECTABLE_SHELL_IDS.join(', ')}`,
    )
  }
  const graceMs = positive(input.graceMs, DEFAULT_CONFIG.graceMs, 'graceMs', host.timeout.MAX_TIMER_DELAY_MS)
  // A tighter cap than the default timeout would make the default unreachable;
  // the executor would then clamp every call down without saying so.
  const timeoutMs = positive(input.timeoutMs, DEFAULT_CONFIG.timeoutMs, 'timeoutMs')
  const maxTimeoutMs = positive(input.maxTimeoutMs, DEFAULT_CONFIG.maxTimeoutMs, 'maxTimeoutMs')
  if (maxTimeoutMs < timeoutMs) {
    throw new Error(
      `dsh-shell-select: "maxTimeoutMs" (${maxTimeoutMs}) must be no smaller than "timeoutMs" (${timeoutMs})`,
    )
  }
  return Object.freeze({
    shell,
    executable: text(input.executable, DEFAULT_CONFIG.executable).trim(),
    loginShell: flag(input.loginShell, DEFAULT_CONFIG.loginShell),
    wslDistro: text(input.wslDistro, DEFAULT_CONFIG.wslDistro).trim(),
    wslMountRoot: text(input.wslMountRoot, DEFAULT_CONFIG.wslMountRoot).trim() || DEFAULT_WSL_MOUNT_ROOT,
    enableRunInBackground: flag(input.enableRunInBackground, DEFAULT_CONFIG.enableRunInBackground),
    timeoutMs,
    maxTimeoutMs,
    maxOutputBytes: positive(input.maxOutputBytes, DEFAULT_CONFIG.maxOutputBytes, 'maxOutputBytes'),
    maxSpillBytes: positive(input.maxSpillBytes, DEFAULT_CONFIG.maxSpillBytes, 'maxSpillBytes'),
    graceMs,
  })
}

/**
 * The subset of the settings section a single call depends on, copied out of
 * the live configuration and frozen.
 *
 * Every step of one call — entry resolution, executable resolution, validation,
 * argv construction, launch options — reads this object rather than the live
 * section, so a configuration write that lands while a call is being prepared
 * changes nothing about that call. The next call reads the next snapshot.
 * @param settings - the live, resolved configuration.
 * @returns the frozen per-call snapshot.
 */
export interface CallSettings {
  readonly shell: string
  readonly loginShell: boolean
  readonly executable: string | undefined
  readonly wslDistro: string | undefined
  readonly wslMountRoot: string
}

/**
 * Narrow the live configuration to the fields one call reads.
 * @param settings - the live, resolved configuration.
 * @returns the frozen per-call snapshot.
 */
export function settingsSnapshot(settings: ResolvedPluginConfig): CallSettings {
  const present = (value: string): string | undefined => value.length > 0 ? value : undefined
  return Object.freeze({
    shell: settings.shell,
    loginShell: settings.loginShell === true,
    executable: present(settings.executable),
    wslDistro: present(settings.wslDistro),
    // The mount root always carries a value: an empty one would make every WSL
    // call translate its path to `/d/work` rather than `/mnt/d/work`.
    wslMountRoot: settings.wslMountRoot.length > 0 ? settings.wslMountRoot : DEFAULT_WSL_MOUNT_ROOT,
  })
}
