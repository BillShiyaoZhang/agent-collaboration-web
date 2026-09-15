# Web 部署与数据库迁移

本版本的 Web 远程工作台按账户保存已认证数据的加密副本，并由常驻后台任务主动同步。联系人、事项、审批和对话的业务真相源在 agent 侧。部署前请保存旧服务镜像、代码、SQLite 备份及原 NEXTAUTH_SECRET。本文描述当前部署流程；各次线上版本与验收证据由部署仓库的 releases 与 verification 目录记录。

## 配置

| 变量 | 含义 |
| --- | --- |
| DATABASE_URL | Web SQLite 路径，生产根项目使用 file:/app/data/prod.db |
| NEXTAUTH_URL | 用户实际访问的 HTTPS Origin；同源校验使用此值 |
| NEXTAUTH_SECRET | 登录会话、控制台私钥及工作台内容的保护密钥，须保留旧值 |
| AGENT_PLATFORM_URL | 服务端访问 Registry/MQ 的地址，如 http://platform:8080 |
| WEB_PUSH_SUBJECT | 可选，浏览器推送的发送方 HTTPS 或 mailto 地址；默认 NEXTAUTH_URL |
| WEB_PUSH_DISABLED | 设为 1 停止后台推送；不影响站内提醒 |

浏览器只访问 Web；Web 经 Registry/MQ 与 agent 通信。agent 无需暴露公网 HTTP 端口。

浏览器后台推送还需要到固定厂商推送端点的 HTTPS 出站连接，详见[后台推送部署与验收](WEB_PUSH.md)。它使用现有读取范围中的提醒，不增加 agent 权限。

根部署项目使用其自身 docker-compose.yml 和 deploy/nginx/nginx.conf。当前目录的 Compose 仅用于独立开发；容器里的 platform 地址必须使用服务名而非 localhost。

后台同步由 Next.js instrumentation 启动常驻 Node worker，部署必须维持 Node 进程和可写持久 SQLite 卷。只在 HTTP 请求期间运行的环境不能保证浏览器关闭后继续同步。worker 使用租约、去重和失败退避；读取通过既有 Registry/MQ 发往 agent，不需要新的公网监听端口，也不依赖浏览器定时点击。

## 旧环境升级

1. 暂停 Web 写入及其后台同步 worker，保留旧镜像和源码快照。不要暂停或清空 platform 的信箱。
2. 对实际 DATABASE_URL 的 SQLite 使用一致性备份。若数据库处于 WAL 模式，不能只复制主文件并遗漏 WAL；可使用 SQLite backup API，或停止 Web 后复制完整数据库文件组。验证备份能打开，记录账户、Agent 和旧业务表的行数。
3. 在**备份副本**上先运行本版本的 prisma/remote-console.sql，核对原表及原列数据没有改变。
4. 部署新代码。容器入口会运行同一 SQL，并在迁移失败时停止启动；不会继续以半迁移状态提供服务。
5. 检查登录、已有连接显示、控制台身份公钥保持不变。用隔离测试连接验证 capabilities / state / inbox 认证往返，不能只用 HTTP 200 判断 RPC 成功。
6. 不点击标签或刷新，检查 worker 是否更新已授权的连接；重启 Web 并重新登录，检查联系人、消息、当前及已知会话是否恢复。模拟 agent 离线，确认旧数据可见且显示最后同步时间；确认后台不会发送对话或审批。验证账户隔离与删除连接的级联清理。

手动迁移命令：

```sh
npm run db:generate
npm run db:migrate
```

不要对现存数据库运行 prisma db push，尤其不能使用 accept-data-loss。本项目已移除此命令及容器的强制覆盖路径。

## 迁移准确改变什么

- 新库创建 User、Agent、ControlRequest 及账户工作台持久副本；旧库保留原 User / Agent 数据。
- ControlRequest 继续保存有限期加密投递信封。新增工作台副本和同步状态存储，与短期缓存分离；联系人视图、收件箱和会话内容使用 AES-GCM 静态加密。
- 已知会话、当前会话及未确认发送的原始请求在服务端恢复。消息和回合按 ID 累积，不能以远端最新 100 项窗口中缺少某条记录为由删除历史。
- 将 Agent 全局 URN 唯一索引替换为 (userId, urn) 联合唯一索引。不同获准账户可以保存同一公共 agent URN。
- 不删除旧 Contact、Message、HITLRequest、Transaction 表，也不删除旧 Agent 私钥列等历史列。新 Prisma 模型和 API 完全不访问这些旧业务字段。
- 旧表不会自动导入 agent 联系人/任务，避免误把旧 UI 记录当成当前 agent 授权。需要迁移的历史内容应单独审核，选择性导入 agent 侧接口。
- 浏览器后台推送追加 WebPushConfig、WebPushSubscription、WebPushDelivery，分别保存加密 VAPID、账户设备订阅和有限期投递；回滚保留这些表及原 NEXTAUTH_SECRET。

迁移验证应在临时真实 SQLite 上重放，校验原密码、旧联系人行、旧凭据列保存，两账户同 URN 不冲突，同账户重复连接被拒绝；同时检查新增副本的静态加密、账户隔离及删除连接后的级联清理。历史验收证据见部署仓库的 verification 目录。

## 回滚

迁移采用兼容性追加，并包含早期版本的连接索引调整。回滚前停止新 Web 及同步 worker，保存新数据库副本和原密钥。回滚到仍支持每账户连接、只是不支持工作台副本的上一版时，保留新增表和数据；旧代码不会提供后台同步与历史恢复。不要为了回滚界面覆盖正在使用的数据库，否则会丢失升级后的账户写入和同步记录。

若回滚目标更早，仍假设 Agent URN 全局唯一，而升级后已经有不同账户保存同一 URN，则不能直接切回该版本继续写入。需要先离线审核兼容性并制定数据恢复方案。不要删除原业务表以“修复”迁移。

## 持久数据与 RPC 缓存

请求 120 秒到期，RPC 缓存 10 分钟逻辑到期，由控制调用和后台同步清理过期记录。持久工作台副本没有这一到期规则，能够在刷新、进程重启和 agent 离线后恢复。副本的内容来自已认证的 agent 读取结果；Web 能解密这些内容用于显示，静态加密并不隐藏于运行中的 Web 服务。

删除连接会级联删除此账户在该连接下的副本和请求记录。逻辑删除不保证立即清除磁盘旧页，SQLite 备份也可能包含历史密文；数据库与备份保留期限应一并管理。删除 Web 副本不删除 agent 本地记录，agent 撤销配对也不能召回已披露的副本。

现有 SDK 没有 conversation.list，也没有 inbox / conversation 历史分页；首次升级只能恢复已知会话及远端最近 100 项读取窗口，不能宣称完整旧历史已回补。同步失败时保留最后一次成功读取的数据，并准确显示离线、权限或同步失败状态。

控制台专用信箱中，验签成功但不是有效匹配 RPC 的消息会消费丢弃。升级前需要保留的旧控制台消息应从升级前数据库和备份离线归档。
