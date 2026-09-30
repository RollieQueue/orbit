# Contract: Skills 2.0 (T14 redesign), T16 buttons, T17 attachments — 2026-09-30

Repository: `C:\Users\Roman Andreevich\Desktop\smth` (Orbit: Electron + React + TypeScript). Runtime and main-process code in
`electron/` (`.mts` runs under Node with `--experimental-strip-types`), renderer in `src/` (Vite), tests are `node:test`
`.cjs` files in `tests/`, one file: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/<file>.test.cjs`.
Renderer TS is tested through vite's oxc transform (see `tests/improvement-loop.test.cjs`). Typecheck: `npx tsc --noEmit`
(renderer) and `npx tsc -p tsconfig.main.json` (main/runtime). Several helpers work at once: fix only errors in YOUR files.

## Why

The user (2026-09-30 17:08Z): «навыки — это функциональность, которую ты реализуешь для себя для каких-то задач или просто
в шутку, без строго регламентированной формы: полезный промпт с действиями, анимация празднования, расширение, которое ты
написал, чтобы, например, поднимать Linux — любое твоё улучшение за рамками изначального функционала, не полностью
интегрированное. Поправить твою функциональность — одно, сделать анимацию празднования — другое.»
So: a skill is an ADD-ON Orbit builds for itself, of any form. Core Orbit only provides generic plumbing (storage,
parameters, triggers, commands, a page stage). The celebration (T14, today hard-coded in React in core) becomes a skill
package with its own HTML/JS/CSS.

## Rules for every helper

- Files are LF in the working copy; edit with the Edit tool, do not reformat, no `sed -i`. No git commands that change state.
- Touch only the files you own (below). Root ("Orbit") owns: `src/types.ts`, `electron/types.mts`, `electron/ipc-contract.cjs`,
  `electron/preload.cjs`, `src/vite-env.d.ts`, `electron/runtime-protocol.mts`, `electron/main.cjs`, `electron/ipc-handlers.cjs`,
  `electron/skill-files.mts`, `electron/fingerprint.cjs`, `docs/*`, `README.md`. Need a change there → `send_message` to Orbit
  with the exact change. Shared files with anchors: `electron/runtime-api.mts` and `src/App.tsx` (see owners below).
- Runtime modules stay ≤ 400 lines (split into a new module if needed). Comments: the repository's style (why, not what).
- UI text is Russian. Report: what you changed (files), checks you ran with results, what is NOT verified.

## Already done by root (use, do not change)

- `electron/skill-files.mts`: `SKILLS_DIR='skills'`, `SKILL_SCHEME='orbit-skill'`, `skillPackageId(skillId)` (folder name =
  orbit-skill:// host), `skillPackageDir(userData, skillId)`, `packagePath(rel)` (valid package-relative path or null),
  `resolvePackageFile(userData, packageId, rel)`, `mimeType(file)`.
- `electron/main.cjs`: `orbit-skill://<package id>/<file>` serves `<userData>/skills/<package id>/<file>` (read-only, 404
  otherwise); the YouTube Referer hook also fixes non-http(s) referers (a page from orbit-skill:// can embed YouTube);
  `openPath(target)` opens files/folders under `<userData>/attachments` or `<userData>/skills` only.
- Types (`src/types.ts`, `electron/types.mts`): `SkillParamType = 'text'|'url'|'number'|'seconds'|'boolean'`,
  `SkillParamValue`, `SkillParam {key,label,type,default,value,hint?}`, `SkillTrigger {on:'task-completed'; show:string}`,
  `SkillCommand {name,run,description?}`, `SkillFile {path,size}`, `SkillPackage {id,dir}`, `SkillFileInput {path,content}`;
  `Capability`/`SkillView` gained `files?, params?, triggers?, commands?, package?` and LOST `action`/`SkillAction`;
  `SkillSaveInput` gained `files?, removeFiles?, fromDir?, params?, triggers?, commands?`;
  `Attachment {id,name,type,size,path}`, `AttachmentUpload {name,type,data /* base64 */}`; `Message.attachments?`;
  `Communication.attachments?`; `StartPayload.attachments?`.
- IPC (`window.orbit`, generated): `setCapabilityParams(id, values: Record<string, SkillParamValue>, workspace) → Capability`
  (channel `capabilities:params`, runtime), `saveAttachments(chatId, files: AttachmentUpload[]) → Attachment[]`
  (`attachments:save`, runtime), `readAttachmentImage(path) → string | null` (`attachments:image`, runtime),
  `messageAgent(runId, agentId, text, attachments?)`, `StartTaskPayload.attachments?`, `openPath(target) → string`
  (main), `setFullScreen(on) → boolean` (main, exists).

## A. Skill store and agent tools — owner `skills-store`

Files: `electron/capabilities.mts` (split package I/O into a new `electron/skill-packages.mts` if it helps),
`electron/runtime/knowledge.mts`, `electron/tool-registry.mts`, `electron/runtime-api.mts` (ONE line: after the
`capabilities:enable` handler add `handle('capabilities:params', (id, values, workspace) => stores.capabilityStore.setParams(id, values, text(workspace)))`),
tests: delete `tests/skill-actions.test.cjs`, add `tests/skill-packages.test.cjs`, keep `tests/skills.test.cjs`,
`tests/skills-review.test.cjs`, `tests/tool-registry.test.cjs` passing (update expected prompt text where the tool text changes).

1. Remove the T14 action concept entirely: `parseSkillAction`, `ACTION_*`, `youtubeId`/`actionSeconds` in the store,
   `orbit-action` handling, `entry.action`, the `action` protection/merge rules. (Never shipped; no stored skill has it.)
2. Entry fields `files: SkillFile[]`, `params: SkillParam[]`, `triggers: SkillTrigger[]`, `commands: SkillCommand[]`
   (revive coerces them; default empty). File contents live in `skillPackageDir(userDataPath, id)`.
   `present()` (list/search/read/UI) includes them and `package: { id: skillPackageId(id), dir }` when there are files.
3. `save(input, {origin})` accepts (all optional; omitted = keep existing on update, explicit `[]` = clear):
   - `files: {path, content}[]` — UTF-8 text written into the package (`packagePath` or error), `removeFiles: string[]`.
   - `fromDir: string` — an absolute folder: its files (recursive; skip dot files/folders and `node_modules`; binary copied
     as-is) REPLACE the package files. If it has `skill.json`, that manifest's `name, description, whenToUse,
     instructions, scope, params, triggers, commands` fill the fields the call does not give (so `capability_install
     {fromDir}` alone installs a package). skill.json itself is also kept as a file.
   - Limits (agent and user): ≤ 40 files, each ≤ 512 KB, package total ≤ 4 MB, else an error naming the limit.
   - `params: [{key,label,type,default,hint?}]`: key `/^[a-z][a-z0-9_]{0,31}$/` unique, label ≤ 80 chars, ≤ 20 params;
     `default` valid for `type` (url: http/https URL ≤ 2000; number: finite; seconds: finite ≥ 0, strings `42`, `42s`,
     `m:ss`, `h:mm:ss` accepted and stored as a number of seconds; boolean; text ≤ 500). On update a param that keeps its
     key and type keeps its current `value` (the user's choice); a new or retyped one gets `value = default`.
   - `triggers: [{on:'task-completed', show}]`: `show` = a package `.html`/`.htm` file that exists after this save; ≤ 5.
   - `commands: [{name, run, description?}]`: name `/^[a-z][a-z0-9-]{0,39}$/` unique, run ≤ 1000 chars, description ≤ 300, ≤ 20.
   - Validate everything first, then write files, then commit the entry. A failed save leaves disk and entry unchanged.
4. `setParams(id, values, workspace)`: each key must exist, value must fit its type (same rules); updates `value` only;
   not a new version; returns `present()`.
5. `remove` deletes the package folder; eviction/maintain dropping a skill deletes its folder too.
6. A skill with files, triggers or commands is protected like a pinned one (never expired, evicted or merged; agent
   twin-merge never merges into or from it). `suggest()` (prompt suggestions) skips skills that have triggers and no
   commands (app behaviour, not a procedure); `search`/`list` keep them. Disabled skills stay hidden from agents (T14).
7. Revisions keep the text fields only; files, params, triggers and commands are current state (restore keeps them).
8. Agent tools (`knowledge.mts`, `tool-registry.mts`): `capability_install` gets optional `files` (array of {path,content}),
   `removeFiles` (strings), `fromDir` (string), `params`, `triggers`, `commands` (arrays of objects; see improvement_plan's
   `tasks` for an array-of-objects schema); validation: name+instructions required unless `fromDir` is given. Rewrite its
   blurb/description: a skill is any add-on — a procedure, or a package (pages, scripts, assets) with parameters the user
   sets, a trigger (task-completed → Orbit shows one of its pages full screen) and commands agents run in the package
   folder; build a package in a folder and install it with fromDir; verify scripts before saving. `capability_read`
   returns the instructions plus `package.dir`, files, params (current values), triggers, commands; it and
   `capability_feedback` refuse a disabled skill ("This skill is switched off"). `capability_list`/`search` show kinds
   (e.g. `kinds: ['instructions','page','commands']`, file count). `renderSkills` may add a short `[commands: a, b]` note.
9. Tests (`tests/skill-packages.test.cjs`): files write/replace/remove; path confinement (`../x`, absolute, `.hidden`);
   limits; fromDir with skill.json; params validation, value kept on update, setParams; trigger must name an existing html;
   commands validation; remove deletes the folder; maintain/eviction never drops a package skill; suggest skips
   trigger-only skills; capability_read refuses disabled; present has `package.id/dir`. Use a temp userData dir.

## B. Skills UI and the page stage — owner `skills-ui`

Files: `src/SkillsPanel.tsx`, new `src/SkillStage.tsx`, new `src/skill-stage.css`, new `src/skill-triggers.ts`,
`src/App.tsx` (ONLY: line 4 import of useCelebration, line 28 `const celebration = …`, line 77 `onPreview={celebration.preview}`,
line 80 `{celebration.overlay}`), `src/Icon.tsx` (add icons if needed), delete `src/CelebrationOverlay.tsx`,
`src/celebration.ts`, `src/confetti.ts`, `src/celebration.css`, `tests/celebration.test.cjs`; new `tests/skill-triggers.test.cjs`.

1. `src/skill-triggers.ts` (pure, tested): `isCompletion(event)` and `missedCompletions(...)` carried over from
   `celebration.ts` (a completed run triggers, a run that ended `restarting` does not, its continuation's completion does);
   `triggeredSkills(skills)` → enabled skills with a `task-completed` trigger and a `package`;
   `skillPageUrl(skill, show, extra)` → `orbit-skill://${skill.package.id}/${show}?<params>` with every param's current
   value as a string (booleans `true`/`false`) plus `orbit_event` (`task-completed` | `preview`) and `orbit_run` when known.
