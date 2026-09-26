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

`protocol-v2-go.json` 由 SDK 的 `v2/testdata/generate.go` 生成。`unit/v2.test.cjs` 用它核对 Go/TypeScript 的规范字节、HPKE、签名策略、持钥回执与托管控制台证书；修改任一侧 v2 wire 后须重新生成并复制此向量。

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
断线后保留原请求、过期回执保持未知且禁止好友申请换 ID 重放、审批同意/拒绝、Agent 终态同步、权限撤回和手机布局。
报告与截图写入 `build/workspace-mutations-preview/`。

### 提醒与无障碍浏览器检查

服务端以 UTC、浏览器分别以 UTC 和 Asia/Shanghai 运行的首屏水合回归需跑两轮：
先用 `TZ=UTC ATTENTION_FIXTURE=1 node tests/integration/workspace-fixture.cjs` 启动隔离服务，
以相同环境运行 `node tests/integration/time-zone-hydration-browser.cjs`；停止 fixture 后，
改用 `TZ=UTC SOCIAL_FIXTURE=1` 启动 fixture 并运行同一浏览器脚本。
两种 fixture 的 `collaboration.state` 数据互斥，所以分别覆盖事项页和带 `received_at`
的收件箱来信。脚本强制加载服务端 HTML，核对连接、事项/来信和提醒时间按浏览器
本地时区显示，且没有 React 水合错误。按上文设置 Playwright/Chromium 路径。

构建后，以 `ATTENTION_FIXTURE=1` 启动同一 fixture，再运行
`node tests/integration/notifications-browser.cjs`。脚本用浏览器通知桩检查跨连接待办、已读与待处理计数、并发标签投递声明、跨源拒绝和 390px 页面；不发送真实系统通知。结果写入 `build/notifications-preview/`。

普通 fixture 启动后运行 `node tests/integration/accessibility-browser.cjs`。它检查 Next.js 官网、文档阅读器、登录/注册、工作台和提醒中心的应用内导航、键盘入口、触控目标、文字与输入字号、320px 回流及 200% 根字号；安装了 `axe-core` 时也运行颜色对比检查。报告写入 `build/accessibility-preview/`，真实设备的通知效果和文字理解仍需另行验收。

## 真实本地组合检查

`integration/full_stack_smoke.py` 使用部署仓库的相邻 Platform/SDK 源码，需完整递归克隆，
先构建 Web、helper 和 platform，再运行：

```sh
python tests/integration/full_stack_smoke.py --helper PATH_TO_HELPER --platform PATH_TO_PLATFORM --node PATH_TO_NODE
```

输出位于 `build/full-stack-smoke/`，测试只使用临时本地身份和数据库。
此检查同时验证新操作的显式配对范围、直接添加与重复联系人、审批同意/拒绝，以及
Agent 事实同步回 Web 账户；不调用语言模型。

### 双账户签名政策与旧快照

构建 Web、当前 Platform/helper、`v2-policy` 后，另备公开 r2 版本的 v1 helper，运行：

```sh
python tests/integration/web_policy_two_accounts.py --platform PATH_TO_PLATFORM --helper PATH_TO_CURRENT_HELPER --legacy-helper PATH_TO_PUBLISHED_R2_HELPER --policy-tool PATH_TO_V2_POLICY --node PATH_TO_NODE
```

此检查在本机随机端口和独立临时 SQLite/密钥上启动真实 Web 与 Platform。两个独立账户先在签名私密模式下与旧 helper 完成加密控制往返并保留快照，随后验证严格私密模式的托管控制台证书、合规模式的逐账户政策确认与暂停/恢复，以及政策服务中断时拒绝新控制而保留旧快照。它发起的确认仅为合成测试数据，不能代表真实用户同意。结果和服务日志位于 `build/web-policy-two-accounts/`。

### 本地双 Agent 有界并发与断线恢复

构建 Web 和当前 Platform，准备公开 r2 helper 后运行：

