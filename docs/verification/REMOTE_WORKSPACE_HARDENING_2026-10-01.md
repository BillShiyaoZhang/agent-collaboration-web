# Web 工作区接入与资源边界验证 · 2026-10-01

本记录验证 `codex/ambient-workspace-review-20261001` 的 Web 工作树，起点为建议分支固定提交 `fc271b6b4093fa23b334869d22c0edee11b27da4`。记录只证明本机隔离测试与编译；本轮未合并 main、未部署云服务器，Ambient 本机仍需接入码适配。

## 改动范围

- 登录后的 `POST /api/workspace-nodes/enroll` 严格接受 `{}`，从真实会话派生账户及最长 200 字符标签，使用现有服务 Bearer 请求 Gateway。返回接入码、期限及独立公开控制 origin。
- `/connect-workspace` 无连接码时与 `/dashboard/workspaces` 提供明确发码、复制和到期清除。GET、刷新和到期不生成码；接入码不作为连接码自动领取，不进入 URL 或浏览器持久存储。
- 节点列表采用 `view=active|history`、默认 50/max 100 与账户绑定游标，严格要求 `next_cursor`，拒绝旧无界服务响应。下一页按用户动作读取，浏览器保留最多最近载入 500 项。
- `tldts 7.4.16`（含 private PSL）核对 Portal 与控制/节点域隔离；公开控制 origin 与节点根须属于同一工作区可注册域，Portal 须另属一域。本机允许独立端口的 localhost。
- Gateway 元数据和账户删除回执统一限制为 128 KiB JSON；访问链接须匹配确切节点 origin 与 launch/ticket 路径。
- 429 回执保留 1–300 秒整数 Retry-After，异常值回退 60 秒。浏览器按账户在内存保存冷却期限，期限内不向 Gateway BFF 发起节点读取、领取或再次发码，并暂禁发码按钮。

## 实际检查

| 环境/入口 | 结果 | 覆盖 |
| --- | --- | --- |
| Windows，`node --test tests/unit/workspace-nodes.test.cjs tests/unit/middleware.test.cjs tests/unit/dashboard-workspace-policy.test.cjs` | 27/27 通过 | 账户、Origin、权限、PSL、分页、节点状态与有界删除回执 |
| Windows，主功能完整 `npm test` | 400/401 通过 | 唯一失败为既有 operator CLI POSIX token 文件权限用例；未弱化权限检查 |
| Linux Docker，主功能完整 Web+client-contract 单元集 | 403/403 通过，约 104 秒 | 包含上述 POSIX 权限用例及前两项新 UI 事件测试 |
| Windows，最后的 Retry-After 补充后 `npm run build` | 成功 | Next.js 15.5.25 编译、lint、类型检查和页面生成；新增 enroll 路由包含在生产产物中 |
| Windows，最后的 Retry-After 补充后 `node --test tests/unit/workspace-nodes.test.cjs tests/unit/workspace-enrollment-client.test.cjs` | 9/9 通过 | 异常/合法 Retry-After、显式发码、重复点击只一次、复制与过期、换账户、丢失回执、GET/claim 冷却阻断 |
| Windows，最后补充后 `node node_modules/typescript/bin/tsc --noEmit --incremental false` | 成功 | 最终 BFF/UI 类型检查 |
| Windows，根仓库 `python tests/integration/test_workspace_portal_gateway.py --gateway-python C:/Users/zhang/Developer/ambient-agent/.venv/Scripts/python.exe` | 成功，退出 0 | 真实 HTTPS NextAuth/BFF + 新 Gateway；内网/公开 Host 分离、发码/重放、pending 页、领取/本机确认、账户撤销和旧 cookie |
| Windows，`docker compose --env-file .env.example -f docker-compose.yml config --quiet` | 成功 | 四项可选工作区 ENV 静态透传；既有 version 字段有弃用警告 |

Linux 验证复用本机已有 `agent-collaboration-web:collaboration-v096-0fc9a6c82352-builder`（镜像 ID `49a9b3ee0cb5`），运行 Node `v24.21.0`，使用 `--network none`。源目录只读挂载；源码、测试、文档和指定 Prisma schema/SQL 复制到容器临时 Linux 目录，复用 Linux 依赖并复制两项纯 JavaScript 的新 tldts 依赖，不复制宿主身份或数据库。测试数据库、文件权限 fixture 与运行结果均为临时合成内容，容器结束即移除。新增 npm 依赖实际从 registry 安装并生成锁文件，只保留新依赖条目，原依赖版本不变。

完整 Linux 检查完成后又补充了 Retry-After 行为和一个 UI 测试；按评审要求仅重跑相关 9 项和最终类型检查与生产构建，并运行隔离组合 smoke；未把 403/403 表述为最后补充后的完整回归。新增 UI 单元测试使用确定性 hook 调度执行生产组件的事件处理器，不替代真实浏览器与 Ambient 验收。

## 隔离组合 smoke 与未覆盖范围

本轮已运行根仓库的可复用 HTTPS smoke 启动器。它在临时目录复制最新生产构建，拒绝已有 dotenv，生成独立 TLS、secret、SQLite 和合成账户；BFF 使用 `127.0.0.1:<随机端口>`，device 明确使用公开 `localhost:<同端口>`，验证内网 Host 的 `/health` 返回 404、服务 Bearer 的 metrics 可访问。输出仅合成 PASS；捕获 READY 时隐藏测试密码，没有读取或更改用户身份、环境或系统信任。自建 Next/Gateway 进程终止、三个监听端口关闭，临时目录与依赖 junction 已清理。未执行真实浏览器截图、DNS/TLS 外网检查、Ambient 连接器、本机 Run、生产账户或云端发布。实际上线还需与 Gateway 成套升级，完成 Ambient `enrollment_token` 输入/发送及正式域名证书配置，见[云入口契约](../architecture/REMOTE_WORKSPACE.md)。
