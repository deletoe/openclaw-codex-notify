# Architecture and operational contract

The package is a lazy OpenClaw CLI plugin plus a macOS LaunchAgent collector. Plugin loading only registers CLI discovery. It does not start services, send messages, request permissions, or execute a model turn.

The collector scans supported native Codex records and consumes reviewed Hooks. It tracks matters in local SQLite, waits 20 minutes for handling, reconciles the native state again before sending, and stores a durable idempotency key. It sends through the public Gateway client SDK into the operator's configured Discord account/channel. Sleeping delays dispatch; handled events observed after waking cancel pending reminders. Historical records at initial enrollment are not replayed. An ambiguous send is retained as uncertain.

Sent receipts persist the Gateway/account/channel/message reference together with original node, native home, thread, project, turn/request and reminder identifiers. A native Discord Reply is resolved using these exact references. Same-title text, a pasted message ID, or another current chat cannot identify the target.

The agent uses `reply-resolve`, `reply-prepare`, `reply-read`, then the appropriate input route. CLI provenance requires compatible source and CLI originator; Desktop provenance requires compatible source and Desktop originator. Unknown, IDE, conflicting and ephemeral cases stop. Provenance describes creation, not an exclusive current-client lease; `notLoaded` is not idle.

CLI replies use the bound UUID/home/cwd with `codex exec resume --json UUID -`, passing raw text through stdin. App replies use a selected, authorized UI provider. App activation is validated against main content title, project and recent context; draft protection is retained. AX element lookup is fresh, then scroll-to-visible, positive size, focus/read-back and Return where applicable. Click completion alone is not proof of switching.

Native history inspection permits only `thread/list` and `thread/read` RPCs over a bounded read-only App Server. It does not inherit Gateway credentials or accept arbitrary native RPCs. The App-bundled binary is preferred; CLI-only installs can use a discovered CLI or `replies.readerBinary`. `replies.cliBinary` independently selects the CLI input executable.

Reply states are `prepared → sending → forwarded`, with uncertain attempts retained and not automatically repeated. A new matching user turn after the saved baseline proves delivery. Registration persistence and task completion are separate. Registration-only recovery never starts a new input. App-only compatibility accepts exactly `observed === original + "\n"`; no broad `trim()` or whitespace conversion is used.

Installation-time permissions are explicit, run via the real Mac executor and use public macOS APIs. The signed OpenClaw companion is the recommended permission owner. Existing JXA deployments have a bounded preflight/request/read-only verification command. A read-only window probe does not prove input or session routing. The packaged Skill runs on the Discord agent host; the Mac node only needs the execution plugin.

Current scope: local macOS user and local Codex sessions. The Gateway can be remote. Linux/Windows collectors, a new Discord bot, a general desktop automation driver, and autonomous permission approval are not supplied. Follow the installation guides for pairing, Hook review, sender authorization, upgrade and uninstall.
