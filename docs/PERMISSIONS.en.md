# App permissions during installation

[中文](PERMISSIONS.zh-CN.md) · [Installation](INSTALL.en.md)

Load the Skill on the Discord-handling agent host. macOS permissions belong to the program actually operating the target Mac, not the Skill text. Loading the plugin, installing npm packages and discovering Skills never request desktop access automatically. Start setup when the user explicitly chooses App control; skip requests when current checks already pass.

## Official preferred route

OpenClaw recommends granting Accessibility to a signed OpenClaw.app, Peekaboo.app or dedicated helper with stable path, bundle ID and signing identity, instead of a generic shared Node runtime. A `node` grant can cover other packages launched through that same runtime and is not a package-specific permission.

For native Computer Control, use **OpenClaw.app → Dashboard → Settings → This Mac → Permissions** on the target Mac and accept its native capability confirmation. Accessibility, Event Posting and Screen Recording are separate checks; local TCC grants and Gateway node/tool permission are separate layers. Inspect the actual node's `node.describe` capabilities/permissions, then use its real provider for acceptance. UI labels/cards vary by installed version.

A companion-app grant does not automatically cover independent LaunchAgent-launched osascript. Installing the companion does not silently migrate the CLI node. Provider changes require separate identity/capability/permission validation. Do not change drivers to bypass a denied operation.

## Existing JXA deployments

Run through the same Mac node executor used for future JXA App input:

```sh
# Guidance only, no system probe
openclaw codex-notify permissions
# Passive public API checks, no prompts or UI access
openclaw codex-notify permissions --backend jxa
# Explicit request plus read-only window verification
openclaw codex-notify permissions --backend jxa --request --verify
# After manual grant; optionally open the relevant settings pane
openclaw codex-notify permissions --backend jxa --verify --open-settings
```

A new install may add `--app-permissions jxa` to `install --apply`. It is only for explicitly selected JXA deployments. Collector installation and permission readiness are reported separately. Existing nodes only need the permission command, not a second collector or a local Skill copy.

The probe uses public `AXIsProcessTrusted`, `AXIsProcessTrustedWithOptions` and `AEDeterminePermissionToAutomateTarget`. It checks automation toward System Events and identifies the target App by `com.openai.codex` (its process may be named ChatGPT). The AX-only route does not request camera, microphone, full-disk or screen-recording access. Another provider, such as screenshots, has its own requirements.

Only `--request` may launch System Events and request missing grants. Users operate native dialogs/settings. AX requests are asynchronous: requesting is not proof of approval. A known automation denial stops requests/UI checks and needs user action in settings. Passive checks are bounded to 15 seconds, explicit requests to 55 seconds; a timeout is unknown, not permission to repeat requests. A stopped System Events process is `target_not_running`, not granted or denied.

`--verify` reads only window role/count/size after grants and unique App identity pass. It does not switch/focus/click/type/send or read titles/chat/drafts. `uiReadVerifiedForCurrentExecutor=true` proves only this invocation's window read; input, session identity and delivery still need separate checks. Process ancestry contains no command arguments and does not prove which app macOS treats as responsible. Use the actual system prompt/settings identity. Terminal/SSH/Codex success cannot substitute for the node result.

Recheck after changes to executable/path/signature/provider. Do not cache past success as permanent authorization. The installer does not click Allow, edit TCC, run tccutil reset, expand Gateway rules or select a previously denied driver.

## Managed fleet preconfiguration

Organizations can use MDM with supported Privacy Preferences Policy Control (PPPC) settings, identified by app/path and code-signing requirement. This is not a normal npm installer's silent grant-all mechanism. Services such as screen recording have separate restrictions. A personal Mac uses the user-attended setup above.

References: [OpenClaw macOS permissions](https://docs.openclaw.ai/platforms/mac/permissions), [Peekaboo bridge](https://docs.openclaw.ai/platforms/mac/peekaboo), [Apple Accessibility](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac), [Apple automation API](https://developer.apple.com/documentation/coreservices/3025784-aedeterminepermissiontoautomatet), [Apple responsible code](https://developer.apple.com/forums/thread/693744), [Apple PPPC](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web).
