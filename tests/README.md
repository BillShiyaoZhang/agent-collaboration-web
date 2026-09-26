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

### 桌面聊天布局与账户记录管理

生产构建后，以 `PRODUCT_FIXTURE=1` 启动 `workspace-fixture.cjs`，运行
`node tests/integration/desktop-agents-browser.cjs`。检查登录后直接显示可输入聊天框，
1440×900 和 1366×768 的“导航｜agent/会话列表｜聊天框”、消息独立滚动和输入固定底部；
左侧列表的重命名、归档、删除与恢复保留正文和草稿，后台同步不会复活已删除记录或自动重发；
切换自己的 agent、连接名称与删除确认范围，以及 320/390px 手机列表抽屉。
此脚本只连接 loopback 的合成账户，报告写入 `build/desktop-agents-preview/`。
它会修改合成账户的名称并删除第二个测试连接，应在独立的新 fixture 中运行。

### 独立页面的完整合作与删除恢复故事

先停止上一套 fixture，再以 `PRODUCT_FIXTURE=1` 启动全新的
`node tests/integration/workspace-fixture.cjs`，然后运行
`node tests/integration/desktop-product-stories-browser.cjs`。不要沿用
`desktop-agents-browser.cjs` 已改名或删除连接的数据库。

新脚本保留原 10 个完整故事的业务断言，导航改用独立的“我的 agents”、合作与联系人页：
真实签名回执、格式化回复、主题搜索与归档、两段草稿的延迟切换、合作页不标记后台聊天已读、
确切委托和邀请的分别审批、真实 dispatch、有限 worker 的 6 次检查/4 次发送/60 秒间隔及单独授权、
实际暂停操作、结构化来源返回原会话并保留草稿，以及 320/390px 回流。

新增 3 个账户管理故事：进行中的合作在 UI 禁止删除且 API 返回 409；联系人确认删除后
仅隐藏本账户 Web 列表，保留已认证快照，重新读取不会复活，恢复不会发送远端社交写操作；
确认终态的合作可删除和恢复，聚合列表与详情按同一 task/collaboration 关联状态显示。
`productCloseTask` 只在 loopback 的 `PRODUCT_FIXTURE` 中将一个确切合成任务设为
revoked、其合作设为 closed/cancelled，便于验证终态管理；它不代表真实双方已经取消任何业务约定。
报告、截图和确切方法/参数证据写入 `build/workspace-sync-preview/desktop-product/`。

## 首次加载的交互就绪保护

生产构建后，以全新 `PRODUCT_FIXTURE=1` 启动 `workspace-fixture.cjs`，运行
`node tests/integration/workspace-hydration-browser.cjs`。三个独立文档分别延迟首次 Next.js 脚本，验证合作筛选、已保存聊天搜索和消息输入在 SSR 阶段受 disabled/inert 保护；一次正常 click/fill 在加载期间等待，释放脚本后同一次操作生效。脚本不等待 React 内部属性，不重点击或重填；所有业务 POST 被拦截。账号、数据库和业务事实仅为 loopback 合成数据。

`workspace-hydration.test.cjs` 使用 React 服务端渲染验证两工作区的保护范围。浏览器回归负责验证原生控件继承的禁用状态、首操作和就绪后的实际布局，不能仅用截图或 HTML 属性代替。

### 父上下文先更新时的真实 hydration 回归

运行 `node tests/integration/workspace-context-hydration-browser.cjs`，无需启动 Next.js 或 fixture。
脚本使用已安装的 Webpack、TypeScript 和真实生产版 React，将现有 `usePolicyAccess`、
`useWorkbench` 与依赖编译到独立的 loopback 随机端口；私有 Context 仅由测试 loader 暴露。
测试入口使用 `.tsx.fixture`，不进入产品 TypeScript 编译；生成的 bundle、旧源码快照和报告
仅写入 `build/workspace-sync-preview/context-hydration/`。

三个独立场景分别检查政策权限、外部同步错误和两者组合：SSR 消费者得到 false/空错误，
客户端首次 hydrate 时父 Context 已为 true/固定合成错误。固定 r3 提交 `48df62e` 的真实 hooks
作为负对照，必须触发一个 React 418 HTML 错误；当前 hooks 首次渲染必须与 SSR 一致且无
recoverable/page 错误，随后显示最新权限和错误。一次正常点击撤销政策须立即移除操作权限，
清除外部错误后提示须消失。测试不登录账户，不允许业务写入或访问 loopback 之外的地址。

运行负对照需要本地 Git 历史包含 `48df62e`；`HARNESS_VARIANTS=new` 可单独验证当前 hooks，
但不提供旧行为的负对照证据。`PLAYWRIGHT_MODULE` 和 `CHROME_EXECUTABLE` 可指定已有工具。
这项合成消费者时序证明首次 hydration 的边界行为，不等于已定位某次生产页面的全部异常。

### 邮件账户浏览器流程

安装依赖并执行 `npm run db:generate` 后，可运行独立检查：

```sh
node tests/integration/email-flows-browser.cjs
```

通过 `PLAYWRIGHT_MODULE` 和 `CHROME_EXECUTABLE` 指定已有 Playwright 模块及本机 Chromium。
脚本自行启动只监听 loopback 的 Next 开发服务、全新 SQLite 和本地 Resend HTTP 替身；
所有账户及收件地址使用 `.invalid`，不读取项目 `.env`，不连接真实邮件服务或 Platform。
测试专用 `email-provider-hook.cjs` 仅在合成 key、开发环境和明确 loopback 地址下运行，
没有生产邮箱验证开关。不要在它运行期间执行 `npm run build`，两者共享 Next 构建目录。

检查包含未验证注册拒绝登录、验证和改密链接 GET 不消费、显式确认、邮件找回密码、
密码修改确认前旧密码仍有效、密码生效后撤销旧会话、保留控制台 URN 与 Agent 连接，
以及已有未验证账户继续登录并准确展示状态。脚本等待真实的收件人发送冷却，通常需要
两次各约 60 秒；同时检查 1440px 和 390px 布局，并保存截图及报告到
`build/account-email-preview/<随机运行目录>/`。这些结果只覆盖本地合成数据，
不证明腾讯邮箱收发、Resend 实际投递或海内外邮箱的送达率。

现有 Python Web/Platform 非邮件检查通过 `seed-account.cjs` 创建合成已验证用户，
不再绕过线上注册验证。此 helper 只接受 `.invalid` 邮箱及明确指定、已存在于
Web 仓库 `build/` 中的数据库文件，保留已有账户，使用项目实际密码哈希及增量迁移。
