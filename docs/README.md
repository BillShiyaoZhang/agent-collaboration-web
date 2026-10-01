# Web 维护文档

- [Ambient 本地工作区云入口（建议实现）](architecture/REMOTE_WORKSPACE.md)：一次性领取、本机确认、独立 Gateway 和账户隔离。
- [技术参考](architecture/TECHNICAL_REFERENCE.md)：组件边界、同步、RPC、开发与验证。
- [视觉约定](architecture/VISUAL_DESIGN.md)：官网统一场景、工作台表面、原创图片与响应式验证。
- [部署与迁移](operations/DEPLOYMENT.md)：配置、升级、账户邮件、数据保留和回滚。
- [官方邮箱开通](https://github.com/BillShiyaoZhang/agent-collaboration-deploy/blob/main/docs/operations/EMAIL.md)：阿里免费企业邮箱人工客服、Resend 事务发信、DNS 与真实收发验收。
- [浏览器后台推送](operations/WEB_PUSH.md)：关闭页面后的提醒、出站网络、订阅、诊断与平台边界。
- [隐私政策维护](operations/PRIVACY.md)：现行 `/privacy` 页面的事实来源、删除边界、公开入口与运营者确认项。
- [内容规范与人工处理](operations/COMMUNITY.md)：公开 `/community` 规范、主人网站审核、举报证据和实际责任人确认项。
- [内容安全 API](architecture/CONTENT_SAFETY.md)：跨端隔离、认证屏蔽、主人审核与举报契约。
- [举报处理运行手册](operations/MODERATION.md)：持久队列、管理员令牌与 CLI、公开回复和运营验收。
- [连接 Ambient 本地工作区（建议实现）](users/REMOTE_WORKSPACE.md)：领取、回到本机确认、打开与撤销。
- [核对、屏蔽与举报](users/CONTENT_SAFETY.md)：本人网站审核、App 入口与未知提交核实。
- [测试入口](../tests/README.md)：自动测试及隔离集成检查。
- [工作区接入与资源边界验证](verification/REMOTE_WORKSPACE_HARDENING_2026-10-01.md)：登录发码、PSL 隔离、有界分页/删除回执、Retry-After、Linux 全套与最终定向检查。
- [工作区入口建议分支验证](verification/REMOTE_WORKSPACE_PROPOSAL_2026-10-01.md)：Linux 完整回归、Windows 权限差异与合成 HTTPS 删除 smoke。
- [官网与文档入口](../site/README.md)：Next.js 公开页面、文档阅读器与历史静态文件。
- [客户端契约](../packages/client-contract/README.md)：跨端协议与兼容要求。

生产发布证据归属部署仓库；本仓文档描述当前实现与操作方式。
