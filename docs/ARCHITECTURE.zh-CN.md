# 实现与运行约定

本项目由惰性加载的 OpenClaw CLI 插件和 macOS LaunchAgent 采集器组成。插件加载只登记 CLI，不启动服务、不发消息、不弹权限窗，也不调用模型。

采集器读取兼容的 Codex 原生记录并消费已审核的 Hooks，用本机 SQLite 记录事项；20 分钟未处理时再次核对原生状态，再经公共 Gateway SDK 发到用户自己的 Discord 账号/频道。发送使用持久化幂等键；睡眠会推迟发送，唤醒后观察到已处理则取消。首次启动不会重放历史事项；投递结果不明时保留 uncertain，不自动重发。

已发送回执保存 Gateway、账号、频道、消息引用，以及原节点、native home、thread、目录、turn/request 和提醒 ID。Discord 原生 Reply 依靠这些精确映射路由；不能用同名标题、粘贴的 ID 或当前聊天猜目标。

agent 调用 `reply-resolve`、`reply-prepare`、`reply-read` 后按原生来源选择输入路径。CLI 来源要求 source 与 CLI originator 一致；App 来源要求兼容 source 与 Desktop originator 一致。未知、IDE、冲突或临时会话停止。创建来源不代表当前客户端独占；`notLoaded` 不能当作空闲。

CLI 回复固定 UUID/home/cwd，用 `codex exec resume --json UUID -` 从 stdin 传入原文。App 回复使用已选择且获准的 UI 控制方式，保留草稿，并以正文标题、项目和最近上下文确认目标。AX 切换按重新定位、滚动到可见、核对正尺寸、聚焦读回、回车执行；动作返回成功本身不证明切换成功。

原生查询器只允许有界、只读的 `thread/list` 与 `thread/read` App Server RPC，不继承 Gateway 凭据，不接受任意 RPC。优先使用 App 内置二进制；纯 CLI 安装可自动发现 CLI 或配置 `replies.readerBinary`。CLI 输入二进制单独由 `replies.cliBinary` 选择。

回复状态是 `prepared → sending → forwarded`；不确定尝试保留核对，不能换通道重发。原会话在基线后新增且正文匹配的用户 turn 证明实际送达；插件登记与任务完成分别报告。补登记不重新输入。App 路径只额外兼容一个追加 LF，即 `observed === original + "\n"`，不使用宽泛 `trim()` 或空白转换。

安装期权限是显式步骤，须由真实 Mac 执行端调用公共 macOS API。官方签名 OpenClaw 伴随 App 是推荐权限主体；已有 JXA 部署可用有界的检查、申请和只读窗口验证。读窗口成功不等于输入或会话路由成功。Skill 在处理 Discord 的 agent 主机加载，Mac 节点只装执行插件。

当前支持本机 macOS 用户的本地 Codex 会话；Gateway 可以远程运行。Linux/Windows 采集器、新 Discord bot、通用桌面控制驱动和自动批准权限不在本包中。配对、Hook 审核、发件人授权、升级和卸载请按安装指南执行。
