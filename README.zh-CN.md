# OpenClaw Codex Notify

[English](README.md) · [中文安装指南](docs/INSTALL.zh-CN.md) · [部署工作文件](docs/WORKBOOK.md) · [发布下载](https://github.com/deletoe/openclaw-codex-notify/releases)

把本机 Codex 的未处理结果发送到你自己的 OpenClaw/Discord 网络，并把人类对提醒的原生 Discord 回复送回原 Codex 会话。

- 监控当前 macOS 用户的本地 Codex CLI 和 App 会话，覆盖不同项目。完成、审批、输入请求和失败在 **20 分钟未处理**后提醒；回复或处理会取消待提醒事项，每个事项只发送一次。
- 发送前读取原生来源。确认是 CLI 来源时使用原生 `codex exec resume`；App 来源使用已经获准的 UI 控制或现有 osascript/JXA 辅助功能路径。
- 原生查询有界且只读。以通知消息 ID、设备/home/thread 的精确映射和持久化用户 turn 确认送达。发送结果不明时不自动重发。
- 安装时可显式申请和检查权限，系统弹窗仍由用户确认；插件加载不自动申请桌面控制权限。

## 换一台电脑部署

当前采集器和服务安装器支持 **macOS**；Gateway 可以在 Linux VPS 等其他主机。Node.js 运行时与 **OpenClaw 网络节点**是两件事，Codex Mac 上两者都要具备。准备 Node.js 24.x 的 24.16+ 或受支持的 26.1+ 版本、OpenClaw 2026.10.3+，以及用户自己的 Codex 安装和登录。原生记录格式与 App 界面可能随更新变化；不认识的格式会停止相关操作。

1. 把 Codex Mac 作为可执行的 OpenClaw node 接入**自己的 Gateway**。
2. 把[中文安装指南](docs/INSTALL.zh-CN.md)交给自己的 OpenClaw agent。
3. 让它在目标 Mac 安装插件和采集器，为该 Mac 申请 operator 权限，选择自己的 Discord 频道，并在 agent 所在主机加载回复 Skill。
4. 用户完成必要的 macOS 权限和 Codex Hook 审核，再用一次性测试会话验收。

可直接把这段话发给 OpenClaw：

> 请读取 https://github.com/deletoe/openclaw-codex-notify/blob/main/docs/INSTALL.zh-CN.md ，帮我在已接入当前 Gateway 的 Codex Mac 上安装 OpenClaw Codex Notify v0.3.3。先确认正确的在线节点和前置条件。使用我自己的 Gateway、Discord 账号、频道和授权用户 ID；凭据只落私有文件。按指南中的 agent 指令执行，只就缺失信息和系统原生授权向我提问，分别报告采集器安装、通知权限、回复路由和 App 权限的就绪情况。

Mac 运行插件和采集器；[`codex-notify-reply`](skills/codex-notify-reply/SKILL.md)由处理 Discord 的 OpenClaw agent 加载，通常在 Gateway 上。仅作为节点的 Mac **不用额外安装 Skill**。

## 下载与开发

[v0.3.3 发布页](https://github.com/deletoe/openclaw-codex-notify/releases/tag/v0.3.3)提供插件 `.tgz`、独立 Skill 压缩包和 `SHA256SUMS`。源码仓库本身也是可构建的独立 OpenClaw 插件项目。

```sh
npm ci
npm test
npm run audit:public
npm run build
```

发布文件生成到 `dist/`。公开内容审查只检查仓库源码与打包清单，不读取或上传用户运行状态。另见[隐私与安全](SECURITY.md)、[实现说明](docs/ARCHITECTURE.zh-CN.md)和[部署工作文件](docs/WORKBOOK.md)。

MIT 许可证。独立集成项目，非 OpenClaw/OpenAI 官方产品；不附带共享服务、共享 Gateway 或维护者凭据。
