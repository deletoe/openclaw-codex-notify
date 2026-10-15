# 安装指南：自己的 Codex Mac 与 OpenClaw 网络

[English](INSTALL.en.md) · [部署工作文件](WORKBOOK.md) · [权限说明](PERMISSIONS.zh-CN.md)

版本：**0.3.3**。当前采集器和服务安装器支持 **macOS**；Gateway 可运行在 Linux VPS。不需要维护者账号、Gateway 或任何维护者凭据。

## 给 OpenClaw agent 的执行约定

先通读指南，再操作。确定用户选择的 Mac 节点、该节点 OS 用户与 Codex 安装；先检查现有安装和状态。Mac 命令使用 `exec host=node node=<真实nodeId>`；Gateway 管理和 Skill 加载在 Gateway/agent 主机完成。不能把 Gateway 目录当作 Mac 目录。

只询问缺失选择：目标 Mac、自己的 Gateway WSS 地址、Discord 账号/频道/所属 agent、允许回传的人类用户 ID，以及需要 App 回复时已选择的 UI 控制方式。不要让用户把 token/私钥贴到聊天。保留原有节点身份、CLI/session-host 能力、其他配置和 Hooks、桌面草稿。遵循现有节点/工具/Discord 策略，拒绝不构成换驱动规避的许可。

分阶段报告：插件/采集器已安装、operator 已授权、通知目标已启用、Skill 已加载、回复发件人白名单已配置、App 权限已验证。有一项没完成就如实列出。发现采集器属于另一配置时，使用原配置或安排保留状态的迁移，不能启动第二份竞争采集器。

## 1. 准备 Codex Mac 并接入自己的网络

在 Mac 检查 Node.js（24.x 的 24.16+ 或受支持的 26.1+）、npm、OpenClaw 2026.10.3+，以及用户自己的 Codex 安装/登录：

```sh
node --version
npm --version
openclaw --version
codex --version
```

