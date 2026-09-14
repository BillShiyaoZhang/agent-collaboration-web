# Web 部署与数据库迁移

本版本把 Web 收敛为 agent 的远程工作台。联系人、事项、审批和对话的业务真相源在 agent 侧。部署前请保存旧服务镜像、代码、SQLite 备份及原 NEXTAUTH_SECRET。

## 配置

| 变量 | 含义 |
| --- | --- |
| DATABASE_URL | Web SQLite 路径，生产根项目使用 file:/app/data/prod.db |
| NEXTAUTH_URL | 用户实际访问的 HTTPS Origin；同源校验使用此值 |
| NEXTAUTH_SECRET | 登录会话及控制台私钥保护密钥，须保留旧值 |
| AGENT_PLATFORM_URL | 服务端访问 Registry/MQ 的地址，如 http://platform:8080 |

浏览器只访问 Web；Web 经 Registry/MQ 与 agent 通信。agent 无需暴露公网 HTTP 端口。

根部署项目使用其自身 docker-compose.yml 和 nginx.conf。当前目录的 Compose 仅用于独立开发；容器里的 platform 地址必须使用服务名而非 localhost。

## 旧环境升级

1. 暂停 Web 写入，保留旧镜像和源码快照。不要暂停或清空 platform 的信箱。
2. 对实际 DATABASE_URL 的 SQLite 使用一致性备份。若数据库处于 WAL 模式，不能只复制主文件并遗漏 WAL；可使用 SQLite backup API，或停止 Web 后复制完整数据库文件组。验证备份能打开，记录账户、Agent 和旧业务表的行数。
3. 在**备份副本**上先运行本版本的 prisma/remote-console.sql，核对原表及原列数据没有改变。
4. 部署新代码。容器入口会运行同一 SQL，并在迁移失败时停止启动；不会继续以半迁移状态提供服务。
5. 检查登录、已有连接显示、控制台身份公钥保持不变。用已在 agent 本机配对的控制台验证 capabilities / state / inbox，不能只用 HTTP 200 判断 RPC 成功。

手动迁移命令：

```sh
npm run db:generate
npm run db:migrate
```

不要对现存数据库运行 prisma db push，尤其不能使用 accept-data-loss。本项目已移除此命令及容器的强制覆盖路径。

## 迁移准确改变什么

- 新库创建 User、Agent、ControlRequest；旧库保留原 User / Agent 数据。
- 新增 ControlRequest 加密投递缓存表和相应索引。
- 将 Agent 全局 URN 唯一索引替换为 (userId, urn) 联合唯一索引。不同获准账户可以保存同一公共 agent URN。
- 不删除旧 Contact、Message、HITLRequest、Transaction 表，也不删除旧 Agent 私钥列等历史列。新 Prisma 模型和 API 完全不访问这些旧业务字段。
- 旧表不会自动导入 agent 联系人/任务，避免误把旧 UI 记录当成当前 agent 授权。需要迁移的历史内容应单独审核，选择性导入 agent 侧接口。

测试会在临时真实 SQLite 上重放迁移，校验原密码、旧联系人行、旧凭据列保存，两账户同 URN 不冲突，同账户重复连接被拒绝。

## 回滚

迁移是兼容性追加与连接索引调整。回滚前停止新 Web，保存新数据库副本。若升级后已出现不同账户保存同一 URN，旧代码对全局唯一的假设不再成立，不能直接切回旧应用继续写入。应恢复升级前镜像、完整 SQLite 备份与相同密钥，或在离线审核后解决重复连接再回滚。不要删除原业务表以“修复”迁移。

## RPC 缓存

请求 120 秒到期，缓存 10 分钟逻辑到期，访问时删除过期记录。无活跃请求的进程不会保证立即清除磁盘旧页，SQLite 备份也可能包含历史密文；这不是一个物理擦除承诺。业务内容的持久主存储始终在 agent。需要存储擦除策略的部署应另行管理数据库与备份保留期限。

控制台专用信箱中，验签成功但不是有效匹配 RPC 的消息会消费丢弃。升级前需要保留的旧控制台消息应从升级前数据库和备份离线归档。
