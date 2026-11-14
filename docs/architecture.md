# Architecture

This document holds the implementation detail behind
[`dsh-shell-select`](../README.md): how a call is decided, which harness APIs the
plugin delegates to, how each shell dialect builds argv, and which execution
routes the selector does and does not control.

## What the plugin mounts

`apply()` in [`src/index.ts`](../src/index.ts) mounts three things and nothing
else:

1. **A `ctx.shell` provider.** [`ShellSelectExecutor`](../src/executor.ts) seats
   the harness's own local executor for the platform (`PwshLocalExecutor` on
   Windows, `LocalBashExecutor` elsewhere) and replaces exactly two things: which
   argv is built, and the decision that refuses a call before any process exists.
   Everything that already routes through `ctx.shell` then uses the selected
   shell: the `shell` tool, Claude Code and Codex hook commands, and the tmux
   context probe.
2. **One model-facing `shell` tool** plus a global tool guard. The guard denies
   `bash` and `pwsh` wherever a preset re-mounts them, so no second shell tool
   competes with the selector. See
   [Execution routes](#execution-routes-covered-and-not-covered).
3. **Its settings form**, through dsh-loader's config-api: one card of persisted
   fields plus two transient panels that report the resolved facts and run a
   fixed self-test.

The plugin builds no client bundle. dsh-loader 2.0 owns the configuration page,
so the entire UI contract is the template in
[`src/config-template.ts`](../src/config-template.ts); this package ships no
`dsh.client` declaration and no `window.__ModuleLoader__` closure.

The shell is a user setting. There is no per-call shell argument, so the model
cannot pick a different shell for one command.

## Binding to the running harness

[`src/host.ts`](../src/host.ts) resolves `@deepseek-ai/dsh-*` at load time instead
of importing it statically. The reason is a property of where a third-party
bundle sits, not of this plugin's own code:

- A bundle lives in the profile (`<profile>/node_modules/…`), while the harness
  that loads it lives in the installation the launcher started. Node resolves a
  bare specifier from the *importing* file, and a profile's `node_modules` is not
  guaranteed to carry the running harness — on a launcher-managed installation it
  carries a junction to an older global `dsh`.
- A Cordis service is recognised by identity, not by shape. A subclass bound to a
  different release's `ShellExecutor` would not be the service the host asked
  for, and the failure would surface as an unrelated runtime error.

So the anchor is the one thing that is always the running harness: the entry
script Node was started with (`dsh`'s own `bin.js`). Resolution walks
`DSH_SHELL_SELECT_HOST_ANCHOR` → `process.argv[1]` → `process.argv[0]` → this
module's own URL, and rejects any candidate whose `@deepseek-ai/dsh-shell` is
older than [`MINIMUM_DSH_VERSION`](../src/host.ts) — which is what makes the last
step safe in a profile whose tree still points at an old global install. The
resolved modules come back as one facade, `host`, so every other module reads
`host.sandbox.classifyRunnerFailure` rather than importing the package.

The failure mode is deliberate: module-level `await` means a plugin that cannot
bind to the running harness fails at load, naming every anchor it tried, rather
than appearing to load and then misbehaving on the first command.

## Harness APIs it delegates to

| Concern | Harness API | What this plugin adds |
|---|---|---|
| Finding an executable | `ctx.subprocess.resolveExecutable` (absolute-path verification, PATH and `PATHEXT` lookup) | per-platform candidate lists of shell *names*, plus the few absolute locations derived from the environment |
| Execution platform and default shell | `ctx.subprocess.terminalEnvironment()` | the rule that decides when `defaultShell` is a preference |
| PowerShell install locations | `candidatePwshPaths` from `@deepseek-ai/dsh-pwsh-local` | nothing |
| Process mechanics: deadlines, bounded and spilled output, background handles, process-tree termination | the inherited local executor's `executeArgv` | nothing |
| Sandbox enforcement | `ctx.sandbox.confine`, `ctx.sandboxPolicy.resolve` | nothing, including for the panel's version probes |
| Background jobs | `ctx.jobs` | nothing |
| Configuration persistence and the settings page | `ctx.dshLoader.config` (dsh-loader 2.0 config-api) | the template and its two operations |
| Model-facing result rendering | the same marker vocabulary as the shipped `tool-bash` and `tool-pwsh` | the shell fact block |

The one thing the plugin replaces is the `ctx.shell` provider, because a selector
has to choose argv before the platform executor would. `resolve()` still calls the
inherited defaulting.

## One decision per call

Every call is decided once in `ShellSelectExecutor.decide()` from **one frozen
configuration snapshot** (`settingsSnapshot()`): a copy of `shell`, `executable`,
`loginShell`, `wslDistro`, and `wslMountRoot`. The decision fixes:

1. the execution platform, from the subprocess seam;
2. the catalog entry, following `auto` when the configuration asks for it;
3. the refusal when the entry's dialect cannot take the staged launch options;
4. the confinement verdict for the caller's resolved mode;
5. the working directory, validated for the platform;
6. the executable, resolved through the subprocess seam;
7. the argv, built by the dialect adapter;
8. the transport environment the dialect needs.

The decision is attached to the spec under an enumerable `Symbol`
(`DECIDED`), so `execute()` — and the background path, which spreads the spec
with a job-owned signal — spawns exactly what was decided. A configuration write
that lands between the decision and the spawn changes the next call, never this
one, and the `shell` fact block recorded with the result is the decision's, not a
second read of the configuration.

Refusals happen **ahead of confinement and ahead of the spawn**, which is why a
refused call produces zero spawn requests rather than a spawn whose failure is
converted into a refusal afterwards. The suites assert exactly that.

## The 0.2.2 execution seam

The shell seam this plugin extends has two methods, `resolve(request)` and
`execute(spec) → Promise<ShellExecution>`; a handle's `result()` is the
foreground projection. That is a change from the `run`/`start` pair earlier
harness releases exposed, and it is why the executor here is a port rather than a
copy:

- `execute()` decides, then calls the inherited `executeArgv(spec, argv,
  onStarted)` — the argv-or-prepare parameter is where `ctx.sandbox.confine`
  wraps the decided argv, and `onStarted` is where the per-process facts are
  recorded, before the handle can settle.
- The handle's `result()` is decorated in place, once, so the per-process facts
  still key on the exact instance: a runner failure becomes
  `SandboxUnavailableError`, everything else carries
  `{ mode, denied, enforcement }`.
- `onProcessDone` stamps the same facts on a background handle, so a job's
  terminal reason and its `job_output` read carry the sandbox verdict too.

Budgets (`timeoutMs`, `maxOutputBytes`, …) reach the inherited executor through
`executorConfig()` as readonly references, which is the shape its schema declares
for volatile fields. They come from the dsh-loader form rather than from a Cordis
entry, so nothing else may replace them — this plugin is the one place the shell
budget is configured.

## `auto`, and when `defaultShell` is a preference

`auto` is not a catalog row: it is whichever shell this machine picks. Two facts
fix how it resolves.

On POSIX, `ctx.subprocess.terminalEnvironment().defaultShell` is the user's own
login shell (`$SHELL`) — a real preference — so a catalog entry matching its
program name wins, provided it is installed. An uninstalled preference falls
through to the catalog walk rather than producing an entry every call would
refuse.

On Windows the same field is `%ComSpec%`, which names the command interpreter
rather than a preference: every Windows host reports `cmd.exe`. Preferring it
would contradict the shell the harness's own Windows executor resolves
(PowerShell) and would silently downgrade an existing deployment to cmd, so there
catalog order is the preference order and PowerShell leads it.

An explicit `executable` under `auto` names its own dialect — a user with
`/opt/custom/bash` means bash, not whichever row happens to lead the catalog.
Without that rule, `auto` plus an override would pair the override with the wrong
argument dialect.

## The catalog

[`src/catalog.ts`](../src/catalog.ts) is a pure function of `(platform,
environment)`. Both platforms can be asked about from either machine, which is
what lets a simulated Windows composition run on a POSIX host and the other way
round.

`names` is an entry's identity: the program names that mean *this* shell. It is
what the identity guard uses to refuse a configured executable that names a
different entry, so an override given for one shell can never be paired with
another shell's launch arguments. An entry may also carry an `accept` guard for a
program of the right family but the wrong kind — Git for Windows' GUI launcher.

`confineable` states only what has been measured. The Windows ACL restricted-token
runner cannot start an MSYS2 shell or a WSL instance, so those two entries carry a
refusal reason and are refused under `workspace-write` and `read-only`, including
for the panel's version probe. Everywhere else confinement wraps argv and the
shell binary is not a factor, so entries default to confineable; the POSIX rows
are the harness's documented wrapper behavior rather than a measurement taken
here, and [`VERIFIED_CONFINEMENT_PLATFORMS`](../src/catalog.ts) says so.

## Dialects

[`src/dialects.ts`](../src/dialects.ts) turns one command text into one argv. A
dialect is chosen by what the shell IS, not by the platform it runs on: `bash` on
Linux and `bash.exe` from Git for Windows take the same flags.

Every dialect receives the command as ONE argv element or one environment value,
so no argument needs a second round of quoting. The `cmd.exe` case is the one
exception, and it is deliberate: cmd re-parses its raw command line with its own
rules and does not understand the `\"` escaping the subprocess seam applies to an
argv element containing whitespace, so the command travels in
`DSH_SHELL_SELECT_COMMAND` and cmd expands `%DSH_SHELL_SELECT_COMMAND%` after
tokenizing. Quotes, redirection, `&` and `|` then reach cmd's parser intact. The
cost is that cmd substitutes once and does not rescan, so a `%NAME%` in the
command stays literal unless the model writes `call` — the model-facing
description says so.

## Configuration

The configuration model lives in [`src/config.ts`](../src/config.ts); the form is
derived from it in [`src/config-template.ts`](../src/config-template.ts). Both
read the same defaults, so the form can never offer a value the executor would
interpret differently — the suites assert that field by field.

Every refusal names its field: an unknown shell lists the alternatives, a budget
that is not a positive finite number is named, a timeout ceiling below the
default is refused rather than silently clamping every call.

The persisted document is `<profile>/config/dsh-shell-select/config.json`,
written by dsh-loader with a revision. The plugin subscribes to the handle and
re-resolves its cached selection on every change, so the next model step sees the
new description.

## Status facts and the self-test

[`src/status.ts`](../src/status.ts) keeps three facts apart, because collapsing
them is how a settings panel ends up claiming safety it has not observed:

- `available` — the executable resolves at all;
- `confineable` — what the catalog expects the sandbox to be able to do with it on
  this platform, which is a claim, not a measurement;
- `confinement.observed` — what this machine actually did when the plugin asked
  the sandbox to run it.

The probes run fixed, plugin-owned argv under the deployment's own confinement.
A row whose mode cannot confine it is reported as not probed rather than started
unconfined: a configurable executable path must not become an unrestricted
execution channel merely because the arguments are fixed.

The self-test runs one module constant (`echo DSH-SHELL-SELECT-TEST-OK`) through
the normal decide/execute path in the deployment's workspace root, so it reports
the same refusal a model call would get. The operation carries no input, so the
route that triggers it cannot be turned into a command channel.

## Execution routes covered and not covered

Covered, because they go through `ctx.shell`:

- the `shell` tool, foreground and background;
- hook commands from the Claude Code and Codex integrations;
- the tmux context probe;
- the panel's probes and self-test.

Not covered, and deliberately: `dsh-tool-bash-persistent`, which the `minimal`
preset mounts for its own persistent-shell realm. It claims the `bash` name, so
the guard denies it wherever it is registered; a preset that wants its own
persistent shell over this plugin is a composition this plugin refuses rather
than silently bypasses.
