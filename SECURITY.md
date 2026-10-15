# Security and private data

Use your own Gateway and per-computer identity. The plugin requests `operator.read`, `operator.write` and `operator.admin`; admin currently enables cross-agent Discord directory discovery and is broad Gateway authority. Gateway approval is a separate trust decision from node pairing and macOS authorization.

The collector intentionally forwards Codex result text and source metadata to the configured Discord destination. Choose a channel whose members may see that information. Native Discord sender/guild/channel/mention policies still apply. New installations set `replies.allowedSenderIds` to `[]` (deny all); explicitly fill the human sender allowlist before enabling reply forwarding.

Keep credentials, private keys, setup/join links, Discord IDs, notification bodies, native session records, SQLite state, logs and permission/process reports out of public issues and commits. Configuration belongs under the current user's OpenClaw private state, not this source checkout. Suggested modes: directories 700, private JSON files 600.

`npm run audit:public` checks common secret patterns, unexpected private files, personal macOS paths, private-network addresses and the published file list. It is a publication aid, not a guarantee that arbitrary user content is safe to disclose. All committed test messages and Discord IDs are synthetic. The repository does not include a user's runtime state or original private Git history.

Replies require the exact persisted Discord notification binding and freshly classified native Codex source. Native reads do not resume a thread. App input stays in an explicitly authorized UI driver; permission/tool denials stop it. There is no fallback from rejected App control to CLI takeover. Ordinary reply text never automatically approves a pending tool/OS request.

Unknown send outcomes remain uncertain and are not automatically resent. One App-added LF is accepted only under the documented App source/transport conditions; whitespace is otherwise preserved. Delivery, registration and task status are separate facts.

The integration depends on evolving OpenClaw/Codex schemas and UI behavior. A schema mismatch should stop the affected operation and preserve evidence, not rewrite native stores or guess a session. Do not reset TCC or edit permission databases as part of installation.

If reporting a vulnerability, share a minimal redacted description through a private security advisory if available. Never include live credentials or another user's session content. Dependency licenses remain their respective owners'.
