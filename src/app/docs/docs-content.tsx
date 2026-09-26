"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PublicFooter, PublicNavigation, usePublicLanguage } from "@/components/public/public-navigation";
import { githubForVirtual, published, renderMarkdown, repositories, validKey, virtualFile } from "./markdown";

type DocumentView = { html: string; status: "loading" | "ready" | "unavailable" | "error" };

const roles = [
  {
    index: ["01 / 使用产品", "01 / USING AGENT COMM"], title: ["我想连接并使用自己的 agent", "I want to connect and use my agent"],
    description: ["从 Hermes 接入开始，学习使用浏览器工作台、看懂状态和权限，遇到连接问题也知道先查哪里。", "Connect Hermes, use the browser workspace, understand status and permissions, and know what to do if a connection stops working."],
    link: "deploy/users/README.md", action: ["阅读用户指南 →", "Read the user guide →"],
  },
  {
    index: ["02 / 使用项目的 agent", "02 / AGENTS USING THE PROJECT"], title: ["我是替用户操作的 agent", "I'm an agent helping someone use it"],
    description: ["根据任务找到现行安装或协作指引，先发现已安装的能力，再按真实结果向用户报告。", "Choose the current installation or collaboration instructions, discover the installed capabilities, and report results based on actual evidence."],
    link: "deploy/agents/README.md", action: ["阅读 Agent 使用指南 →", "Read the agent guide →"],
  },
  {
    index: ["03 / 开发与运维", "03 / DEVELOPING AND OPERATING"], title: ["我要开发或运维 Agent Comm", "I build or operate Agent Comm"],
    description: ["先定位负责的仓库，再查源码、测试、部署与开发用 coding agent 的工作约定。", "Locate the owning repository, set up source, test changes, deploy safely, and find instructions for coding agents working on the code."],
    link: "deploy/developers/README.md", action: ["阅读开发者指南 →", "Read the developer guide →"],
  },
] as const;

const components = [
  { title: "Web", description: ["浏览器工作台、账户副本、官网与客户端行为。", "Browser workspace, account copies, site, and client behavior."], link: "web/README.md", action: ["Web 文档 →", "Web documentation →"] },
  { title: "Platform", description: ["公共通讯录、加密信箱、转发与服务端运维。", "Public registry, encrypted mailbox, relay, and service operations."], link: "platform/README.md", action: ["Platform 文档 →", "Platform documentation →"], extra: "platform/guides/API.md", extraAction: ["Platform API 文档 →", "Platform API reference →"] },
  { title: "SDK / Runtime", description: ["本机 helper、SDK、Python runtime 和 agent 连接器。", "Local helper, SDK, Python runtime, and agent connectors."], link: "sdk/README.md", action: ["SDK 文档 →", "SDK documentation →"] },
] as const;

function docHref(key: string) {
  return `/docs/?path=${encodeURIComponent(key)}`;
}

function isPublishedKey(key: string) {
  if (!validKey(key)) return false;
  const slash = key.indexOf("/");
  return published(key.slice(0, slash), key.slice(slash + 1));
}

function DocsLanding({ english }: { english: boolean }) {
  const text = (zh: string, en: string) => english ? en : zh;
  return <div id="landing">
    <section className="wrap hero" aria-labelledby="guide-title">
      <p className="eyebrow">{text("Agent Comm 文档", "Agent Comm documentation")}</p>
      <h1 id="guide-title">{text("按你要做的事，找到正确的说明。", "Find the guide for what you want to do.")}</h1>
      <p className="hero-intro">{text("先选择你在这里要做的事。每个入口都会说明需要准备什么、下一步怎么做，以及到哪里看深入资料。", "Start with your role. Each guide explains what you need, what to do next, and where to find deeper details. Detailed documentation is currently primarily in Chinese.")}</p>
    </section>
    <section className="wrap role-grid" aria-label={text("按读者选择文档", "Choose documentation by reader")}>{roles.map(role => <article className="role-card" key={role.link}>
      <span className="role-index">{role.index[english ? 1 : 0]}</span>
      <h2>{role.title[english ? 1 : 0]}</h2>
      <p>{role.description[english ? 1 : 0]}</p>
      <Link href={docHref(role.link)}>{role.action[english ? 1 : 0]}</Link>
    </article>)}</section>
    <section className="section" aria-labelledby="components-title"><div className="wrap">
      <div className="section-head"><div><p className="eyebrow">{text("继续深入", "Explore the system")}</p><h2 id="components-title">{text("按组件查具体说明。", "Find the component you work on.")}</h2></div><p>{text("部署仓库负责组合整套系统；网页、公共服务和 agent 设备端组件各自维护自己的 docs/ 说明。", "The deployment repository connects the system; Web, Platform, and the device-side SDK each maintain their own documentation under docs/.")}</p></div>
      <div className="component-grid">{components.map(component => <article className="component" key={component.title}>
        <h3>{component.title}</h3><p>{component.description[english ? 1 : 0]}</p>
        <Link href={docHref(component.link)}>{component.action[english ? 1 : 0]}</Link>
        {"extra" in component && <> · <Link href={docHref(component.extra)}>{component.extraAction[english ? 1 : 0]}</Link></>}
      </article>)}</div>
      <nav className="more-links" aria-label={text("更多开发文档", "More developer documentation")}>
        <Link href={docHref("deploy/architecture/OVERVIEW.md")}>{text("跨组件架构 →", "System architecture →")}</Link>
        <Link href={docHref("deploy/operations/DEPLOYMENT.md")}>{text("部署与升级 →", "Deployment and upgrades →")}</Link>
        <a href="https://github.com/BillShiyaoZhang/agent-collaboration-deploy/blob/main/AGENTS.md">{text("开发用 coding agent 工作约定 ↗", "Instructions for coding agents ↗")}</a>
      </nav>
    </div></section>
    <aside className="wrap source-note"><p>{text("这里直接读取各仓库 docs/ 中的现行 Markdown。带日期的发布与验收记录仍可在源码仓库查看。替用户安装的 agent 也可直接读取", "These pages read the current Markdown from each repository's docs/ directory. Historical release and verification records remain in the source repositories. Agents installing for a user can also read")} <a href="/agent-install.md">/agent-install.md</a>。</p></aside>
    <noscript><p className="wrap">阅读器需要 JavaScript。可直接打开 Markdown 原文：<a href="/docs/source/deploy/users/README.md">用户指南</a> · <a href="/docs/source/deploy/agents/README.md">Agent 指南</a> · <a href="/docs/source/deploy/developers/README.md">开发者指南</a> · <a href="/docs/source/platform/guides/API.md">Platform API 参考</a>。</p></noscript>
  </div>;
}

