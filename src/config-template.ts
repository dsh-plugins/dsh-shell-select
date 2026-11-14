/**
 * The settings form dsh-loader renders and persists.
 *
 * The plugin's own package builds no browser bundle: dsh-loader 2.0 owns the
 * configuration page, so this template is the entire UI contract — one card of
 * fields plus two transient panels, one that reports what the machine resolved
 * and one that runs the fixed self-test command.
 *
 * Two rules keep the form and the runtime honest:
 *
 * - Every default here comes from {@link DEFAULT_CONFIG}, so the form never
 *   offers a value the executor would read differently.
 * - The panels carry no persisted state. Their results are display-only, which
 *   is why the probe and the self-test can be buttons rather than settings.
 *
 * @module dsh-shell-select/config-template
 */

import { defineConfig, type ConfigField, type ConfigTemplate } from '@dsh-plugin/dsh-loader/config'

import { AUTO_SHELL, catalogFor } from './catalog.js'
import {
  DEFAULT_CONFIG,
  PLUGIN_ID,
  PLUGIN_NAME,
  SELECTABLE_SHELL_IDS,
} from './config.js'

/** Panel id owning the read-only shell facts. */
export const STATUS_PANEL_ID = 'status'

/** Panel id owning the self-test action. */
export const TEST_PANEL_ID = 'test'

/** Operation id that reports the shell facts. */
export const STATUS_OPERATION_ID = 'refresh'

/** Operation id that runs the fixed self-test command. */
export const TEST_OPERATION_ID = 'run'

/**
 * The shell selector's options: `auto` plus every catalog id.
 *
 * Both platforms' ids are listed, and each is labelled with the platform it
 * belongs to, because a configuration document travels: a value naming a shell
 * this host lacks is diagnosed when it is resolved ("does not exist on posix"),
 * which is a clearer answer than refusing to store a value the user typed on
 * another machine.
 * @returns the options, `auto` first.
 */
function shellOptions(): { label: string; value: string }[] {
  const labels = new Map<string, string>()
  for (const platform of ['windows', 'posix'] as const) {
    for (const entry of catalogFor(platform)) {
      if (!labels.has(entry.id)) labels.set(entry.id, `${entry.label} (${platform})`)
    }
  }
  const options = [{ label: `Automatic — the platform's own default`, value: AUTO_SHELL }]
  for (const id of SELECTABLE_SHELL_IDS) {
    options.push({ label: labels.get(id) ?? id, value: id })
  }
  return options
}

/** The persisted fields, in presentation order. */
export function configFields(): ConfigField[] {
  return [
    {
      type: 'select',
      key: 'shell',
      label: 'Shell',
      default: DEFAULT_CONFIG.shell,
      required: true,
      options: shellOptions(),
      description: 'Every command the model runs uses this shell. "Automatic" resolves from the platform and the '
        + 'executable override below; the status panel says which shell that is.',
    },
    {
      type: 'text',
      key: 'executable',
      label: 'Executable path',
      default: DEFAULT_CONFIG.executable,
      description: 'Absolute path for the selected shell. Leave empty to discover it by name. A path that cannot be '
        + 'resolved, or that names a different shell, is an error rather than a cue to search.',
    },
    {
      type: 'boolean',
      key: 'loginShell',
      label: 'Run bash as a login shell',
      default: DEFAULT_CONFIG.loginShell,
      description: 'Sources your profile scripts on every command. Applies to bash-family shells only; off by default.',
    },
    {
      type: 'text',
      key: 'wslDistro',
      label: 'WSL distribution',
      default: DEFAULT_CONFIG.wslDistro,
      description: 'WSL Bash only. Leave empty to use the distribution\u2019s default.',
    },
    {
      type: 'text',
      key: 'wslMountRoot',
      label: 'WSL mount root',
      default: DEFAULT_CONFIG.wslMountRoot,
      description: 'WSL Bash only: where the distribution mounts Windows drives. Default /mnt.',
    },
    {
      type: 'boolean',
      key: 'enableRunInBackground',
      label: 'Allow background commands',
      default: DEFAULT_CONFIG.enableRunInBackground,
      description: 'Advertise `run_in_background` on the shell tool. Disabled calls are refused as well.',
    },
    {
      type: 'group',
      key: 'limits',
      label: 'Execution limits',
      collapsible: true,
      defaultCollapsed: true,
      fields: [
        {
          type: 'number',
          key: 'timeoutMs',
          label: 'Default timeout',
          default: DEFAULT_CONFIG.timeoutMs,
          min: 1,
          description: 'Foreground command timeout in milliseconds.',
        },
        {
          type: 'number',
          key: 'maxTimeoutMs',
          label: 'Timeout ceiling',
          default: DEFAULT_CONFIG.maxTimeoutMs,
          min: 1,
          description: 'Upper bound for a per-call timeout override. Must be no smaller than the default timeout.',
        },
        {
          type: 'number',
          key: 'maxOutputBytes',
          label: 'Output cap',
          default: DEFAULT_CONFIG.maxOutputBytes,
          min: 1,
          description: 'Per-stream in-memory output cap in bytes; overflow spills to a temporary file.',
        },
        {
          type: 'number',
          key: 'maxSpillBytes',
          label: 'Spill cap',
          default: DEFAULT_CONFIG.maxSpillBytes,
          min: 1,
          description: 'Per-stream spill-file cap in bytes.',
        },
        {
          type: 'number',
          key: 'graceMs',
          label: 'Kill grace',
          default: DEFAULT_CONFIG.graceMs,
          min: 1,
          description: 'Grace period between SIGTERM and SIGKILL, in milliseconds.',
        },
      ],
    },
  ]
}

/**
 * The complete template: fields plus the two transient panels.
 * @returns the template dsh-loader registers.
 */
export function createConfigTemplate(): ConfigTemplate {
  return defineConfig({
    id: PLUGIN_ID,
    packageName: PLUGIN_NAME,
    title: 'Shell selection',
    description: 'Choose the shell every model command runs in, and see what this machine resolved for each candidate.',
    fields: configFields(),
    panels: [
      {
        id: STATUS_PANEL_ID,
        title: 'Shell facts',
        description: 'What this machine resolved for every candidate shell, and what the sandbox was observed doing '
          + 'with it. Read-only.',
        custom: false,
        fields: [
          {
            type: 'textarea',
            key: 'report',
            label: 'Status',
            default: '',
            description: 'Refresh after changing the selection or the executable path.',
          },
        ],
        operations: [
          {
            id: STATUS_OPERATION_ID,
            input: [],
            readOnly: true,
            autoRun: true,
            button: { label: 'Refresh', success: 'Shell facts refreshed' },
            result: [{ type: 'text', path: ['report'], title: 'Shell facts' }],
          },
        ],
      },
      {
        id: TEST_PANEL_ID,
        title: 'Test the selection',
        description: 'Runs one fixed command through the saved selection, under the same confinement a model call '
          + 'gets. A refusal here is what a command would get right now.',
        custom: false,
        fields: [
          {
            type: 'textarea',
            key: 'report',
            label: 'Result',
            default: '',
          },
        ],
        operations: [
          {
            id: TEST_OPERATION_ID,
            input: [],
            readOnly: false,
            button: { label: 'Test shell', success: 'Test finished' },
            // The facts are re-read by the handler itself and returned beside the
            // result: a cross-panel refresh would be a second round trip and, more
            // to the point, dsh-loader only permits refreshing read operations in
            // the same panel.
            result: [
              { type: 'text', path: ['report'], title: 'Test result' },
              { type: 'text', path: ['status'], title: 'Shell facts' },
            ],
          },
        ],
      },
    ],
  })
}
