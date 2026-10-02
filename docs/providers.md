# Provider adapters

Orbit runs the installed Codex and Claude Code CLIs using their existing login.
It also supports Ollama and an explicitly configured OpenAI-compatible endpoint.
Orbit 0.3 also supports Antigravity and Cursor subscription CLIs; see the setup
section below. OpenCode remains unsupported.

| Provider | Setup | Model selection | Transport | Live output |
| --- | --- | --- | --- | --- |
| Codex | Install Codex CLI and run `codex login` | Chat setting, otherwise CLI default | `session` (exec thread resumed per turn; App Server in Ask mode) | JSONL assistant messages, command/file/MCP/search activity |
| Claude Code | Install Claude Code and sign in there | Chat setting, otherwise CLI default | `session` (`--session-id` / `--resume`) | Text deltas, tool calls and tool results |
| Ollama | Start Ollama with an already installed model | Chat setting, `ORBIT_OLLAMA_MODEL`, otherwise an unambiguous installed model | `envelope` | Generated text deltas |
| Compatible endpoint | Set `ORBIT_OPENAI_BASE_URL` | Chat setting or `ORBIT_OPENAI_MODEL` required | `envelope` | Chat Completions SSE, with JSON response compatibility |

Antigravity and Cursor use the `envelope` transport, except in Full access: there Antigravity keeps a session, and
Cursor does when opted in (`transport: 'session'` in its provider options or `ORBIT_CURSOR_SESSION=1`); see "Cursor
and Antigravity sessions" below. `transportFor(providerId, options)` returns the transport;
`ORBIT_LEGACY_ENVELOPE=1` forces the envelope for every provider. See "Session transport" below.

For custom installations, `ORBIT_CODEX_COMMAND` and `ORBIT_CLAUDE_COMMAND` can name
an executable. On Windows, native executables and ordinary npm Node shims work;
arbitrary batch wrappers are rejected rather than interpreted by a shell.
Ollama readiness checks the server and installed models, not merely whether its
CLI exists. If several models are installed, metadata capabilities prefer a
unique model with tools/thinking; equally suitable models require an explicit
selection. This avoids accidentally selecting an OCR model by installation
order. Metadata selection is cached for one minute. No model is downloaded
automatically. A configured custom endpoint
is labelled configured; its connection and credentials are checked when used.

Compatible endpoint configuration:

```text
ORBIT_OPENAI_BASE_URL=http://127.0.0.1:1234/v1
ORBIT_OPENAI_MODEL=your-model-id
ORBIT_OPENAI_API_KEY=optional-endpoint-key
```

The adapter appends `/chat/completions` unless the URL already ends with it.
Only the explicitly configured `ORBIT_OPENAI_API_KEY` is sent; unrelated
`OPENAI_API_KEY` credentials are not inherited by this adapter. Endpoints with
credentials embedded in the URL are rejected. Ollama defaults to
`http://127.0.0.1:11434`; `ORBIT_OLLAMA_URL` may override the base URL or the
legacy full `/api/generate` URL.

Plain `http://` is accepted only for this machine (`localhost`, `127.0.0.0/8`,
`[::1]`, as the URL parser canonicalizes them): to another host the prompt and
`ORBIT_OPENAI_API_KEY` would travel unencrypted, so such an address needs
`https://`, or `ORBIT_ALLOW_INSECURE_HTTP=1` for a trusted network (Ollama on
another computer at home). A refused address stops the run before any request,
and the provider list shows the variable and the reason (`endpointUrl` in
`electron/providers.mts`).

## Execution and permissions

Prompts go through stdin, including on Windows. Commands use `shell: false`.
The prompt, project path, and model name are never assembled into shell code.
This also avoids Windows command-line length limits for conversation context.

Two timers watch a CLI. The inactivity timer (`inactivityMs`, default 15 minutes,
env `ORBIT_PROVIDER_INACTIVITY_MS`, `null` disables) kills a process that has
written nothing to stdout or stderr for that long; in session mode an Orbit tool
call in flight (`session.activity()` reports `pending > 0`) defers the verdict,
because a CLI waiting on `wait_agent` is silent by design. The total deadline
(`timeoutMs`) applies to a session run only when the caller passes one
(`run.limits.timeoutMs`); envelope runs and direct `runProvider` calls without
`timeoutMs` keep the 30-minute default, `ORBIT_PROVIDER_TIMEOUT_MS` overrides it.
On top of both, the runtime watches every turn (`electron/runtime/watchdog.mts`):
a turn whose provider reports no event (text, reasoning, a tool status,
diagnostics) for `ORBIT_STALL_MS` (default 10 minutes, `0` disables) is aborted,
unless a native tool it started is unfinished, an Orbit tool call is pending or
an approval waits for the user. That stop and the inactivity timeout (its error
carries `code: 'ORBIT_PROVIDER_IDLE'`) go to recovery: the turn is repeated once
on the same model, in a fresh session, with a `WATCHDOG:` note; a second silent
turn in a row hands the agent to another subscription (handover reason
`stalled`), and without one the agent stops with the reason. A stopped turn is
not counted against the turn budgets. A turn the provider itself failed (any
error of `runProvider` other than a quota refusal or a cancellation) hands the
agent over at once with reason `failed` when failover is on; an error that says
the subscription cannot answer at all (`failover.unreachable`: region, sign-in,
missing CLI) also keeps that provider away from every agent of the run for 10
minutes. Orbit's own failures around a turn (its time budget) are not handed over.
Cancellation kills the CLI process tree on Windows and its process group on
POSIX; HTTP requests are aborted. stdout and stderr are consumed incrementally
and bounded to 32 MB per invocation, with only a small raw diagnostic tail retained.

