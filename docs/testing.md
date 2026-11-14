# Testing and verification

What the suites cover, what they do not, and which claims have actually been
exercised. Every claim here is either a command that can be re-run or a
measurement that is named as such.

## Running the suites

```sh
npm ci
npm run typecheck     # tsc --noEmit
npm run build         # tsc → lib/
npm test              # build + node --test tests/*.test.mjs
```

The suites import the **built output** under `lib/`, never `src/`, because that is
what a profile installs: a type-only check would not catch a wrong `exports` path
or a stale build.

### The scratch-root rule

Every disposable fixture lives under an approved scratch root:
`<project>/.test-tmp/` by default, or `DSH_SHELL_SELECT_TEST_TMP` when the project
itself sits inside the real user profile (a CI runner, a clone in `$HOME`). A
fixture root inside a user profile is refused before anything is created, and
`removeFixture()` refuses to delete anything outside the root it validated.
Containment is decided on canonical paths, so a symlinked `$HOME` cannot pass a
lexical check.

On CI the variable is therefore set on the test step, to `D:\a\_temp\…` on Windows
and to `/var/tmp/dsh-shell-select` on Linux. `/tmp` is deliberately not used on
Linux: the POSIX `workspace-write` profile grants `/tmp` writable, so a fixture
there could not show that a write outside the workspace is denied.

## What each suite covers

