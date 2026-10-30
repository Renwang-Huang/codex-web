# 第三方组件

项目依赖下列上游组件。浏览器模块由 `scripts/sync-vendor.mjs` 从 `npm ci` 安装的锁定版本复制，相关许可证随 `public/vendor/` 发布。

| 组件 | 用途 | 版本 | 上游与许可证 |
| --- | --- | --- | --- |
| Marked | Markdown 解析 | 18.1.2 | [上游](https://github.com/markedjs/marked)、[许可证](public/vendor/marked.LICENSE) |
| DOMPurify | HTML 净化 | 3.4.17 | [上游](https://github.com/cure53/DOMPurify)、[许可证](public/vendor/purify.LICENSE) |
| Highlight.js | 代码高亮 | 11.12.0 | [上游](https://github.com/highlightjs/highlight.js)、[许可证](public/vendor/highlight.LICENSE) |
| ws | Unix WebSocket 控制连接 | 以 lockfile 为准 | [上游](https://github.com/websockets/ws)、MIT |
| Playwright Test | 开发与浏览器回归 | 以 lockfile 为准 | [上游](https://github.com/microsoft/playwright)、Apache-2.0 |

调研比较的 HAPI、Codex WebUI、codex-monitor、frp 等项目仅作为架构参考，没有将其整体复制为本项目框架，来源见 [架构文档](docs/ARCHITECTURE.md)。

本仓库尚未为自有代码指定开源许可证；公开可见不自动授予额外使用许可。第三方代码按各自许可证提供。
