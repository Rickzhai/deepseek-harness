# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 本 Fork：多用户网关

本 fork 完整保留上游 DeepSeek Harness，并新增一个可选、自包含的能力：**多用户网关**，让多人安全地共用一套 Web 服务。

- **每用户账号与登录** — 本地账号（scrypt 密码哈希、登录限速）与 OIDC 单点登录（授权码 + PKCE），并签发 HttpOnly 会话 cookie。
- **天然隔离** — 每个已认证用户获得独立的 `dsh web` 实例与私有 `$DSH_HOME`（会话、凭据、设置及默认工作区），由网关拉起并经 HTTP + WebSocket 反向代理访问。
- **用户管理 CLI** — `dsh-web-gateway user add/passwd/rm/list` 以及工作区授权（`grant`/`revoke`），且无需重启网关即可生效。
- **Docker 部署** — 现成的 `Dockerfile` 与 `docker-compose.yml`，位于 [`docker/web-gateway/`](docker/web-gateway/)。

网关代码位于 [`packages/host/web-gateway`](packages/host/web-gateway/README.md)；用法见其 README。

### 上游兼容性

未修改任何上游核心包——网关全部为新增文件，外加四处仅用于注册的一行改动（`tsconfig.host.json`、`knip.json`、`scripts/verify-package-readme-model-experience.ts`、`pnpm-lock.yaml`）。原始 `dsh` CLI、Web UI 及全部上游行为原样保留，且网关为可选：不使用它时，本 checkout 与上游行为完全一致。

上游版本通过将 `multi-user-web-gateway` 分支 rebase 到 `upstream/master` 即可干净合并。完整流程（含每次升级后需要复验的内容）见 [`docker/web-gateway/UPGRADING.md`](docker/web-gateway/UPGRADING.md)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
