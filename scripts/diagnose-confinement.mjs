/**
 * Diagnostic: spawn one argv through the harness's own confinement, outside the
 * plugin, and print exactly what came back.
 *
 * This exists because a probe that answers "exited with code 1" with an empty
 * stderr cannot distinguish three different problems: the runner failed, the
 * wrapped program failed, or the argv was built wrong. The script mounts only the
 * sandbox provider and the policy service, confines one argv, spawns it with the
 * subprocess seam, and prints the exit facts plus both streams.
 *
 * Usage:
 *   node scripts/diagnose-confinement.mjs [mode]
 * where mode is `workspace-write` (default) or `danger-full-access`.
 */

import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const bin = process.argv[2] === '--anchor'
  ? process.argv[3]
  : process.env.DSH_SHELL_SELECT_HOST_ANCHOR
    ?? 'C:/Users/Administrator/AppData/Roaming/in.dsh-plug.dsh-launcher/versions/0.2.2-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const mode = process.argv[4] ?? 'workspace-write'
const require = createRequire(realpathSync(bin))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const [cordis, sandboxLocal, policyModule, subprocessLocal] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/dsh-sandbox-local'),
  load('@deepseek-ai/dsh-sandbox-policy'),
  load('@deepseek-ai/dsh-subprocess-local'),
])

const ctx = new cordis.Context()
// SandboxPolicyService injects sessionProjections; the diagnostic needs none
// of its behavior, only the service to exist so the policy activates.
await ctx.plugin({ name: 'stub-session-projections', apply: context => context.provide('sessionProjections', { register: () => () => {} }) })
await ctx.plugin(policyModule.SandboxPolicyService, {
  mode,
  workspaceRoot: process.cwd(),
})
await ctx.plugin(subprocessLocal.LocalSubprocessRuntime, {})
await ctx.plugin(sandboxLocal.LocalSandboxProvider, {})

const argv = process.argv[2] === '--argv'
  ? JSON.parse(process.argv[5])
  : [process.env.ComSpec ?? 'cmd.exe', '/d', '/q', '/c', 'echo hello']

console.log('argv      :', JSON.stringify(argv))
console.log('mode      :', ctx.sandboxPolicy.resolve().mode)
console.log('workspace :', ctx.sandboxPolicy.resolve().workspaceRoot)

const policy = ctx.sandboxPolicy.resolve()
const confined = await ctx.sandbox.confine(argv, policy)
console.log('confined  :', JSON.stringify(confined.argv))
console.log('enforce   :', confined.enforcement)

const handle = ctx.subprocess.spawn({
  argv: confined.argv,
  cwd: process.cwd(),
  stdio: {
    stdin: 'ignore',
    stdout: { maxBytes: 64 * 1024 },
    stderr: { maxBytes: 64 * 1024 },
  },
  graceMs: 3000,
})
const outcome = await handle.done
const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
console.log('outcome   :', JSON.stringify(outcome))
console.log('stdout    :', JSON.stringify(stdout))
console.log('stderr    :', JSON.stringify(stderr))
await ctx.fiber?.dispose?.()