function DocsReader({ documentKey, english }: { documentKey: string; english: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<DocumentView>({ html: "", status: "loading" });
  const valid = isPublishedKey(documentKey);
  const repo = documentKey.split("/")[0] as keyof typeof repositories;
  const source = valid ? `/docs/source/${documentKey}` : "";
  const github = valid ? githubForVirtual(virtualFile(documentKey)) : "";

  useEffect(() => {
    if (!valid) { setView({ html: "", status: "unavailable" }); return; }
    const controller = new AbortController();
    setView({ html: "", status: "loading" });
    void fetch(source, { credentials: "same-origin", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const markdown = await response.text();
      if (controller.signal.aborted) return;
      setView({
        html: renderMarkdown(markdown, documentKey),
        status: "ready",
      });
    }).catch(() => { if (!controller.signal.aborted) setView({ html: "", status: "error" }); });
    return () => controller.abort();
  }, [documentKey, source, valid]);

  useEffect(() => {
    if (view.status !== "ready") return;
    if (window.location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView());
  }, [view]);

  const text = (zh: string, en: string) => english ? en : zh;
  return <div id="reader" className="reader-shell">
    <nav className="reader-breadcrumb" aria-label={text("文档位置", "Document location")}><Link href="/docs/">{text("全部文档", "All documentation")}</Link><span aria-hidden="true">/</span><span id="reader-group">{valid ? repositories[repo].label[english ? "en" : "zh"] : ""}</span></nav>
    <div className="reader-toolbar"><span id="reader-path">{valid ? `${repositories[repo].github}/docs/${documentKey.slice(repo.length + 1)}` : ""}</span>{valid && <a id="reader-raw" href={source}>{text("查看 Markdown 原文 ↗", "View original Markdown ↗")}</a>}</div>
    <div id="reader-status" className="reader-status" role="status" aria-live="polite">{view.status === "loading" ? text("正在读取文档…", "Loading documentation…") : view.status === "unavailable" ? text("此文档不在公开指南中。", "This document is not available from the public guide.") : view.status === "error" ? text("暂时无法读取此文档。可打开源码仓库查看，或稍后重试。", "Unable to load this guide. Open the source repository or try again later.") : ""}</div>
    <noscript><p>{valid ? <>阅读器需要 JavaScript。可直接打开 <a href={source}>Markdown 原文</a>。</> : "此文档不在公开指南中。"}</p></noscript>
    {view.status === "ready" && <article id="reader-content" className="markdown" onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element).closest("a[href]");
      const href = link?.getAttribute("href");
      if (!href?.startsWith("/docs/?path=")) return;
      event.preventDefault();
      router.push(href);
    }} dangerouslySetInnerHTML={{ __html: view.html }} />}
    <div className="reader-end"><Link href="/docs/">{text("← 返回文档首页", "← Back to documentation")}</Link>{valid && <a id="reader-source" href={github}>{text("到源码仓库查看 ↗", "View in source repository ↗")}</a>}</div>
  </div>;
}

export default function DocsContent({ documentKey }: { documentKey: string | null }) {
  const [language, setLanguage] = usePublicLanguage();
  const [hydrated, setHydrated] = useState(false);
  const english = language === "en";
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    document.documentElement.lang = english ? "en" : "zh-CN";
    return () => { document.documentElement.lang = "zh-CN"; };
  }, [english]);
  return <div className={`public-site public-docs${hydrated ? "" : " no-js"}`}>
    <PublicNavigation current="docs" language={language} onLanguageChange={setLanguage} />
    <main id="main">{documentKey ? <DocsReader documentKey={documentKey} english={english} /> : <DocsLanding english={english} />}</main>
    <PublicFooter language={language} />
  </div>;
}
