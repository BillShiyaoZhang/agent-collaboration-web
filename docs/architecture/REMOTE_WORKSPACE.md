# Ambient 本地工作区云入口

此入口复用现有 NextAuth 账户，只连接用户电脑上的 Ambient，不在 Web 或 Platform 启动另一份 Agent。本文描述 main 的实现；线上启用状态、版本和验收结果以部署仓库的发布及验收记录、实际入口为准。

## 使用流程与授权

1. 登录正确云账户，在 `/connect-workspace` 或 `/dashboard/workspaces` 点击“生成本机接入码”。复制公开入口地址与 5 分钟有效的一次性接入码；GET 打开页面不生成码，刷新不会恢复或续期。
2. 在 Ambient 本机“远程连接”输入入口地址及接入码，创建一次性连接码或链接，选择 `workspace.control`（工作区操作）及可选 `workspace.manage`（配置与能力管理）和到期时间。
3. 在 `/connect-workspace?code=...` 登录正确云账户并明确领取，或在 `/dashboard/workspaces` 输入一次性码。GET 打开链接不自动领取。
4. 回到 Ambient 本机核对领取账户、范围与期限并确认。云端领取后显示“等待本机确认”，尚不可打开工作区。
5. 本机已确认且连接在线后，点击“打开工作区”。Web 取得一次性访问链接，浏览器跳到该节点独立 origin。Agent、数据、密钥和 Run 仍在用户电脑。
6. 本机或云端撤销后，Gateway 使现有工作区会话与通道失效。网页列表保留已撤销状态；重新接入须本机发起新申请。

本次工作区范围独立于普通聊天的 RPC 配对。网页不能修改本机范围、期限或代替本机确认。一个节点首版绑定一个账户；账户可有多个节点。离线页面不会提交或重试 Ambient Run。

## Web 与 Gateway 接口

以下地址约束描述默认 `WORKSPACE_GATEWAY_ORIGIN_MODE=separate-site`。此变量严格只接受 `separate-site` 与 `same-site-subdomains`，未设置时使用前者；空值、拼写错误及未知值拒绝，不会退回宽松配置。临时同站子域的额外约束见下一节。

设置服务端环境变量 `WORKSPACE_GATEWAY_URL`（例如内网 `http://workspace-gateway:8090`）和 `WORKSPACE_GATEWAY_SECRET`（至少 32 字节随机值）。另设 `WORKSPACE_GATEWAY_PUBLIC_URL`（Ambient 可访问的控制 origin）与 `WORKSPACE_GATEWAY_DOMAIN`（Gateway 同一节点 wildcard 根域）。公网控制 URL 必须 HTTPS，且控制与节点根的可注册域必须相同、与 `NEXTAUTH_URL` 不同；使用 `tldts` 的完整 PSL（含 private suffix）核对，不能仅换子域名隔离 Portal Cookie。本机允许 HTTP loopback/localhost 与独立端口，示例 `http://localhost:8788` 和 `localhost:8788`。公开 URL 不允许路径、用户信息、query 或 fragment，配置无效时发码与打开返回 503/502；内部 URL 不作为公开地址回退。这两个内部值不使用 `NEXT_PUBLIC_`，不传入浏览器。Gateway 需配置相同 service secret。未设置时入口返回未配置提示，现有聊天和账户功能继续使用原服务。

| 浏览器 BFF | Gateway | 约束 |
| --- | --- | --- |
| GET `/api/workspace-nodes?view=active&limit=50&cursor=...` | 同参 GET `/v1/accounts/{account_id}/nodes` | 默认 active，history 为撤销/到期；limit 1–100，cursor 绑定账户与 view |
| POST `/api/workspace-nodes/enroll`，`{}` | POST `/v1/accounts/{account_id}/enrollments`，`{label}` | label 派生自会话且限 200 字符；返回一次性 `enrollment_token`、`expires_at` 与经校验的公开 `gateway_url` |
| POST `/api/workspace-nodes/claim`，`{code}` | POST `/v1/accounts/{account_id}/pairings/claim`，`{code,label}` | label 为会话邮箱；不能提交 account_id、权限或期限 |
| POST `/api/workspace-nodes/{id}/open`，`{}` | POST `/v1/accounts/{account_id}/nodes/{id}/launch` | Gateway 核验归属、未撤销、期限及在线；返回一次性 URL |
| DELETE `/api/workspace-nodes/{id}`，`{}` | DELETE `/v1/accounts/{account_id}/nodes/{id}` | 撤销此账户节点 |

所有 BFF 使用真实 `getServerSession(authOptions)`；变更请求沿用现有可信 `NEXTAUTH_URL` 同源 Origin 校验、严格 JSON 和有界正文。Gateway 的所有账户请求带独立 service Bearer；不透传浏览器 Cookie、Authorization、Host 或账户参数。响应为 `private, no-store`，`Vary: Cookie`。接入码仅在页面内存显示，可复制但不进入 URL、localStorage/sessionStorage 或日志。Web 不自动把接入码作为连接码领取，也不自动重试发码。Gateway 元数据（含账户删除回执）严格限制为 128 KiB JSON 与 10 秒网络超时；访问链接还须精确匹配当前节点 origin 和唯一 ticket 路径。429 回执安全保留 1–300 秒的整数 Retry-After（异常值使用 60 秒）；浏览器按账户在内存保存冷却期限，期限内不发起节点轮询或重复生成，并暂时禁用发码。没有 Gateway 请求正文或响应正文日志，不创建 Ambient 工作区数据库副本。

