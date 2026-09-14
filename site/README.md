# Agent Comm 官网

面向第一次接触 Agent Comm 的用户，介绍整体用途、四个项目的分工和首次接入步骤。页面是独立的中英文静态 HTML，入口为 [index.html](index.html)。

官网与远程工作台同属 Web 仓库维护，但不依赖 Next.js 构建，也不嵌入 Platform 的 Go 程序。[部署仓库](https://github.com/BillShiyaoZhang/agent-collaboration-deploy)通过 nginx 将此目录只读挂载到 `/srv/site`，仅站点根路径 `/` 读取 `index.html`。工作台和 API 仍使用各自原有路由。

## 更新与检查

1. 编辑 `index.html`，同时更新中文及对应 `data-en` 内容；标题、页面描述和辅助标签在文件末尾的语言切换脚本中维护。
2. 用静态 HTTP 服务预览，检查中文、英文、手机窄屏、页内链接和复制说明；禁用 JavaScript 后中文仍应完整可读。
3. 发布时把审核后的文件同步到服务器已挂载的 `site` 目录。仅改静态内容无需重建或重启 Web、Platform 或 nginx。首次启用目录挂载、修改 nginx 路由时，仍需要部署相应配置。

页面使用系统字体与内联图形，没有外部前端依赖。控制台地址、授权范围和期限由用户决定；示意对话不代表真实执行结果。
