# 开发与验证

项目是 Node.js 服务和原生浏览器模块，没有打包框架或数据库服务。使用 Linux 和 Node.js 22+，以 `npm ci` 安装锁定依赖；安装后会同步 `public/vendor/`。修改依赖时同时提交 lockfile、浏览器模块及上游许可证。

## 日常检查

```sh
npm ci
npm test
npm run test:review-browser
```

`npm test` 使用临时目录、隔离 HTTP 服务及模拟控制接口，不调用真实模型。`test:review-browser` 启动独立 HTTP/SSE fixture，不读取本机登录密钥或会话。

浏览器检查默认使用 `/usr/bin/microsoft-edge`，也支持指定 Chromium：

```sh
npx playwright install chromium
PLAYWRIGHT_EXECUTABLE_PATH="$(node --input-type=module -e 'import {chromium} from "@playwright/test"; console.log(chromium.executablePath())')" npm run test:review-browser
```

GitHub Actions 在 Node.js 22、24 上执行 `npm ci` 与自动化测试，并在独立任务中安装 Chromium 执行隔离浏览器回归。CI 不安装 Codex、不读取用户认证、不建立公网隧道，也不启动真实模型测试。

## 实机脚本

| 命令或脚本 | 行为 |
| --- | --- |
| `npm run probe` | 发现已有控制接口并只读查询；没有输出表示没有发现接口 |
| `npm run test:browser` | 登录运行中的工作台、读取实际会话，发送交互使用模拟 fixture；截图可能包含本机会话信息 |
| `scripts/smoke.mjs`、`api-smoke.mjs` | 创建专用测试会话并发送真实模型请求，会消耗用量 |
| `scripts/session-management-check.mjs` | 新建、配置、发送、归档与恢复真实测试会话 |
| `scripts/native-queue-check.mjs` | 仅对显式指定的专用测试终端发送任务，需要 `TEST_THREAD_ID` |
| `npm run test:public` | 公网完整链路测试，需要 `BASE_URL`、`RELAY_IP`，包含真实模型请求 |
| `npm run test:relay-recovery` | 停止、终止和重启服务，影响登录态，需要 `BASE_URL`、`RELAY_IP` |

上述实机脚本按需人工运行；不要把它们加入常规 CI。测试产物、日志、会话内容及部署状态都放在 `.local/`。

## 提交约定

提交应描述具体行为与验证范围。涉及状态、去重、控制竞争或认证时，补充能证明行为的回归；文档和简单外观调整以相应检查为主。不要把模拟结果写成真实 Codex 链路已通过，也不要把旧 CLI 版本的验收推广到其他版本。

保持依赖和运行架构的改动有据可查，优先比较成熟方案。发布前检查 `git diff --cached --stat` 和提交文件集合，排除 `.local/`、`.env`、私钥、认证、会话日志和个人部署记录；可使用 [Gitleaks](https://github.com/gitleaks/gitleaks) 对将提交的文件及 Git 历史扫描。
