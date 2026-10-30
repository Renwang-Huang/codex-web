# 公网访问条件与建议（历史调研）

> 这是首次部署前的方案比较与环境快照。实际采用的 Caddy + OpenSSH 结构及维护方法见 [部署指南](../DEPLOYMENT.md)，下文的“当前”均指调研当时。

核查日期：2026-10-26。此记录是部署前评估，没有开启公网入口或修改现有网络设置。

## 当前判断

现有前后端架构可以继续使用，但尚未完成公网部署所需的入口、HTTPS、反向代理适配和外网验收。不应直接把 HTTP 4317 端口映射到公网。

本次实机核查：

- 工作台正在监听 `0.0.0.0:4317`，由 Node HTTP 服务提供页面和 API。
- 已有随机访问密钥、HttpOnly / SameSite Cookie、登录失败限流和同源请求检查。
- 登录 Cookie 的 Secure 属性只检查 `req.socket.encrypted`。HTTPS 在上游代理终止时，当前 HTTP 后端无法据此判断外部连接使用 HTTPS。
- 登录限流按 TCP 对端地址计算；接入本机隧道或代理后，多个外部访问者可能共用同一限流桶。
- 实时更新使用 `/api/events` SSE，保留十秒轮询兜底。
- 没有发现本机安装的 cloudflared、Nginx 或 Caddy，也没有这些服务的常见配置目录。
- Tailscale 已安装且 daemon 存在，但状态为 NeedsLogin，当前没有 Serve / Funnel 配置。
- ZeroTier 服务存在；当前用户的 CLI 无法查询成员网络，不能据此确认手机是否已有可用的私人网络路径。
- 域名控制权、Cloudflare 账户、路由器映射、外部反向代理和手机蜂窝网络连通性尚未核实。

## 路线选择

### 需要直接通过 HTTPS 域名访问：固定 Cloudflare Tunnel + Access

访问路径：浏览器 → HTTPS / Cloudflare Access → 固定 Tunnel → 本机 cloudflared → `127.0.0.1:4317`。

本机主动连接 Cloudflare，不要求住宅公网 IP 或路由器入站端口映射。需要 Cloudflare 账户、可在 Cloudflare 配置的域名，以及本机可用的出站连接。此路线的公网 HTTPS 入口由 Cloudflare 处理。

实施顺序：

1. 确定独立子域名，例如 `codex.example.com`，以及允许访问的具体邮箱或身份。
2. 在 Access 中先为该完整主机名创建 Self-hosted 应用和 Allow 策略；保留默认拒绝，不添加全员放行或 Bypass。
3. 完成下述应用适配，并验证代理配置。
4. 安装 cloudflared，创建固定 Tunnel，将主机名指向本机 `http://127.0.0.1:4317`；启用 Protect with Access，由 cloudflared 验证 Access token。
5. 将工作台监听收紧到回环地址，通过服务管理器托管工作台与隧道，配置失败重启和日志。
6. 用手机蜂窝网络验证：未授权身份被拒绝、授权身份可登录、SSE 保持和重连、指令去重与两轮排队、Cookie Secure 属性、服务重启后恢复。

工作台仍保留自身访问密钥。只发布工作台 HTTP 服务，不发布 Codex 原生控制接口或任意端口范围。

应用适配范围：

- 固定公开 Origin 和允许的 Host；针对本机代理明确规定可接受的转发信息，不直接信任任意客户端的转发头。
- 在 HTTPS 部署中始终设置 Secure Cookie，保留 HttpOnly 和 SameSite。
- 调整代理后的限流来源识别和连接数量上限，避免全部用户被当成本机同一来源。
- 验证 SSE 不被缓存或长时间缓冲，验证 Access 会话到期和重连行为。
- 补充关键写操作的审计信息和单实例服务管理；不把本地自测当作公网验收。

### 只需要自己的手机和电脑在外网使用：私人 VPN

可使用 Tailscale 或已有的 ZeroTier 网络。Tailscale 路线需要在电脑与手机登录同一 tailnet，并限制访问身份；Tailscale Serve 可以把回环 HTTP 服务变成 tailnet 内的 HTTPS 服务。手机需要运行对应客户端。

当前 Tailscale 尚未登录，ZeroTier 的可用成员网络尚未核实。此路线提供互联网环境下的私人访问，不等于发布一个无需 VPN 的公网网站。

## 不采用的快捷方式

- 不直接公开 HTTP 4317 端口。
- 不把临时 Cloudflare Quick Tunnel 当长期入口：官方说明其不支持 SSE，且地址和可用性不适合固定服务。轮询兜底不等于完整实时链路已经通过验收。
- 不把 Tailscale Funnel 当成 tailnet 身份门禁。Funnel 是公网发布功能，授权模型与仅 tailnet 可用的 Serve 不同。

## 官方依据

- [Cloudflare Tunnel 原理：不需要公网 IP 或入站开放端口](https://developers.cloudflare.com/tunnel/concepts/)
- [固定 Tunnel 的前提与配置](https://developers.cloudflare.com/tunnel/get-started/)
- [Access Self-hosted 应用、先保护后发布、Access token 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Quick Tunnel 限制，包括不支持 SSE](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [Tailscale Serve：私人网络 HTTPS 访问](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Funnel：向公网发布服务](https://tailscale.com/docs/features/tailscale-funnel)
