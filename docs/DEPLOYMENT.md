# Caddy 与 OpenSSH 部署指南

本指南使用示例域名 `codex.example.com` 和文档保留地址 `192.0.2.10`，需要替换为自己的配置。个人服务器地址、私钥、访问密钥和完整部署记录不进入仓库。

## 结构与前提

```text
浏览器 ── HTTPS ── 中继服务器 Caddy
                         ├─ /：/opt/codex-web/public
                         └─ /api/*：127.0.0.1:14317
                                          │ SSH 反向转发
                                          ▼
                                 本机 127.0.0.1:4317
                                          │
                                 本地日志与 Codex 控制接口
```

本机需要 Linux、Node.js 22+ 和 OpenSSH 客户端；安装用户服务需要 Python 3 与 systemd。中继服务器需要已配置的 Caddy、OpenSSH、Python 3 和域名 DNS。云端仅提供页面与传输，不执行 Codex，本机不需要公网 IP 或路由器端口映射。

Caddy 在代理期间能接触请求与响应内容。此结构不提供对中继不可见的端到端内容加密。本机离线时，静态页面仍可打开，API 返回不可用。

## 本机试运行

```sh
npm ci
npm test
npm start
```

在 `http://127.0.0.1:4317` 登录，密钥见 `.local/access-key`。先用 `npm run probe` 确认可连接的控制接口；没有输出时，网页的控制功能不能据此视为可用。不要为同一项目同时启动多个工作台实例。

## 首次配置中继

1. 将子域名 DNS 指向中继，确认服务器已有站点并备份 Caddy、SSH 配置。`deploy/inspect-server.sh` 可作只读盘点，其输出可能含个人主机信息，应留在 `.local/`。
2. 在本机创建专用隧道密钥，写入 `.local/deploy/relay_ed25519`。用可信渠道核对服务器 SSH 主机指纹后，准备 `.local/deploy/known_hosts`。不要将 `ssh-keyscan` 的结果直接当成已经独立核验的身份。
3. 复制 `deploy/Caddyfile.codex` 到 `.local/deploy/Caddyfile.codex`，将其中所有 `codex.example.com` 替换成实际域名。
4. 打包并上传下面列出的文件。只上传前端、Caddy 配置和公钥，不上传整个项目、`.local/` 或私钥。

```sh
mkdir -p .local/deploy
tar -czf .local/deploy/public.tar.gz public
scp .local/deploy/public.tar.gz root@192.0.2.10:/tmp/codex-web-public.tar.gz
scp .local/deploy/Caddyfile.codex root@192.0.2.10:/tmp/codex-web-Caddyfile
scp .local/deploy/relay_ed25519.pub root@192.0.2.10:/tmp/codex-web-relay.pub
```

审阅 `deploy/install-server.sh` 后，在服务器上以 root 执行。该脚本用于首次安装，会创建项目标记、备份已有配置、安装静态文件、追加独立 Caddy import，并配置受限 `codex-relay` 用户；不是纯前端更新命令。它只允许该用户建立回环端口 `14317` 的远程转发，禁止 shell、其他端口、TTY 和代理转发。服务器的其他站点仍需在操作前后核验。

可用普通 SSH 将脚本送到服务器执行。`scripts/remote-admin.py` 是可选的 Paramiko 管理工具，额外需要该 Python 依赖；首次连接采用 TOFU，密码只从 TTY 读取。无人值守运行应使用受限密钥，且提前核对主机身份。

## 本机托管服务

先退出手动启动的工作台，再预览服务：

```sh
python3 scripts/install-local-services.py \
  --public-origin https://codex.example.com \
  --relay-host 192.0.2.10 \
  --dry-run
```

确认后去掉 `--dry-run`，脚本将生成 `.local/deploy/` 下的单元文件，链接到用户 systemd 目录并启用两个服务。项目路径请避免空格。已有服务运行时，修改源脚本不会自动改写已生成单元；重新安装会写入配置并启动服务，执行前应核对参数。

- 本机服务：`HOST=127.0.0.1`、`PORT=4317`、`PUBLIC_ORIGIN` 为实际 HTTPS Origin、`TRUST_LOOPBACK_PROXY=1`。
- 隧道：`127.0.0.1:14317` 转发到本机 `127.0.0.1:4317`，固定 SSH 主机密钥并启用保活。
- 单元在该用户的 systemd 会话中启用；需要退出登录后继续运行时，另行配置适当的用户会话策略。

## 更新与回退

前端没有编译步骤。`npm ci` 会同步浏览器依赖和许可证，发布 `public/` 时要包含 `render.js` 和 `vendor/` 的全部资源。

先保留云端旧 `public/` 及文件哈希，再上传新包。`deploy/update-public.sh` 从固定临时路径 `/tmp/codex-web-public.tar.gz` 原地覆盖文件，需要事先备份；它不提供原子切换或自动回滚。需要无中间态更新时，先在同一文件系统的暂存目录完整解压、核对文件集合与哈希，再原子交换目录。保留旧目录，更新失败时恢复并重新核验。不要用历史备份覆盖后来其他站点的配置。

纯前端更新不需要重载 Caddy。后端源码更新后重启本机服务，内存中的网页登录态会失效；指令状态与去重回执应成套备份。旧版不识别新去重回执时，直接替换源码降级会丢失旧请求的去重能力，详见 [审查处理记录](REVIEW_RESPONSE.md)。

## 验证与维护

```sh
systemctl --user status codex-web.service codex-web-tunnel.service
journalctl --user -u codex-web.service -u codex-web-tunnel.service -n 50
systemctl --user restart codex-web-tunnel.service
```

服务器上的只读核验脚本需要显式指定域名或待比较站点：

```sh
CODEX_WEB_DOMAIN=codex.example.com sh deploy/verify-server.sh
CODEX_WEB_DOMAIN=codex.example.com sh deploy/verify-preservation.sh
COMPARE_HOST=existing.example.com sh deploy/inspect-route-diff.sh
INSPECT_HOSTS=api.example.com,existing.example.com sh deploy/inspect-egress.sh
```

检查 HTTPS 证书、全部静态文件哈希、未登录 API 的 401、本机离线行为和其他站点的路由。只读核验脚本运行在服务器；某些脚本需要之前的配置备份。

以下两条是人工触发的实机检查，不属于普通测试：

```sh
# 会创建测试会话并发送真实模型请求
BASE_URL=https://codex.example.com RELAY_IP=192.0.2.10 npm run test:public
# 会停止/重启本机服务并清除当前网页登录态
BASE_URL=https://codex.example.com RELAY_IP=192.0.2.10 npm run test:relay-recovery
```

停止服务：`systemctl --user stop codex-web-tunnel.service codex-web.service`。撤回服务器站点时，只移除项目自己的 import、SSH 管理块和受限用户；验证配置后 reload，保留其他站点。
