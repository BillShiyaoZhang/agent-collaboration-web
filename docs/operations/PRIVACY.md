# 隐私政策维护

正式页面源码在 [privacy 页面](../../src/app/privacy/page.tsx)，中英文事实正文在 [privacy-copy.ts](../../src/app/privacy/privacy-copy.ts)。公开导航、公开页脚、应用页脚和注册提交前均提供 `/privacy` 入口；middleware 对 `/privacy` 与 `/privacy/` 放行，不需要登录。历史 `site/*.html` 不是现行入口。

本次源码修改没有发布生产，也不等于已完成 App Store 隐私审核。上线前要把本文的运营配置确认与真实验收完成，并据确认结果修订正文；不要用未确认的承诺填补政策内容。

审核依据为 Apple [App Store Review Guidelines 5.1.1 与 5.1.2](https://developer.apple.com/app-store/review/guidelines/#privacy) 的公开政策、数据用途、接收方与删除披露，以及[账户删除要求](https://developer.apple.com/support/offering-account-deletion-in-your-app/)。源码能证明功能和处理边界，第三方保护条款、主体及实际保存规则仍需运营者核对。

## 事实来源

| 内容 | 源码或运行约定 |
| --- | --- |
| 账户、控制台身份、连接及关联副本 | [Prisma schema](../../prisma/schema.prisma)、[认证](../../src/lib/auth/auth.ts)、[控制台身份](../../src/lib/control/console-identity.ts) |
| 托管服务可解密、静态加密、配对和平台政策边界 | [技术参考](../architecture/TECHNICAL_REFERENCE.md)、[持久数据与缓存](DEPLOYMENT.md#持久数据与-rpc-缓存) |
| Resend 邮件、token 生命周期与请求触发的清理 | [账户邮件](../../src/lib/auth/account-email.ts)；人工邮箱及公开入口配置见[官方邮箱运维](https://github.com/BillShiyaoZhang/agent-collaboration-deploy/blob/main/docs/operations/EMAIL.md) |
| 配置优先的客服地址；无配置时区分官方托管与自托管 | [公开邮箱校验](../../src/lib/shared/support-email.ts)、[Web 配置](../../.env.example)；2026-09-27 已核对[现行官网](https://agent-communication.online/)页脚公开 `support@agent-communication.online`，仅作为官方托管服务联系地址，不证明投递已验收 |
| 推送端点、期限和浏览器绑定 | [推送策略](../../src/lib/notifications/push-policy.ts)、[浏览器推送](../../src/lib/notifications/browser-push.ts)、[Service Worker](../../public/agent-comm-sw.js) |
| 删除当前账户在线数据库数据；不自动撤销 Agent 配对或清除其他系统 | [账户删除](../../src/lib/auth/account-deletion.ts)、[账户设置](../../src/app/dashboard/settings/page.tsx) |
| 所属记录审核、举报证据与处理回复 | [内容安全架构](../architecture/CONTENT_SAFETY.md)、[举报运维](MODERATION.md)、[原举报恢复客户端](../../src/lib/product/content-report-client.ts)；浏览器本机原请求使用普通 localStorage，无应用层加密，按本站账户/记录隔离，确认回执或成功账户删除后清理；其他设备不远程擦除 |
| 代理访问日志与备份边界 | 部署仓库 `deploy/nginx/nginx.conf` 的 `account_safe`（IP、时间、method、URI、status、字节；无 query/Referer）及[Web 部署](DEPLOYMENT.md) |
| Apple 设备恢复数据 | 独立 Apple 客户端的 `NetworkManager`、`WorkspaceStore`、`AgentWorkspaceKit/SecureStore`；会话 Cookie 按服务地址隔离，未同步草稿和未确认发送按服务地址与账户隔离，均保存于 Keychain。退出保留恢复记录；确认账户删除后清理当前设备该账户命名空间和该服务的会话 Cookie，本机失败时保存清理标记，重启只重试本机清理 |

## 运营者必须确认的内容

- 正式运营主体名称、法定联系信息及适用服务地区；不能根据项目品牌或 GitHub 用户名推断经营主体。
- 人工邮箱是否已经通过真实双向收发验收。`NEXT_PUBLIC_SUPPORT_EMAIL` 是公开构建参数并优先覆盖联系地址；未配置时页面明确将 `support@agent-communication.online` 限定为官网已发布的官方托管服务地址，自托管用户向该部署实际运营者联系。官方 GitHub issues 也可请求私下联系渠道，提醒不得公开个人资料；官网已发布地址不证明收发已验收。
- 实际基础设施、数据库备份和日志保存地点、可访问人员、保存及删除周期、备份恢复后的删除请求处理流程。当前源码没有可用来承诺统一清除期限的配置。
- Resend、人工邮箱、基础设施及其他第三方的实际处理协议、地区和保护约定；在未核对合同前不能声称所有第三方均提供已经验证的同等保护。
- 用户自行连接的外部 Agent 由其所有者管理具体模型/工具提供方、数据用途、政策及配置变化。按用户明确的项目边界，工作区负责准确说明连接对象、内容流向、无法自动核验外部配置，以及独立的同意、拒绝与撤回入口；平台网关模式说明不代替这一共享许可。
- App Store Connect 的隐私标签、公开政策 URL 与最终部署/应用行为一致；页面具备说明不代表已完成申报。

## 验证

`node --test tests/unit/privacy-page.test.cjs tests/unit/middleware.test.cjs tests/unit/support-email.test.cjs` 检查两语言正文、目录目的地、公开导航、可选邮箱及未登录访问。再运行 Web 类型/构建检查，并在部署后的真实公开 URL 验证无登录读取、语言切换、窄屏、键盘目录跳转、注册与 App 的政策入口。

维护本文或其他文档后，在部署仓库运行 `python3 tools/maintenance/check_structure.py`。