2. `src/SkillStage.tsx`: `useSkillTriggers(projects, ready, runs)` (the logic of T14's `useCelebration`: runtime
   completion events, completions missed while the window reloaded, handled run ids kept in localStorage — last 50; the
   project's skills are fetched with `window.orbit.listCapabilities(workspace)` each time, so a switched-off skill or new
   parameters apply at once) → `{ stage, preview(skill) }`; pages are queued and shown one at a time. The stage: fixed
   layer over the whole window (above modals), `<iframe src={url} sandbox="allow-scripts allow-same-origin allow-presentation"
   allow="autoplay; fullscreen; encrypted-media; picture-in-picture">`, a close button (top-right, aria-label «Закрыть»),
   closes on a `message` event whose `source` is that iframe's contentWindow and `data.type === 'orbit-skill:close'`, on
   Esc pressed in the host, and after 10 minutes at most. Enters full screen with `window.orbit.setFullScreen(true)` when
   a page shows and restores the previous state when the queue empties.
3. `src/SkillsPanel.tsx`: every skill card shows kind badges («Инструкция», «Страница: по завершении задачи»,
   «Команды: N», «Файлы: N»), the enable switch (keep T14's), a parameters form from `params` (text/url → text input,
   number/seconds → number input, boolean → checkbox; «Сохранить» → `window.orbit.setCapabilityParams`, errors via
   `onError`), «Показать» for skills with a task-completed trigger (stage preview), «Открыть папку»
   (`window.orbit.openPath(skill.package.dir)`), the file list and the commands (collapsed `<details>`). Remove the T14
   action editor. Keep the existing pin / remove / versions / instruction editing.
