# Web 测试

在 Web 仓库根目录运行命令。先执行 `npm ci` 和 `npm run db:generate`。

| 目录 | 内容 | 入口 |
| --- | --- | --- |
| `unit/` | 协议、认证、真实 SQLite 迁移与持久化、同步和路由 | `npm test` |
| `fixtures/` | Go/JavaScript 跨语言签名向量及生成器 | 供协议测试读取 |
| `integration/` | 隔离的服务、浏览器和完整链路检查 | 手动运行，见下文 |
| `../packages/client-contract/tests/` | 多端共享契约 | `npm run test:contract`；也包含在 `npm test` |

单元目录中包含使用临时真实数据库的测试。集成检查不由 `npm test` 自动启动。

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
