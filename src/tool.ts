/**
 * The one model-facing shell tool.
 *
 * There is exactly one tool (`shell`) and no per-call shell argument: the shell
 * is a user setting, so a model cannot reach past it to a different one. The
 * description is a getter re-read at every assembly, so a configuration change
 * shows up in the next model step rather than at the next restart, and the
 * syntax it states is the selected shell's own.
 *
 * Background execution registers process handles with `ctx.jobs`; their work
 * uses job cancellation rather than the tool-call signal after an id returns.
 * Sandbox escalation goes through the shared `approveEscalation` sequence, so
 * this tool contributes only its own composition guard and approval ingredients.
 *
 * @module dsh-shell-select/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobHooks, JobId, JobOutcome, JobOutputSource, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { GenericCallView, TerminalCallView, ToolResult, ToolResultView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isAbsolute, sep } from 'node:path'

import type { ShellSelectExecutor } from './executor.js'
import { host } from './host.js'
import { describeShellFact, renderShellProcessRead, renderShellResult, type RenderedResult } from './render.js'

/** Tool name registered on `ctx.tools`. */
export const SHELL_TOOL_NAME = 'shell'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** Background commands started by this plugin's `shell` tool. */
    shell: 'shell'
  }
}

/**
 * Tool names this plugin replaces.
 *
 * Several composition layers can mount a shell tool: the base bundle mounts
 * `tool-bash`/`tool-pwsh`, and every agent preset re-mounts them inside its own
 * realm, where no patch can address them.
 *
 * These are denied instead, which is layer-independent by construction: a guard
 * is consulted for every call regardless of which composition registered the
 * tool, and a guard's denial cannot be turned back into permission by listener
 * order. The denial names the replacement, so the model redirects rather than
 * retries.
 */
export const REPLACED_SHELL_TOOLS: readonly string[] = Object.freeze(['bash', 'pwsh'])

/**
 * Deny every competing shell tool, whoever registered it.
 *
 * Without this the model would see two shell tools in a preset session and
 * could run commands through one whose shell the user never selected.
 * @param ctx - a plain (deployment-plane) plugin context carrying `tools`.
 * @returns the exact disposer that unregisters the guard.
 */
export function registerShellToolReplacement(ctx: Context): () => void {
  return ctx.tools.guard(exec => REPLACED_SHELL_TOOLS.includes(exec.name)
    ? `"${exec.name}" is not available in this deployment: the session shell is a user setting, and the `
      + `"${SHELL_TOOL_NAME}" tool is the only route to it. Run the command through "${SHELL_TOOL_NAME}" instead.`
    : undefined)
}

/** The `shell` fact block a result carries: which shell actually ran the call. */
export interface ShellFactBlock {
  readonly shell: string
  readonly label: string
  readonly platform: string
  readonly executable?: string
  readonly workdir?: string
}

/**
 * Project a fact block into the lossless JSON the tool output schema declares.
 * @param fact - the decision's shell facts.
 * @returns the JSON object.
 */
function factJson(fact: ShellFactBlock): { [key: string]: JsonValue } {
  return {
    shell: fact.shell,
    label: fact.label,
    platform: fact.platform,
    ...fact.executable === undefined ? {} : { executable: fact.executable },
    ...fact.workdir === undefined ? {} : { workdir: fact.workdir },
  }
}

/**
 * Map a settled background process onto the generic task-outcome vocabulary.
 * @param proc - the settled process handle.
 * @returns the outcome for the `ctx.jobs` registration.
 */
function processOutcome(proc: ShellProcess): JobOutcome {
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}

/** Job hooks plus the original error of a job that failed before its process produced an outcome. */
interface ProcessJobHooks extends JobHooks {
  /** The error that ended a `failed` job, kept with its own class and code. */
  failure(): { error: unknown } | undefined
}

/**
 * Adapt asynchronous shell preparation after job admission without exposing a
 * partial process.
 * @param start - starts the process with job-owned cancellation.
 * @param renderOutput - consumes output from a published process.
 * @returns synchronous job hooks whose completion includes preparation and process settlement.
 */
