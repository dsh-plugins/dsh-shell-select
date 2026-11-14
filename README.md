<div align="center">

<img src="icon.svg" alt="Shell selection" width="96" height="96">

# Shell selection

**Choose the shell every agent command runs in, and see what the machine actually resolved.**

[English](README.md) · [简体中文](README.zh_CN.md)

[![npm](https://img.shields.io/npm/v/@dsh-plugin/dsh-shell-select.svg)](https://www.npmjs.com/package/@dsh-plugin/dsh-shell-select)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.2-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)

</div>

PowerShell, Windows PowerShell, `cmd.exe`, Git Bash, WSL Bash, `bash`, `zsh`,
`fish`, or the system `sh`: you pick one, it is stored as a plugin setting, and
every agent command uses it.

The selection belongs to the deployment, not to the model. Agents get a single
`shell` tool and cannot choose a different shell for one command, and a shell the
current permission mode cannot confine is refused rather than run outside the
sandbox.

## Features

| Capability | What it does |
|---|---|
| One shell per deployment | The selector becomes `ctx.shell`, so the `shell` tool, hook commands, and the harness's own probes all run through it. The shipped `bash` and `pwsh` tools are denied with a reason naming `shell`. |
| Discovery, with an override | Shells are found by name through the harness's own executable resolution. Set `executable` when a shell lives somewhere unusual, or when two installs exist. A path that cannot be resolved, or that names a different shell, is an error — never a cue to search anyway. |
| Fail-closed sandbox | When the selected shell cannot be confined under the session's permission mode, the call is refused **before any process exists**. No silent fallback, no silent drop of the sandbox. |
| Facts, not claims | The panel reports three separate things: whether the executable resolves, what the catalog expects the sandbox to be able to do with it, and what this machine was observed doing. |
| A fixed self-test | One button runs one fixed command through the saved selection, under the same confinement a model call gets, in the deployment's workspace root. |
| The model is told what the shell needs | Each shell carries its own syntax notes (PowerShell paths, `cmd` variable expansion, WSL's `/mnt/...` paths, fish's non-POSIX syntax), re-read on every model step. |
| No execution machinery of its own | Deadlines, output limits, background jobs, and confinement come from the harness unchanged. |

## Quick start

```sh
dsh plugin --profile web add "@dsh-plugin/dsh-shell-select"
dsh web
```

Then open **Settings → Plugins → Shell selection**:

1. Pick a shell. **Automatic** (the default) resolves from the platform and the
   `executable` override; the **Shell facts** panel says which shell that is.
2. Press **Save**.
3. Press **Test shell** in the *Test the selection* panel to run one fixed
   command through the saved selection.

**The self-test runs the saved selection, not the edits staged in the form.** If
it reports a refusal, that refusal is what a command would get right now.

### Installing from a checkout

```sh
git clone https://github.com/dsh-plugins/dsh-shell-select
cd dsh-shell-select && npm install && npm run build
dsh plugin --profile web add link:/absolute/path/to/dsh-shell-select
```

A `link:` install keeps the checkout live, so editing the plugin and restarting
the profile is enough to see a change. The plugin installs into a profile that
already provides the harness, because it resolves the harness packages from the
running installation instead of carrying a second copy of them.

## Supported shells and compatibility

| Platform | Catalog entries | Confinement verified here |
|---|---|---|
| Windows (primary) | `pwsh`, `powershell 5.1`, `cmd`, `gitbash`, `wsl` | `cmd.exe` and PowerShell 5.1, yes |
| Linux | `bash`, `zsh`, `fish`, `sh`, `pwsh` | the POSIX rows follow the harness's documented wrapper behavior, not a measurement taken by this plugin |
| macOS | `bash`, `zsh`, `fish`, `sh`, `pwsh` | not exercised |

**On Windows, Git Bash and WSL Bash cannot start under the restricted token the
sandbox uses**, so they are refused under `workspace-write` and `read-only`,
including for the panel's version probe; they run only under
`danger-full-access`. That refusal is deliberate: the alternative would be running
a shell the sandbox cannot confine.

`engines.dsh` is `>=0.2.2-0`: the plugin needs the 0.2.2 shell seam
(`resolve`/`execute`) and the config-api settings page. CI runs the suites on
Windows, Linux, and macOS; the platform column above states what this plugin has
measured itself rather than what the harness documents.

## Configuration

The plugin's settings live in `<profile>/config/dsh-shell-select/config.json`,
written by dsh-loader and edited from the plugin page.

| Setting | Default | Meaning |
|---|---|---|
| `shell` | `auto` | A catalog id, or `auto`. |
| `executable` | empty | Explicit path for the selected shell. Wins over discovery. A path that cannot be resolved, or that names a *different* shell, is an error rather than a cue to search. |
| `loginShell` | `false` | Run a bash-family shell with `-l`, which sources your profile scripts on every command. |
| `wslDistro` | empty | WSL distribution name; empty uses the distribution's default. |
| `wslMountRoot` | `/mnt` | Where the distribution mounts Windows drives. |
| `enableRunInBackground` | `true` | Offer `run_in_background` on the `shell` tool. |
| `timeoutMs` | `120000` | Default foreground timeout. |
| `maxTimeoutMs` | `600000` | Upper bound for a per-call timeout override. |
| `maxOutputBytes` | `64000` | Per-stream in-memory output cap. |
| `maxSpillBytes` | `67108864` | Per-stream spill-file cap. |
| `graceMs` | `3000` | SIGTERM→SIGKILL grace period. |

**Automatic** is the default because it reproduces what the deployment already
does: the first catalog entry that resolves, which on Windows is PowerShell (what
the harness's own executor runs) and on Linux follows a `$SHELL` that names a
catalog entry. An explicit `executable` override changes the answer, because an
override naming a shell claims that shell: setting `executable` to a `bash.exe`
path while `shell` is `auto` runs that bash, with bash's arguments.

A setting change applies to subsequent calls. It never alters a call that is
already being prepared, a running process, or the facts a finished call recorded.

## Upgrading from `dsh-shell-select` 0.1.x

The package was renamed to `@dsh-plugin/dsh-shell-select`, rewritten in
TypeScript, and retargeted at dsh ≥ 0.2.2. **Settings do not migrate
automatically**: dsh 0.2.2 removed the per-namespace settings contract the old
version used, so the selection is re-entered once in the new form. Everything
else — the single `shell` tool, the `bash`/`pwsh` denial, the `auto` rules, every
dialect — keeps its semantics. The full list of breaking changes is in
[migration.md](docs/migration.md).

## Troubleshooting and limitations

**No `<shell>` executable found.** The plugin looked for the shell by name and
found nothing. Install it, or set `executable` to its full path. The error lists
every location that was probed.

**Refused under the current permission mode.** The selected shell cannot be
confined by the sandbox the session resolved. On Windows this is expected for Git
Bash and WSL Bash under `workspace-write` and `read-only`. The refusal names the
shell and the mode; pick a shell the mode can confine, or switch the session to
`danger-full-access` deliberately.

**Automatic shows *unknown*.** The host has not resolved the `executable`
override yet, or the override names nothing installed. Automatic is resolved for
its own configurations, which is a different question from what the saved
selection runs.

**A warning says the selection probe did not settle.** Activation waits at most
`SELECTION_DEADLINE_MS` (5 s) for the first resolution and then continues without
it, so the plugin still mounts and the `shell` tool still resolves a shell for
each call. The warning points at the host's `subprocess` seam, not at the
selection: until that seam answers, the description reports the selection as
*pending* and the status panel's **Refresh status** retries the same resolution
on demand.

**The plugin does not load, and the message names anchors.** `src/host.ts` could
not find a harness ≥ 0.2.2 to bind to. The message lists every anchor that was
tried; set `DSH_SHELL_SELECT_HOST_ANCHOR` to the absolute path of the running
`dsh` entry (usually `<dsh>/lib/bin.js`) to point it at the right one.

**`cmd` quirks.** The command reaches `cmd.exe` in one pass, so a `%NAME%` in your
command stays literal; write `call echo %CD%` when you need expansion. Non-ASCII
output depends on the console code page. Unicode paths and filenames are
unaffected.

**`wsl.exe` diagnostics arrive garbled.** With no distribution installed, `wsl`
writes its "run `wsl.exe --install`" message as UTF-16LE, which the output
collector decodes as UTF-8 and shows as mojibake. The command itself ran and its
exit code is reported; only the wording is unreadable. Decoding belongs to the
subprocess seam, so this plugin does not re-encode it.

**Routes the selector does not control.** Agent commands go through the selected
shell, but `run_code` program bodies, PTY-based terminal tools, and out-of-process
subagents spawn their own processes. The full list, with reasons, is in
[architecture.md](docs/architecture.md#execution-routes-covered-and-not-covered).

Shell selection is not destructive-command protection. The sandbox restricts
write-class access according to the session's permission mode; this plugin adds
no destructive-command detection and is not a safety layer.

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

Tests create their fixtures under `<projectRoot>/.test-tmp/<unique-id>/`. They
refuse a root inside the real user profile, so a checkout that lives inside the
profile (a clone in `$HOME`, a CI runner) must name an approved root outside it:

```sh
# Linux, macOS, or Git Bash — /var/tmp, never /tmp: the POSIX profile grants /tmp
DSH_SHELL_SELECT_TEST_TMP=/var/tmp/dsh-shell-select npm test
```

```powershell
# Windows: name a path outside the profile, since %TEMP% is inside it
$env:DSH_SHELL_SELECT_TEST_TMP = 'D:\dsh-shell-select-test-tmp'
npm test
```

See [architecture.md](docs/architecture.md) for how a call is decided and why the
harness packages are resolved at runtime rather than declared as dependencies.

The suites live in `tests/` and run against the built output under `lib/`, which
is what a profile installs:

| Suite | Covers |
|---|---|
| `catalog` | Both platforms' catalogs, entry identity, the identity guard, the confinement verdicts, candidate enumeration, and probe selection |
| `dialects` | Whole-argv assertions per dialect, the `cmd` environment transport, WSL mount translation, and version queries |
| `discovery` | Resolution through the seam, a configured path failing by name, and the working-directory rule |
| `executor` | The decision and its refusals (zero spawns), `auto` on both platforms, the model-facing description, and the status surfaces |
| `tool` | One `shell` tool, the `bash`/`pwsh` guard, both call presentations, and the background job path |
| `config` | The configuration model's defaults and refusals, and the form derived from it |
| `status` | The three facts staying apart, and the self-test's failure stages |
| `activation` | That a stalled or failing selection probe can never hold activation (and therefore the host's boot), and that its timeout is reported instead of thrown |
| `package` | The package contract: entry points, shipped files, locale, icon, and `engines.dsh` |

## License

[MIT](LICENSE), copyright 2026 Muhammad Athif Humam.
