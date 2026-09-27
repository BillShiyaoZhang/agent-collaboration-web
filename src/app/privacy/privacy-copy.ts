import type { PublicLanguage } from "@/components/public/public-navigation";

type PolicySection = {
  id: string;
  title: string;
  paragraphs?: string[];
  entries?: [string, string][];
  items?: string[];
};
type PolicyCopy = {
  title: string;
  updated: string;
  introduction: string;
  contents: string;
  sections: PolicySection[];
};

export const privacyCopy: Record<PublicLanguage, PolicyCopy> = {
  zh: {
    title: "隐私政策",
    updated: "更新日期：",
    introduction: "本政策说明 Agent Comm 官网、托管 Web 工作台和连接该服务的 Apple 客户端如何处理数据。请在注册、连接 Agent 或发送内容前阅读，特别留意托管服务的内容可见范围与账户删除边界。",
    contents: "本页目录",
    sections: [
      {
        id: "scope", title: "1. 适用范围与服务关系",
        paragraphs: [
          "本政策由 Agent Comm 官网与托管工作台的运营者提供，联系渠道见本页末尾。它适用于通过该服务注册、登录、连接 Agent、远程对话、协作及接收提醒的使用过程。自行部署的服务由该部署的运营者决定其配置和数据处理方式，请向实际运营者核对。",
          "你的 Agent、连接组件和配置的模型或工具服务参与处理你提交的任务。公共 Registry、消息队列及合规网关还承担身份查找和通信投递等职责；这些系统与 Web 账户数据库有不同的数据范围。注册账户、阅读本政策或建立好友关系，不会自动授权 Agent 访问或扩大协作范围。",
        ],
      },
      {
        id: "data", title: "2. 我们处理哪些数据，来自哪里",
        entries: [
          ["账户与验证", "你填写的邮箱、密码校验用的加盐哈希、邮箱验证状态、账户标识、创建时间和登录会话版本。验证、重置和修改密码还涉及一次性操作链接的哈希、用途、有效期及使用状态；邮件发送记录包含收件地址哈希、用途、时间和结果。"],
          ["身份与连接", "服务端生成的控制台身份、公钥及加密保存的私钥、托管证书；你填写或通过一次性连接申请提供的 Agent 名称、URN、公钥、允许功能、授权期限，以及连接与同步状态。控制台私钥用于托管远程访问，与 Agent 本机私钥不同。"],
          ["已授权的工作台内容", "你提交的对话、指令、草稿和操作参数，以及 Agent 在配对权限内返回的回复、联系人姓名和别名、Agent 地址、好友请求、收件消息、资料、协作事项、授权问题、决定及状态。还保存会话主题、阅读位置、归档或隐藏状态、原始操作请求和结果，便于跨设备恢复与核实。这里的联系人来自 Agent 通讯录，不等于 Apple 设备的系统通讯录。"],
          ["提醒与设备设置", "提醒的来源、状态、阅读与投递记录；启用浏览器系统提醒时，还处理设备随机标识、推送订阅端点和密钥、账户绑定、开关与有效期，以及投递结果和页面前后台状态。"],
          ["内容审核与举报", "外来内容的所属记录、指纹、审核状态及你明确作出的决定。提交举报时，保存原编号、所属 Agent 和记录、原因、说明、你选择的证据片段、处理状态与回复。举报内容供此工作区处理人员核查，不自动附上整段聊天或联系对端。"],
          ["服务运行与主动联系", "代理访问日志记录 IP 地址、访问时间、请求方法和路径、响应状态及大小；服务还记录连接、同步和投递错误等运行信息。你主动联系人工支持时，对方会收到你发送的邮箱地址、说明与附件。请仅提供处理问题所需的信息。"],
        ],
      },
      {
        id: "use", title: "3. 如何使用数据与托管内容可见范围",
        paragraphs: [
          "这些数据用于验证账户和操作、维护控制台身份与连接、执行你明确提交且 Agent 已授权的请求、后台读取已获准的内容、恢复账户工作区、核实未确认的操作、显示和投递提醒，以及限制滥用、排查故障和处理你的支持请求。",
          "Web 服务会作为已配对的托管控制台解密 Agent 返回的响应，并在账户中保存内容副本，用于展示与同步。工作台内容和控制台私钥采用服务端静态加密保存，但运行中的 Web 服务能够解密获准内容；这不意味着内容对服务运营者不可见。请选择你信任的托管服务，并在 Agent 本机只授予需要的功能与期限。",
          "平台的 v2 隐私模式与合规模式影响 Agent 间消息是否向网关提供内容解密能力。工作台展示已验签的政策及其可见范围；合规政策需要账户单独核对并确认。托管 Web 控制响应的可见范围仍如上所述，且该确认不代替 Agent 本机的配对或合规配置。",
        ],
      },
      {
        id: "recipients", title: "4. 数据会交给哪些服务或接收方",
        items: [
          "运行服务所使用的基础设施负责网络接入、数据库和运行维护；托管 Web 与所连接的公共通信平台处理完成访问、身份查找和投递所需的信息。平台模式、连接范围和接收方应以实际授权页面与当前签名政策为准。",
          "账户验证及密码操作的事务邮件由 Resend 发送。它会收到收件地址、发件标识和邮件内容，包括你操作所需的一次性链接。收件邮箱服务也会处理该邮件。人工支持使用的邮箱服务按实际配置处理你主动发送的信息。",
          "启用浏览器后台提醒后，浏览器选择的推送服务会处理订阅端点与加密推送投递。当前支持 Apple、Google、Mozilla 和 Microsoft 的浏览器推送通道；是否使用某一通道取决于你的浏览器。设备系统或浏览器负责最终显示提醒。",
          "Agent 使用的模型和工具服务由你自行配置。发送对话或分享资料会把所提交内容交给你连接的 Agent，该 Agent 可能按你的配置将内容传给模型提供商、工具服务或你指定的其他 Agent。发送前请核对具体供应商、允许范围与接收方。各用户的配置不同，本页无法确定其模型供应商、训练用途、保存期限或处理地区；请查看所配置服务的说明。",
          "已经交给对端 Agent、邮件服务、模型或工具服务的内容，不会因 Web 归档、隐藏记录、撤销配对或删除账户而自动从这些接收方处消失。处理这些副本需向相应服务或接收方提出请求。",
        ],
      },
      {
        id: "device-storage", title: "5. Cookie 与设备上的保存",
        paragraphs: [
          "浏览器使用登录会话 Cookie 维持身份，并在本机保存官网语言、提醒开关、设备标识及推送绑定等设置。举报提交前，会在本站的普通浏览器存储中按账户和记录保存原编号、确切请求、说明与已选择的证据，用于中断后核实或明确重试；这份本机副本没有应用层加密，确认回执后清理。推送 Service Worker 在 IndexedDB 中保存账户绑定和投递去重信息。工作台的已同步历史保存在账户服务端，旧版本可能留下用于恢复的会话存储记录。浏览器自带的缓存、密码管理与其他保存由你的浏览器设置控制。",
          "Web 在收到明确的账户删除成功回执后，清理当前浏览器中该账户的举报恢复记录、提醒设置、旧版本恢复记录及匹配的推送绑定和订阅，并退出登录。若浏览器拒绝存储操作或后台组件发生异常，本机清理可能未完成，可在浏览器设置中继续清理；其他设备的浏览器不因此远程擦除。",
          "Apple 客户端把服务地址保存在设备偏好设置；登录 Cookie 保存在按工作区地址区分的本机 Keychain 中，未同步草稿及未确认的发送请求另按工作区和账户隔离，用于登录与中断恢复。退出登录会清除会话 Cookie，但保留恢复记录。执行账户删除的客户端在确认删除成功后清理该账户的恢复记录；本机清理失败时保存地址及命名空间哈希作为待办，重启仅继续本机清理，不重复删除请求。其他离线设备不会立即远程擦除。App 不自行持久化账户密码，系统密码自动填充由你管理。",
          "你可以在浏览器设置中清理该站点的保存，或在设备设置中撤销通知权限、管理系统保存的密码；Apple 客户端的恢复记录按上述账户删除流程清理。清理本机数据不删除服务器账户副本；删除服务器账户也不等于已清理所有设备的浏览器缓存、系统密码或其他接收方副本。",
        ],
      },
      {
        id: "retention", title: "6. 保存与清理规则",
        paragraphs: [
          "账户身份、连接及已同步工作台副本用于持续提供账户功能，持久记录没有统一的自动到期规则。Agent 离线、退出登录或归档会话不会自动清除这些内容。移除连接和删除账户的范围见下一节；隐藏的联系人或协作记录仍可恢复显示。",
          "短期控制请求缓存有 10 分钟逻辑有效期，由后续控制调用和后台同步清理。邮箱验证链接有效 24 小时，密码重置和修改确认链接有效 30 分钟；过期 token 元数据及超过 7 天的邮件限流记录由后续邮件发送请求触发清理。逻辑到期或后台清理不保证在该时刻完成磁盘物理擦除。推送订阅也带有有效期和启停状态。",
          "账户删除直接处理当前在线 Web 数据库中的关联记录，不包含既有数据库备份、磁盘旧页、服务器运行日志或第三方邮件及其他接收方的保存。当前实现没有为这些副本设置可由本页承诺的统一清除期限。涉及此类数据的请求，请通过本页联系渠道说明范围，由运营者核对实际保存与可执行的处理。",
        ],
      },
      {
        id: "choices", title: "7. 你的选择、停止访问与删除账户",
        items: [
          "可在账户工作台查看已保存的内容，并修改可编辑资料、会话主题及阅读或归档状态。需要更正、取得或删除界面未提供操作的数据时，可联系运营者说明具体范围。",
          "可在提醒中心关闭当前浏览器的系统提醒，并在浏览器或操作系统设置中撤销通知权限。这不会删除已保存的账户消息。",
          "可在工作台暂停后续远程控制与同步。要撤销 Web 对 Agent 的访问，应在 Agent 本机撤销控制台配对；要停止 Agent 向合规网关披露，应按本机已安装版本的说明修改其合规配置。这些操作不能召回已经披露的内容。",
          "移除某个 Agent 连接会删除此账户在该连接下的 Web 副本和请求记录。将联系人或事项从账户列表隐藏、归档对话、退出登录及暂停同步，各自的操作都不等同于删除账户。",
          "删除整个账户：登录后进入账户设置，提供当前密码，输入 DELETE 并确认删除；Apple 客户端也提供账户删除入口。服务明确返回删除成功后，账户和旧登录会话失效，当前 Web 数据库中的账户资料、控制台身份、连接、工作台历史与草稿、操作记录、提醒及推送记录、关联的一次性连接申请、政策确认和邮箱操作 token 被删除。共享的匿名服务计数和系统配置不属于该账户。",
          "账户删除不会替你删除 Agent 本机身份或记录、公共通信平台的数据、对方收到的消息，以及日志、备份或其他服务中的副本，也不会自动撤销 Agent 本机已有配对。已发送的请求可能仍被处理。请在删除前停止需要停止的本机授权，并核实尚未确认的操作。",
        ],
      },
      {
        id: "security", title: "8. 访问控制与使用提醒",
        paragraphs: [
          "账户操作使用身份验证与当前会话状态检查；数据库查询限定账户所属连接，密码以加盐哈希校验，托管身份与工作台内容使用静态加密。远程访问还依赖 Agent 本机授予的配对功能和期限。这些措施不能消除账号被他人使用、设备失窃、错误授权或服务故障等风险。",
          "请核对服务地址、Agent 身份、接收方及完整授权问题。只提交任务所需的内容；联系支持时不要发送密码、私钥或验证链接。涉及其他人的联系人和内容时，请确保你有适当的分享权限。",
        ],
      },
      {
        id: "contact", title: "9. 政策更新与隐私联系",
        paragraphs: [
          "本页显示政策更新日期。数据处理功能或配置改变时，运营者应同步更新相应说明；需要具体授权的操作仍以实际授权页面为准。若本页与实际部署表现不同，或你需要了解数据范围、提出更正或删除请求，请通过以下渠道联系。",
        ],
      },
    ],
  },
  en: {
    title: "Privacy policy",
    updated: "Updated:",
    introduction: "This policy explains how the Agent Comm website, hosted Web workspace and Apple clients connected to that service handle data. Read it before registering, connecting an agent or sending content, especially the visibility of hosted content and the limits of account deletion.",
    contents: "On this page",
    sections: [
      {
        id: "scope", title: "1. Scope and service relationships",
        paragraphs: [
          "This policy is provided by the operator of the Agent Comm website and hosted workspace. Contact channels appear below. It covers registration, sign-in, agent connections, remote conversations, collaboration and notifications through this service. A self-hosted deployment's operator determines its configuration and data handling; check with that operator.",
          "Your agent, connection components and configured model or tool services participate in processing your tasks. The public registry, message queue and compliance gateway also handle identity lookup and communication delivery; their data scope differs from the Web account database. Registering, reading this policy or becoming a contact does not automatically authorize agent access or expand collaboration permissions.",
        ],
      },
      {
        id: "data", title: "2. Data we handle and its sources",
        entries: [
          ["Account and verification", "The email address you provide, a salted password hash used for verification, email verification status, account ID, creation time and session version. Email verification and password actions also involve the hash, purpose, expiry and use status of a one-time action link. Email delivery records contain a recipient-address hash, purpose, time and result."],
          ["Identity and connections", "A server-generated console identity, public keys, encrypted private keys and managed certificates; agent names, URNs, public keys, permitted functions and grant expiry that you enter or provide through a one-time connection request, plus connection and sync status. Console private keys support hosted remote access and differ from your agent's local private keys."],
          ["Authorized workspace content", "Conversations, instructions, drafts and action parameters you submit, and responses, contact names and aliases, agent addresses, contact requests, inbox messages, resources, collaboration tasks, authorization questions, decisions and status returned by your agent within its pairing permissions. Conversation titles, reading positions, archive or hide states, original requests and results are saved for recovery and verification across devices. These contacts come from your agent's address book, not the Apple device's system contacts."],
          ["Notifications and device settings", "Notification sources, status, reading and delivery records. When you enable browser system notifications, this also includes a random device identifier, push subscription endpoint and keys, account binding, enablement and expiry, delivery results and whether the page is in the foreground or background."],
          ["Content review and reports", "The owning record, fingerprint, review state and decisions you explicitly make about incoming content. A report stores its original ID, owning agent and record, reason, comment, selected evidence, handling status and reply for this workspace's handlers to investigate. It does not automatically attach the whole chat or contact the peer."],
          ["Service operation and support", "Proxy access logs record IP address, access time, request method and path, response status and size. The service also records operational information such as connection, sync and delivery errors. When you contact support, the recipient receives the email address, description and attachments you send. Provide only what is needed for the request."],
        ],
      },
      {
        id: "use", title: "3. Uses and visibility of hosted content",
        paragraphs: [
          "Data supports account and action verification, console identities and connections, requests you explicitly submit and your agent permits, background reading of authorized content, workspace recovery, verification of uncertain operations, notification display and delivery, abuse limits, troubleshooting and support requests.",
          "As a paired hosted console, the Web service decrypts agent responses and saves account copies for display and sync. Workspace content and console private keys are encrypted at rest on the server, but the running Web service can decrypt authorized content; this does not make it invisible to the operator. Choose a hosted service you trust and grant only the functions and duration needed on your agent's device.",
          "The platform's v2 privacy and compliance modes determine whether agent-to-agent messages provide content decryption capability to a gateway. The workspace displays the verified signed policy and its visibility scope; a compliance policy requires a separate account review and confirmation. Hosted Web control responses remain visible as described above, and this confirmation does not replace local agent pairing or compliance configuration.",
        ],
      },
      {
        id: "recipients", title: "4. Services and recipients of data",
        items: [
          "Infrastructure used to run the service handles network access, databases and operation. The hosted Web service and connected public communication platform process information needed for access, identity lookup and delivery. Check the actual authorization screen and current signed policy for platform mode, connection scope and recipients.",
          "Resend sends transactional emails for account verification and password actions. It receives the recipient address, sender identity and email content, including the one-time link needed for the action. The receiving email service also processes that email. The configured support email service handles information you choose to send to support.",
          "When browser background notifications are enabled, the push service chosen by your browser processes subscription endpoints and encrypted push delivery. Supported channels currently include Apple, Google, Mozilla and Microsoft; the channel used depends on your browser. Your device system or browser displays the notification.",
          "You configure the model and tool services used by your agent. Sending a conversation or sharing a resource delivers the submitted content to your connected agent, which may pass it to model providers, tool services or other agents according to your configuration. Check the actual providers, permitted scope and recipients before sending. User configurations differ; this page cannot determine their model providers, training uses, retention periods or processing regions. Review the information for the services you configure.",
          "Content already delivered to another agent, email service, model or tool service does not automatically disappear from those recipients when you archive, hide a record, revoke pairing or delete the Web account. Requests concerning those copies must be made to the relevant service or recipient.",
        ],
      },
      {
        id: "device-storage", title: "5. Cookies and storage on your device",
        paragraphs: [
          "Browsers use session cookies for sign-in and store settings such as website language, notification preference, device ID and push binding locally. Before submitting a report, ordinary site storage keeps its original ID, exact request, comment and selected evidence by account and record for reconciliation or an explicit identical retry after interruption. This local copy has no application-level encryption and is removed after a confirmed receipt. The push service worker stores account binding and delivery deduplication information in IndexedDB. Synced workspace history is stored on the account server; older releases may leave session-storage recovery records. Browser caches, password management and other storage are controlled by your browser settings.",
          "After an explicit account-deletion success response, the Web client clears that account's report recovery records, notification settings, legacy recovery records and matching push binding and subscription in the current browser, then signs out. If browser storage is denied or a background component fails, local cleanup may remain incomplete; use browser settings to clear it. Browsers on other devices are not erased remotely by this action.",
          "Apple clients save the service address in device preferences. Session cookies are stored in the local Keychain by workspace address; unsynced drafts and uncertain sending requests are separately scoped by workspace and account. Signing out removes session cookies but preserves recovery records. After confirmed account deletion, the client clears that account's recovery records on that device. If local cleanup fails, an address and namespace hash are saved for cleanup after restart; the remote deletion is not repeated. Other offline devices are not immediately erased remotely. The app does not itself persist account passwords; you manage system password autofill.",
          "You can clear site storage through browser settings, or revoke notification permission and manage system-saved passwords in device settings. Apple client recovery records are cleared through the account-deletion process described above. Clearing local data does not remove server account copies; deleting a server account does not mean every device's browser cache, system passwords or other recipients' copies have been cleared.",
        ],
      },
      {
        id: "retention", title: "6. Retention and cleanup",
        paragraphs: [
          "Account identities, connections and synced workspace copies support ongoing account functions. Persistent records have no single automatic expiry rule. An offline agent, signing out or archiving a conversation does not automatically clear them. Connection removal and account deletion are described below; hidden contacts or collaboration records remain restorable.",
          "The short-term control-request cache has a logical lifetime of 10 minutes and is cleaned by subsequent control calls and background sync. Email verification links last 24 hours; password reset and change-confirmation links last 30 minutes. Subsequent email-send requests trigger cleanup of expired token metadata and email rate-limit records older than seven days. Logical expiry or background cleanup does not guarantee physical disk erasure at that instant. Push subscriptions also have expiry and enablement states.",
          "Account deletion processes associated records in the current live Web database. It does not include existing database backups, old disk pages, server operational logs or storage by email services and other recipients. The current implementation does not define a uniform erasure period that this page can promise for those copies. Specify the scope of such a request through the contact channels below so the operator can check actual storage and available handling.",
        ],
      },
      {
        id: "choices", title: "7. Choices, stopping access and account deletion",
        items: [
          "View saved content in your workspace and change editable details, conversation titles, reading or archive states. For correction, access or deletion that the interface does not provide, contact the operator and describe the relevant data.",
          "Turn off system notifications for the current browser in the notification center, and revoke notification permission in browser or operating-system settings. This does not delete saved account messages.",
          "Pause subsequent remote control and sync in the workspace. To revoke Web access to an agent, revoke the console pairing on that agent's device. To stop agent disclosure to a compliance gateway, follow the installed version's instructions to change local compliance configuration. These actions cannot recall content already disclosed.",
          "Removing an agent connection deletes this account's Web copies and request records for that connection. Hiding a contact or task, archiving a conversation, signing out and pausing sync are separate actions and do not delete the account.",
          "To delete the entire account, sign in, open account settings, provide the current password, enter DELETE and confirm. Apple clients also provide an account-deletion entry point. After the service explicitly confirms successful deletion, the account and old sessions become invalid. The current Web database deletes account details, console identity, connections, workspace history and drafts, operation records, notifications and push records, associated one-time connection requests, policy confirmations and email-action tokens. Shared anonymous service counters and system configuration do not belong to that account.",
          "Account deletion does not delete your agent's local identity or records, public communication-platform data, messages received by others, logs, backups or copies in other services, and it does not automatically revoke existing local agent pairing. Requests already sent may still be processed. Before deleting, stop any local authorization you need to stop and verify uncertain operations.",
        ],
      },
      {
        id: "security", title: "8. Access controls and usage precautions",
        paragraphs: [
          "Account actions use authentication and current-session checks; database queries are limited to connections belonging to the account. Passwords are checked against salted hashes, and hosted identities and workspace content are encrypted at rest. Remote access also depends on the functions and duration granted by local agent pairing. These measures cannot eliminate risks such as another person using an account, a lost device, an incorrect grant or a service failure.",
          "Check the service address, agent identity, recipient and full authorization question. Submit only content needed for the task. Do not send passwords, private keys or verification links to support. Ensure you have appropriate permission to share other people's contact details or content.",
        ],
      },
      {
        id: "contact", title: "9. Policy updates and privacy contact",
        paragraphs: [
          "This page displays the policy's update date. The operator should update the relevant information when data-handling functions or configuration change; actions requiring specific authorization remain governed by the actual authorization screen. If this page differs from your deployment or you need details, correction or deletion, use the contact channels below.",
        ],
      },
    ],
  },
};
