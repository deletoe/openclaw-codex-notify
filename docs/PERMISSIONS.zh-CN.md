# 安装阶段完成 App 权限准备

Skill 在 VPS 的 OpenClaw agent 中加载；权限属于目标 Mac 上实际操作 App 的程序。插件载入、npm 安装脚本和 Skill 自动发现均不触发授权。只在用户明确选择配置 App 控制时进入下列流程，已有权限通过就不重复请求。

## 官方推荐：稳定的签名 App 承载权限

OpenClaw 官方推荐把辅助功能权限授予 OpenClaw.app、Peekaboo.app 或专用签名 helper，保持安装路径、bundle ID 和签名稳定。共享 `node` 的权限不是某个插件独享，不能把“允许 node”当作本插件的专属授权。

选用原生 Computer Control 时，在目标 Mac 的 **OpenClaw.app → Dashboard → Settings → This Mac → Permissions** 检查和申请所需权限，并由用户确认开启 Computer Control。辅助功能、事件投递和屏幕录制分开检查；本地权限与 Gateway 节点/工具授权也是两层。使用 `node.describe` 查看当前节点公开的能力和权限，再用该节点的实际控制工具验收。不同版本的页面与权限卡片可能不同，以安装版本提供的入口为准。

这不代表给 OpenClaw.app 的授权会自动覆盖独立 LaunchAgent 下的 `osascript`，也不代表安装伴随 App 后已有 CLI 节点会自动迁移。更换执行端必须单独检查节点归属、能力和权限。已有工具/策略明确拒绝后，不可通过换驱动绕过。

## 当前 JXA 路径的安装预检

插件 v0.3.2 提供以下命令。**通过后续真正运行 JXA 的同一 Mac 节点执行**（例如 Gateway 的 `exec host=node node=<真实nodeId>`）；不要拿 Terminal、SSH 或 Codex 内的结果代替节点验收。

```sh
# 查看官方路径和使用说明；不执行系统探针
openclaw codex-notify permissions

# 不弹窗、不启动 App、不读取聊天正文的权限检查
openclaw codex-notify permissions --backend jxa

# 用户选择配置权限后，申请缺失权限并做只读窗口结构验证
openclaw codex-notify permissions --backend jxa --request --verify

# 手工调整权限后，从同一节点复核；需要时显式打开对应设置页
openclaw codex-notify permissions --backend jxa --verify --open-settings
```

首次安装也可显式合并到安装步骤：

```sh
openclaw codex-notify install --gateway wss://你的Gateway地址:443 --apply --app-permissions jxa
```

该选项只适用于已经选定 JXA 的部署。采集器安装成功与 App 权限准备成功分开报告；权限不齐不会伪称安装完全就绪，也不会撤销已安装的采集器。已经运行的节点无需重新安装，直接运行 `permissions` 即可。本机仍不需要额外安装 Skill。

探针使用 macOS 公共 API：`AXIsProcessTrusted`、`AXIsProcessTrustedWithOptions` 与 `AEDeterminePermissionToAutomateTarget`。自动化只检查对 **System Events** 的权限，目标 App 通过 `com.openai.codex` 核实；不为当前 AX 路径申请无用的相机、麦克风、全磁盘或屏幕录制权限。若以后选择截图或另一控制后端，需再检查该后端自己的权限。

`--request` 允许启动 System Events 并请求缺失授权。授权弹窗和系统开关由人操作；辅助功能请求是异步的，发起请求不等于已经获批。自动化明确拒绝时停止，请用户在系统设置中处理。默认检查最长 15 秒，申请最长 55 秒；超时只报告未确定，不能因此反复弹窗。System Events 没运行返回 `target_not_running`，不能当成已拒绝或已授权。

`--verify` 仅在权限通过且 App 身份唯一时读取窗口角色、数量和尺寸，不切换会话、不点击、不聚焦、不输入、不发消息、不读取标题或聊天正文。返回 `uiReadVerifiedForCurrentExecutor=true` 只证明当前执行环境能读取窗口结构，**不证明输入能力、正确会话定位或端到端送达**。发送前仍执行 Skill 的正文核对、草稿保护和去重。输出的进程链不包含命令行参数，也不能据此断言哪个程序是 macOS 最终认定的权限主体；以系统提示/设置中的实际身份为准。

程序重启、签名/路径变化或版本升级后重新预检；不把过去的成功缓存当作永久授权。不会自动点击授权按钮、写 TCC 数据库、执行 `tccutil reset`、扩大 Gateway 策略或切换拒绝过的驱动。

## Apple 的批量预配置方式

组织管理的 Mac 可以用 MDM 下发 PPPC，对受支持的权限按应用身份和代码签名要求配置。它不是普通 npm 安装器可用的“静默授权全部”机制，也不能把所有服务都视为允许自动授予；屏幕录制等服务的规则需分别核对。个人 Mac 使用上面的用户参与授权流程即可。

参考：

- [OpenClaw macOS permissions](https://docs.openclaw.ai/platforms/mac/permissions)
- [OpenClaw Peekaboo bridge](https://docs.openclaw.ai/platforms/mac/peekaboo)
- [Apple 辅助功能授权](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac)
- [Apple 自动化权限 API](https://developer.apple.com/documentation/coreservices/3025784-aedeterminepermissiontoautomatet)
- [Apple TCC responsible code 说明](https://developer.apple.com/forums/thread/693744)
- [Apple PPPC 部署要求](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web)
