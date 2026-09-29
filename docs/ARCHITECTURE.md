# Orbit harness contract

```text
React: projects → task chats → optional agent inspector
                      │ typed preload IPC
Electron main:        ├─ state, memory, capabilities, run history
                      └─ OrbitRuntime
                          ├─ root agent ↔ model/tools
                          ├─ child ↔ model/tools → grandchildren
                          └─ replaceable provider adapters
```

## Model-driven execution

There is no intent classifier, fixed specialist pipeline, mandatory repository scan or simulated answer. A user message starts one root agent. Its prompt includes a stable identity, bounded conversation history, relevant memory, a capability index, access rules and tool descriptions.

Each model response is either a normal final answer or an explicit JSON tool envelope. The runtime parses the complete envelope (not arbitrary JSON embedded in prose), dispatches declared tools, attaches observations and calls the model again. All providers share this contract. Codex and Claude can also use their native tools; their streamed execution events are exposed as traces. Orbit-created agents form the inspectable tree; agents created internally by a vendor's own tools remain vendor trace events.

The runtime provides file operations, subprocess execution, durable memory, reusable capabilities and swarm operations. The model decides which operations to use. `spawn_agent` requires a concrete task and reason. Every child runs the same loop with its own context and can delegate further. Parent agents receive child results and integrate them. Model-call concurrency slots are released before tool calls and waiting, so a parent does not occupy the slot a child needs to finish.

Agent communication also belongs to the harness, so it works across different providers. `send_message` targets another member of the same run, including siblings and parents. `read_messages` and `wait_message` let agents read or await correspondence. Delivery occurs at a model-turn boundary; an already running vendor inference is not secretly modified. Waiting releases the model slot. `followup_agent` resumes an eligible finished helper with a new assignment and preserved context under the same shared budget. The team correspondence is recorded separately from messages addressed to the user and exposed in the agent panel.

Run limits cover total agents, nesting depth, simultaneous model requests, turns per agent, and total turns across a run. Context and observations are bounded. Reaching a limit produces an explicit failure or tool error. It never fabricates a completed review.

## Working memory and the loop guard

Every provider turn is a fresh inference: the prompt Orbit assembles is the agent's only memory. It has three parts. Fixed instructions and the compact shared context come first (stable prefix). A `WORK LOG` follows: one line per call the agent has executed (tool, target, outcome), kept for the life of the agent and bounded to the newest 60 entries plus a tally of older ones. The rolling transcript comes last and holds full observations. The transcript never drops below a floor (40 000 characters, 9 000 for Ollama/compatible endpoints) whatever the fixed part costs, so a requested `maxContextChars` that cannot hold the instructions plus a usable window is raised rather than spent on starving the history. When old entries scroll out, the log still records what they were.

A loop guard runs after every tool turn. A call is a *repeat* when the same tool and arguments return the same result, compared after removing self-changing fields (turn counters, timestamps) and timings in output. A turn is *stale* when every call in it is a repeat; waits that really blocked are not counted. Two stale turns in a row add a directive to the transcript, four stop the agent with a partial result that lists its last actions and helpers' results, and its still-running descendants are cancelled. Any novel call resets the counter, so this is not a turn limit and long varied work is unaffected. Independently, eight consecutive turns that changed nothing (no write, delegation, message or saved note) add a nudge to conclude, and a harness reminder (`model_evaluate`, improvement mode) that the model ignores three times in a row is dropped.

## Attribution, persistence and cancellation

`start` accepts `projectId`, `chatId`, `workspace`, `prompt`, `history`, `providerId`, optional `model`, access policy, memory setting and limits. Events contain `runId`, `projectId` and `chatId` even when the renderer is displaying another chat.

Canonical events: `run.started`, `run.info`, `agent.created`, `agent.updated`, `trace.added`, `message.added`, `communication.added`, `run.finished`, `run.failed`, `run.cancelled`. Snapshots contain agents, traces, messages, execution settings and timestamps. The renderer associates root answers with the owning chat and subagent output with the inspector. Updates to a communication reuse its ID, so delivery updates do not duplicate messages.

Communication events and the snapshot's `communications` array retain sender, recipient, content, time and delivery state. Messages cannot cross into another run or project merely by naming an agent. The UI restores correspondence alongside the agent tree after a reload.

Runtime lives in Electron main, independent of the displayed chat. Durable snapshots survive renderer reloads and app restarts. Cancellation propagates through one run to its children and provider process trees. A restart marks previously active snapshots `interrupted`; saved history can be used in a new turn. This is not a daemon that survives closing Electron.

## Memory and capabilities

Memory uses exact canonical project paths, with case folding only on Windows. Global scope is explicit. Reads, writes and deletion enforce scope. Legacy project records without a workspace remain quarantined rather than becoming global. Common token strings are redacted before memory/capability persistence.

Capabilities are versioned instructions. The agent sees a small index and loads relevant instructions using `capability_read`. It can save or improve a procedure through `capability_install`, including instructions for scripts created and tested in the project. The previous ten revisions are retained; restore creates another version rather than erasing history. This does not execute downloaded skill text as code or install a new Orbit executable automatically.

Atomic JSON writes and backup recovery are shared by state stores. Run snapshots are batched during activity and flushed at completion/shutdown. The source of truth is local application data, not transient React state or demo seed records.

## Access boundary

File tools reject traversal and symlink escapes outside the selected project. Read-only mode disallows harness command execution and file writes. Workspace-write mode permits subprocesses with the current OS user's rights; `cwd` is not an OS sandbox. Native CLI providers apply their own documented access settings. The harness does not claim that it can sandbox arbitrary programs merely by validating command text.

Different chats may run concurrently in the same project, including write tasks. They share files; this is not worktree isolation. Prompts include other active tasks in overlapping folders and require preserving concurrent changes. The UI shows other active chats. A chat accepts only one active turn, including process cleanup. Cancelled/failed write processes still block new writes in overlapping folders until their operations settle. Within a swarm, the model must assign disjoint write responsibilities. Old worktree helpers remain internal utilities, not the default execution path.

Codex native multi-agent tools are disabled per process (`features.multi_agent=false`) in both exec and App Server transports. Orbit owns delegation, messages, cancellation and persistence. Orbit tool envelopes must be returned as the final provider response; commentary JSON is not executed. This avoids the invisible native-agent tree and ephemeral-thread collaboration failures. Readable reasoning summaries supplied by Codex are attributed to their Orbit agent; the UI does not fabricate unavailable reasoning. Inspector navigation stays outside the scrolling activity/correspondence pane.

## Verification

`tests/runtime.test.cjs` exercises recursion, tool observations, cancellation, limits and provider failures with controlled model responses. `tests/providers.test.cjs` exercises streaming parsers and transports. `tests/storage.test.cjs` covers project isolation, migration, recovery and skill revisions. `scripts/smoke-desktop.cjs` exercises actual Electron/preload/IPC/provider integration in a temporary profile against a local fixture endpoint. These verify software behavior; they do not establish the quality of any particular language model.
