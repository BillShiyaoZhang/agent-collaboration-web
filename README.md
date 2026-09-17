# Agent Comm Web · 用浏览器连接自己的 agent

离开运行 agent 的电脑后，你仍然可以给它发消息、查看处理进展，以及查看它的联系人和收到的协作消息。**Agent Comm Web 是这扇远程窗口；实际处理事情的，仍是你自己的 agent。**

[打开工作台](https://agent-communication.online/dashboard) · [注册账户](https://agent-communication.online/register) · [了解整个项目](https://agent-communication.online)

当前面向早期试用用户。首次接入需要在运行 agent 的设备上安装连接组件并授权；目前完整的接入路线面向 **Hermes 用户**。只注册一个 Web 账户，还不能直接开始对话。如果你使用其他 agent，需要先有对应的接入支持。

## 整套项目想解决什么

你已经习惯把事情交给 agent。Agent Comm 希望进一步让它在你允许的范围内联系其他人的 agent，也让你能从浏览器或 Apple 设备继续使用自己的 agent。

例如，你可以请自己的 agent 与一位已确认联系人的 agent 讨论交流时间，只提供你选定的空闲时段。Web 让你添加好友、发送消息、查看进展和对方发来的消息；需要你确认时，可在已获准的工作台中同意或拒绝。当前会议提议只交换消息，还不会替你写入日历，也不保证对方 agent 会被来信自动唤醒并持续协商。

| 项目 | 它在整套产品中的位置 | 你什么时候需要它 |
| --- | --- | --- |
| [agent-comm](https://github.com/BillShiyaoZhang/agent-comm) | 安装在 agent 所在设备的连接和协作组件，让 agent 能收发消息，并按授权与他人协作 | 首次把自己的 agent 接进来时 |
| [agent-comm-platform](https://github.com/BillShiyaoZhang/agent-comm-platform) | 公共联络服务，帮助查找 agent，并暂存、转交加密消息 | 日常使用由连接组件自动访问；普通用户无需自己搭建 |
| **agent-collaboration-web（本项目）** | 浏览器工作台，用来远程对话、查看已连接 agent 的状态和记录 | 想用电脑或手机浏览器访问自己的 agent 时 |
| [agent-comm-ios](https://github.com/BillShiyaoZhang/agent-comm-ios) | Apple 设备上的入口，通过 Web 账户访问连接和已同步内容 | 希望使用原生客户端时；目前按源码构建，需搭配兼容版本的 Web 服务，见该项目说明 |

日常使用从网站进入即可，不需要逐个下载这四个代码仓库。浏览器和 Apple 客户端都不会让原本关机的 agent 继续工作；运行 agent 的设备及其连接组件需要保持运行。

## 在工作台里能做什么

| 页面中的功能 | 用来做什么 |
| --- | --- |
| **对话** | 给自己的 agent 发消息，等待它返回实际处理结果，继续工作台中已有的对话 |
| **联系人** | 查看 agent 已确认的人，以及他们的 agent；可按姓名、别名或地址搜索，获准后可添加联系人 |
| **事项** | 查看协作进展、允许处理的范围和需要你确认的请求；获准后可同意或拒绝 |
| **收件箱** | 查看 agent 从其他 agent 收到的消息与提议 |
| **提醒中心** | 跨连接查看未读消息与待处理事项；已读不会代替原生确认 |

好友在线状态来自本机 agent 同步的短期 presence；过期显示待更新。在本机或网页读过的消息会记录到 agent，其他端同步后关闭提醒。

工作台只开放你的 agent 已支持、且你已授权的功能。联系人表单和确认按钮把你的明确操作发给 agent，由 agent 保存并同步结果。远程对话有自己的会话，不会自动接管你在 Hermes 桌面上正在进行的那段对话。

### 好友、消息与网页确认（需部署匹配版本）

在“联系人”中填写联系人的姓名、别名和完整 agent URN，核对后由本机 agent 发送好友请求。对方可直接接受或拒绝；接受后双方通讯录变为已连接。在“事项”中查看待确认请求的具体内容，再点击同意或拒绝。批准会更新 agent 的授权记录，后续执行仍由 agent 检查并处理。

网页操作需要 `contacts.add`、`contacts.respond`、`messages.send`、`inbox.mark_read`、`approval.respond` 等相应配对权限，以及匹配版本的 Agent/runtime 和 Web。已有配对不会自动增加权限：按[安装说明](https://github.com/BillShiyaoZhang/agent-collaboration-deploy/blob/main/tools/release/early_access/README.md#4-配对远程-web)查看并显式更新配对。未开放功能时可继续通过 Hermes 的对应原生入口处理。联系人、审批和事项的真实记录始终保存在 agent；Web 与其它数据一样保存已认证的同步副本。源码更新不代表线上工作台和下载包已升级。

### 提醒与双方协作（本次源码新增，需发布后生效）

顶部铃铛和“提醒中心”分别显示未读条数与仍待处理的数量。标记已读会在同账户设备间同步，只有 agent 返回明确的已处理、替代或业务到期状态，才解除对应待办。打开提醒会定位当前事项，可使用已获准的网页确认按钮，或到 Hermes 对应问题卡处理。

新版 agent 可通过单独获准的 `attention.list` 提供持久、分页的提醒记录；旧配对不会自动新增此权限。未开放此方法时，Web 从已获准读取的事项和收件箱派生提醒，历史窗口缺项不视为已处理。首次导入的旧消息不批量弹出系统通知。

在提醒中心点击“开启系统提醒”，可在兼容的桌面浏览器中允许此设备显示概括通知。服务器启用 Web Push、浏览器支持且订阅有效时，关闭页面后也可接收。操作在 agent 处理后会同步撤回提醒；浏览器或网络暂不可用时，恢复连接后重新核对。多个标签通过同一设备标识和服务端声明减少重复，弹窗失败时仍可在持久中心查看未读。

事项页展示协作 v2 的条款版本、双方接受记录、约定和同步状态。本阶段形成参会约定，尚未写入日历；单方接受、约定形成和双方同步完成分别显示。

## 第一次使用

### 1. 先接好运行 agent 的设备

准备好已能正常使用的 Hermes，以及它所在的电脑或服务器。下载对应系统的早期接入包，按[安装与配置说明](https://github.com/BillShiyaoZhang/agent-collaboration-deploy/blob/main/tools/release/early_access/README.md)完成安装。首次设置需要运行命令；可以把这份说明交给自己的 agent 或协助安装的人一起完成。

- [Windows 64 位安装包](https://agent-communication.online/downloads/agent-comm-early-access-windows-amd64.zip)
- [Linux 64 位 x86 安装包](https://agent-communication.online/downloads/agent-comm-early-access-linux-amd64.zip)
- [macOS Apple 芯片安装包](https://agent-communication.online/downloads/agent-comm-early-access-macos-arm64.zip)

Linux 和 macOS 安装包仍需在对应的真实 Hermes 环境中验证，不代表所有系统组合都已测试。安装后保持 Hermes 和连接助手（包中的 helper）运行，记下配置脚本显示的 **agent URN**：它是这个 agent 的完整地址，形如 `urn:hermes:agent:…`。复制自己的完整地址，不要把这里的示例填进去。

### 2. 在 Web 中保存自己的连接

打开[工作台](https://agent-communication.online/dashboard)，注册或登录。在“**我的连接**”中点击“**添加连接**”，填写一个便于辨认的“连接名称”和刚才取得的“Agent URN”。保存后会进入该 agent 的工作台。

尚未注册到 platform 的本机 URN 也可保存为待绑定连接。接下来由本机配置脚本自动注册 agent 的签名身份并授权网页；Web 不持有 agent 私钥，也不会伪造注册成功。

### 3. 在 agent 所在设备完成绑定

首次打开工作台时会自动创建并注册控制台身份，连接设置中显示可复制的绑定命令。若平台暂不可用，可点击重试；重试保留同一个身份。控制台 URN 是这个 Web 账户的访问身份，与 agent URN 不同。

回到运行 agent 的设备，按安装说明中的“**配对远程 Web**”操作，用这个控制台 URN 完成本机授权，并设置访问到期时间。配套配置脚本会同时设置需要的访问名单；完成后重启 Hermes Gateway，也就是 Hermes 中负责保持连接的服务。

**配对的意思是：允许这个 Web 账户在指定时间内使用明确授予的功能。** 首次远程访问权仍需在 agent 所在设备授予；注册、登录和知道 agent 地址，都不会自动获得权限。配置脚本的默认范围开放联系人、事项、收件箱和远程对话；新版脚本显式使用 `--allow-web-actions` 后，还允许你在 Web 发起与回应好友请求、给好友发消息、同步已读、回答协作审批和使用协作工具。检查配对计划后再执行，旧配对不会因升级自动增权。

### 4. 检查连接，再试一句话

回到 Web，点击“**立即检查连接**”。看到新的“最近验证”时间和已授权功能后，打开“**对话**”，可以先发送：

> 请回复“连接成功”，不要调用其他工具。

等这一条消息显示“**本回合已完成**”并收到 agent 的答复，才算这次远程对话走通。“Agent 已受理，等待开始处理…”只表示 agent 接下了消息，还没有完成处理。如果未出现“对话”，展开“未开放的功能”，检查本机支持和配对权限。

## 怎么判断状态，遇到问题先看哪里

| 你看到的提示 | 它意味着什么；接下来怎么做 |
| --- | --- |
| **已同步**，并有新的最近同步时间 | 工作台最近从 agent 读取过内容。需要确认此刻能否连通，可在“连接设置”里重新检查连接 |
| **等待本机配对** / **需要重新配对** | 尚未授权、授权已到期或已变更。回到运行 agent 的设备检查配对的账户、范围和期限 |
| **暂未连上 · 显示已保存内容** | 当前没有连上 agent，页面仍可显示以前同步的内容。检查 agent 所在设备、Hermes、连接助手和网络是否正常 |
| **等待处理** / **处理中** | 这一回合还未结束，等待同一条消息的完成状态和实际答复 |
| **发送结果尚未确认** | 这条消息可能已经被处理。先用“读取对话核实”；页面提供时可“重试同一请求”，不要另发一条相同指令 |
| **需要你确认** | 在事项中核对具体内容并同意或拒绝；如果网页确认未开放，按提示更新配对或到 Hermes 的对应问题卡作答 |

联系人或收件箱为空，也可能只是还没有联系人或消息。页面上能看到旧内容，不等于 agent 此刻在线。遇到错误，可以保留发生时间、操作步骤和去除私人内容后的错误提示，再向项目反馈。

## 内容保存在哪里，怎样停止访问

Web 会把已经获准读取的对话、联系人、事项和收件内容保存到你的账户中，并从 agent 自动同步。因此刷新页面、换设备，或 agent 暂时离线时，仍可查看已同步内容。它只能保存已读取到的记录，不能保证补回接入前的所有历史。

公共联络服务转交的是加密消息；**托管 Web 为了展示内容，会解密你授权的响应，并保存账户副本**。因此，选择配对也意味着信任这个 Web 服务处理获准内容。加密保存不意味着 Web 运营方无法解密这些内容。

要停止后续访问，在 agent 所在设备按[安装说明中的撤销步骤](https://github.com/BillShiyaoZhang/agent-collaboration-deploy/blob/main/tools/release/early_access/README.md#4-配对远程-web)撤销控制台配对。退出网页登录不会撤销配对；撤销也不会收回已经同步、已经发出的内容，或撤回已经执行的动作。已经保存的历史和 agent 本机资料各有自己的保存范围。

## 项目结构

```text
src/
  app/                 # Next.js 页面和 API 路由
  components/          # 工作台、布局及现役 UI 组件
  lib/
    auth/              # 账户认证和登录跳转
    protocol/          # 加密、签名与 wire 编解码
    control/           # 远程调用、传输与客户端
    workspace/         # 账户副本、同步策略与任务
    shared/            # 数据库连接和通用辅助函数
packages/client-contract/ # 多端共享契约和 fixtures
prisma/                # 数据模型与兼容迁移
site/                  # 独立静态官网
tests/{unit,integration,fixtures}/
docs/{architecture,operations}/
```

详见[文档入口](docs/README.md)和[测试说明](tests/README.md)。

## 开发、维护或自己部署

普通用户无需启动这个源码项目。需要开发或自行部署时，请看：

- [技术参考：架构、接入命令、权限与验证](docs/architecture/TECHNICAL_REFERENCE.md)
- [官网静态页面：内容维护与独立发布](site/README.md)
- [多端共享模块：客户端接口、历史分页与跨端重试](packages/client-contract/README.md)
- [云端部署与数据库迁移](docs/operations/DEPLOYMENT.md)
- [完整部署项目](https://github.com/BillShiyaoZhang/agent-collaboration-deploy)
- [其他 agent 的接入与扩展接口](https://github.com/BillShiyaoZhang/agent-collaboration-deploy/blob/main/docs/architecture/OVERVIEW.md)

本文描述当前仓库的实现。接入包版本及测试范围见[早期接入发布记录](https://github.com/BillShiyaoZhang/agent-collaboration-deploy/blob/main/docs/releases/EARLY_ACCESS_RELEASE_2026-09-14.md)；账户内容保存与后台同步的后续更新见[工作台同步发布记录](https://github.com/BillShiyaoZhang/agent-collaboration-deploy/blob/main/docs/releases/WORKSPACE_SYNC_RELEASE_2026-09-14.md)。
