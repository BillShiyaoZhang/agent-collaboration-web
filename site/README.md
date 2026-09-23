# Agent Comm 官网

面向第一次接触 Agent Comm 的用户，介绍整体用途、四个项目的分工和首次接入步骤。中英文静态首页在 [index.html](index.html)。[docs/index.html](docs/index.html) 是按用户、使用项目的 agent、开发者分组的文档入口。

官网与远程工作台同属 Web 仓库维护，但不依赖 Next.js 构建，也不嵌入 Platform 的 Go 程序。[部署仓库](https://github.com/BillShiyaoZhang/agent-collaboration-deploy)通过 nginx 将此目录只读挂载到 `/srv/site`：`/` 读取首页，`/docs/` 读取统一文档入口。工作台仍使用原有路由；Platform API 文档位于 `/docs/api/`。

## 文档门户

文档阅读页用 `/docs/?path=deploy/users/README.md` 这样的可分享地址，从 `/docs/source/` 获取 Markdown 原文并在浏览器中排版。原文由部署仓库把四个仓库各自的 `docs/` 只读挂载给 nginx；门户不维护另一份文档副本：

| 原仓库 `docs/` | 原文地址前缀 |
| --- | --- |
| 部署仓库 | `/docs/source/deploy/` |
| Web | `/docs/source/web/` |
| Platform | `/docs/source/platform/` |
| agent-comm SDK / Runtime | `/docs/source/sdk/` |

只公开现行操作和技术指南；日期化的发布与验收记录仍从 GitHub 查看。阅读器会把公开 `docs/` 内的相对 Markdown 链接留在门户，把不在公开范围的仓库文件链接指向对应 GitHub 仓库。原始 `.md` 地址也可供 agent 直接读取；阅读器需要 JavaScript，但页面在禁用 JavaScript 时提供三类读者的原文入口。

## 更新与检查

1. 编辑 `index.html` 或 `docs/index.html`，同时更新中文及对应 `data-en` 内容。修改门户文档链接时，确认目标仍在部署仓库的公开路径清单内。
2. 用静态 HTTP 服务预览首页与门户，检查中文、英文、手机窄屏、页内链接和复制说明；禁用 JavaScript 后中文首页仍应完整可读。文档读取还需在部署 nginx 路由下检查 `/docs/source/`、`/docs/api/`、阅读视图和跨仓相对链接。
3. 发布时把审核后的文件同步到服务器已挂载的 `site` 目录。仅改静态内容无需重建或重启 Web、Platform 或 nginx。首次启用目录挂载、修改 nginx 路由时，仍需要部署相应配置。

页面使用系统字体与内联图形，没有外部前端依赖。控制台地址、授权范围和期限由用户决定；示意对话不代表真实执行结果。

## Hermes 自动接入入口

首页 HTML 的 head 与正文都链接到同域 `/agent-install.md`，`/llms.txt` 提供简短机器入口。这两个文件由 Next.js 的 `public/` 目录提供，middleware 明确允许匿名读取；它们需要随 Web 镜像发布，不能只替换静态首页。现有 nginx 默认 Web 路由可直接转发这两个路径。

当前指南要求完整安装 ZIP 内的 `onboard_hermes.py`。Hermes 自行安装和启动本机组件、发起签名申请，网页用户在 `/connect/{code}` 核对具体身份、方法和期限后确认，本机后台程序自动取得控制台签名并配对。网页不需要用户复制命令回 Hermes。公开 claim code 与不公开的本机轮询 secret 分离；默认七天读取与对话权限。旧手动接入仍保留在包内 README。

部署时必须同步 Web API/UI、公开指南、静态首页和包含新入口的完整安装包；指南不能先指向尚未分发的脚本。
