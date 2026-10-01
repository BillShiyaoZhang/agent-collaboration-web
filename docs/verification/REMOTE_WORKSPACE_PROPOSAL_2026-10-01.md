# Ambient 工作区入口建议分支验证（2026-10-01）

本记录覆盖隔离建议检出的 Web 入口，基线为 `21693d1556111a94de7c09abd614d91398f82c03`。没有推送、部署或访问真实模型、邮件、线上 Platform、原项目数据库及用户工作区。产品边界见[云入口契约](../architecture/REMOTE_WORKSPACE.md)，复现入口见[测试指南](../../tests/README.md)。

## 自动检查

| 检查 | 环境与实际结果 |
| --- | --- |
| 工作区入口、认证、账户删除和政策定向回归 | Windows，41 项通过 |
| `npm test` 完整回归 | Windows，397 项中 396 项通过；唯一失败为既有 moderation CLI 的 POSIX `0600` 令牌文件权限检查 |
| `npm test` 完整回归 | 缓存 Web builder 的 Linux 环境、Node 24.21.0，397 项通过，0 失败、0 跳过，15.406 秒 |
| `npm run lint` | Windows，退出 0，无 ESLint 警告或错误；Next.js 提示该命令将在版本 16 移除 |
| `npm run build` | Windows，生产构建及类型检查通过 |

Linux 检查使用本机已有的 `agent-collaboration-web:collaboration-v096-0fc9a6c82352-builder`（镜像 `49a9b3ee0cb5`）及其中的 Linux 依赖，不拉取镜像。运行参数为 `--pull never --network none --read-only --tmpfs /tmp:rw,exec`，建议检出只读挂载到 `/proposal`；源码复制到临时目录，排除 `.git`、`.env*`、`node_modules`、`.next` 和 `build`。测试数据库及修复后的 workspace 包链接均在临时目录中，容器退出后删除。

Windows 的权限断言没有降低。`tests/unit/moderation.test.cjs` 的 Git blob 仍为 `25e2f90270712f1f8be0bcc22a370ed1f7ac6757`，`scripts/moderation-admin.cjs` 仍为 `32ce9a2bfe14b5b5a990c4a0b4b34eb18ed3152f`，两者与基线完全相同；Linux 完整回归包含该检查并通过。

## 真实 HTTPS 账户删除 smoke

本轮重新运行未改动的 `node tests/integration/workspace-portal-smoke.cjs`，退出 0，保存了以下实际标准输出：

```text
WORKSPACE_PORTAL_SMOKE_PASS real login, origin/account isolation, local confirmation, deletion revocation and stale-cookie rejection
```

服务仅监听 loopback：HTTPS Web `localhost:3330`，内部 Next.js `127.0.0.1:3331`，独立 Gateway `127.0.0.1:8798`。Web fixture 新建 `portal-1790836957890.db`，Gateway 使用独立临时 SQLite，账户、密码和 service secret 均为运行时合成值；只对该进程通过 `NODE_EXTRA_CA_CERTS` 信任 build 目录内的 localhost 测试证书。

脚本走真实 NextAuth 登录和 BFF/Gateway HTTP，拒绝错误 Origin 和客户端指定账户；领取后在设备接口明确确认到 `paired`；错误密码保留已确认授权；正确删除取得明确回执后，原 cookie 请求节点返回 401，设备授权已撤销，迟到的设备确认被拒绝。两个本轮 Web fixture 进程已按创建记录与命令行核对并停止；Gateway 由其创建者停止。此 smoke 没有启动 Ambient Run 或调用模型，不能替代生产 TLS、运营政策、真实用户环境或部署验收。

## 留存证据

原始输出仅留在被忽略的 `build/workspace-portal-preview/`，数据库、证书私钥、运行时密码和凭据不进入 Git 或建议包。下列 SHA-256 对应本轮本地文件：

| 文件 | SHA-256 |
| --- | --- |
| `full-suite-linux-final.log` | `E690AD9E2624588F31E2066B7299EA4ADC7FB9B000622B8563644E50AA1D0463` |
| `https-deletion-smoke-final.log` | `D99E7D75DC5D18D8353479F3F5FDB18D09CD4C5979FC99D9906FFFADE6085E0A` |
| `web-tests.log`（Windows 完整回归） | `B23186F62E9DB46875FFA3796DEF7F5A2A727695F6D22AF3E1CB4E1708E91B73` |
| `tests/integration/workspace-portal-smoke.cjs` | `ED030F588A5557E4906FC75C4C1377A929BE6FAC793E05F2BBCEF8138FA2F7A5` |
| `tests/integration/workspace-portal-fixture.cjs` | `996994346820EDAF42BB87E3C0198B15AFEAC8955BAC09ED30C1B9FFA561F169` |