Gateway 节点列表必须为 `{nodes:[...],next_cursor:null|string}`，单页最多请求的 limit 条，不兼容旧无界响应；游标缺失或越界时拒绝显示，升级 Web 与 Gateway 必须成套。浏览器按用户动作加载下一页、保留最多最近载入 500 项；多页期间暂停首屏轮询，点击重新读取返回最新一页。节点字段含 `node_id,name,status,online,account_id,account_label,grant_id,scopes,expires_at,workspace_origin,last_seen_at`，时间使用 ISO 8601 UTC 字符串。状态为 `pending/claimed/paired/revoked/expired`；新 pending 已绑定接入码所属账户、account_label 暂为空，仍需本人领取和本机确认；`online` 为独立布尔值，已配对但断开显示离线。列表数据由 Gateway 返回，Web 不从云记录推断当前本机权限。

## 临时同站子域模式

只有显式设置 `WORKSPACE_GATEWAY_ORIGIN_MODE=same-site-subdomains` 才允许 Portal、公开控制 origin 与节点根共用可注册域。完整 PSL（含 private suffix）仍参与校验；三者必须 HTTPS、host 不同，Portal 不能位于节点根内，公开控制地址仍是纯 origin，每个节点仍使用自己的 `<node_id>.<root>` origin。仅改端口或把工作区 HTML 放到门户路径不能建立此边界。Web、Gateway 和生产 ingress 必须配置同一模式，不能只关闭其中一层的 PSL 检查。

此模式使用 Edge 可用的 `src/lib/auth/workspace-security.ts`：NextAuth 的 session、callback、CSRF、PKCE、state、nonce 六类 Cookie 全部为 `__Host-`、Secure、HttpOnly、SameSite=Lax、Path=/、无 Domain；middleware 使用相同 session Cookie 名并支持分块。原 `__Secure-`/无前缀会话不再被认证，切换时必须重新登录，账户、原密钥和数据库保留。默认独立站点模式不修改现有 Cookie 配置。

Portal 浏览器门禁先于公开路由执行：拒绝所有 `Sec-Fetch-Site: same-site`；有 Cookie 而 Fetch Metadata 缺失/非法时拒绝；有 Cookie 的非 GET/HEAD 请求要求精确 Portal Origin；显式外部或 `null` Origin 拒绝。地址栏/书签的 `none` 安全请求可用；来自外部站点的 GET/HEAD document 导航仅允许页面，不允许 `/api`，fetch、iframe 与不安全请求拒绝。无 Cookie、无 Fetch Metadata 的 CLI onboarding 保留原签名/Bearer 验证。响应增加 `Origin-Agent-Cluster: ?1` 和 `Cross-Origin-Opener-Policy: same-origin`；运维还须让 nginx 保护同 Host 的 Platform/Admin 入口。

临时模式仅支持具备 Cookie 前缀和 Fetch Metadata 的现代浏览器；现有不发送 Fetch Metadata 的 native Cookie 客户端需适配，不能据现有 native 契约宣称兼容。Workspace 到 Portal 的同站链接也会被拒绝，需在地址栏打开 Portal 或使用书签。`__Host-` 阻止认证 Cookie 的 Domain/Path 注入，但同注册域的普通父域 Cookie 仍可能造成请求头过大或浏览器存储可用性影响；本模式不等同独立可注册域的完整隔离，后续仍应迁回默认模式。

## 验证与部署边界

`node --test tests/unit/workspace-nodes.test.cjs tests/unit/middleware.test.cjs` 覆盖发码账户/标签派生、未登录和错误 Origin、严格载荷、PSL Cookie 隔离、分页/越界/缺失游标及有界删除回执、节点归属、claim/launch/revoke、Gateway 凭据隔离与故障、登录返回一次性链接及状态语义；`npm run build` 检查页面和接口的生产编译。隔离真实 HTTP fixture 可用现有 NextAuth 登录验证 BFF，不联系公网平台或真实模型。

发布还需根部署仓库配置独立 Gateway、service secret、通道节点 wildcard/TLS、配额和撤销。此文档及本地测试不代表现网已经提供工作区连接。已有 MQ 与 libp2p Relay 不直接承载此 HTTP/WS 工作区通道；现有获准聊天副本保持原路径。

## 账户生命周期与政策范围

配置 Gateway 后，账户删除先验证当前密码、会话版本及本地归档结构，再调用服务端 `DELETE /v1/accounts/{account_id}`，只有收到明确撤销回执后才提交现有数据库删除事务。Gateway 持久标记该账户已删除，关闭其远程授权、会话与通道，并拒绝迟到的领取、本机确认和打开请求。上游失败时本地账户保留，界面提示撤销尚未确认并允许重试；远程撤销成功而本地事务失败时，账户可能仍在，但远程访问已关闭。未配置可选 Gateway 的旧部署保持原账户删除流程。

现有平台 policy disclosure 管理聊天 RPC 控制与同步，新 HTTP/WS 工作区使用独立授权及服务范围。`/dashboard/workspaces` 不用聊天 RPC 的政策回执决定通道访问；页面直接披露 Gateway 能读取传输内容、不保存正文副本及权限由本机控制。原聊天门禁的提示限定为“聊天控制与同步”。商业上线仍需制定 Gateway 服务政策、留存约定和运营者认证，不把现有聊天政策或其签名当作 Gateway 合同。