缺失时按[官方安装文档](https://docs.openclaw.ai/install)准备 Node/OpenClaw，并与 Gateway 版本兼容。macOS 服务与权限机制不同于 Linux/Windows，本版不在后两者安装采集器。

如果 Mac 已配对且能执行命令，复用它。否则在**自己的 Gateway**生成一次性加入命令：

```sh
openclaw devices join-code
```

在 **Mac** 执行 Gateway 输出的命令，使用其指定版本和私有加入链接。后台运行保留 `--service`。输出可能包含 `--session-host`：仅当所有者希望这台受信 Mac 托管 agent session 时保留；通知功能只需可执行的节点，session hosting 是可选项。不要为省略审批添加 `--all-commands`。加入链接是短期凭据，不应进入公开聊天/日志。

在 Gateway 用当前节点 list/describe 工具确认所选节点在线并有 `system.run`。按现有策略只批准确切设备/能力请求。后续 operator 或 App 权限缺失时，不要重新配对或覆盖节点身份。[官方节点接入说明](https://docs.openclaw.ai/cli/connect)。

## 2. 在目标 Mac 下载并安装插件

在 **Mac** 的私有临时目录下载固定版本：

```sh
umask 077
NOTIFY_DOWNLOAD_DIR="$(mktemp -d)"
cd "$NOTIFY_DOWNLOAD_DIR"
curl --fail --location --proto '=https' -o openclaw-codex-notify-0.3.3.tgz https://github.com/deletoe/openclaw-codex-notify/releases/download/v0.3.3/openclaw-codex-notify-0.3.3.tgz
curl --fail --location --proto '=https' -o SHA256SUMS https://github.com/deletoe/openclaw-codex-notify/releases/download/v0.3.3/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
tar -tzf openclaw-codex-notify-0.3.3.tgz
openclaw plugins install ./openclaw-codex-notify-0.3.3.tgz
openclaw codex-notify --help
```

信任前审核确切包/源码。校验值能发现相对于下载清单的变化，但不等于独立的发布者签名。OpenClaw 可能要求本地来源和能力审核。对已审核且获准的非交互安装，支持的版本可用 `--force --accept-capabilities`；这些参数不会批准 macOS 权限或其他工具策略。

确保命令管理的是目标 Mac 的本地插件。仅把插件装在 VPS 不能采集 Mac 会话。

## 3. 安装采集器并审核 Codex Hooks

在 **Mac** 将示例地址换成自己的 WSS 地址：

```sh
openclaw codex-notify install --gateway wss://gateway.example.com:443
openclaw codex-notify install --gateway wss://gateway.example.com:443 --apply
```

第一条预览，`--apply` 才写备份、私有配置、5 个 Hook handler 和 LaunchAgent。初始禁止发送。默认配置/状态在 `~/.openclaw/codex-notify/`，服务名是 `com.openclaw.codex-notify`；以安装输出的实际路径为准。自定义或已有状态目录时，每条命令都在 `codex-notify` 后加入 `--config /绝对路径/私有config.json`。

在 Codex 正式 `/hooks` 界面审核并信任新增 handler，必要时重载相应客户端；不同 Codex home 可能各需审核。不绕过 Hook trust、不覆盖无关 Hooks。采集器覆盖当前 OS 用户的各项目本地会话；其他 OS 用户和远程主机另行部署。

## 4. 授权该 Mac 的通知 operator

节点配对、operator 权限、macOS 桌面权限是不同层。在 **Mac** 执行：

```sh
openclaw codex-notify pairing-request
```

把输出中的说明、地址和 Mac 私有目标路径交给自己的 Gateway 管理 agent。在 **Gateway** 使用自己的地址生成 mode-600 的 setup JSON：

```sh
umask 077
NOTIFY_PAIRING_DIR="$(mktemp -d)"
openclaw qr --public-url wss://gateway.example.com:443 --json > "$NOTIFY_PAIRING_DIR/pairing.json"
```

先创建并使用真实的私有临时目录。通过已有可信节点文件传输或 SSH 把文件送到 `pairing-request` 打印的 Mac 位置；不要 echo/base64 到模型可见聊天记录。不要用 `--limited`：本版为跨 agent 查询频道，申请 `operator.read`、`operator.write` 和 **`operator.admin`**。admin 是广泛权限，应按这个范围审核。

在 **Mac** 执行：

```sh
openclaw codex-notify pair --file ~/.openclaw/codex-notify/pairing.json
```

返回 `PAIRING_REQUIRED` 时，核对设备/request/scopes，再在 **Gateway** 执行输出中确切的 `approvalCommand`；凭据过期前在 Mac 重跑 `pair --file`。认证错误但没有 request ID，不代表已存在待批准请求。过期则生成新的 setup 凭据，不要为此撤销或覆盖现有 node token。

随后验证不依赖 setup 文件的重连：

```sh
openclaw codex-notify pair
```

成功后删除两端本次临时配对文件，保留私有 `operator.json` 与 SQLite。安装器在兼容情况下复用现有 node 设备身份；原生 OpenClaw 状态格式变化时明确失败，不猜字段或复制另一电脑身份。

## 5. 选择 Discord 目标和允许回传的人

在 **Mac** 执行：

```sh
openclaw codex-notify channels --query codex
openclaw codex-notify target --channel-id YOUR_CHANNEL_ID --account YOUR_ACCOUNT_ID --agent YOUR_AGENT_ID
```

核对实际 Discord 服务器、频道、账号和所属 agent，注意同名频道；查询可覆盖各可见 agent。保存目标时仍禁止发送。本包不新建 Discord bot，自己的 Gateway 应已配置该账号。

在**安装输出的私有配置**中安全合并以下片段，填真实的人类 Discord 用户 ID。新安装默认空数组，未配置时拒绝全部回复发件人：

```json
{"replies":{"allowedSenderIds":["YOUR_HUMAN_DISCORD_USER_ID"]}}
```

保留其余字段，不能用片段覆盖整份配置。Gateway 现有发件人/guild/channel/提及策略继续有效。可选私有配置：`replies.cliBinary`（CLI 绝对可执行路径）、`replies.readerBinary`（兼容原生查询器绝对路径）、`replies.cliTimeoutMs`。默认优先发现 App 内置二进制或 PATH 中的 CLI；LaunchAgent 环境受限时可以显式指定。

然后执行：

```sh
openclaw codex-notify enable
openclaw codex-notify status
```

检查输出的健康/状态路径，确认服务在运行、原生扫描健康、Gateway 配置正确。不把私有记录/凭据贴到 Discord；通知会携带 Codex 结果和来源信息，应选择适当私密的频道。

## 6. 在 agent 主机加载回复 Skill

阅读 [Skill](../skills/codex-notify-reply/SKILL.md)。把固定版本源码 `skills/` 下的完整 `codex-notify-reply` 文件夹，或独立 Skill 包中的该文件夹，复制到**实际处理 Discord 的 agent workspace 的 `skills/` 目录**。它通常在 Gateway/agent 主机；替换前检查是否已有内容，多 agent 时不能假定默认 workspace。

按当前 OpenClaw 版本的正常 Skill 发现/刷新/下一轮机制生效，并确认目标 agent 能看到 `codex-notify-reply`；可用 `openclaw skills info codex-notify-reply --json` 辅助检查当前上下文。纯节点 Mac 不需要 `reply-skill --apply`、额外 Skill 副本，也不需要为了发布 Skill 重启节点。

确认原生回复机器人消息能在现有提及策略下进入该 agent，不全局放宽提及、发件人或工具规则。必须具备原生 reply reference 和真实 sender 元数据，粘贴 ID/引用正文不足以路由。多 Mac 情况必须恰好一个在线节点持久化匹配该通知。

## 7. 按需准备 App 权限

CLI 来源回复依赖原生 CLI 和既有 Codex 授权，不需要桌面控制；App 来源另需已授权 UI 控制方式。插件本身不是通用桌面驱动，Skill 编排的是 OpenClaw 已有的控制工具。

优先采用签名和身份稳定的 OpenClaw.app/helper，在 **Dashboard → Settings → This Mac → Permissions** 与 Computer Control 原生确认中授权。检查真实节点的能力/权限报告；CLI node 不会因安装伴随 App 自动迁移为 App 控制节点。

已有且选定 JXA 路径时，通过**未来真正执行 App 操作的同一 Mac 节点环境**执行：

```sh
openclaw codex-notify permissions --backend jxa
openclaw codex-notify permissions --backend jxa --request --verify
# 用户手动调整后复核：
openclaw codex-notify permissions --backend jxa --verify
```

用户可能要操作 macOS 弹窗/设置并重开权限主体程序。探针按需申请辅助功能和对 System Events 的自动化权限，不输入、不点击、不切换会话、不发送消息；纯 AX/JXA 不申请屏幕录制，截图驱动另查自己的权限。缺失时非零返回；`uiReadVerifiedForCurrentExecutor=true` 只证明该只读探针通过，不证明输入或路由。Terminal/Codex 内检查不能代表节点授权。拒绝时停止，不换工具规避。[详细说明](PERMISSIONS.zh-CN.md)。

首次安装明确选定 JXA 时，可在 `install --apply` 后加 `--app-permissions jxa` 合并安装期申请/验证。仅重查权限时不用重跑安装。

## 8. 验收并交接

使用所有者同意的一次性 Codex 测试会话。结果按正常规则保持 20 分钟未处理后，在选定频道检查单条提醒。不要为演示缩短生产期限或更换生产状态目录。

用 Discord **原生 Reply** 回复提醒。agent 应精确定位原 Mac/home/thread，执行鉴权和去重，重读来源与基线；只有确认 CLI 来源才走 CLI，App 来源使用已授权 UI。App 输入前核对正文标题、项目和最近上下文，保留已有草稿；来源未知、忙碌或存在冲突时停止。

在原会话核对新持久化且匹配的用户 turn，分别报告**送达、插件登记、任务状态**。App 原生正文只多一个 LF 时，可由窄兼容规则登记。观察到实际送达后 `reply-confirm` 失败，只允许补登记，不能重新打字或重启 CLI 发送。仅查看会话不取消待提醒，实际回复/处理才会。

将私有部署信息记入 [WORKBOOK.md](WORKBOOK.md) 的记录模板。代码测试、采集器健康、只读权限预检均不代表真实端到端验收已完成。

## 升级、停用、卸载

复用同一配置/状态目录，保留 SQLite outbox、回复去重和 operator 凭据。升级前停止服务，在插件目录外备份，安装新包后审核变化的 Hooks 再重启。服务与配置不匹配时安排迁移，不能创建第二份采集器。

```sh
openclaw codex-notify stop
# 安装已审核的新包，并审核发生变化的 Hooks。
openclaw codex-notify start
openclaw codex-notify status
# 禁止发送 / 卸载采集器，先预览再 apply：
openclaw codex-notify disable
openclaw codex-notify uninstall
openclaw codex-notify uninstall --apply
openclaw plugins uninstall codex-notify
```

先卸载采集器，再删除插件代码。卸载保留私有状态/凭据以便审计和去重；电脑退役时另行撤销 Gateway 授权。格式或权限漂移采用官方修复流程，不删除锁、不改 TCC/原生会话数据库、不禁用 sandbox/审批来强行通过。
