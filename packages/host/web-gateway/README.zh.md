# `@deepseek-ai/dsh-host-web-gateway`

[English](README.md) | 中文

DeepSeek Harness Web GUI 的多用户网关：一套服务、多个相互隔离的用户。网关是一个独立的边缘进程（纯 `node:http`——无 cordis 树、无 Loader），负责提供登录页、完成用户认证，并把每个已认证请求反向代理到该用户专属的私有 `dsh web` 实例。每个实例以网关数据根下的独立 `$DSH_HOME` 运行，因此会话、凭据、设置与默认工作区天然按用户隔离。

## 工作原理

```
browser ──► gateway (login page + /auth/* + reverse proxy)
                 │  cookie session
                 ▼
        per-user `dsh web` on 127.0.0.1:<port>
        DSH_HOME=<data-root>/users/<id>
```

- **本地账号** — 密码以 scrypt 哈希存储（`scrypt$N$r$p$salt$hash`），用恒定时间比较校验；登录接口按「用户名+IP」限速。
- **OIDC/SSO** — 授权码流程 + PKCE（S256），包含 discovery、令牌交换与 userinfo；默认在登录成功时自动创建网关用户，或绑定到已有账号。
- **会话 cookie** — 不透明的 256 位 bearer 令牌，HMAC 签名，`HttpOnly`/`SameSite=Lax`，滑动 TTL；仅持久化令牌摘要，会话文件泄露也不会暴露可用 cookie。
- **每用户实例** — `InstanceManager` 以 `dsh web --host 127.0.0.1 --port <空闲端口>` 启动实例，设置 `DSH_HOME=<data-root>/users/<id>` 并以用户默认工作区为 cwd；探测就绪、按可配置超时回收空闲实例、崩溃后自动重启。
- **反向代理** — HTTP 与 WebSocket upgrade 转发并做头清理：子实例的浏览器信任围栏要求 loopback 的 `Host` 且无跨站标记，因此网关剥离 `Origin`/`Sec-Fetch-*`/`Cookie` 并把 `Host` 改写为 `127.0.0.1:<port>`。

## CLI

本包提供 `dsh-web-gateway` 命令，另附一个本地一键启动脚本：

```sh
# Start the gateway on 127.0.0.1:3088 (defaults: GATEWAY_PORT / GATEWAY_DATA_ROOT / GATEWAY_HOST).
./docker/web-gateway/start-gateway.sh

# Create and manage users against the same data root.
./docker/web-gateway/start-gateway.sh user add alice --admin --password 'pw'
./docker/web-gateway/start-gateway.sh user list
```

原生 `dsh-web-gateway` 命令（不经过包装脚本）用法相同：

```sh
# Serve the gateway (login page + proxy). First user created via `user add` becomes admin.
dsh-web-gateway serve --host 0.0.0.0 --port 8080 --data-root /srv/gateway --dsh-bin dsh

# Manage users (runs against the same data root).
dsh-web-gateway user add alice --admin
dsh-web-gateway user passwd alice
dsh-web-gateway user rm alice
dsh-web-gateway user list
dsh-web-gateway user grant alice /srv/team-shared
dsh-web-gateway user revoke alice /srv/team-shared
dsh-web-gateway user set-default-workspace alice /srv/alice
```

OIDC 通过 `serve` 参数配置（`--oidc-issuer --oidc-client-id --oidc-client-secret --oidc-redirect-uri --oidc-extra-scopes`，另有 `--no-oidc-auto-provision`）。服务端密钥持久化于 `<data-root>/secret`（或 `GATEWAY_SECRET`）；建议设置固定密钥，使 cookie 在网关重启后仍然有效。

## 工作区

每个用户在 `<data-root>/users/<id>/workspace` 拥有默认工作区（自动创建，并作为启动实例的 cwd）。团队共享工作区是通过 `user grant`/`user revoke` 按用户授权的目录；授权结果通过 `/auth/me` 暴露，可支撑工作区选择器。共享空间访问的文件级强制不在网关自身范围内（见 Known Limitations）。

## 扩展点

- `createGatewayServer(config)` — 进程内构建网关；返回 `{ server, listen, close, port, users, instances }`。
- `UserStore`、`SessionStore`、`InstanceManager`、`discoverOidc`、`proxyHttp`/`proxyUpgrade` — 可复用的构件，用于自定义部署（例如把网关挂进既有服务器）。

## 模型体验

无。网关只负责认证浏览器用户并把请求代理到每用户的 dsh web 实例；所有面向模型的效果都由子实例承担。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求，且每用户实例是拥有各自请求流的独立进程。

## 已知限制与延期工作

- **未实现文件级工作区强制** — 授权只是记录在用户存储中的目录授权，并不阻止某用户的实例读取同一主机上的其它路径。真正的强制需要每用户 OS 账号/容器或文件系统沙箱层。
- **实例资源随用户数增长** — 每个活跃用户一个 `dsh web` 进程。空闲回收限制了稳态成本，但多用户并发部署需要足够大的主机。
- **无内置 TLS** — 请部署在 TLS 终结反向代理（或容器入口）之后，并设置 `--secure-cookies` 让会话 cookie 携带 `Secure`。
- **OIDC state 仅存于内存** — 网关重启会使进行中的 SSO 尝试失效（已完成的会话通过持久化会话存储存活）。
- **JWT 签名校验委托给提供商** — 令牌交换信任提供商经 HTTPS 提供的 token/userinfo 端点；不执行 `id_token` 验证（当前防护为 PKCE + HTTPS + 签名 state）。