## Session transport

**Proxies.** A CLI started for a session inherits the user's environment, and `HTTP_PROXY`/`HTTPS_PROXY` (a VPN or a
corporate proxy) would route its calls to Orbit's loopback MCP server through the proxy, which cannot reach
`127.0.0.1` of this machine; Claude Code then reports the server as `failed` and the model never sees the Orbit tools.
Orbit therefore adds `127.0.0.1`, `localhost` and `::1` to `NO_PROXY`/`no_proxy` of every session process
(`providers.loopbackNoProxy`), keeping whatever the variable already listed. Verified live on 2026-09-29 with
`HTTP_PROXY=http://127.0.0.1:12334` set: without the exclusion the server was `failed`, with it Claude Code connected in 137 ms.

**Live check.** `node scripts/smoke-session-live.cjs [model] [effort]` (default `haiku low`) spends a little of the user's
Claude quota to prove the session transport end to end: a restricted agent creates a file through `write_file` over MCP
(one process, exact diff recorded), then a root agent spawns one helper, waits for it over MCP and is resumed with the
result. Report: `artifacts/session-live.json`. Measured 2026-09-29: 9 s and 24 s.

Session mode keeps one CLI conversation per agent instead of restarting the CLI
with the whole transcript at every Orbit tool call. Orbit tools reach the CLI as
an MCP server (`electron/mcp-server.mts`: streamable HTTP on `127.0.0.1`,
ephemeral port, one bearer token per run and agent, `tools/list` from
`electron/tool-registry.mts`, `tools/call` dispatched to the runtime). The
registry is the single source of truth for every Orbit tool: name, prompt
signature, description, JSON-Schema input, `rootOnly`, `waits`, `mutating`,
`minAccess`; the envelope prompt text and the envelope response schema are both
derived from it, so envelope providers still see exactly the text they saw before.
The internal `approve` tool is listed only for tokens issued with `approve: true`
and answers Claude Code's `--permission-prompt-tool` with the JSON string
`{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`.

`runProvider({ …, session: { id, token, mcpUrl, systemAppend, resume, activity } })`
runs one session turn and returns `{ providerId, client, transport: 'session',
sessionId, text, model, access }`. `sessionId` is the id to pass back as
`session.id` with `resume: true` on the next turn. Usage still arrives through
the completion `observation` event, once. MCP tool calls appear in the stream as
`kind: 'tool'` events with `tool: 'mcp__orbit__<name>'` (Claude; Cursor and Antigravity too) or
`tool: 'mcp_tool_call'` (Codex), `orbitTool: '<name>'`, `mcp: true` and
`native: false`; their results carry the same `orbitTool`.

Claude Code (checked against 2.1.284, no prompt was run):

```text
claude --print --output-format stream-json --verbose --include-partial-messages
       --session-id <uuid chosen by Orbit>            first turn
       --resume <that uuid>                            follow-ups
       --mcp-config '{"mcpServers":{"orbit":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <token>"}}}}'
       --strict-mcp-config --allowedTools mcp__orbit__*
       [--tools Read,Glob,Grep]                        every mode except Full access
       [--append-system-prompt-file <temp file>]       the stable Orbit block, removed after the run
       [--permission-prompt-tool mcp__orbit__approve]  Ask mode only
       --permission-mode default|bypassPermissions [--model m] [--effort level]
```

The prompt goes through stdin. There is no `--no-session-persistence` (a resume
needs the session file) and no `ORBIT_RESPONSE_SCHEMA`. The session id comes
back in `system/init` and `result`. The child gets
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (24 h unless already set): Claude Code drops
an idle HTTP tool call after 5 minutes by default, and a `wait_agent` legitimately
takes longer; the MCP server also sends `notifications/progress` every 15 s while
a call runs. The `--mcp-config` JSON, token included, is visible on the command
line of a loopback-only process; the token belongs to one agent and is revoked
when it ends.

Codex exec (checked against 0.155):

```text
codex exec --json --skip-git-repo-check -C <ws> --sandbox <mode> -c features.multi_agent=false
     -c 'mcp_servers.orbit.url="http://127.0.0.1:<port>/mcp"' -c 'mcp_servers.orbit.bearer_token_env_var="ORBIT_MCP_TOKEN"'
     -c mcp_servers.orbit.tool_timeout_sec=3600
     [-c developer_instructions="<the stable Orbit block>"]
     [-c approval_policy="never" | --approve-for-me] [--model m] [-c model_reasoning_effort="x"] -
codex exec resume --json --skip-git-repo-check -c sandbox_mode="<mode>" -c features.multi_agent=false
     -c mcp_servers.orbit.* … [-c developer_instructions=…] <thread id> -
```

