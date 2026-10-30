# 文档与代码导航

## 按任务阅读

| 任务 | 文档 |
| --- | --- |
| 安装、登录、会话操作和兼容边界 | [项目 README](../README.md) |
| 部署 HTTPS、反向隧道和用户服务 | [部署指南](DEPLOYMENT.md) |
| 理解数据来源、控制协议及已有方案取舍 | [架构决策](ARCHITECTURE.md) |
| 区分自动化、历史实机结果及尚未验证的能力 | [验收记录](ACCEPTANCE.md) |
| 理解审查问题的修复依据 | [审查处理记录](REVIEW_RESPONSE.md) |
| 开发、测试和提交 | [贡献说明](../CONTRIBUTING.md) |
| 认证、代理信任与数据边界 | [安全说明](../SECURITY.md) |
| 第三方依赖及许可证 | [依赖声明](../THIRD_PARTY_NOTICES.md) |

## 模块职责

| 位置 | 职责 |
| --- | --- |
| `server/index.mjs`、`request-policy.mjs` | HTTP、登录、Cookie、同源校验、可信代理、SSE 与审计 |
| `server/discovery.mjs` | Linux 进程、入口 home、文件句柄及已有控制 socket 发现 |
| `server/sessions.mjs` | 活动日志增量索引、历史与归档扫描、状态摘要 |
| `server/hub.mjs`、`rpc.mjs` | 官方控制接口连接、会话操作、队列、审批与发送状态协调 |
| `server/store.mjs` | 已读状态、指令台账和持久去重回执 |
| `server/changes.mjs`、`messages.mjs` | 增量合并、消息身份与事件批处理 |
| `server/model-settings.mjs` | 模型、推理强度及配置来源 |
| `public/app.js`、`render.js` | 浏览器状态、交互与经过净化的 Markdown 渲染 |
| `public/vendor/` | 锁定版本的浏览器依赖与上游许可证，由 `npm ci` 同步 |
| `test/` | 使用临时目录与模拟 RPC 的服务端回归 |
| `scripts/review-browser-check.mjs` | 不依赖登录或真实模型的 HTTP/SSE 浏览器回归 |
| `scripts/` 其他脚本 | 只读探测、人工触发的实机测试和部署辅助；详见贡献说明 |
| `deploy/` | Caddy 示例、服务器安装与只读核验脚本 |
| `.github/workflows/ci.yml` | Linux 上的 Node.js 测试与隔离浏览器回归 |
| `.local/` | 本机密钥、状态、部署单元、个人记录与测试产物；Git 忽略 |

## 历史材料

[早期公网方案](archive/PUBLIC_ACCESS_PLAN.md)和[原始审查报告](archive/PROJECT_REVIEW.md)用于保留设计依据。阅读时以文档所标日期为准；其中的建议、评分和环境快照不代表当前能力或新版本验收。