| Suite | Covers |
|---|---|
| `catalog.test.mjs` | Both platforms' catalogs, entry identity, the `auto` value not being an id, program-name extraction for either separator, the identity guard against a sibling shell's program, the entry-specific acceptance guard, the confinement verdicts per mode, and probe selection |
| `dialects.test.mjs` | Whole-argv assertions per dialect: the command as one argv element, the login flag placement, the PowerShell UTF-8 preamble riding on one line, the cmd environment transport, WSL mount translation and the distro flag, version queries, and the fixed self-test command |
| `discovery.test.mjs` | Resolution through the seam, a configured path failing **by name** with no fallback, an override that names another shell, the failure naming every probed location, a candidate skipped on a failed identity check, the per-row override rule, and the working-directory rule (shape everywhere, existence only for this host's platform) |
| `executor.test.mjs` | The decision: zero spawn requests for every refusal, argv per dialect, the decision carried forward so a later change cannot alter a decided call, `auto` resolution on both platforms including the `%ComSpec%` rule and the override names its dialect, the model-facing description in each state, and the status/self-test surfaces including a refused probe and an unconfined probe only under `danger-full-access` |
| `tool.test.mjs` | The tool registration: exactly one `shell` tool, the description getter re-reading the live selection, `run_in_background` advertised only when allowed, the prompt section, both call presentations, a foreground run reporting the decision's own facts, a background run registering one job, a refused selection never reaching the job registry, and argument validation |
| `config.test.mjs` | The configuration model's defaults and every refusal naming its field, the per-call snapshot, and the form: template identity, the exact persisted field list, **every default equal to the runtime model**, the shell options, and both panels' operations |
| `status.test.mjs` | The three facts staying apart, a non-zero probe exit reported as a failure rather than a version, an interpreter probe, a refusal distinguished from "did not run", the payload's rows and automatic resolutions, and the self-test's two failure stages with their rendering |
| `package.test.mjs` | The package contract: name equals `export const name`, a stable `X.Y.Z`, `dsh.bundle.patch` pointing at a file that exists, no client bundle, the patch disabling both platform families and mounting itself, entry points, shipped files, both locale dictionaries, the icon's format and size limit, `engines.dsh` admitting prereleases of the target release and refusing older lines, and no `@deepseek-ai/*` runtime dependency |

Counts on the development host: **145 tests, 145 passing, 0 skipped**.

## What the suites deliberately do not do

- **No real process is spawned by the unit suites.** Every execution assertion
  goes through a scripted subprocess seam and a scripted sandbox provider, which
  is what makes the Windows-only refusal paths drivable on this host. Real
  execution is exercised by the end-to-end instance below.
- **No copy of the harness's own executor logic.** The background job adapter in
  `src/tool.ts` is written against `JobHooks`/`JobOutputSource`, not copied from
  `dsh-tool-bash`.
- **No assertion about the harness's own dispatch.** That the tool registry
  routes a call, or that the config page renders a field, is the harness's test
  surface; this package asserts what it registers.

## End-to-end verification

The plugin was verified in an isolated DSH 0.2.2 instance rather than in the
running one: `.test/shell-select/home` is its own `DSH_HOME`, with its own
profile, its own configuration document, and its own port. Environment: Windows
10.0.26200, Node v24.18.0, dsh `0.2.2-rc.2`, dsh-loader `2.0.0`, plugin `1.0.0`.

What was confirmed there, because only a real host can answer it:

1. **the startup log carries no plugin-load failure** — only dsh-loader's own
   three lines and the `dsh web:` line;
2. **the configuration template registers** with its 11 fields and both panels;
3. **`ctx.shell` is `ShellSelectExecutor`**, and the visible tool set contains
   exactly one shell tool, `shell`; `bash` and `pwsh` are absent and the guard
   answers a denial naming `shell` for each;
4. **the tool body reaches a real process**: a foreground call returned
   `FIXTURE-FOREGROUND-OK` with the decision's shell, executable, and working
   directory; a background call returned job id `shell-8e08aa82bee94e87`,
   settled `completed`, and its output was readable; an invalid `timeoutMs` was
   refused before any process existed;
5. **the facts panel reports the machine's own answers**: Windows PowerShell
   5.1 `5.1.26100.9711`, `cmd` `10.0.26200.9711`, Git Bash
   `5.3.15(1)-release`, and `pwsh` reported as not installed because it is not;
6. **the self-test follows the selection**: `auto → powershell`, then `cmd`,
   then `gitbash` — each `exit 0` with the matching executable — and switching
   the saved selection drove the next call to the new shell;
7. **`auto` resolves to what the harness itself runs**: Windows PowerShell 5.1,
   not `%ComSpec%`.

The full record, including the raw JSON evidence and the exact reproduction
commands, is in [`.test/shell-select/README.md`](../../.test/shell-select/README.md).

### Why that instance ran unconfined

The harness's own Windows ACL confinement cannot start a process on this host,
independently of this plugin. `scripts/diagnose-confinement.mjs` mounts only the
harness's `sandbox-policy`, `sandbox-local`, and `subprocess-local`, hands
`cmd /c echo hello` to `ctx.sandbox.confine`, receives the correct runner prefix,
and the process never returns. Under the shipped `workspace-write` default every
command — version probes included — would therefore fail for an environment
reason, and the plugin's own behavior could not be observed.

So the verification instance used a `--patch` overlay that makes the deployment
`danger-full-access`, and the confinement **refusals** are covered by the unit
suites instead, which drive them through a scripted sandbox provider and assert
zero spawn requests. Removing `--patch` and restarting shows the shipped default.

## Platform status

| Platform | Unit suites | End-to-end |
|---|---|---|
| Windows (primary) | run and passing on the development host | run and recorded in `.test/shell-select` |
| Linux | not exercised in this change | not exercised |
| macOS | not exercised | not exercised |

CI runs the quality matrix on `ubuntu-latest`, `windows-latest`, and
`macos-latest`; check the latest run rather than trusting this table.

## Known limitations

- **`wsl.exe` writes UTF-16 diagnostics.** With no distribution installed, `wsl`
  reports its «run `wsl.exe --install`» message as UTF-16LE, which the collector
  decodes as UTF-8 and shows as mojibake. The argv is correct — wsl's own message
  arrives — but its wording is not readable in the result. Not fixed here because
  decoding is the subprocess seam's contract, not this plugin's.
- **Probes are Windows-verified only.** The `confineable` claims for POSIX
  entries follow the harness's documented wrapper behavior rather than a
  measurement taken by this plugin; `VERIFIED_CONFINEMENT_PLATFORMS` says so, and
  the panel prints the per-platform flag differently.
- **`dsh-loader`'s `registry.tools.list()` reports unnamed entries on this
  release.** Its values are `{ definition, when }`, so the facade reads the wrong
  field. This plugin does not use that facade; the test fixture records the
  difference beside the real names so it is not mistaken for a plugin fault.