`ORBIT_MCP_TOKEN` is in the child environment, never on the command line. No
`--ephemeral`: the thread must persist for `resume`. The thread id comes from the
`thread.started` event. `codex exec resume` accepts neither `-C` nor `--sandbox`
nor `--approve-for-me`, so the process cwd is the workspace, the sandbox travels as
`sandbox_mode`, and an auto-review resume keeps the thread's own approval policy.
The stable Orbit block (`systemAppend`) becomes the thread's developer instructions,
a TOML string on the command line (Codex has no file option for it); the App Server
gets it as `developerInstructions` in `thread/start` and `thread/resume`. A resumed
thread keeps the block it started with (both transports, checked 2026-10-01 against
0.155 with a stub Responses server); a resume passes it all the same. The override
replaces a `developer_instructions` the user set in `CODEX_HOME/config.toml` for Orbit's
sessions (`AGENTS.md` still applies). A lone surrogate (a string bounded inside an emoji)
goes out as U+FFFD: on the command line TOML refuses its escape, and the App Server drops
a JSON-RPC line that carries one without answering, so every string of every App Server
message is made well-formed (`rpcLine`).

Codex ends an MCP tool call after the server's `tool_timeout_sec` (60 s unless set), and Orbit's tools legitimately
take longer (`wait_agent`, `run_command`, the checks of `restart_orbit`), so both Codex transports set it to 3600
(added 2026-09-30; with codex-cli 0.155, `codex mcp get orbit --json` shows 3600).

Codex Ask mode keeps one App Server process and one thread alive for the agent
(`thread/start` with `ephemeral: false`, then one `turn/start` per Orbit turn; a
resume whose process is gone tries `thread/resume` and falls back to a new
thread). The MCP server goes in as `-c mcp_servers.orbit.*` on the process.
`providers.closeSession(sessionId)` ends the process; a session idle for
`ORBIT_SESSION_IDLE_MS` (default 30 minutes) ends itself, and cancellation kills
the process tree before the turn settles.

Codex Ask mode uses the stdio App Server with `on-request` approvals and a
`workspace-write` sandbox. Native command, file-change and permission requests
open an Orbit confirmation dialog showing the agent, project and proposed action.
Approval is for that request only; cancelling the task closes pending dialogs.
Other modes use `codex exec` with the selected sandbox and no interactive
escalation. Full access uses `danger-full-access` and `approval_policy="never"`.

Web search: codex-cli 0.155 always offers the model its `web_search` tool, live with the
`danger-full-access` sandbox and cached-only in `workspace-write` / `read-only`. An Ask-mode thread runs
in `workspace-write` (approvals escalate single actions), so with full access the App Server is launched
with `-c web_search="live"` as well; restricted modes keep the cached results.

On Windows the Codex CLI often is not on PATH: Orbit also finds the `codex.exe` that the VS Code
extension bundles (`%USERPROFILE%\.vscode\extensions\openai.chatgpt-*\bin\windows-x86_64\codex.exe`).
A helper that wants to run Codex by hand (`codex mcp get --json`, `codex --help`) uses that path.

Both Codex transports override `features.multi_agent=false` for the spawned
process only. Delegation uses Orbit's tools, so child
agents, their messages and results are owned by Orbit and shown in its UI.

**Cursor and Antigravity sessions** (2026-09-30). Only in Full access (`danger-full-access`, approval policy not
`on-request`): headless, neither CLI can approve an MCP tool call except by approving everything (`--force`,
`--dangerously-skip-permissions`). Antigravity uses the session there by default. Cursor uses it only when opted in
(`transport: 'session'` in the Cursor provider options, a field the settings UI does not offer, or
`ORBIT_CURSOR_SESSION=1`) until a live check passes: the Cursor account is out of quota, so the path from the model to
an Orbit tool call over MCP is not verified; the arguments, the plugin and the stream parser are checked against a fake
CLI only. In every other mode both stay on the envelope. The CLI process of a root agent working on Orbit's own
repository also gets the runtime's restart variables (`extraEnv`, see "Runtime contract"). Both CLIs name their
sessions: only a plain token (`SESSION_ID`: a letter or digit, then letters, digits and `._:-`, at most 128 characters)
is taken from the stream, anything else is ignored and reported once as a diagnostic, and a resume id that is not such
a token is refused with the code `ORBIT_SESSION_ID`, after which the runtime drops it once and starts a fresh session
(the same rule holds for Codex thread ids). A handover to another subscription closes the old session first.

Cursor:

```text
agent --print --output-format stream-json --trust --approve-mcps --plugin-dir <temp folder>
      --force --sandbox disabled [--resume <chat id>] [--model m]
```

