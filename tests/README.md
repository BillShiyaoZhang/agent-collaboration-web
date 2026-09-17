# Web 测试

在 Web 仓库根目录运行命令。先执行 `npm ci` 和 `npm run db:generate`。

| 目录 | 内容 | 入口 |
| --- | --- | --- |
| `unit/` | 协议、认证、真实 SQLite 迁移与持久化、同步和路由 | `npm test` |
| `fixtures/` | Go/JavaScript 跨语言签名向量及生成器 | 供协议测试读取 |
| `integration/` | 隔离的服务、浏览器和完整链路检查 | 手动运行，见下文 |
| `../packages/client-contract/tests/` | 多端共享契约 | `npm run test:contract`；也包含在 `npm test` |

单元目录中包含使用临时真实数据库的测试。集成检查不由 `npm test` 自动启动。

`unit/onboarding.test.cjs` 使用真实临时 SQLite 和 Ed25519 密钥，检查安装交接的 agent 身份证明、原始请求签名、独立 claim code / polling secret、登录与同源确认、固定方法与期限、跨账号隔离、一次性认领、可重试完成回执、过期与 30 分钟已批准回执宽限。`middleware.test.cjs` 同时检查只有 agent 创建/轮询 API 和公开安装指南允许匿名访问，Web claim 仍需登录。生产验收还需真实 Hermes 安装、浏览器确认和模型回复，单元测试不代替这些步骤。

## 工作区同步集成检查

先执行 `npm run build`，在一个终端运行 `node tests/integration/workspace-fixture.cjs`。
输出 `FIXTURE_READY` 后在另一个终端依次运行：

```sh
node tests/integration/workspace-browser.cjs
node tests/integration/workspace-resilience.cjs
```

浏览器脚本需要 Playwright 和 Chromium。可用 `PLAYWRIGHT_MODULE` 与 `CHROME_EXECUTABLE`
指定已有安装。服务仅监听 `127.0.0.1:3061`、`127.0.0.1:3062`，创建独立 SQLite 和测试身份。
结果存入 `build/workspace-sync-preview/`；结束后用 Ctrl+C 停止 fixture。

### Web 添加联系人和授权确认

构建后，将环境变量 `MUTATION_FIXTURE` 设为 `1` 再启动同一 fixture，然后运行
`node tests/integration/workspace-mutations-browser.cjs`。它使用隔离账户，检查联系人确认、
断线后保留原请求、请求过期后显式恢复、审批同意/拒绝、Agent 终态同步、权限撤回和手机布局。
报告与截图写入 `build/workspace-mutations-preview/`。

## 真实本地组合检查

`integration/full_stack_smoke.py` 使用部署仓库的相邻 Platform/SDK 源码，需完整递归克隆，
先构建 Web、helper 和 platform，再运行：

```sh
python tests/integration/full_stack_smoke.py --helper PATH_TO_HELPER --platform PATH_TO_PLATFORM --node PATH_TO_NODE
```

输出位于 `build/full-stack-smoke/`，测试只使用临时本地身份和数据库。
此检查同时验证新操作的显式配对范围、直接添加与重复联系人、审批同意/拒绝，以及
Agent 事实同步回 Web 账户；不调用语言模型。

### 好友请求、消息与跨端状态

构建后，设置 `SOCIAL_FIXTURE=1` 启动 `node tests/integration/workspace-fixture.cjs`，再运行
`node tests/integration/workspace-social-browser.cjs`。检查真实 React 控件发送的签名控制请求：好友请求接受/拒绝、发送后等待对方接受、在线/离线状态、网页发消息、电脑端与网页已读同步、协作动作结果不明确时禁止换 ID 重放，以及手机布局。
报告与截图保存在 `build/workspace-social-preview/`。`PLAYWRIGHT_MODULE`、`CHROME_EXECUTABLE` 可指定已有浏览器测试工具。

`npm test` 另验证 agent 权威好友快照、旧消息已读更新、已处理通知计数、后台推送撤回和服务工作线程在关闭网页时关闭原通知。