4. Tests `tests/skill-triggers.test.cjs` for the pure helpers.

## C. The celebration skill package — owner `celebration-skill`

Files: new folder `skills/task-completed-celebration/` in the repository: `page.html`, `celebration.js`,
`celebration.css`, `skill.json`; verification scripts under `scratchpad/celebration-skill/` only.

- `skill.json`: `{ "name": "Праздник по завершении задачи", "description": "…Russian…", "whenToUse": "…", "instructions":
  "…English, for agents: what it is, the trigger, the params, how to change the page files…", "scope": "global",
  "params": [video url default "https://www.youtube.com/watch?v=6-8E4Nirh9s", start seconds 42, end seconds 73,
  text "TASK COMPLETED", confetti boolean true], "triggers": [{"on":"task-completed","show":"page.html"}], "commands": [] }`.
- The page (plain HTML/CSS/JS, no build step, no external scripts besides the YouTube embed iframe): full-window stage;
  the YouTube segment `video` from `start` to `end` s, autoplay with sound, as large as possible (16:9 cover/contain);
  confetti canvas (colourful paper pieces that flutter and spin + emoji, a big burst at start then a steady rain); the
  `text` param in a garish PowerPoint-WordArt style (gradient fill, thick outline, 3D extrusion shadow, fonts like
  Impact / "Comic Sans MS" / "Arial Black") rotating around its own axis AND bouncing across the screen like the DVD logo
  (colour change on every wall hit). Parameters from `location.search` (`video`, `start`, `end`, `text`, `confetti`;
  YouTube id from watch?v=, youtu.be/, /embed/, /shorts/, /live/ links; invalid video → confetti + text only for 12 s).
  Closes at the end of the segment (YouTube iframe API state via postMessage `enablejsapi=1`, plus a fallback timer
  end−start+5 s), on Esc and on a click: `parent.postMessage({ type: 'orbit-skill:close' }, '*')` (outside a frame:
  `window.close()`). `prefers-reduced-motion` → gentler motion. Port the visuals from T14's `src/CelebrationOverlay.tsx`,
  `src/confetti.ts`, `src/celebration.css`, `src/celebration.ts` (read them; another helper deletes them later — copy what
  you need first).