The prompt goes through stdin, and every turn, a resume included, runs in the workspace (Cursor keys its chats by
folder). The plugin folder (`%TEMP%/orbit-cursor-mcp-<pid>-*`, created for every turn and removed after it) holds
`.cursor-plugin/plugin.json` (`{"name":"orbit",…}`) and `mcp.json` with `Authorization: Bearer ${env:ORBIT_MCP_TOKEN}`:
the token is only in the child's environment, and the server's id is `plugin-orbit-orbit`. `--approve-mcps` approves
every MCP server Cursor has configured, the user's global and project ones included, not only Orbit's: acceptable only
because this transport exists in Full access alone. A project `.cursor/mcp.json` is not used, because Cursor resolves
the project root by the Git root, which on the owner's machine is the home folder. The chat id comes from
`system/init`. Cursor has no system-prompt option, so the stable Orbit block opens the conversation's first message. An
empty final `result` falls back to the last text the turn streamed, and an error event whose error is an object is
described as JSON. "You've hit your usage limit", which Cursor prints on stderr only, becomes a quota-tagged error, so
failover recognises it. The reasoning level picks a model variant as in the envelope mode.

Antigravity (`agy` 1.2.13):

```text
agy --input-format stream-json --output-format stream-json [--model m]
    --add-dir <workspace> --dangerously-skip-permissions [--conversation <id>]
```

Each conversation runs in its own folder, `%TEMP%/orbit-agy-session-<pid>-*`, with `.agents/plugins/orbit/plugin.json`,
`mcp_config.json` (`serverUrl`, a `Bearer` header with the token itself, because `agy` expands no variables;
`timeoutSeconds: 3600`) and `rules/AGENTS.md` (the stable Orbit block as an always-on rule, plus the workspace path and
how to call Orbit's tools). The files are rewritten before every turn, since the port and the token may change; the
prompt is one NDJSON line on stdin; the Google CLI proxy settings apply as in the envelope mode, with the loopback
server excluded. Orbit tool calls arrive as `call_mcp_tool` with `ServerName` `orbit_orbit`; `denied_actions` is a
diagnostic, not a failure; an empty `response` falls back to the streamed text. The folder goes with `closeSession`
(the run's end, or a handover) or when Orbit exits (the exit hook retries a folder that is still locked); the first
session of a later process removes such folders (and Cursor plugin folders) at once when the process named in the
folder is gone, else when their configuration is older than 6 h. Verified live on 2026-09-30 through Orbit's own code
path: two turns on `claude-sonnet-4-6` with an Orbit tool call over MCP in each, the rules file applied, and a resume
of the same conversation from a new folder with a new port and token; about 10 s per turn; the CLI's global
configuration files were unchanged (sha256 before and after). Gemini models are refused for this account by location.

**Per-call limits.** Some MCP clients end a tool call on their own clock: Cursor after 60 s (the MCP SDK default; it
sends no progress token), Antigravity after `timeoutSeconds`, Codex after `tool_timeout_sec`. `mcpCallLimit(providerId)`
is the time Orbit answers within: Cursor 50 s, Codex and Antigravity 59 min, no limit for Claude (which gets progress
notifications and the 24 h idle timeout above). `ORBIT_MCP_CALL_LIMIT_MS` can only lower it. A longer `wait_agent` or
`wait_message` is cut at the limit and answers "still running, call again"; any other call keeps running past it, and
the agent's identical next call collects the result instead of starting the tool again, unless files changed since it
started or it finished more than 2 minutes ago; such a call is stopped with the agent's session, at a handover and at
the end of the run (docs/SESSION-MODE.md).

The rest of this section describes the envelope transport (Antigravity and Cursor
outside a session, Ollama, compatible endpoints, and the CLIs under `ORBIT_LEGACY_ENVELOPE=1`).
The first completed assistant message containing a validated, nonempty tool
envelope transfers control to Orbit, including commentary. Both transports stop
the provider process tree before returning that envelope to the runtime. Later
messages cannot overwrite pending calls; the next inference receives real tool
results. Partial messages, reasoning, native tool output and JSON embedded in
prose cannot trigger this handoff. Nullable optional arguments may be omitted in
commentary. Cancellation during handoff remains cancellation.
Codex exec reasoning
items and App Server readable reasoning-summary deltas are forwarded when supplied;
unavailable reasoning is not reconstructed. See the official
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [App Server events](https://learn.chatgpt.com/docs/app-server).
Claude streams its thinking text empty; inside the agent's own thinking block
(`content_block_start` of type `thinking` without `parent_tool_use_id`, up to its
`content_block_stop`) the CLI's `system/thinking_tokens` events (`estimated_tokens`:
the estimate of the block so far) become `thinking` events. The runtime keeps the
estimate on the open turn's record (`turnTimings[].thinking`, gone when the block,
a text or tool call, or the turn ends) and the chat shows it as
«думает · ~N тыс. токенов»; it is not traced.

Claude uses `bypassPermissions` in Full access. In other modes, native tools
are restricted to Read/Glob/Grep with `default` permissions; writes and commands
use Orbit tools, with confirmation in Ask mode. Avoiding native `plan` mode
prevents the model from asking the user to switch modes to complete an authorized task.
These are tool permission policies, not an operating-system sandbox.

Access is fixed when the task starts and inherited by all Orbit children;
model-supplied child arguments cannot expand access. Harness
write/edit/command tools request permission in Ask mode, including for Ollama
and compatible endpoints. A missing approval handler declines the action.

Reasoning is saved separately for each provider and each model in the mixed
provider pool. Root selection takes precedence over legacy provider defaults.
A helper's level is chosen by the first rule that names one: the `spawn_agent.reasoningEffort` the
parent passes (the parent is told to choose it per helper), the pool entry for that model (an empty
pool effort means auto), the routing table's level for the `kind` (`model-routing.json`), the
parent's level when the helper keeps its provider/model, the provider settings. The winner is kept
as `effortSource`. A level the model does not offer is moved to the nearest one it does, below
first (`reasoning-levels.mts`; handovers use the same rule), and `spawn_agent` answers with the
level and why.
The agent inspector displays the effective effort. Changes apply to new tasks.

A helper stays on the subscription the caller gave it unless Orbit's automatic failover moves it (quota nearly used
up or refused, a failing or silent model). `spawn_agent` controls that move: `failover: "none"` pins the helper
(it never changes subscription; out of quota or failing, it stops with an error that names the provider and the reason,
which `wait_agent` shows), and `avoidProviders: ["claude"]` lists subscriptions it is never moved to or routed onto.
A `kind: "review"` with a `providerId` other than the caller's is pinned by default (an independent judge of another
vendor must not quietly become the producer's); `failover: "auto"` allows the move. With a `kind`, a `providerId` and no
`model`, a pinned helper whose subscription has no usable model now (all out of quota) is not started
(`provider_unavailable`); a free one starts and `routed.note` says it may be moved. Whatever moved, `wait_agent` and
`list_agents` report it as `failedOver` (`from`, `to`, `switches`, `why`; `wait_agent` adds `steps`), also when the
agent moved before its first turn. `avoidProviders` works per provider id: Cursor can serve Claude models, so for a
strict vendor rule use `failover: "none"`.

