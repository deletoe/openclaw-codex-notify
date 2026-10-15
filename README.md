# OpenClaw Codex Notify

[中文](README.zh-CN.md) · [Installation](docs/INSTALL.en.md) · [Deployment workbook](docs/WORKBOOK.md) · [Releases](https://github.com/deletoe/openclaw-codex-notify/releases)

Send unhandled Codex results to your own OpenClaw/Discord network, then route a human Discord reply back to the exact original Codex session.

- Monitors the current macOS user's local Codex CLI and App sessions across projects. Completion, approval, input requests and failures are notified after **20 minutes without handling**. A reply/handled event cancels the pending reminder; each matter is sent at most once.
- Reads session provenance before forwarding. Confirmed CLI-origin sessions use native `codex exec resume`; App-origin sessions use an authorized UI controller or the existing osascript/JXA accessibility route.
- Keeps native reads bounded and read-only. Exact notification IDs, original device/home/thread and persisted user turns verify delivery. Ambiguous sends are not retried automatically.
- Provides explicit installation-time permission checks. Users still approve macOS prompts. Plugin loading itself never requests desktop access.

## Deploy on another computer

Current collector/service support is **macOS**. The Gateway may run elsewhere, such as a Linux VPS. Node.js and an **OpenClaw network node** are different things; both are needed on the Codex Mac. Use Node.js 24.16+ on the 24.x line or a supported 26.1+ runtime, OpenClaw 2026.10.3+, and your own Codex installation/login. Native record formats and App interfaces change; unknown formats stop the relevant operation.

1. Join the Codex Mac to **your own Gateway** as an executable OpenClaw node.
2. Give your OpenClaw agent [the installation guide](docs/INSTALL.en.md).
3. Let it install the plugin/collector on that Mac, authorize that Mac's operator identity, choose your Discord channel and load the reply Skill on the agent host.
4. Complete any manual macOS permission and Codex Hook approvals, then validate on a disposable session.

Paste this into OpenClaw:

> Read https://github.com/deletoe/openclaw-codex-notify/blob/main/docs/INSTALL.en.md and help install OpenClaw Codex Notify v0.3.3 on my Codex Mac connected to this Gateway. Start by identifying the correct online node and checking prerequisites. Use my own Gateway, account, channel and authorized sender IDs. Keep credentials in private files. Follow the guide's agent instructions, ask me only for missing choices or native approvals, and separately report collector installation, notification authorization, reply routing and App permission readiness.

The plugin and collector run on the Mac. [`codex-notify-reply`](skills/codex-notify-reply/SKILL.md) is loaded by the OpenClaw agent handling Discord, usually on the Gateway. A node-only Mac does **not** need a separately installed Skill. The Skill is currently written in Chinese; it gives deterministic command contracts usable by multilingual agents. Installation guides are available in both languages.

## Downloads and development

[Release v0.3.3](https://github.com/deletoe/openclaw-codex-notify/releases/tag/v0.3.3) contains the plugin `.tgz`, a standalone Skill archive and `SHA256SUMS`. The source repo is also a standalone OpenClaw plugin root.

```sh
npm ci
npm test
npm run audit:public
npm run build
```

The build puts release files in `dist/`. `npm run audit:public` checks publication source and the build's pack list; it does not inspect or upload a user's runtime state. See [security and private data](SECURITY.md), [architecture](docs/ARCHITECTURE.md) and the [deployment workbook](docs/WORKBOOK.md).

MIT licensed. Independent integration; not an official OpenClaw or OpenAI product. No hosted service, shared Gateway, or maintainer credential is included.
