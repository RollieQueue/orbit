# Main process in TypeScript without a build step (wave 3)

Decided 2026-09-29 after probing this machine (Node 22.13 locally, Node 24.21 inside Electron 44.4.5,
TypeScript 7.0.2). The goal of the whole refactor is an app that improves itself on the fly, so the main
process must stay runnable straight from the source tree: no transpile step, no generated `.cjs` that can go
stale. This file records the final layout of wave 3; `docs/SESSION-MODE.md` has the IPC contract itself.

## The layout

- **ES modules, `electron/**/*.mts`:** every pure-Node module (`runtime.mts`, `providers.mts`, `memory.mts`, …, all of
  `electron/runtime/`). Real `import`/`export`, type annotations, `strict` TypeScript.
- **CommonJS shell, five files, JSDoc-typed:** `electron/main.cjs` (lifecycle and wiring), `electron/ipc-handlers.cjs`
  (one handler per call channel), `electron/ipc-guard.cjs` (sender check, CSP), `electron/ipc-contract.cjs` (the one
  table of the IPC surface) and the generated `electron/preload.cjs`. They stay CommonJS because
  `tests/main-load.test.cjs` and `tests/ipc-contract.test.cjs` load `main.cjs` and `preload.cjs` against a stub of the
  `electron` module through `Module._load` / `require.cache`, which ESM cannot do; the sandboxed preload must be
  CommonJS anyway (Electron 44 renderers are sandboxed: the preload can `require` only Electron's own modules, so
  `scripts/gen-ipc-types.cjs` inlines the contract table into it); and `package.json` `"main"` stays
  `electron/main.cjs`. The shell files `require('./x.mts')` the ES modules (Node's `require(esm)`); no `.mts` module
  imports a shell file, so no CommonJS module sits inside an ESM cycle.
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

`tsc -p tsconfig.main.json` checks the five `.cjs` files with `allowJs` + `checkJs` and the same `strict` settings
as the `.mts` modules. TypeScript (7.0, `module: NodeNext`) types a `require('./x.mts')` in a `.cjs` file as the
module's exports, so `const { OrbitRuntime } = require('./runtime.mts')` is as typed as an import; types are
referenced with `/** @typedef {import('./runtime.mts').OrbitRuntime} OrbitRuntime */`.

- `ipc-contract.cjs`: `IpcArg` and `IpcEntry` describe a table row (`{ method, channel, args, returns, push? }`);
  `CALLS`, `EVENTS`, `ENTRIES` are `IpcEntry[]`.
- `ipc-handlers.cjs`: `createIpcHandlers(ctx: IpcContext): Map<string, IpcHandler>`. `IpcContext` lists what
  `main.cjs` passes (Electron's `app`/`dialog`/`shell`, the `OrbitRuntime`, the `QuotaMonitor`, `Stores`, the
  workspace helpers, `relaunchApp`, `startedAt`, `isHealthy`). `Stores` has every store nullable (they exist only
  after `app.whenReady`); the handlers read `ctx.stores` at call time through one cast to `ReadyStores`, because a
  window (and so a call) exists only after the stores do. `IpcHandler` takes `(event: IpcMainInvokeEvent, ...args:
  any[])`: the arguments are whatever the renderer sent, so each handler validates what it relies on, as before.
  `GitContext` here is the main-process twin of the renderer's interface in `src/vite-env.d.ts`.
- `ipc-guard.cjs`: `IpcSenderEvent` is the structural minimum the guard reads (`sender.isDestroyed/getURL`,
  `senderFrame.url/parent`); Electron's `IpcMainInvokeEvent` satisfies it and the tests pass plain objects.
  `guardIpc` is generic and keeps the wrapped handler's signature.
- `main.cjs`: `HealthResult` (what one health report adds), `CommandResult` (`{ ok, value }` of `runGit`/
  `runProcess`), `ApprovalRequest` (what `runtime/tools.mts` hands `requestApproval`), `Stores`/`GitContext`
  imported from `ipc-handlers.cjs`. Three deliberate escapes, each with zero effect at runtime: the losing
  single-instance branch keeps its top-level `return` (valid CommonJS, but TypeScript's grammar has no CommonJS
  exception, TS1108) behind one `// @ts-expect-error`; Electron types `additionalData` of `second-instance` as
  `unknown`, so the call to `isRelaunchSignal` casts it to `{ relaunch?: boolean } | undefined`; and the three
  `catch (error)` messages cast `error` to `Error` (`strict` makes catch variables `unknown`).
- `preload.cjs` is generated with `// @ts-check` and JSDoc (`CALLS` as `[method, channel, arity][]`, `orbit` as a
  record of functions, the typed `ipcRenderer` listener); `tests/ipc-contract.test.cjs` asserts the generator emits
  the directive and that the committed file equals the rendered one.
- Once `electron/types.mts` carries the store interfaces (`MemoryStore`, `CapabilityStore`, `RunStore`, …), the
  `@typedef` lines at the top of `ipc-handlers.cjs` are the one place to switch the shell from the class types to
  those interfaces.

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
  `allowImportingTsExtensions: true`, `erasableSyntaxOnly: true`, `noEmit: true`, `types: ["node"]`, `allowJs: true`,
  `checkJs: true`. `npm run typecheck` runs both (`tsc --noEmit && npm run typecheck:main`); the self-upgrade gate
  therefore covers the main process and the shell.
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
- `self-upgrade`, `self-upgrade:check`, `gen:ipc`, `clean:bundles`: unchanged commands. `scripts/self-upgrade.cjs`
  itself requires no `.mts` module; its child steps run `tsc --noEmit`, `tsc -p tsconfig.main.json`,
  `node --experimental-strip-types --disable-warning=ExperimentalWarning --test …` and the runtime smoke with the same flags.
- `gen:ipc` (`node scripts/gen-ipc-types.cjs`, `--check` to report only) rewrites `electron/preload.cjs` and the
  generated block of `src/vite-env.d.ts` from the contract; run it after editing `electron/ipc-contract.cjs`.
- CI (`.github/workflows/ci.yml`, Node 22): `npm run typecheck` (both configs, the `.cjs` shell included), `npm test`,
  `npm run build`, `npm run smoke`, `npm run self-upgrade:check`, `npm run clean:bundles`.
- Packaging: verified with `asar: true`. An electron-builder `--dir` build packs every `electron/**/*.mts` and `.cjs`
  into `app.asar` byte-identical to the source, and the packaged `Orbit.exe` started with `ORBIT_USER_DATA` in a temp
  profile writes a health file with `ok: true`.

## Conversion record

`scripts/codemod-esm.cjs` did the mechanical part of the `.cjs` → `.mts` move (kept in the repository as
documentation); the reports of the wave list the hand fixes. Two consequences of ESM that changed code, not behaviour:

- A module namespace is read-only, so `scripts/smoke-desktop.cjs` can no longer assign `providers.runProvider = …`
  before loading `main.cjs`. `main.cjs` passes the providers module's `runProvider` into
  `new OrbitRuntime({ runProvider, … })` explicitly (it is the runtime's default anyway, so the identity check in
  `runtime/session.mts` still holds), and the smoke substitutes what `main.cjs` and `ipc-handlers.cjs` get from
  `require('./providers.mts')` through `Module._load`, the pattern the loading tests already use. `quota.readers` is
  a plain exported object and is still patched in place.
- Lazy `require()` calls became top-level imports, the ESM cycles `providers ⇄ codex-server` and `providers ⇄ quota`
  included: both sides use the other only inside functions, so live bindings make them harmless
  (`tests/runtime-modules.test.cjs` still forbids cycles inside `electron/runtime/`). The one deliberate lazy load is
  `provider-network.mts`, which does `await import('electron')` inside `systemProxy()`: outside Electron the package
  resolves to the binary's path and has no `session`, exactly as the old `require` did.

## Gate before the wave is accepted

`npm run verify` (typecheck of both configs, all tests, runtime smoke), `npm run build`, `npm run smoke:desktop`,
a start from the repo via `Orbit.cmd` with a temp profile (`ORBIT_USER_DATA`, `ORBIT_HEALTH_FILE`) and a health file
with `ok: true`, and `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/smoke-session-live.cjs haiku low`
(one small real-model check). Nothing else changes in this wave: no behaviour, no renames beyond extensions.

## Remaining work (state at 0.4.0)

The typing wave was interrupted before the runtime side was finished. These files still start with `// @ts-nocheck`
(their annotations are kept; the file-level flag only silences errors until each is completed): `electron/mcp-server.mts`, `electron/router.mts`, `electron/runtime-tools.mts`, `electron/runtime.mts`, `electron/tool-registry.mts`, `electron/tool-schema.mts`, `electron/runtime/agents.mts`, `electron/runtime/changes.mts`, `electron/runtime/handover.mts`, `electron/runtime/knowledge.mts`, `electron/runtime/lifecycle.mts`, `electron/runtime/loops.mts`, `electron/runtime/mailbox.mts`, `electron/runtime/prompts.mts`, `electron/runtime/session.mts`, `electron/runtime/store.mts`, `electron/runtime/tools.mts`, `electron/runtime/turn.mts`.
`electron/ipc-handlers.cjs` carries two `any` casts where `run-store.mts` and `types.mts` declare their own `StoredRun`/`FileChange`
shapes; unify them in `types.mts` when finishing the runtime modules. Everything else passes `tsc -p tsconfig.main.json` under `strict`.
