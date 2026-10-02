# Main process in TypeScript without a build step (wave 3)

Decided 2026-09-29 after probing this machine (Node 22.13 locally, Node 24.21 inside Electron 44.4.5,
TypeScript 7.0.2). The goal of the whole refactor is an app that improves itself on the fly, so the main
process must stay runnable straight from the source tree: no transpile step, no generated `.cjs` that can go
stale. This file records the final layout of wave 3; `docs/SESSION-MODE.md` has the IPC contract itself.

## The layout

- **ES modules, `electron/**/*.mts`:** every pure-Node module (`runtime.mts`, `providers.mts`, `memory.mts`, …, all of
  `electron/runtime/`). Real `import`/`export`, type annotations, `strict` TypeScript.
- **CommonJS shell, JSDoc-typed:** `electron/main.cjs` (lifecycle, health reports, restarts and wiring),
  `electron/ipc-handlers.cjs` (main's own call channels; the others are forwarded to the runtime process),
  `electron/ipc-guard.cjs` (sender check, CSP), `electron/ipc-contract.cjs` (the one table of the IPC surface), the
  generated `electron/preload.cjs`, and since 2026-09-30 `electron/runtime-client.cjs` (main's handle on the runtime
  process) and `electron/fingerprint.cjs` (the code hashes of the restart levels; `scripts/self-upgrade.cjs` requires
  it too, and it loads only `node:` modules). They stay CommonJS because
  `tests/main-load.test.cjs` and `tests/ipc-contract.test.cjs` load `main.cjs` and `preload.cjs` against a stub of the
  `electron` module through `Module._load` / `require.cache`, which ESM cannot do; the sandboxed preload must be
  CommonJS anyway (Electron 44 renderers are sandboxed: the preload can `require` only Electron's own modules, so
  `scripts/gen-ipc-types.cjs` inlines the contract table into it); and `package.json` `"main"` stays
  `electron/main.cjs`. The shell files `require('./x.mts')` the ES modules (Node's `require(esm)`); no `.mts` module
  imports a `.cjs` file, so no CommonJS module sits inside an ESM cycle.
- **The shell as the restart levels count it** is `SHELL_FILES` of `electron/fingerprint.cjs`: those seven `.cjs`
  files, the ES modules main loads (`electron/git.mts`, `electron/process-table.mts`, `electron/runtime-protocol.mts`,
  `electron/skill-files.mts`, which import no other
  `electron/` module at run time) and `package.json`. In child mode main loads nothing else under `electron/`
  (`tests/main-load.test.cjs` enforces it); a change to any of them takes a full relaunch, a change anywhere else in
  `electron/` only a new runtime process. A module main starts to require is added to `SHELL_FILES` in the source.
- **The runtime process's entry, `electron/runtime-child.cjs`,** is CommonJS as well but not a shell file: main forks
  it with `utilityProcess` (tests with `child_process.fork`), it may enable the compile cache before any runtime
  module loads, reads `ORBIT_USER_DATA_DIR`, `ORBIT_REPO_ROOT` and `ORBIT_PARENT_PID` once and deletes them (so the
  processes the runtime starts do not inherit them; `--user-data` and `--repo-root` win over them), and `require`s
  `runtime-protocol.mts`, `provider-network.mts` and `runtime-host.mts`, which pulls in the rest of the runtime.
- **Renderer:** unchanged (`src/`, `tsconfig.json`, Vite).

## Mechanism: ESM `.mts` + Node type stripping

- Node strips the types at load time: on by default in Node 23.6+ (so inside Electron 44, where it prints no warning),
  behind `--experimental-strip-types` on Node 22.6–22.x (local Node and CI use 22), where
  `--disable-warning=ExperimentalWarning` silences the per-process `ExperimentalWarning: Type Stripping` notice.
- **Erasable syntax only.** No `enum`, no `namespace` with runtime code, no parameter properties
  (`constructor(public x)`), no `import x = require()`, no `export =`. `tsconfig.main.json` sets
  `erasableSyntaxOnly: true` and `tsc --noEmit` catches violations (verified: TS1294), and Node refuses them at
  load time (verified: `ERR_INVALID_TYPESCRIPT_SYNTAX`), so nothing can slip through.
- Verified end to end: a `.cjs` file can `require('../electron/x.mts')` (`require(esm)`, no top-level `await`
  allowed) under `node --experimental-strip-types` on 22.13, unflagged inside Electron's Node 24, and from inside
  `app.asar`.
- The `electron` module is CommonJS: in ESM import it as default, `import electron from 'electron'` and
  destructure (`const { app, BrowserWindow, ipcMain } = electron`). A named import fails at runtime
  (verified: "does not provide an export named 'app'").
- `__dirname`/`__filename` → `import.meta.dirname` / `import.meta.filename` (Node 20.11+); `main.cjs` keeps `__dirname`.
- `module.exports = { a, b }` → `export { a, b }`; a `_testing` bag is `export const _testing = { … }`.
- JSON: `import tiers from './model-tiers.json' with { type: 'json' }` (`failover.mts`, `providers.mts`).

## The shell: JSDoc under `// @ts-check`

`tsc -p tsconfig.main.json` checks every `.cjs` file under `electron/` (the shell and `runtime-child.cjs`) with
`allowJs` + `checkJs` and the same `strict` settings as the `.mts` modules. TypeScript (7.0, `module: NodeNext`) types
a `require('./x.mts')` in a `.cjs` file as the module's exports, so `const { OrbitRuntime } = require('./runtime.mts')`
is as typed as an import; types are referenced with
`/** @typedef {import('./runtime.mts').OrbitRuntime} OrbitRuntime */`.

- `ipc-contract.cjs`: `IpcArg` and `IpcEntry` describe a table row (`{ method, channel, args, returns, push? }`);
  `CALLS`, `EVENTS`, `ENTRIES` are `IpcEntry[]`.
- `ipc-handlers.cjs`: `createIpcHandlers(ctx: IpcContext): Map<string, IpcHandler>`. Since the runtime moved into its
  own process (2026-09-30), `IpcContext` lists what the shell needs: Electron's `dialog` and `shell`, the workspace
  helpers (`getGitContext`, `cloneGitWorkspace`), `relaunchApp`, `restartRuntime` (answers `RuntimeRestartResult`),
  `runtimeStatus`, `callRuntime(channel, args)` (the runtime client's `call`), the optional `whenStarted()` (settles
  once the start has its health report; `runtime:restart` waits for it, 60 s at most), `startedAt` and `isHealthy`. The
  handlers serve `SHELL_CHANNELS` and forward every channel of `RUNTIME_CHANNELS` (`runtime-protocol.mts`) through
  `callRuntime`; the old `app`, `OrbitRuntime`, `QuotaMonitor`, `Stores` and the cast to `ReadyStores` are gone, and the
  runtime's handlers live in `runtime-api.mts` with a `RuntimeStores` whose stores are never null (the service creates
  them before any call). `IpcHandler` takes `(event: IpcMainInvokeEvent, ...args: unknown[])`: the arguments are
  whatever the renderer sent, so each handler (or the runtime, for a forwarded channel) validates what it relies on.
  `GitContext` here is the main-process twin of the renderer's interface in `src/vite-env.d.ts`.
- `ipc-guard.cjs`: `IpcSenderEvent` is the structural minimum the guard reads (`sender.isDestroyed/getURL`,
  `senderFrame.url/parent`); Electron's `IpcMainInvokeEvent` satisfies it and the tests pass plain objects.
  `guardIpc` is generic and keeps the wrapped handler's signature.
- `main.cjs`: `HealthResult` (what one health report adds), `RuntimeHealth` (its `runtime` part), `Generation`
  (one start, runtime restart or renderer reload), `RestartSignal`, `CommandResult` (`{ ok, value }` of `runGit`/
  `runProcess`); `GitContext` and `RuntimeRestartResult` come from `ipc-handlers.cjs`, `RuntimeClient` and
  `RuntimeStatus` from `runtime-client.cjs`, `ApprovalRequestWire`, `RestartLevel` and `ShutdownMode` from
  `runtime-protocol.mts`. Deliberate escapes, each with zero effect at runtime: the losing single-instance branch keeps
  its top-level `return` (valid CommonJS, but TypeScript's grammar has no CommonJS exception, TS1108) behind one
  `// @ts-expect-error`; `restartSignal` reads Electron's `unknown` `additionalData` of `second-instance` through a cast
  to `{ relaunch?, restartRuntime?, reloadRenderer? }` of `unknown` values, checked with `=== true`; `isShuttingDown`
  reads the `code` of an `unknown` error through a cast to `{ code?: unknown } | null` (compared with
  `ERROR_CODES.shuttingDown` of `runtime-protocol.mts`); and `recordRunning` casts a spawn error to
  `NodeJS.ErrnoException` to read its `code` and a caught value to `Error` for its warning. Other error messages go
  through `errorMessage(error)` (`instanceof Error`) instead of casts.
- `runtime-client.cjs`: `RuntimeClient`, `RuntimeStatus` (with `retrying` and the optional `lastError`
  `RuntimeErrorInfo`; the renderer's `RuntimeStatus` in `src/types.ts` is its twin), `ChildHandle` (what the client
  needs of a process: `adaptUtilityProcess` makes one from Electron's `UtilityProcess`, `adaptChildProcess` from Node's
  `ChildProcess`, tests pass fakes), `ProcessRow` (a row of the process table the orphan check reads) and the message
  shapes imported from `runtime-protocol.mts` (`SpawnedProcess` among them). `runtime-child.cjs` types its channel to
  main as `Transport` over `process.parentPort` (utilityProcess) or `process.send` (fork). `fingerprint.cjs` is plain
  `node:` code; it also exports `RENDERER_INPUTS`, `rendererFiles` and `rendererHash`, which main uses for the
  `rendererHash` of its health reports and `scripts/self-upgrade.cjs` for the build record and the rollback base.
- `preload.cjs` is generated with `// @ts-check` and JSDoc (`CALLS` as `[method, channel, arity][]`, `orbit` as a
  record of functions, the typed `ipcRenderer` listener); `tests/ipc-contract.test.cjs` asserts the generator emits
  the directive and that the committed file equals the rendered one.
- The shell no longer refers to any store type: the stores are built in `runtime-host.mts`, and `runtime-api.mts`
  (`RuntimeStores`) is the one place to switch the handlers from the class types to the interfaces of `types.mts`.

## Why not `.cts` (CommonJS TypeScript)

Also runs under type stripping, but TypeScript does not read `module.exports = …` in `.cts` as the module's
exports, and the typed alternatives (`export =`, `import x = require()`) are not erasable. Module boundaries
would be `any`, which defeats the purpose. JSDoc in `.cjs` gives the same types without a new syntax.

## Why not a bundler (esbuild/tsup)

100 ms builds are cheap, but every run, test and self-upgrade would depend on generated files, and a stale
build is exactly the class of bug the owner already hit with `dist/`. Type stripping keeps one source of truth.

## Type checking

- `@types/node@22` is a dev dependency (the `electron` package ships its own types).
- Two configs: `tsconfig.json` (renderer, unchanged) and `tsconfig.main.json`: `include` is `electron/**/*.mts` and
  `electron/**/*.cjs`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `strict: true`,
  `allowImportingTsExtensions: true`, `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`, `noEmit: true`,
  `types: ["node"]`, `allowJs: true`, `checkJs: true`. `npm run typecheck` runs both
  (`tsc --noEmit && npm run typecheck:main`); the self-upgrade gate therefore covers the main process and the shell.
- Strictness is the rule for every file: a `.mts` file may carry `// @ts-nocheck` only while its conversion is in
  progress, and the wave report lists every such file. Interfaces for the stores (`memoryStore`, `capabilityStore`,
  `runStore`, `projectIndex`, `quota`) and for provider results live in `electron/types.mts` and replace the
  duck-typed dual code paths noted in the audit.

## Scripts

- `test`: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/*.test.cjs`;
  `smoke`: the same flags with `scripts/smoke-runtime.cjs`; `package:win`: `npm run build && node <flags>
  scripts/package-win.cjs`. Both flags are harmless on Node 24. The live checks are run the same way:
  `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/smoke-session-live.cjs [model] [effort]`.
- `smoke:desktop`, `start`, `dev`: run under Electron's Node through `scripts/run-electron.cjs`; no flags needed.
  `start` passes flags on (`npm start -- --restart-runtime` signals a running Orbit). The runtime process runs under
  Electron's Node as a utility process, which strips types by default; tests that fork `electron/runtime-child.cjs`
  on Node 22 pass the two flags as `execArgv` (`NODE_EXEC_ARGV` of `runtime-client.cjs`) with
  `serialization: 'advanced'`.
- `self-upgrade`, `self-upgrade:check`, `gen:ipc`, `clean:bundles`: unchanged commands. `scripts/self-upgrade.cjs`
  itself requires no `.mts` module (only `electron/fingerprint.cjs`, which loads `node:` modules); its child steps run
  `tsc --noEmit`, `tsc -p tsconfig.main.json`,
  `node --experimental-strip-types --disable-warning=ExperimentalWarning --test …` and the runtime smoke with the same flags.
  For `restart_orbit` the runtime starts the script with `ORBIT_NODE`, else `node` from `PATH`, else Electron's binary
  with `ELECTRON_RUN_AS_NODE=1`; main starts `--record-running` with `node`, else Electron's binary the same way.
- `build` is `tsc --noEmit && vite build && node scripts/self-upgrade.cjs --mark-build` (since 2026-09-30): the last
  step writes `dist/orbit-build.json` with the renderer hash the build was made from (no verification claimed), which
  the self-upgrade's build skip and main's health reports read.
- `scripts/smoke-fixtures.cjs` is not run directly: the runtime loads it through `ORBIT_RUNTIME_FIXTURES` (the child
  process, or the client in `inprocess` mode) to replace `runProvider`, `inspectProviders` and the quota readers for
  `smoke:desktop`; with `ORBIT_SMOKE=1` the runtime refuses to start without all three.
- `ORBIT_COMPILE_CACHE=1` (or a folder) turns on Node's module compile cache in the runtime process
  (`module.enableCompileCache`, before any runtime module loads). Off by default: measured on this machine, a warm cache
  saves about 0.1 s of a 0.3 s start, a cold one costs about 0.5 s at the exit that writes it and about 2 s at the next
  start, and on Node 22 it slows every start down.
- `scripts/check-type-equivalence.mjs` (see "Typing completed") compares the type-stripped code of the working copy
  with a revision.
- `gen:ipc` (`node scripts/gen-ipc-types.cjs`, `--check` to report only) rewrites `electron/preload.cjs` and the
  generated block of `src/vite-env.d.ts` from the contract; run it after editing `electron/ipc-contract.cjs`.
- CI (`.github/workflows/ci.yml`, Node 22): `npm run typecheck` (both configs, the `.cjs` shell included), `npm test`,
  `npm run build`, `npm run smoke`, `npm run self-upgrade:check`, `npm run clean:bundles`.
- Packaging: verified with `asar: true`. An electron-builder `--dir` build packs every `electron/**/*.mts` and `.cjs`
  into `app.asar` byte-identical to the source, and the packaged `Orbit.exe` started with `ORBIT_USER_DATA` in a temp
  profile writes a health file with `ok: true`. A packaged build runs the runtime inside main (`ORBIT_RUNTIME_MODE`
  defaults to `inprocess` when `app.isPackaged`): forking `electron/runtime-child.cjs` from inside `app.asar` with
  `utilityProcess` is not verified.

## Conversion record

`scripts/codemod-esm.cjs` did the mechanical part of the `.cjs` → `.mts` move (kept in the repository as
documentation); the reports of the wave list the hand fixes. Two consequences of ESM that changed code, not behaviour:

- A module namespace is read-only, so `scripts/smoke-desktop.cjs` can no longer assign `providers.runProvider = …`
  before loading `main.cjs`. `main.cjs` passes the providers module's `runProvider` into
  `new OrbitRuntime({ runProvider, … })` explicitly (it is the runtime's default anyway, so the identity check in
  `runtime/session.mts` still holds), and the smoke substitutes what `main.cjs` and `ipc-handlers.cjs` get from
  `require('./providers.mts')` through `Module._load`, the pattern the loading tests already use. `quota.readers` is
  a plain exported object and is still patched in place. (Since 2026-09-30 `runtime-host.mts` builds the runtime and
  passes `runProvider` the same way, `main.cjs` no longer loads `providers.mts`, and the smoke hands its fixtures to
  the runtime through `ORBIT_RUNTIME_FIXTURES` = `scripts/smoke-fixtures.cjs`; `patchQuotaReaders` there patches
  `quota.readers` in place before the quota monitor reads it.)
- Lazy `require()` calls became top-level imports, the ESM cycles `providers ⇄ codex-server` and `providers ⇄ quota`
  included: both sides use the other only inside functions, so live bindings make them harmless
  (`tests/runtime-modules.test.cjs` still forbids cycles inside `electron/runtime/`). The deliberate lazy loads:
  `provider-network.mts` does `await import('electron')` inside `systemProxy()`: outside Electron the package resolves
  to the binary's path and has no `session`, exactly as the old `require` did; since 2026-09-30 it first asks the
  resolver the runtime child installs (`setProxyResolver`: Electron's `session` exists only in main, so the child asks
  main), and the `import('electron')` path serves the `inprocess` mode. `runtime/session.mts` imports `mcp-server.mts`
  (MCP SDK, zod) with `await import()` on the first session; `runtime-client.cjs` requires `runtime-host.mts` only in
  `inprocess` mode, so a child-mode main never loads the runtime.

## Gate before the wave is accepted

`npm run verify` (typecheck of both configs, all tests, runtime smoke), `npm run build`, `npm run smoke:desktop`,
a start from the repo via `Orbit.cmd` with a temp profile (`ORBIT_USER_DATA`, `ORBIT_HEALTH_FILE`) and a health file
with `ok: true`, and `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/smoke-session-live.cjs haiku low`
(one small real-model check). Nothing else changes in this wave: no behaviour, no renames beyond extensions.

## Typing completed

No file under `electron/` carries `// @ts-nocheck` any more. The 18 files left at 0.4.0 (`runtime.mts`, twelve
modules of `electron/runtime/`, `mcp-server.mts`, `router.mts`, `runtime-tools.mts`, `tool-registry.mts`,
`tool-schema.mts`) pass `tsc -p tsconfig.main.json` under `strict`, and no `any` was added.

- `FileChange` (with `ChangeKind` and `ChangeSource`) and the saved-run shapes `StoredRun` and `StoredAgent` are
  declared once, in `electron/types.mts`; `change-log.mts` and `run-store.mts` import them and re-export them with
  `export type`. A live `RunSnapshot` is a `StoredRun`, so the two `any` casts of `ipc-handlers.cjs` are gone (those
  handlers have since moved to `runtime-api.mts`).
  `ChatRunView` (an earlier turn of the chat) is chat-memory's own `RunView`.
- `tsconfig.main.json` sets `verbatimModuleSyntax: true`. Node's type stripping removes only imports marked `type`,
  so a plain import of a name that exists only as a type passes `tsc` without the option and then fails when Node
  loads the module ("does not provide an export named …"); with it, `tsc` rejects that import (TS1484) and a type
  re-exported without `export type` (TS1205). Turning it on needed no code change, and the CommonJS shell files are
  unaffected.
- The typing changed no behaviour. For each changed file, the `HEAD` version and the working copy were stripped of
  their types with Node's own `module.stripTypeScriptTypes` (the code Node runs), parsed with oxc
  (`rolldown/parseAst`) and their syntax trees compared, ignoring positions, comments, redundant parentheses and the
  spelling of literals (`ipc-handlers.cjs` the same way, without the stripping). 18 of the 23 changed files are
  identical at run time. The other five contain rewrites TypeScript needed that give the same result for every value
  the code can meet: `+active(b) - +active(a)` on two booleans (`router.mts`); `id ? find() : undefined` in place of
  `id && find()` where the result is only read through `?.` or tested (`runtime/store.mts`, `runtime/mailbox.mts`);
  `clearTimeout(timer ?? undefined)`, as elsewhere in the tree (`runtime/turn.mts`; Node ignores `null` and
  `undefined` alike); the two inline status lists of `improvement_plan` moved into constants read through
  `util.oneOf`, which is `includes` (`runtime/tools.mts`). The script is `scripts/check-type-equivalence.mjs`
  (`--self-test` first checks it on known type-only and behaviour-changing pairs; `--base=<rev>` picks the revision to
  compare with, HEAD by default, so `--base=afdf490` repeats this check on a working copy of the typing snapshot
  `refs/orbit/snapshots/techdebt-typing`; the later changes of 2026-09-30 change behaviour on purpose).
- `tests/runtime-modules.test.cjs` strips the facade's types the same way before it checks that every method
  forwards its parameters unchanged, so `getRun(id: string)` is compared as `getRun(id)`.