function processJob(
  start: (signal: AbortSignal) => Promise<ShellProcess>,
  renderOutput: (process: ShellProcess) => string,
): ProcessJobHooks {
  const controller = new AbortController()
  let process: ShellProcess | undefined
  let failure: { error: unknown } | undefined
  const done: Promise<JobOutcome> = (async () => {
    try {
      process = await start(controller.signal)
      try {
        if (controller.signal.aborted) process.kill()
      } finally {
        await process.done
      }
      return processOutcome(process)
    } catch (error) {
      const killed = controller.signal.aborted && process === undefined
      if (!killed) failure = { error }
      return {
        status: killed ? 'killed' : 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  return {
    cancel: (reason?: string) => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      process?.kill()
    },
    done,
    failure: () => failure,
  }
}

/**
 * The process's non-consuming stream readers as registry pull sources.
 *
 * They bind lazily because the process is spawned inside the starter, after the
 * registry admitted the job; a read before the spawn yields nothing, and the
 * pump keeps the model's consuming cursor untouched.
 * @param proc - the started process, once the starter has spawned it.
 * @returns one source per stream, stdout first.
 */
function processSources(proc: () => Pick<ShellProcess, 'observed'> | undefined): JobOutputSource[] {
  const source = (channel: 'stdout' | 'stderr'): JobOutputSource => ({
    channel,
    read: (fromByte: number) => {
      const live = proc()
      return live === undefined ? { text: '', nextOffset: fromByte, lossy: false } : live.observed[channel].readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}

/**
 * Describe the tool's current shell for the model.
 *
 * The shell identity and its syntax are per-deployment facts the model needs
 * before it writes a command, so they belong here rather than in a prompt
 * section: the description is what the model reads when choosing how to write
 * the command, and it is recomputed from live configuration on every assembly.
 * @param describe - a fresh `describeShell()` result.
 * @param backgroundEnabled - whether `run_in_background` is advertised.
 * @param escalationModes - escalation targets this composition advertises.
 * @returns the tool description for the next model step.
 */
export function shellDescription(
  describe: ReturnType<ShellSelectExecutor['describeShell']>,
  backgroundEnabled: boolean,
  escalationModes: readonly string[],
): string {
  const background = backgroundEnabled
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  const identity = describe.available
    ? `The shell for this session is ${String(describe.label)}, invoked as ${String(describe.executable)} (${describe.platform}). ${describe.syntax}`
    : describe.pending === true
      // The executable is still being resolved; the shell itself is known.
      ? `The shell for this session is ${String(describe.label)} (${describe.platform}). ${describe.syntax}`
      : `WARNING: the configured shell is not available: ${String(describe.detail)} Commands will be refused until the `
        + '"shell" plugin setting names a working executable. '
  const base = `Execute a command in the session's configured shell and return its stdout/stderr. ${identity}`
    + 'Each call runs in a fresh, stateless process: no state (working directory, variables, functions) persists between calls — '
    + 'pass `workdir` instead of changing directory. Non-zero exits are reported as `[exit code: N]`. '
    + 'Current harness environment facts are exposed through managed `DSH_*` variables; inspect them when needed. '
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — '
    + 'a policy denial, not a bug in the command; do not retry another way. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + background
  if (escalationModes.length === 0) return base
  return base + ' Attempting a command the sandbox may deny is safe and expected: run it and read the '
    + 'marker rather than assuming the denial. When a command is denied and a wider mode would let it '
    + 'succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry '
    + 'the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) '
    + 'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the '
    + 'approval prompt raised by that retry is how the user consents. If the session states approval '
    + 'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. '
    + 'Never escalate speculatively. A rejected escalation is final for that command — stop and explain, '
    + 'never work around it — but it does not forbid attempting or escalating other commands later.'
}

/**
 * Validate the args the schema cannot express.
 * @param command - the command text.
 * @param description - the required human description.
 * @param timeoutMs - optional per-call timeout.
 * @param sandboxPermissions - optional escalation target.
 * @param justification - optional escalation justification.
 * @throws {Error} naming the first argument that cannot be used.
 */
export function validateShellArgs(
  command: string,
  description: string,
  timeoutMs: number | undefined,
  sandboxPermissions: string | undefined,
  justification: string | undefined,
): void {
  if (typeof command !== 'string' || command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (typeof description !== 'string' || description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(timeoutMs)}`)
  }
  host.sandbox.validateEscalationArgs(sandboxPermissions, justification)
}

/** What the tool needs from the plugin to register itself. */
export interface ShellToolOptions {
  /** The mounted shell-select executor. */
  readonly executor: ShellSelectExecutor
  /** Whether `run_in_background` is advertised, read from the live configuration. */
  readonly backgroundEnabled: () => boolean
}

/**
 * Register the `shell` tool.
 * @param ctx - plugin context carrying tools, shell, jobs, approval, and the prompt registry.
 * @param options - the mounted executor and the live background switch.
 */
export function registerShellTool(ctx: Context, options: ShellToolOptions): void {
  const { executor } = options
  const describeShell = (): ReturnType<ShellSelectExecutor['describeShell']> => executor.describeShell()
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined ? [] : host.sandbox.ESCALATION_TARGETS
  const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error(`${SHELL_TOOL_NAME}: the mounted executor confines but ctx.sandboxPolicy is missing`)
  }

  /** Resolve the complete standing policy for this call when a confining executor is mounted. */
  const resolveSandboxPolicy = (exec: ToolRunContext): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE anything
   * executes. Escalating the mode cannot make an unconfineable shell
   * confineable, so a refused shell stays refused.
   */
  const approveShellEscalation = (
    mode: string,
    justification: string,
    exec: ToolRunContext,
    standingPolicy: SandboxExecutionPolicy | undefined,
  ): Promise<SandboxMode> => {
    if (escalationModes.length === 0) {
      throw new host.sandbox.SandboxEscalationError(
        'sandbox_permissions is not available in this composition (no sandboxing executor to escalate)',
        'SANDBOX_ESCALATION_UNAVAILABLE',
      )
    }
    return host.sandbox.approveEscalation<NonNullable<ToolRunContext['agent']>, ToolRunContext['callId']>(
      {
        requestedMode: mode,
        justification,
        effectiveMode: (standingPolicy as SandboxExecutionPolicy).mode,
        subject: 'command',
      },
      {
        approver: ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName: SHELL_TOOL_NAME,
        signal: exec.signal,
      },
    )
  }

  /**
   * Resolve an explicit workdir first, making a relative one session-workspace-relative.
   * A resolved sandbox-policy root wins so workdir and confinement use the
   * exact same per-call identity.
   */
  const resolveWorkdir = (
    modelWorkdir: string | undefined,
    policyWorkspaceRoot: string | undefined,
    sessionCwd: string | undefined,
  ): string | undefined => {
    const base = policyWorkspaceRoot ?? sessionCwd
    if (modelWorkdir === undefined) return base
    if (base !== undefined && !isAbsolute(modelWorkdir)) return `${base}${sep}${modelWorkdir}`
    return modelWorkdir
  }

  /**
   * The same fact block for the *call preview*, before the decision exists.
   *
   * A preview can only read the cached description, because nothing is decided
   * yet; it is what the call card shows while the command is running, and the
   * result replaces it with the decision's own facts.
   */
  const previewFact = (): ShellFactBlock => {
    const describe = describeShell()
    return {
      shell: describe.id ?? '(unresolved)',
      label: describe.label ?? '(unresolved)',
      platform: describe.platform,
      ...describe.available ? { executable: describe.executable } : {},
    }
  }

  const definition = host.tools.defineTool({
    name: SHELL_TOOL_NAME,
    description: shellDescription(describeShell(), options.backgroundEnabled(), escalationModes),
    parameters: {
      command: { type: 'string', required: true, description: 'The command to execute, written in the syntax of the shell named in this tool description.' },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, '
          + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
          + '"git status" → "Show working tree status".',
      },
      timeoutMs: { oneOf: [{ type: 'number' }, { type: 'string', const: '' }], description: 'Foreground timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
      workdir: { type: 'string', description: 'Absolute working directory for this command. Defaults to the session workspace; a relative path is resolved against it. The directory must exist — it is never substituted.' },
      ...options.backgroundEnabled() ? {
        run_in_background: { oneOf: [{ type: 'boolean' }, { type: 'string', const: '' }] as const, description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' },
      } : {},
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string' as const,
          enum: [...escalationModes, ''] as const,
          description: 'The wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; widening requires user approval. A narrower mode is ignored, and the command uses the current mode.',
        },
        justification: {
          type: 'string' as const,
          description: 'Required with sandbox_permissions unless the requested mode is narrower than the current mode. Give one sentence explaining why this command needs wider access.',
        },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object' as const,
            additionalProperties: false as const,
            properties: {
              kind: { type: 'string' as const, required: true as const, const: 'background' },
              jobId: { type: 'string' as const, required: true as const },
              shell: { type: 'object' as const, additionalProperties: true as const },
            },
          },
          {
            type: 'object' as const,
            additionalProperties: false as const,
            properties: {
              kind: { type: 'string' as const, required: true as const, const: 'foreground' },
              exitCode: { required: true as const, oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] },
              signal: { required: true as const, oneOf: [{ type: 'string' as const }, { type: 'null' as const }] },
              timedOut: { type: 'boolean' as const, required: true as const },
              aborted: { type: 'boolean' as const, required: true as const },
              timeoutMs: { type: 'number' as const, required: true as const },
              shell: { type: 'object' as const, additionalProperties: true as const },
              stdout: {
                type: 'object' as const,
                additionalProperties: false as const,
                required: true as const,
                properties: {
                  text: { type: 'string' as const, required: true as const },
                  truncated: { type: 'boolean' as const, required: true as const },
                  spillPath: { type: 'string' as const },
                },
              },
              stderr: {
                type: 'object' as const,
                additionalProperties: false as const,
                required: true as const,
                properties: {
                  text: { type: 'string' as const, required: true as const },
                  truncated: { type: 'boolean' as const, required: true as const },
                  spillPath: { type: 'string' as const },
                },
              },
              sandbox: {
                type: 'object' as const,
                additionalProperties: false as const,
                properties: {
                  mode: { type: 'string' as const, required: true as const },
                  denied: { type: 'boolean' as const, required: true as const },
                  enforcement: { type: 'string' as const },
                  runnerFailed: { type: 'boolean' as const },
                },
              },
            },
          },
        ],
      },
      // Persisted per-call metadata: the UI's call details read the shell that
      // actually ran, not whichever shell is selected when the card renders.
      presentationMeta: (_args, value): { [key: string]: JsonValue } => {
        const fact = value.shell
        if (fact === undefined) return {}
        return { shell: fact as JsonValue }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background job ${value.jobId}`
          : renderShellResult(value as unknown as RenderedResult, escalationModes),
      }],
    },
    async execute(args, exec: ToolRunContext) {
      const standingPolicy = resolveSandboxPolicy(exec)
      const effectiveMode = standingPolicy?.mode
      const requestedMode = args.sandbox_permissions === '' ? undefined : args.sandbox_permissions
      const ignoreEscalation = effectiveMode !== undefined && requestedMode !== undefined
        && escalationModes.some(mode => mode === requestedMode)
        && (host.sandbox.WIDER_MODES[requestedMode] ?? []).includes(effectiveMode)
      const sandboxPermissions = ignoreEscalation ? undefined : requestedMode
      const justification = sandboxPermissions === undefined ? undefined : args.justification
      const timeoutMs = args.run_in_background === true || args.timeoutMs === '' ? undefined : args.timeoutMs
      validateShellArgs(args.command, args.description, timeoutMs, sandboxPermissions, justification)
      const approvedMode = sandboxPermissions !== undefined && justification !== undefined
        ? await approveShellEscalation(sandboxPermissions, justification, exec, standingPolicy)
        : undefined
      const policy = approvedMode === undefined
        ? standingPolicy
        : { ...(standingPolicy as SandboxExecutionPolicy), mode: approvedMode }
      const workdir = resolveWorkdir(
        args.workdir === '' ? undefined : args.workdir,
        standingPolicy?.workspaceRoot,
        exec.agent?.session.header.cwd,
      )
      const request = {
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...timeoutMs !== undefined ? { timeoutMs } : {},
        dshEnv: ctx.shellEnv.collect(exec),
        ...policy !== undefined ? { sandboxPolicy: policy } : {},
      }

      if (args.run_in_background === true) {
        if (!options.backgroundEnabled()) {
          throw new host.jobs.JobError('run_in_background is disabled for this deployment', 'JOB_BACKGROUND_DISABLED')
        }
        const jobs: JobRegistry | undefined = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        // The caller owns cancellation until ctx.jobs commits detached ownership.
        if (exec.signal.aborted) throw toolAborted()
        // Decided before admission: the job spawns exactly what the result
        // names, and a refused selection fails the call instead of creating a
        // job that fails on its first tick. The job's own controller owns
        // cancellation, so the spec carries no tool-call signal.
        const decided = await executor.decide(executor.resolve(request))
        let proc: ShellProcess | undefined
        // Task preflight finishes before the starter can spawn a process.
        const id: JobId = jobs.start({
          kind: SHELL_TOOL_NAME,
          label: args.command,
          ...exec.agent === undefined ? {} : { owner: exec.agent.id },
          toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
          output: processSources(() => proc),
          run: () => {
            const job = processJob(
              async signal => {
                const execution = await executor.execute({ ...decided.spec, signal })
                proc = execution
                return execution
              },
              process => renderShellProcessRead(
                process.readOutput(),
                (process.sandbox ?? undefined) as Parameters<typeof renderShellProcessRead>[1],
                escalationModes,
              ),
            )
            return { done: job.done, cancel: job.cancel }
          },
        })
        return {
          kind: 'background' as const,
          jobId: id,
          shell: factJson({
            shell: decided.decision.shell.id,
            label: decided.decision.shell.label,
            platform: decided.decision.shell.platform,
            executable: decided.decision.shell.executable,
            workdir: decided.decision.shell.workdir,
          }),
        }
      }

      // One decision for this call: it refuses an unusable selection before any
      // process exists, and it fixes the shell, the executable, and the argv
      // that `execute` then spawns, so the reported facts cannot drift from it.
      const decided = await executor.decide(executor.resolve({ ...request, signal: exec.signal }))
      const result: ShellRunResult = await (await executor.execute(decided.spec)).result()
      if (result.aborted) throw toolAborted()
      return {
        kind: 'foreground' as const,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        timeoutMs: result.timeoutMs,
        shell: factJson({
          shell: decided.decision.shell.id,
          label: decided.decision.shell.label,
          platform: decided.decision.shell.platform,
          executable: decided.decision.shell.executable,
          workdir: decided.decision.shell.workdir,
        }),
        stdout: {
          text: result.stdout.text,
          truncated: result.stdout.truncated,
          ...result.stdout.spillPath !== undefined ? { spillPath: result.stdout.spillPath } : {},
        },
        stderr: {
          text: result.stderr.text,
          truncated: result.stderr.truncated,
          ...result.stderr.spillPath !== undefined ? { spillPath: result.stderr.spillPath } : {},
        },
        ...result.sandbox === undefined ? {} : {
          sandbox: {
            mode: result.sandbox.mode,
            denied: result.sandbox.denied,
            ...result.sandbox.enforcement === undefined ? {} : { enforcement: result.sandbox.enforcement },
            ...result.sandbox.runnerFailed === undefined ? {} : { runnerFailed: result.sandbox.runnerFailed },
          },
        },
      }
    },
    // The call card names the shell and the working directory up front, so a
    // user reading the transcript sees which shell will run the command. This is
    // the cached selection: the call has not been decided yet.
    presentCall: (args): GenericCallView | TerminalCallView => {
      const shell = describeShellFact(previewFact())
      if (args.run_in_background === true) {
        return {
          card: 'generic',
          title: args.command,
          kind: 'execute',
          rawInput: args.command,
          content: [{ type: 'text', text: `${args.description}${shell === undefined ? '' : ` — ${shell}`}` }],
        }
      }
      return {
        card: 'terminal',
        title: args.command,
        description: `${args.description}${shell === undefined ? '' : ` — ${shell}`}`,
        ...(args.workdir !== undefined && args.workdir !== '') ? { cwd: args.workdir } : {},
      }
    },
    presentResult: (args, result: ToolResult): ToolResultView | undefined => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text
      if (args.run_in_background === true || result.isError) {
        return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/u, '')}\n\`\`\`` }] }
      }
      // The exit marker becomes the card's exit pill, so it leaves the output body.
      const { body, ...exit } = host.shell.parseExitStatus(raw)
      return { card: 'terminal', output: body, ...exit }
    },
  })

  // Re-read at every assembly so the model's description tracks the setting.
  Object.defineProperty(definition, 'description', {
    enumerable: true,
    get: () => shellDescription(describeShell(), options.backgroundEnabled(), escalationModes),
  })

  // Cross-call guidance belongs in the prompt rather than one-call schema prose.
  ctx.systemPrompt.section({
    name: `tool:${SHELL_TOOL_NAME}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: `Check the [exit code: N] marker on every ${SHELL_TOOL_NAME} result; investigate failures before moving on.`,
  })

  ctx.tools.register(definition)
}

/** The abort error the foreground path throws when the caller cancels the call. */
function toolAborted(): Error {
  const error = new host.llm.HarnessError('tool call aborted', host.tools.TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}
