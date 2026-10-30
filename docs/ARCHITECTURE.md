# 调研与架构决策

## 已查阅的方案

| 来源 | 可复用的思路 | 对此项目的判断 |
| --- | --- | --- |
| [OpenAI app-server 官方文档](https://learn.chatgpt.com/docs/app-server) | 线程、轮次、真实状态、事件订阅、审批与中断；Unix Socket 使用 WebSocket | 使用官方控制协议，不复刻 agent 执行循环 |
| [HAPI](https://github.com/tiann/hapi) 与 [共享 Codex 会话说明](https://hapi.run/docs/guide/codex-shared-sessions) | 终端与移动端共享 app-server，本地运行，移动端持续控制 | 功能成熟但范围包括多类 agent、Hub、Runner、原生客户端及中继；当前需求是已有三个本机入口的统一观察面，因此不安装另一套启动包装 |
| [Codex WebUI](https://github.com/lezi-fun/codex-webui) | 真正连接 app-server，支持审批、工具流与手机布局 | 适合完整 Codex 聊天 UI；其默认独立 stdio app-server 并不直接覆盖本机所有已有进程和三个独立 home |
| [codex-monitor](https://github.com/lucianlamp/codex-monitor) | 发现已有控制端点，区分 daemon 控制面与自建运行实例，避免无条件 resume/fork | 采用发现已有端点的方式，先只读 `thread/loaded/list`、`thread/read`，用户选中后才对已加载线程重接事件 |

调研查阅了以上项目的 README；未将第三方项目整体复制为运行框架。控制连接使用 `ws` 包。UI 使用原生浏览器模块，Markdown 使用 Marked、DOMPurify 和 Highlight.js；`npm ci` 将锁定版本的浏览器模块及许可证复制到 `public/vendor/`，可随静态前端部署，无需访问 CDN。HTTP 与 Linux 进程读取使用 Node.js 标准库。

## 2026-10-26 实机验证得到的事实

以下为 CLI 0.164.0 环境的历史观察。2026-10-29 的 0.165.0 环境没有发现可连接接口，不能把下面的控制能力当作所有 CLI 版本的保证。

- 入口 `codex`、`codex1`、`codex2` 使用独立 home；后两个入口是 shell 函数，最终执行的二进制名称并不能说明入口归属。
- 当时 CLI 版本为 `0.164.0`，三个 home 均存在可连接的控制 socket。
- 一部分 daemon 是服务管理进程，其监听 socket 不接受 app-server WebSocket 协议。实现只选择已识别的 app-server 进程，避免把管理 socket 当成会话接口。
- 实际进程既有共享 app-server，也有持有 rollout 文件的独立终端；独立终端不能通过给另一个 app-server 发 `thread/resume` 安全接管。
- CLI 0.164.0 的实验性 `thread/queue/add`、`thread/queue/list`、`thread/queue/delete` 可操作同一 home 的 Codex 原生持久队列。独立终端会监听并消费自己的队列，不要求该线程被另一个 app-server 加载。已在专用独立终端实测，再通过公网网页完成一轮提交与回复验证。
- 已通过本机 Unix WebSocket 读取真实 loaded thread 的 `active` 和 `idle` 状态。stdio proxy 探测在此机器上没有返回初始化响应，已改为官方文档描述的 WebSocket Upgrade 方式。

## 数据与控制路径

```text
电脑 / 手机浏览器
    │ 同源 HTTP + 登录 Cookie + SSE 更新
    ▼
本机 Node HTTP 服务
    ├─ /proc：同用户 Codex 进程、父子关系、文件句柄、监听 socket
    ├─ 三个 home/sessions：活动日志增量索引、历史日志有界摘要
    ├─ Unix WebSocket → 已有 app-server：状态、续接、发送、中断、审批
    │                                  原生队列增删查 → 独立终端自行接收
    └─ 项目 .local：访问密钥、已读状态、指令队列及发送记录
```

会话主键是 `入口:threadId`。进程和任务不是一对一关系：一个 app-server 可以承载多个会话，空闲会话也可以保留进程，工具进程又可能是多层后代。进程存活与日志最近修改时间都不单独用于宣告任务正在执行或已经完成。

状态来源优先级：官方 live thread 状态；其次是日志明确的开始、完成和中断事件；缺少当前轮证据时显示“状态待确认”“已离线”或“状态未知”。一次 task/turn 完成只代表这一轮响应已结束。

每四秒重新发现进程并更新活动日志；历史目录与非活动文件每 30 秒核对一次，归档、恢复、新建操作会主动使目录缓存失效。新打开的日志不等待历史核对。目录核对时清除已消失文件的缓存。保留 `/proc` 的定期归属检查，发送或归档前仍再次检查终端持有情况。

SSE 将助手文字增量按 250ms 合并，携带会话、消息编号和字符偏移；浏览器直接追加未接收部分，不因 Token 增量请求快照或历史。检测到增量缺口时只读重取当前详情。列表仅在状态、预览、队列、进程集合等内容变化时通知更新；扫描时间和 RSS 单独变化不触发全量拉取。其他详情通知带会话 key，只刷新选中会话。列表快照采用字段白名单和有界预览，不携带计划、完整提示词及工具内容。浏览器每 30 秒兜底核对，页面唤醒和 SSE 重连时立即核对。

活动日志首次以流式方式完整读取，此后只处理新增的完整 JSONL 记录，保留跨窗口的轮次、计划和接收回执；文件替换、截断时重建索引。其他历史日志继续读取文件头和文件尾的有界窗口。网页仅保留有上限的公开消息、活动和结果，不展示完整历史或大型工具输出。不会向前端提供加密推理、完整环境变量或任意文件读取接口。官方历史与本地消息按轮次身份合并，保留不同轮次的相同文字；官方空轮次不会抹掉刚出现的本地消息。

运行状态与控制能力分别判断：独立终端持有日志、且完整活动索引包含未结束的 `task_started` 时显示执行中；无法共享即时控制不使它变成待确认。原生队列通过同 home 的官方 API 提交，不冷续接正在运行的线程、不注入终端按键。指令编号同时用作 `clientUserMessageId`，读取 rollout 中 `item_completed.UserMessage.client_id` 作为接收回执。排队响应丢失时只读核对同一编号，不自动重放；队列中已消失但没有回执时保持结果未知。

对应官方实现见 [终端队列命令](https://github.com/openai/codex/blob/main/codex-rs/tui/src/session_queue_commands.rs)、[队列持久化与消费](https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime/queued_items.rs)、[app-server 队列协议测试](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/thread_queue.rs)。运行时以安装版本的协议探测和实测为准，不能假定其他版本也支持相同实验接口。

## 写操作与限制

- 工作台只发送用户主动提交的文字；新建会话可以明确选择模型和推理强度，通过 `thread/start` 的 `model` 和会话级 `config.model_reasoning_effort` 设置，不写全局配置、不设置新的审批策略或沙箱权限。模型选项与可选强度来自该入口的 `model/list`，默认值通过对应工作目录的 `config/read` 解析；HTTP 只返回模型与强度的白名单字段，不提供配置或凭据透传。
- 只对已知入口、已发现会话和受支持请求开放固定 HTTP 接口，没有通用 JSON-RPC 透传和 shell 执行端点。
- 发送前持久化状态，指令带客户端消息编号，同一工作台请求编号去重。丢失写响应时标为结果未知，不能靠重新连接证明失败，更不能自动重放。
- 完整指令历史保留最近 100 条已结束记录，未解决记录不淘汰。移除旧正文前先写入按请求编号哈希寻址的去重凭据；旧请求重试只返回原状态，改变正文重用编号则拒绝。去重凭据持续保留，不宣称所有磁盘数据都有固定上限。
- 排队针对同一会话串行发送。普通 `turn/start` 无原子空闲检查，终端与网页同时发消息的竞争仍存在；见 README。
- 进程和文件归属检查是同一 Linux 用户下的防误操作措施，不构成对恶意同用户进程的隔离。
- 审批是否能在网页回答，取决于 app-server 是否把待处理请求同步到本连接。无法同步或未实现的类型留给原客户端处理。
- 当前没有 OS 通知、PWA 离线、文件编辑器、终端模拟器、跨主机代理或自动重启 Codex 服务；这些不是本轮核心需求的先决条件。

官方 app-server 接口仍标为实验性。升级 CLI 后应先运行探测和回归，尤其检查生成的本机协议、历史分页、审批及多客户端行为。

## 模型与回收站

模型信息优先读取已加载线程的 `model`、`reasoningEffort`；独立终端读取当前 `turn_context.model` 与 `effort`。历史详情可只读查询 `thread/read` 的最近持久化配置，不为查看元数据冷续接。不存在的字段显示未记录，不使用今天的入口默认值代替过去的会话配置。上述字段是 Codex 选择的配置，不证明代理上游实际使用的物理模型身份。

安装版本实测显示：新建但尚无输入的空白线程能归档和恢复，不过归档后 `thread/read` 的模型和强度可以为 null；不带覆盖参数冷续接会使用当前入口默认值。因此工作台保存 `thread/start` 已确认的模型与强度作为缺少记录时的补充，并在历史续接时传入该会话已知的模型与强度。已加载线程的实际值、后续轮次记录优先于创建时的补充值。

回收站直接使用 `thread/archive` / `thread/unarchive` 维护 Codex 自己的归档目录及数据库，避免自行搬走 rollout 后破坏索引。SessionIndex 同时发现 `sessions` 与 `archived_sessions`，以原会话编号保留身份；普通列表及统计排除归档记录，回收站单独展示。归档会话拒绝输入，恢复只改变归档状态，不自动启动任务。

归档会尝试处理后代线程，操作前检查已知会话树的活动状态、终端归属和未处理指令，并再查进程、官方线程状态及原生队列。网页展示级联数量，恢复逐条执行。跨客户端同时开始任务与归档仍有竞争窗口；这些检查不构成全局原子锁。没有实现永久删除或自动清空回收站。