`spawn_agent {connectors: [names]}` passes external MCP servers (connectors) to a helper: none by default, only names the caller itself has
(the root: every enabled connector); see "Connectors" in ARCHITECTURE.md.

Codex uses `model_reasoning_effort` for exec and `effort` for App Server; levels
come from its local catalog. Claude receives `--effort`. Google models (Antigravity)
have reasoning built in: Orbit shows no selector for them and never sends an effort
flag, even when an old value is saved in settings, the pool or a `spawn_agent` call. Cursor
selects an actually advertised model variant for the chosen level, preserving
fast/thinking variants, and rejects a level that a model with variants does not
advertise. Auto has no effort selector: a level saved for another model, or asked
for by a `spawn_agent` call, is ignored there instead of failing the agent. The
trace says so once and the agent inspector stops showing the dropped level.
Ollama discovers `/api/show` thinking controls and sends `think` as a
boolean or supported level; incompatible values are rejected before generation.
Compatible endpoints receive `reasoning_effort`; support depends on the server.

Ollama silently discards the start of a prompt that exceeds its context window, and the start of an Orbit prompt is the tool protocol. Orbit therefore sends `options.num_ctx` sized to the prompt in coarse steps (4096, 8192, 16384, 32768) so the model is not reloaded on every turn. Compatible endpoints cannot be told a window size.

Ollama and compatible endpoints have no native filesystem access: the Orbit
runtime executes their requested tools under its own permissions.

CLI-native tools are retained, including any subagents the native CLI launches.
Their emitted activity appears as provider events. The Orbit agent tree tracks
children launched through Orbit's own delegation tools; native CLI subagents
are not independent Orbit tasks. Claude events retain `parentToolId` for tracing
native subagent activity when the CLI emits it.

## Quota

Orbit shows what is left of each subscription and moves a running agent to another one when a quota runs out (see
`docs/ARCHITECTURE.md`, "Subscription quotas and failover"). The figures come from the CLIs themselves and were
checked against the real CLIs on 2026-09-29; none of the calls below runs a model or spends quota.

| Provider | Source | Windows | Notes |
| --- | --- | --- | --- |
| Codex | app-server request `account/rateLimits/read`, live `account/rateLimits/updated` | 5 hours, week; plan; credits | Needs a ChatGPT login; an API key is billed by usage and has no window. |
| Claude Code | `claude -p "/usage"` (text), `claude auth status` (plan name only), stream `rate_limit_event` | session (5 h), week (all models), week per model | `/usage` answers locally in about 3 s (`num_turns: 0`). Reset times are wall-clock text with an IANA zone and are converted. A key-based login has no windows. |
| Antigravity | `agy -p "/usage" --output-format json` | 5 hours and week for the Gemini group and for the Claude/GPT group | Uses the configured Google CLI proxy. Reading the quota does not prove that generation is allowed in the account's region. |
| Cursor | `agent about` | none | Only the plan (for example Free) is published. A refusal is noticed when it happens. |
| Ollama | none | none | Local, unmetered. |
| Compatible endpoint | none | none | Limits are the server's business. |

