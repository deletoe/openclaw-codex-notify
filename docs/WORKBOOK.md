# Deployment workbook / 部署工作文件

This repository is the reusable handoff for a new operator. / 本仓库是交给新部署者和其 OpenClaw agent 的完整工作文件。

| Artifact / 内容 | Location / 位置 | Where it runs / 执行位置 |
| --- | --- | --- |
| English installation | [INSTALL.en.md](INSTALL.en.md) | Human + Gateway agent + target Mac |
| 中文安装指南 | [INSTALL.zh-CN.md](INSTALL.zh-CN.md) | 用户、Gateway agent、目标 Mac |
| Plugin manifest and CLI | `openclaw.plugin.json`, `index.mjs`, `cli.mjs` | Codex Mac |
| Collector, delivery, reply state | `src/notify*.mjs` | Codex Mac |
| Read-only native adapter | `src/readonly-codex.mjs` | Codex Mac |
| Install, pair, permissions, uninstall | `scripts/` | Codex Mac, with Gateway-side approval |
| Reply Skill / 回复技能 | [SKILL.md](../skills/codex-notify-reply/SKILL.md) | Discord-handling OpenClaw agent |
| Permission details / 权限细节 | [English](PERMISSIONS.en.md), [中文](PERMISSIONS.zh-CN.md) | Actual Mac UI executor |
| Examples / 配置示例 | `examples/` | Copy/merge into private state; never publish real values |
| Release / 发布包 | GitHub Releases, local `dist/` after build | Download and inspect before installing |

## Data flow / 数据流

```text
Codex CLI/App on Mac
  → native records + reviewed Codex Hooks
  → local durable reminder queue
  → own Gateway send → own Discord channel

human native Discord Reply
  → own authorized OpenClaw agent + reply Skill
  → exact originating Mac/notification/thread lookup
  → source=CLI: native CLI resume
  → source=App: authorized App UI input
  → persisted user turn verification → delivery registration
```

## Deployment worksheet / 私有部署记录模板

Fill these in a **private local document**, not a public issue or commit. / 在本机私有文件中填写，不要贴到公开 issue 或提交。

- Target Mac / 目标 Mac: node ID, OS user, Codex home, executable paths.
- Gateway: own WSS endpoint and version; record credential file paths only, never tokens.
- Discord: account, channel, owning agent, authorized sender IDs.
- Skill host: actual agent workspace and loaded Skill version.
- Permissions: selected UI provider, macOS responsible app, checks performed via the real node, manual approval/restart still needed.
- Collector: state/config paths, service label, reviewed Hook files, health check.
- Acceptance: notification message reference, exact originating test thread, reply delivery/registration/task status. Keep all IDs private.
- Upgrade/rollback: previous package version, state backup path, native schema compatibility.

## Acceptance boundaries / 验收边界

Code tests do not grant OS permissions. A connected node does not prove desktop availability. A successful click does not prove session switching. A new matching persisted user turn proves delivery even when registration fails. Record installation, grants, notification delivery, reply delivery, registration and task execution separately.

代码测试不等于 OS 已授权；节点在线不等于桌面可操作；点击成功不等于已切换会话。原会话中匹配的新用户 turn 已持久化即证明送达，登记失败也不能重发。请分别记录安装、授权、通知投递、回复送达、登记和任务执行状态。
