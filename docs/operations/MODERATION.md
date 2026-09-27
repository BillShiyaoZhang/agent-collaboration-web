# 举报与内容处理运行手册

本功能使用工作区数据库中的持久队列，不调用外部审核模型，不自动发邮件。管理员的公开处理回复会保存在报告中，举报人可在 `/dashboard/reports` 查看。账户主人在 `/dashboard/content-review?agentId=...&messageId=...` 审核确切对端内容；运营者不能通过管理 CLI 代替主人批准 Agent 使用内容。

## 启用与权限

升级时执行正常 `npm run db:migrate`，新表在 `prisma/remote-console.sql`：`ModerationReport`、`ModerationContent`、`ModerationRate`、`WorkspacePeerSafety`。脚本随生产 Docker 镜像复制；应在持有同一 `DATABASE_URL` 和 `NEXTAUTH_SECRET` 的受信任运行环境执行。不要在另一份数据库上处理生产举报。

在运营者的秘密管理系统配置独立随机 `MODERATION_ADMIN_TOKEN`，至少 32 个 UTF-8 字节。CLI 从受保护的 `--token-file` 读取同一令牌；文件不得有组或其他用户的读写执行权限，例如由运营者配置 `chmod 600 /run/secrets/moderation-admin`。运行环境必须能读取该文件。禁止把令牌写入命令参数、浏览器、公开环境变量、Git 或工单日志。

CLI 在触碰数据库之前校验令牌；普通登录账户不能使用管理员入口。`show` 会解密私人证据，只有实际负责处理的授权人员可以运行。列表只显示元数据；终端输出也属于受保护数据，不应转贴到公开渠道。

## 实际处理流程

以下命令中的账户 ID、报告 ID、`updatedAt` 都来自刚读取的真实队列；不使用邮箱作为删除或处理授权来源。

```sh
node scripts/moderation-admin.cjs list --queue reports --status pending --limit 20 --token-file /run/secrets/moderation-admin
node scripts/moderation-admin.cjs show --queue reports --user ACCOUNT_ID --id REPORT_UUID --token-file /run/secrets/moderation-admin
node scripts/moderation-admin.cjs report --user ACCOUNT_ID --id REPORT_UUID --status reviewing --response-file /private/review-response.txt --decision none --actor operator-1 --updated UPDATED_AT --token-file /run/secrets/moderation-admin
```

接手后查看证据、核对内容规范与目标。处理完毕重新 `show` 获取最新时间戳，再将状态设为 `resolved` 或 `dismissed`。最终状态必须有非空公开回复，最多 4000 UTF-8 字节。回复写给举报人，不复制其他人的秘密、令牌或完整私人聊天。脚本不会发邮件。

`--decision hide` 表示持续隐藏本账户此目标记录的显示内容：收件箱、协作内容和被举报的私人助手单回合均在读取时执行移除，后者同时覆盖分页、预览与搜索。它不会撤回已经送出的网络请求、删除 Agent 本机数据或代替真正屏蔽。联系人关系、权限和后续来信阻止需主人使用 Agent 返回认证回执的屏蔽动作。

```sh
node scripts/moderation-admin.cjs report --user ACCOUNT_ID --id REPORT_UUID --status resolved --response-file /private/review-response.txt --decision hide --actor operator-1 --updated UPDATED_AT --token-file /run/secrets/moderation-admin
node scripts/moderation-admin.cjs list --queue content --status pending --limit 20 --token-file /run/secrets/moderation-admin
node scripts/moderation-admin.cjs show --queue content --user ACCOUNT_ID --id CONTENT_UUID --token-file /run/secrets/moderation-admin
node scripts/moderation-admin.cjs reject --user ACCOUNT_ID --id CONTENT_UUID --actor operator-1 --updated UPDATED_AT --token-file /run/secrets/moderation-admin
```

已拒绝内容不能由主人重新批准；正文改变会产生新的摘要与审核记录。CLI 没有内容批准命令。每次决定要求匹配 `updatedAt`，并发修改会拒绝，必须重新读取后判断。

## 保存、删除和发布准备

报告的评论、用户主动附加的最小证据与公开回复使用 AES-256-GCM 加密；待审对端记录同样加密，密钥从 `NEXTAUTH_SECRET` 派生并绑定账户、Agent 和记录。不要直接轮换该秘密而丢失已有内容的解密能力。数据库复制、备份与秘密应按真实部署的访问控制管理；本实现没有自动承诺的备份删除期限。

账户删除事务显式清除此账户的报告、审核队列、速率计数与所属 Agent 的屏蔽投影，兼容旧库没有外键的情况；未知含账户数据的归档表会阻止删除并要求维护者核对，不会假报已清理。删除不会影响其他账户或外部 Agent/Platform 的本机资料。

TODO：运营者需要指定实际负责人、日常查看队列的安排、升级渠道和响应目标。Apple 要求及时响应举报；脚本和持久队列存在不证明已经有人处理。现阶段未部署或完成真实运营验收，不得据此宣称已满足全部 App Store 发布条件。另见 [公开规范与负责人待办](COMMUNITY.md)、[隐私政策维护](PRIVACY.md)。

验证：`npm run test:moderation` 在临时 SQLite 上检查真实外键、ownership、加密队列、过期预览幂等、HTTP 来源/大小、管理员拒绝、令牌文件与删除隔离；真实生产负责人和回应安排仍需人工核验。