```sh
python -B tests/integration/web_two_agent_stability.py --platform PATH_TO_PLATFORM --helper PATH_TO_PUBLISHED_R2_HELPER --node PATH_TO_NODE
```

脚本在负载前写入 `run-config.json`，以真实 Web/Platform、两套旧 helper 和两个独立账户执行各 8 轮、最多 12 个并行 HTTP 请求；Web SQLite URL 固定使用 `connection_limit=1`。负载混合控制往返、工作台/提醒/Push 设置读取及同步调度，并注入一次本地 Platform 停启，核对原请求 ID 的恢复与 Agent 业务副作用去重。逐请求时间线、p95/p99、5xx、SQLite Code 5/P2024、数据库完整性和服务日志位于 `build/web-two-agent-stability/`。这只覆盖 E1 本机 HTTP；真实 HTTPS/TLS、Nginx、容器重启和外部 Push 投递须分别验收。

### 好友请求、消息与跨端状态

构建后，设置 `SOCIAL_FIXTURE=1` 启动 `node tests/integration/workspace-fixture.cjs`，再运行
`node tests/integration/workspace-social-browser.cjs`。检查真实 React 控件发送的签名控制请求：好友请求接受/拒绝、发送后等待对方接受、在线/离线状态、网页发消息、电脑端与网页已读同步、协作动作结果不明确时禁止换 ID 重放，以及手机布局。
其中拒绝后重新申请会核对 Web 沿用原联系人 ID、别名和 URN，并生成另一条好友请求；旧拒绝记录保持可见。收件箱用例还核对两条近时消息的完整可复制 ID、已读按钮的精确标签和实际提交的 `message_id`。
报告与截图保存在 `build/workspace-social-preview/`。`PLAYWRIGHT_MODULE`、`CHROME_EXECUTABLE` 可指定已有浏览器测试工具。

`npm test` 另验证 agent 权威好友快照、旧消息已读更新、已处理通知计数、后台推送撤回和服务工作线程在关闭网页时关闭原通知。

workspace-store.test.cjs 另用真实临时 SQLite 验证操作账本的账户隔离、静态加密、原 ID/参数绑定、迁移重跑保留、过期和旧浏览器记录不续期、认证社交状态核实；会话主题/归档/草稿/阅读位置、等时分页和仅已保存历史搜索；对话完成通知首次历史抑制、原生提醒归并以及阅读不解除审批。workspace-routes.test.cjs 检查新接口的登录、同源、字段/大小约束及拒绝浏览器伪造结果；control.test.cjs 检查账本不可写时不会投递 RPC。它们不替代真实宿主、浏览器多设备或生产部署验收。

### 聊天与目标协作故事

生产构建后，以 PRODUCT_FIXTURE=1 启动 workspace-fixture.cjs，再运行 product-stories-browser.cjs。
它使用隔离合成账号与签名 MQ 往返，验证默认聊天入口、格式化答复、账号草稿、主题搜索归档、
联系人/目标表单、任务委托与邀请的独立审批、来源关联回到原聊天，以及 320/390 手机布局。
输出在 build/workspace-sync-preview/product。此验收不操作真实 agent，不证明真实用户可用性研究或外部业务完成。

mutation-recovery-policy.test.cjs 验证联系人添加、任意协作执行与缺少稳定 message_id 的旧消息发送不能换 RPC ID 通用重启；只有同一审批、好友请求或消息的确切对象可显式核实后继续。

draft-cache.test.cjs 验证另一设备的服务端草稿优先于已保存旧缓存、仅未落盘编辑可覆盖、迟到保存及读取响应不能覆盖新编辑；workspace-browser.cjs 通过两个独立浏览器上下文核对跨设备切换、重新挂载、700ms 前导航及迟到读取。明确 action=describe 的协作功能说明属于只读，旧说明账本仍保留审计但不作为待执行写操作恢复。
