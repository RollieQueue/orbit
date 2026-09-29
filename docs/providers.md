# Provider adapters

Orbit runs the installed Codex and Claude Code CLIs using their existing login.
It also supports Ollama and an explicitly configured OpenAI-compatible endpoint.
Orbit 0.3 also supports Antigravity and Cursor subscription CLIs; see the setup
section below. OpenCode remains unsupported.

| Provider | Setup | Model selection | Live output |
| --- | --- | --- | --- |
| Codex | Install Codex CLI and run `codex login` | Chat setting, otherwise CLI default | JSONL assistant messages, command/file/MCP/search activity |
| Claude Code | Install Claude Code and sign in there | Chat setting, otherwise CLI default | Text deltas, tool calls and tool results |
| Ollama | Start Ollama with an already installed model | Chat setting, `ORBIT_OLLAMA_MODEL`, otherwise an unambiguous installed model | Generated text deltas |
| Compatible endpoint | Set `ORBIT_OPENAI_BASE_URL` | Chat setting or `ORBIT_OPENAI_MODEL` required | Chat Completions SSE, with JSON response compatibility |

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

## Execution and permissions

Prompts go through stdin, including on Windows. Commands use `shell: false`.
The prompt, project path, and model name are never assembled into shell code.
This also avoids Windows command-line length limits for conversation context.

The default invocation deadline is 30 minutes. Set `ORBIT_PROVIDER_TIMEOUT_MS`
or pass `timeoutMs` for a different positive millisecond deadline. Cancellation
kills the CLI process tree on Windows and its process group on POSIX; HTTP
requests are aborted. stdout and stderr are consumed incrementally and bounded
to 32 MB per invocation, with only a small raw diagnostic tail retained.

Codex Ask mode uses the stdio App Server with `on-request` approvals and a
`workspace-write` sandbox. Native command, file-change and permission requests
open an Orbit confirmation dialog showing the agent, project and proposed action.
Approval is for that request only; cancelling the task closes pending dialogs.
Other modes use `codex exec` with the selected sandbox and no interactive
escalation. Full access uses `danger-full-access` and `approval_policy="never"`.

Both Codex transports override `features.multi_agent=false` for the spawned
process only. Delegation uses Orbit's tool envelopes, so child
agents, their messages and results are owned by Orbit and shown in its UI.
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
Children use their pool entry, explicit `spawn_agent.reasoningEffort`, or inherit
the parent effort when keeping its provider/model. An empty pool effort means auto.
The agent inspector displays the effective effort. Changes apply to new tasks.

Codex uses `model_reasoning_effort` for exec and `effort` for App Server; levels
come from its local catalog. Claude receives `--effort`. Google models (Antigravity)
have reasoning built in: Orbit shows no selector for them and never sends an effort
flag, even when an old value is saved in settings, the pool or a `spawn_agent` call. Cursor
selects an actually advertised model variant for the chosen level, preserving
fast/thinking variants, and rejects unavailable combinations. Auto has no effort
selector. Ollama discovers `/api/show` thinking controls and sends `think` as a
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

## Runtime contract

```js
await runProvider({
  providerId, prompt, workspace, mode, accessMode, approvalPolicy,
  model, signal, onEvent, timeoutMs,
})
// -> { providerId, client, text, model, access }
```

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

Cursor в Full access запускается в Agent (без `--mode ask`), с `--force --sandbox disabled`. В режимах Ask, чтения и доступа к проекту native-инструменты остаются read-only, а разрешённые записи выполняются через Orbit. Antigravity использует временный custom agent `tools: []`; все действия выполняет Orbit с выбранными правами. Политика и способ выполнения разрешённых записей явно указаны агентам в контексте. Завершённый шаг Antigravity (`agent_response`, `state: DONE`) с целым ответом по схеме Orbit сразу передаёт управление рантайму; дерево CLI останавливается до повторной генерации или исправления схемы. Частичные сообщения, текст инструментов и невалидный JSON этого не делают. Без такой передачи управления обязателен успешный terminal result.

Потоковые сообщения обновляют одну запись по идентификатору сообщения, участнику и ходу. Интервал обновления интерфейса больше не разрезает текст на отдельные записи, а длинные сообщения не обрезаются до 6000 символов. В панели агента показывается текст `content`, итоговый ответ публикуется в чате после обработки инструментов Orbit.

**Claude Code по подписке:** установите официальный CLI по [инструкции Anthropic](https://code.claude.com/docs/en/setup), выполните `claude auth login` своим Claude-аккаунтом и нажмите «Проверить» в Orbit. API-ключ не требуется. Доступны стандартные CLI-псевдонимы `sonnet`, `opus`, `haiku`, ручной идентификатор или модель по умолчанию; конкретный доступ определяет аккаунт. Завершённое сообщение основного Claude-агента с валидными вызовами Orbit передаёт управление рантайму сразу, без ожидания дальнейших ответов CLI. Поток размышлений показывается отдельно. Источник: [CLI reference](https://code.claude.com/docs/en/cli-reference).

Проверено 2026-09-29: Claude Code 2.1.284 установлен, требуется вход пользователя. Локальные проверки транспорта проходят; живой вызов Antigravity из проверочного процесса получил `User location is not supported for the API use`, поэтому успешная облачная генерация после исправления не подтверждена.

Проверено 2026-09-28: системный прокси загружает 14 моделей Antigravity, но генерация возвращает региональный отказ Google. Cursor с текущим CLI-входом отклоняет именованные модели как Free-план; Auto успешно создал файл во временной папке в Full access. Оплата другой подписки или другого аккаунта не доказывает наличие платного плана у текущего CLI-входа.

Источники протоколов: [Antigravity headless](https://antigravity.google/docs/cli/headless/), [custom agents](https://antigravity.google/docs/subagents/), [установка и вход](https://antigravity.google/docs/cli/install/), [Cursor параметры](https://cursor.com/docs/cli/reference/parameters), [Cursor форматы ответа](https://cursor.com/docs/cli/reference/output-format).

Проверки адаптеров используют документированные события и управляемые CLI-транспорты без расхода подписки. Реальные облачные вызовы требуют установленных CLI и выполненного входа; их успешность не следует из локальных тестов.