- Verify in Electron (`node scripts/run-electron.cjs <script>` or `npx electron <script>`): serve the folder through a
  registered `orbit-skill` protocol like main.cjs does (or file://), apply the same Referer hook as main's
  `allowVideoEmbeds`, load `page.html?start=42&end=47`, check the video plays (state/time via the iframe API), the text
  moves between two screenshots, the close message is posted at the end. Inspect the screenshots (not blank). Read the
  memory note on blank screenshots first (memory_search "blank screenshots").

## D. T16 duplicated controls — owner `t16-buttons`

Files: `src/AgentInspector.tsx` (and another `src/*.tsx` only if it has the same bug); harness under
`scratchpad/t16-buttons/`.
Suspected cause: in `AgentInspector`, `AgentControlsBar key={agent.id}` and `AgentMessageBox key={agent.id}` are siblings
with the SAME key under `.agent-inspector-shell`; duplicate sibling keys break React reconciliation, so switching agents
leaves old controls in the DOM («плодятся кнопки Пауза и Остановить»). Reproduce with the real components in Electron
(build a small harness like `scratchpad/t14-probe/harness`), fix with distinct keys, scan `src/` for other sibling
duplicate keys, verify: after switching between agents several times there is exactly one `.agent-controls` and one
`.agent-message`.

## E. T17 attachments — owner `t17-attachments`

Files: new `electron/attachments.mts`; `electron/runtime-api.mts` (ONLY the `runtime:message` handler line and new
handlers right after it); `electron/runtime/lifecycle.mts`, `electron/runtime/mailbox.mts`, `electron/runtime/prompts.mts`
(prompt blocks), `electron/providers.mts` (Claude `--add-dir`), `electron/runtime.mts` (facade signature if needed);
`src/Composer.tsx`, `src/ChatPane.tsx`, `src/useOrbitState.ts`, `src/state-store.ts` (if messages are built there), new
`src/attachments.ts(x)`, new `src/attachments.css`, `src/Icon.tsx` (paperclip icon — coordinate with skills-ui if both
add icons: add yours at the end of the icon table), `src/App.tsx` (ONLY the `composer={{…}}` block); tests
`tests/attachments.test.cjs`.

- `electron/attachments.mts`: `saveAttachments(userData, chatId, uploads)` → `<userData>/attachments/<safe chatId>/<8-hex id>-<safe name>`;
  ≤ 10 files per message, each ≤ 20 MB decoded, ≤ 50 MB total; names sanitised; type from the upload, else by extension;
  returns `Attachment[]`. `readAttachmentImage(userData, path)` → data URL for an image ≤ 8 MB inside the attachments
  root, else null. Paths from the window are trusted only inside `<userData>/attachments`.
- runtime-api: `attachments:save`, `attachments:image`; `runtime:message` passes attachments to `postUserMessage`.
- Runtime: `StartPayload.attachments` → the root's task prompt gets, after the user's text:
  `ATTACHMENTS FROM THE USER (files attached to this message; read them with your file tools — an image is shown to you when you read it):`
  then `- <absolute path> (<type>, <size>)` lines. `postUserMessage(runId, agentId, text, attachments?)` → the
  communication carries `attachments` and the steering mail (`mailbox.mts`: mailBlock/userMail/mailboxContext) lists them
  the same way under the message. Server-side: keep only attachments whose path is inside the attachments root and exists.
  A message with attachments and no text is allowed.
- Claude in restricted modes (`--tools Read,Glob,Grep`, `--permission-mode default`) cannot read outside the workspace:
  add `--add-dir <userData>/attachments` to Claude's session and non-session args (the runtime child has
  `process.env.ORBIT_USER_DATA_DIR`; pick the cleanest way, e.g. an `attachmentsDir` launch option set by the runtime).
- Renderer: Composer — paperclip button (hidden `<input type=file multiple>`), drag & drop onto the composer, paste of
  images/files; chips above the textarea (name, size, image thumbnail via object URL, remove ×); limits with a clear
  error. Sending: read files as base64 (FileReader), `window.orbit.saveAttachments(chatId, uploads)`, then `startTask({…,
  attachments})` or `messageAgent(runId, 'root', text, attachments)` while a run works; the chat message keeps
  `attachments`; `ChatPane` shows them as chips (image thumbnails via `readAttachmentImage`, click → `openPath`).
- Tests: save/limits/sanitising/confinement/readImage; the prompt block of a start and of steering mail; Claude args
  contain `--add-dir`.
