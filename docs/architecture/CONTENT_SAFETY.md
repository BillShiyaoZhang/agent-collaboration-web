# 跨端内容安全契约

依据 Apple [App Review Guidelines 1.2](https://developer.apple.com/app-store/review/guidelines/#user-generated-content) 实现展示前隔离、最小举报、真实屏蔽与公开联系入口。本文件描述代码能力；发布还需要运营者落实处理举报的人与安排。

## 展示隔离

`filterWorkspaceInbound` 在认证 RPC 保存前、直接控制响应与旧快照读取时执行。Web 服务生成 `WorkspaceAgent.contentSafety={version:1}`，不信任 Agent 自报同名字段。对端收件箱正文及自由字段、协作邀请/条款/变更/任务/资源/操作/确认/来源上下文在审核前只能投影安全元数据。未覆盖的自由扩展字段显示固定占位，不能借摘要、原始详情或通知绕过。协议 receipt/agreement_ack/sync 仅显示服务生成的固定状态文字，不把协议自由字段当已审核内容。

记录使用规范 JSON 的 SHA-256 作为确切版本摘要，完整审核证据加密保存到 `ModerationContent`；未标记内容同样隔离。占位为 `content_review:{status:'pending'|'rejected',reviewId,digest}`；仅已批准的确切证据回填正文并标记 `approved`。正文改变要重新审核，已屏蔽和运营者移除的目标不能批准。网站显式敏感预览是主人判断的入口；App 默认入口只显示元数据并链接该网站。

私人助手普通问答和历史没有进入运营审核队列。仅针对真实单回合举报的 `hide` 决定，移除那份回复及其搜索/分页/预览投影。Web 无法证明旧 Agent 本地模型曾经如何使用对端正文；新 `conversation.send` 必须具有通过认证 RPC 保存的 `peer_content_safety:{version:1,mode:'owner_review',automatic_peer_model_execution:false}`，缺失即升级提示且不创建提交记录。`peer_content_safety_required` 证明新请求未受理；`peer_content_safety_changed` 表示已受理回合宿主变化，保持结果不确定并只核实既有会话。

## Agent 安全动作

`contacts.block/unblock` 参数严格 `{urn}`；回执核对相同 URN、`status:'blocked'|'unblocked'`、对应 `blocked` 布尔值、`connection_status` 和非负安全整数 `safety_revision`。SDK 的主人 ACL 真正改变才递增 revision；同 RPC 重放保持原值。Web 持久投影只接受不旧于当前 revision 的认证状态，迟到快照或旧 block 回执不能覆盖后来 unblock。`contacts.list` / `collaboration.state` 的 `blocked_peers` 保留尚未成为联系人的发送者，支持真实解屏蔽。旧 Agent/旧配对缺方法不显示成功，现有配对权限不会扩张。

`inbox.review_preview {message_id}` 是显式配对授权的 READ，返回完整 text、sender、fingerprint、`text_truncated:false`。`inbox.review {message_id,decision:'approve'|'reject'}` 的结果必须同 ID、sender、fingerprint 与决定一致。主人身份从配对导出，不能由 JSON 指定。Agent 的本机使用审核与 Web 的显示批准分别保存；网站只在本机真实认证决定完成后批准对应 Web 内容。旧 Agent 仅有网站显示 gate，不声称控制旧 Agent 的模型。上述安全动作不向 AI 发送正文，不要求 AI 共享许可，仍要求本人会话、ownership 和显式配对权限。

## 举报 API

所有 POST 要求已验证会话、配置的同源 Origin、16 KiB body 限制与严格 schema。目标必须是所属 Agent 已保存的 `contact|contact_request|inbox|turn|collaboration`，稳定 ID 长度 1–128；服务器最终按 session 判定账户。未审核、被屏蔽或被移除的正文不会通过举报 preview 泄露。

- `POST /api/moderation/reports/preview`：`{reportId:UUID,agentId,target:{kind,id}}` → HTTP 200 `{reportId,evidence,previewToken,expiresAt}`。证据最多 4000 UTF-8 字节，HMAC 预览凭证绑定账户、目标、ID、证据摘要，15 分钟有效。
- `POST /api/moderation/reports`：上述目标字段加 `{reason:'harassment'|'hate'|'sexual'|'violence'|'spam'|'other',comment,evidence,previewToken,consent:true}` → HTTP 200 `{report}`。评论最多 2000 字节；证据只能是原预览片段或空，不默认提交整段聊天。原 ID 已成功且内容相同则先返回已有记录，即使凭证已过期；不同内容 409，原请求 ID 不得改绑。
- `GET /api/moderation/reports?limit=20` → `{reports:[...]}`；limit 1–50。
- `GET /api/moderation/reports/{UUID}` → `{report}`。报告公开字段：`id,agentId,target,reason,status,createdAt,updatedAt,response`；毫秒时间，状态 `pending|reviewing|resolved|dismissed`。不返回其他账户证据或管理员身份。

数据库队列主键 `(userId,id)`，创建报告每天每账户最多 20 份，原报告重放不消耗配额；预览每 5 分钟最多 60 次。请求结果未知时按原 UUID GET 核实，不自动重复危险请求或生成新报告。处理回复持久保存，不发邮件。

`GET /api/moderation/content?agentId=...` 返回本人最近 50 条审核元数据。POST `{action:'preview',id}` 返回 `{item,body,previewToken}`；主人明确同意后的 `{action:'decide',id,digest,decision,previewToken,consent:true}` 校验确切摘要、本人、预览凭证、屏蔽与移除状态。受限 60 次/5 分钟。UI 绑定账户、会话和 Agent，切换登录隐藏旧证据并禁用投递。

`ModerationReport` / `ModerationContent` 有 User 和 Agent Cascade，`ModerationRate` 有 User Cascade，`WorkspacePeerSafety` 有 Agent Cascade；删除同时执行显式作用域清理。已有外发请求、外部平台授权、Agent 本机记录和离线备份不是本事务可撤销的边界。操作流程见 [举报与内容处理](../operations/MODERATION.md)。