`ORBIT_CODEX_COMMAND`, `ORBIT_CLAUDE_COMMAND`, `ORBIT_ANTIGRAVITY_COMMAND`, `ORBIT_CURSOR_COMMAND` and the per-provider
command in the settings apply to these calls too. Account identifiers printed by `auth status` and `agent about` are
discarded; only the plan name is kept. The CLIs' output formats are not a published API: when one changes, the reader
reports the provider as "unavailable" or "no data" instead of inventing numbers, and the reactive path (recognising
a refusal) still works.

Which model may replace which is decided by `electron/model-tiers.json`: ordered patterns on the lowercase model id that
give a tier (3 flagship, 2 strong, 1 light, 0.5 weak, 0 unknown or unreliable). The first patterns are measured: models
the model audit (`docs/MODEL-AUDIT.md`) placed away from what their names suggest, each with the reason in `measured`
(GPT-6 Luna is strong, not light; Claude Haiku 4.5 and the `haiku` alias are weak; GPT-OSS gave no answer and is taken
only from the pool). The rest follow naming conventions; edit the file when a new model family appears or a new audit
measures one. Doubtful models are placed low, which only makes a replacement rarer, never worse. Models listed in
`excluded` are never chosen on their own, whatever their tier, only when the user named them in the provider pool: Claude
Fable (also Cursor's `claude-fable-5-thinking-high`) is there at the user's request. A provider pooled without a model (or
Cursor's `auto`) runs whatever its CLI picks, which Orbit cannot see: name the model in the pool to keep an excluded one out.

Which model a new helper gets for a kind of work (`spawn_agent` with `kind`) is decided by `electron/model-routing.json`:
per kind, the candidates in the order of the model audit, each with what was measured in `why` and the level the audit ran
at. Claude models are named by the CLI aliases the health list shows (`sonnet`, `opus`). A candidate whose provider lists
models but not this one is passed over, so a renamed model drops out instead of failing a helper. Claude Fable 5.1 is
left out at the user's request. Edit the file after a new audit.

## Runtime contract

```js
await runProvider({
  providerId, prompt, workspace, mode, accessMode, approvalPolicy,
  model, signal, onEvent, timeoutMs, inactivityMs,
  session, // { id, token, mcpUrl, systemAppend, resume, activity } for the session transport
  extraEnv, // added to the environment of every CLI process of the turn (the runtime's restart variables)
})
// -> { providerId, client, text, model, access }                       envelope
// -> { providerId, client, transport: 'session', sessionId, text, model, access }  session
transportFor(providerId, options) // 'session' | 'envelope'
mcpCallLimit(providerId)          // ms within which Orbit answers one MCP tool call; 0 = no limit
closeSession(sessionId)           // ends a Codex App Server session or an Antigravity conversation's folder; false when nothing was alive
```

`extraEnv` reaches Claude, both Codex transports, Cursor and Antigravity on either transport; Orbit's own variables
(the MCP token, `NO_PROXY`, the Google CLI proxy) win over it. The runtime passes `ORBIT_RUN_ID`, `ORBIT_CHAT_ID`,
`ORBIT_PROJECT_ID`, `ORBIT_AGENT_ID`, `ORBIT_RESUME_FILE` and `ORBIT_USER_DATA` exactly where `restart_orbit` is offered
(the root agent of a writable run on any project, when Orbit can restart itself and is not under the Vite dev
server), so a self-upgrade run from that CLI's own shell names the run to continue and signals this Orbit's profile
(README, "Самообновление"); every other agent gets none.

`text` is the exact final assistant text, preserving whitespace and JSON tool
envelopes. Intermediate commentary and tool output are separate events. Codex
must emit a completed turn; Claude must emit a successful result. Missing,
empty, failed or truncated responses reject instead of returning diagnostics
as an answer. Native command failures remain visible to the native agent, which
can recover before finishing its turn.

`onEvent` receives `{ kind: 'output' | 'tool' | 'observation', text, providerId,
...metadata }`. Output events use `messageId` and append text deltas; a rare
`replace: true` event replaces that message's content. Tool events can include
`toolId`, `tool`, `status`, `input`, `output`, `exitCode`, and `parentToolId`.
Usage is emitted on completion where the provider supplies it. Provider
reasoning traces are not used as assistant answers. Consumers should display
progress separately and use returned `text` as the authoritative final result.
A CLI that names its own session announces it as soon as it does:
`{ kind: 'session', sessionId }` (Codex `thread.started`, Cursor `system/init`,
Antigravity `init`, the Codex App Server's thread before `turn/start`), so the
runtime can resume a turn cut off before its result (docs/SESSION-MODE.md,
"Session ids").

The HTTP adapters request text responses. Orbit's model-controlled tool loop
interprets its text protocol in the runtime. Unexpected native HTTP function
calls are rejected, because these requests do not advertise a function schema.

Agent-to-agent communication belongs to this shared Orbit tool protocol as
well. `send_message`, `read_messages`, `wait_message`, and `followup_agent`
are handled by the runtime, not by provider-specific CLI commands. The model
requests them with the same JSON `tool_calls` envelope as other Orbit tools;
their observations return in its next prompt. The transport preserves agent
IDs, message text, and tool arguments verbatim inside the final response.
Codex, Claude Code, Ollama, and compatible endpoints therefore use the same
mailbox and delegation contract, including teams using different providers.
The selected model still needs to follow the text tool protocol reliably.
Native CLI messaging is not required and does not substitute for Orbit
mailboxes. Delivery, read status, waiting, cancellation, and following up a
finished child are enforced and recorded by the runtime.

## Validation and protocol references

`node --test tests/providers.test.cjs` runs fixture parsers, real local child
processes, process-tree cancellation, stdin/Unicode transport, and local HTTP
streaming/error tests. It makes no inference request to a paid provider.
`tests/providers-session.test.cjs` drives fake Claude and Codex CLIs through the
session transport (session flags, temp system file, session-id parsing, resume
arguments, inactivity and deadline timers, Codex config overrides and token
environment, App Server sessions across turns with approvals, close and
cancellation) and, since 2026-09-30, fake Cursor and Antigravity CLIs (session flags, plugin
folders and their removal, the token only by variable for Cursor, resume ids, the usage-limit
refusal, `closeSession`); `tests/subscription-providers.test.cjs` covers their session parsers
and plugin files, and `tests/session-mode.test.cjs` the call limits (cut waits, parked calls).
`tests/mcp-server.test.cjs` talks to the Orbit MCP server with the
SDK client (tools/list, tools/call, unread suffix, errors, 401, approve round
trip, progress, stop). `tests/tool-registry.test.cjs` pins the prompt text and
the envelope schema to their pre-registry bytes.
`node --test tests/providers-messaging.test.cjs` connects the actual compatible
SSE and Ollama NDJSON adapters to a local fixture server. The root and child
exchange three Unicode/multiline messages through one provider slot, preserve
their explicitly selected models, and restore correspondence from run history.
The locally installed Codex `exec --help` was also checked. A separate real
Codex smoke in an empty temporary directory returned exactly `ORBIT_READY`
with read-only permissions and no tool activity. Claude protocol
coverage uses fixtures and documentation, including process shutdown at tool
handoff. Native Windows installs are detected before PATH is refreshed.

`node scripts/smoke-live.cjs` is an optional, explicit real Codex integration
check using the existing CLI login and default model. It creates one actual
Orbit child, waits through `wait_agent`, verifies the answer `19 × 23 = 437`,
and checks restored run history in temporary storage. The first run passed
with two completed agents, four provider calls, and no native CLI tools or
project changes. This script is excluded from the normal test suite because
it performs real inference through the user's CLI account.

- [Codex noninteractive JSONL protocol](https://developers.openai.com/codex/noninteractive)
- [Claude Code programmatic streaming](https://code.claude.com/docs/en/headless)
- [Claude Code CLI flags](https://code.claude.com/docs/en/cli-reference)
- [Ollama generation API](https://docs.ollama.com/api/generate)
- [Ollama model metadata schema](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml)
- [Chat Completions reference](https://platform.openai.com/docs/api-reference/chat/create)

- [Codex App Server approvals and turn configuration](https://learn.chatgpt.com/docs/app-server)
# Подписки Antigravity и Cursor (Orbit 0.3)

**Antigravity:** установите официальный CLI и выполните `agy`, выберите свой Google-аккаунт с Google AI Pro/Ultra. Orbit использует существующую CLI-авторизацию, не читает и не копирует OAuth-токены. Подписка не превращается в Gemini API key. Модели запрашиваются через `agy models` (текущий CLI не поддерживает `--json`); при недоступном списке можно ввести slug вручную. Рассуждения встроены в модели Google: Orbit не показывает выбор уровня и не передаёт `--effort` (см. раздел о рассуждениях выше).

**Cursor:** установите официальный CLI и выполните `agent login`. Orbit проверяет `agent status --format json` и получает список через `agent --list-models`. Поле модели допускает ручной идентификатор. Лимиты и доступность моделей определяет аккаунт Cursor.

Установленный **Cursor IDE не заменяет Cursor CLI**. Для Windows официальный установщик CLI запускается в PowerShell: `irm 'https://cursor.com/install?win32=true' | iex`. Затем выполните `agent login` и нажмите «Проверить» в Orbit. Если текущий терминал ещё не видит `agent`, откройте новый. Orbit также ищет CLI в `%LOCALAPPDATA%/cursor-agent` без обновления PATH. [Инструкция Cursor](https://cursor.com/docs/cli/installation).

Google CLI по умолчанию получает системный HTTP-прокси через переменные своего процесса. В Electron учитываются системные настройки/PAC; вне Electron на Windows читается включённый прокси из реестра. Можно выбрать собственный HTTP(S)-адрес без пароля, наследование окружения или прямое соединение. Глобальные настройки системы и CLI не меняются. При явном прокси старый `NO_PROXY` не позволяет запросам Google обойти выбранный маршрут. VPN с TUN продолжает маршрутизировать трафик на уровне ОС.

Ошибка Antigravity `Eligibility check failed … not currently available in your location` означает отказ Google по региону. Проверьте маршрут CLI, страну аккаунта на [странице условий Google](https://policies.google.com/terms) и [список поддерживаемых регионов](https://antigravity.google/docs/faq). Если страна указана неверно, отправьте [запрос на исправление](https://policies.google.com/country-association-form). Прокси не меняет страну аккаунта. Успешная загрузка списка моделей ещё не подтверждает доступ к генерации.

Путь к CLI настраивается в интерфейсе или через `ORBIT_ANTIGRAVITY_COMMAND` / `ORBIT_CURSOR_COMMAND`. Приложение запускает команду без shell, передаёт запрос через stdin и завершает дерево процессов при отмене. Для Cursor Windows поддерживаются native executable, стандартные npm-shim и официальный пакет с `versions/<version>/node.exe` + `index.js`.

Cursor в Full access запускается в Agent (без `--mode ask`), с `--force --sandbox disabled`. В режимах Ask, чтения и доступа к проекту native-инструменты остаются read-only, а разрешённые записи выполняются через Orbit. Antigravity использует временный custom agent `tools: []`; все действия выполняет Orbit с выбранными правами. Политика и способ выполнения разрешённых записей явно указаны агентам в контексте. Завершённый шаг Antigravity (`agent_response`, `state: DONE`) с целым ответом по схеме Orbit сразу передаёт управление рантайму; дерево CLI останавливается до повторной генерации или исправления схемы. Частичные сообщения, текст инструментов и невалидный JSON этого не делают. Без такой передачи управления обязателен успешный terminal result. Всё это — режим конверта; в Full access Antigravity (и Cursor, если включён `ORBIT_CURSOR_SESSION=1`) работает в сессионном режиме с инструментами Orbit по MCP, см. «Cursor and Antigravity sessions» выше. Native-инструменты Cursor оба режима разбирают одинаково (`cursorToolEvent`). Инструмент называется по ключу внутри `tool_call`. Начало и конец вызова связываются по `call_id`, без него по `tool_call.toolCallId`, без обоих по тексту из аргументов (тогда два одинаковых одновременных вызова делят ключ). Законченный вызов, чей результат не вариант успеха (`success`, у немногих инструментов `approved`, `complete` и т. п.), считается неудачным: `error`, `rejected`, `fileNotFound`, `writePermissionDenied`, `timeout` и другие. Чтения и удачные правки попадают в учёт файлов агентов и в записи изменений. В режиме конверта MCP-вызов Cursor всегда native: сервера Orbit у него там нет.

Потоковые сообщения обновляют одну запись по идентификатору сообщения, участнику и ходу. Интервал обновления интерфейса больше не разрезает текст на отдельные записи, а длинные сообщения не обрезаются до 6000 символов. В панели агента показывается текст `content`, итоговый ответ публикуется в чате после обработки инструментов Orbit.

**Claude Code по подписке:** установите официальный CLI по [инструкции Anthropic](https://code.claude.com/docs/en/setup), выполните `claude auth login` своим Claude-аккаунтом и нажмите «Проверить» в Orbit. API-ключ не требуется. Доступны стандартные CLI-псевдонимы `sonnet`, `opus`, `haiku`, ручной идентификатор или модель по умолчанию; конкретный доступ определяет аккаунт. Завершённое сообщение основного Claude-агента с валидными вызовами Orbit передаёт управление рантайму сразу, без ожидания дальнейших ответов CLI. Поток размышлений показывается отдельно. Источник: [CLI reference](https://code.claude.com/docs/en/cli-reference).

Проверено 2026-09-30: генерация Antigravity на `claude-sonnet-4-6` проходит (проверялся сессионный режим, с вызовом инструмента Orbit по MCP); модели Gemini для этого аккаунта по-прежнему отклоняются по региону. Cursor CLI отвечает «You've hit your usage limit», поэтому его сессионный режим вживую не проверен.

Проверено 2026-09-29: Claude Code 2.1.284 установлен, требуется вход пользователя. Локальные проверки транспорта проходят; живой вызов Antigravity из проверочного процесса получил `User location is not supported for the API use`, поэтому успешная облачная генерация после исправления не подтверждена.

Проверено 2026-09-28: системный прокси загружает 14 моделей Antigravity, но генерация возвращает региональный отказ Google. Cursor с текущим CLI-входом отклоняет именованные модели как Free-план; Auto успешно создал файл во временной папке в Full access. Оплата другой подписки или другого аккаунта не доказывает наличие платного плана у текущего CLI-входа.

Источники протоколов: [Antigravity headless](https://antigravity.google/docs/cli/headless/), [custom agents](https://antigravity.google/docs/subagents/), [установка и вход](https://antigravity.google/docs/cli/install/), [Cursor параметры](https://cursor.com/docs/cli/reference/parameters), [Cursor форматы ответа](https://cursor.com/docs/cli/reference/output-format).

Проверки адаптеров используют документированные события и управляемые CLI-транспорты без расхода подписки. Реальные облачные вызовы требуют установленных CLI и выполненного входа; их успешность не следует из локальных тестов.
