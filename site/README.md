# 官网与文档入口

官网首页 `/`、文档入口 `/docs/`、登录与工作台由同一个 Next.js 应用提供。现行代码在 [`src/app/page.tsx`](../src/app/page.tsx)、[`src/components/public/`](../src/components/public/) 和 [`src/app/docs/`](../src/app/docs/)；公开导航可在首页、文档和工作台之间切换。修改这些页面后要构建并发布 Web，不再靠替换 nginx 挂载的 HTML 更新。

本目录的 [`index.html`](index.html) 与 [`docs/index.html`](docs/index.html) 是迁移前静态页面的历史参考，现行服务不读取它们。维护文案、样式和交互时应修改上述 Next.js 文件，并同时核对中英文、窄屏、键盘与缩放显示。

## 文档原文

文档阅读器保留 `/docs/?path=deploy/users/README.md` 等可分享地址，从 `/docs/source/` 读取四仓原始 Markdown。根部署项目把四仓 `docs/` 只读挂载给 nginx 和 Web；nginx 保留现行公开路径白名单、旧 `/docs/api/` 和 `/guide/` 跳转。Next.js 原文路由使用相同的仓库和目录白名单，可供直接访问 Web 与本地开发；非法路径、历史记录和目录外符号链接返回 404。

独立 Web 镜像只包含 Web 仓库自身的 `docs/`。完整文档门户需要根部署项目的四仓只读挂载；独立部署时可通过 `DOCS_SOURCE_ROOT` 提供四个原文目录。阅读器在某份原文不可用时提供源码仓库链接。

## 检查

运行 Web 的 `npm test` 与 `npm run build`，再核对中文、英文、320px 宽度、200% 文字缩放、键盘跳转、复制接入说明和 `/docs/?path=platform/guides/API.md`。在组合部署下核对 `/docs/source/` 的公开与拒绝路径、`/docs/api/` 和 `/guide/` 的跳转，以及公开 `/agent-install.md`、`/llms.txt` 和下载清单。一次性 Hermes 授权仍在 `/connect/{code}`；不要把手工配对写成首装必经步骤。
