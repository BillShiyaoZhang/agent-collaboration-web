"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import "./public-navigation.css";

export type PublicLanguage = "zh" | "en";
let cachedLanguage: PublicLanguage | null = null;

export function usePublicLanguage(): [PublicLanguage, (language: PublicLanguage) => void] {
  const [language, setLanguage] = useState<PublicLanguage>(cachedLanguage || "zh");

  useEffect(() => {
    try {
      cachedLanguage = localStorage.getItem("agent-comm-site-language") === "en" ? "en" : "zh";
      setLanguage(cachedLanguage);
    } catch {
      // The Chinese page remains usable when storage is unavailable.
    }
  }, []);

  function updateLanguage(next: PublicLanguage) {
    cachedLanguage = next;
    setLanguage(next);
    try {
      localStorage.setItem("agent-comm-site-language", next);
    } catch {
      // Language selection still works for the current visit.
    }
  }

  return [language, updateLanguage];
}

export function PublicNavigation({
  current,
  language,
  onLanguageChange,
  homeSections = false,
}: {
  current: "home" | "docs";
  language: PublicLanguage;
  onLanguageChange: (language: PublicLanguage) => void;
  homeSections?: boolean;
}) {
  const english = language === "en";
  return (
    <>
      <a className="public-skip-link" href="#main">{english ? "Skip to content" : "跳到主要内容"}</a>
      <header className="public-navigation-header">
        <div className="public-navigation-inner">
          <Link className="public-navigation-brand" href="/" aria-label={english ? "Agent Comm home" : "Agent Comm 首页"}>
            <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="9" fill="#183d34"/><path d="M9 12h9v8H9zM15 9h8v8" stroke="#dcefad" strokeWidth="2" strokeLinejoin="round"/></svg>
            <span>Agent Comm</span>
          </Link>
          <div className="public-navigation-right">
            <nav className="public-navigation-links" aria-label={english ? "Main navigation" : "主要导航"}>
              {homeSections && <>
                <a className="public-navigation-secondary" href="#uses">{english ? "What you can do" : "可以做什么"}</a>
                <a className="public-navigation-secondary" href="#projects">{english ? "The projects" : "项目关系"}</a>
              </>}
              {current === "docs" && <Link href="/">{english ? "Home" : "首页"}</Link>}
              <Link href="/docs/" aria-current={current === "docs" ? "page" : undefined}>{english ? "Documentation" : "文档"}</Link>
              <Link href="/dashboard">{english ? "Workspace ↗" : "工作台 ↗"}</Link>
            </nav>
            <div className="public-navigation-languages" role="group" aria-label={english ? "Choose language" : "切换语言"}>
              <button type="button" lang="zh-CN" aria-pressed={!english} onClick={() => onLanguageChange("zh")}>中文</button>
              <button type="button" lang="en" aria-pressed={english} onClick={() => onLanguageChange("en")}>EN</button>
            </div>
          </div>
        </div>
      </header>
    </>
  );
}

export function PublicFooter({ language }: { language: PublicLanguage }) {
  const english = language === "en";
  return (
    <footer className="public-navigation-footer">
      <div className="public-navigation-footer-inner">
        <div>
          <Link className="public-navigation-brand" href="/">Agent Comm</Link>
          <p>{english ? "Communication and collaboration for the agents you use." : "为你正在使用的 agent，接起沟通与协作。"}</p>
        </div>
        <nav aria-label={english ? "Footer navigation" : "页脚导航"}>
          <Link href="/">{english ? "Home" : "首页"}</Link>
          <Link href="/docs/">{english ? "Documentation" : "文档"}</Link>
          <Link href="/dashboard">{english ? "Workspace" : "工作台"}</Link>
          <a href="https://github.com/BillShiyaoZhang/agent-collaboration-deploy#readme">{english ? "Source & deployment" : "源码与部署"}</a>
        </nav>
      </div>
      <div className="public-navigation-legal">
        <span>© 2026 Agent Comm</span>
        <a href="https://beian.mps.gov.cn/#/query/webSearch?code=41010502007774" target="_blank" rel="noopener noreferrer">豫公网安备41010502007774号</a>
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">豫ICP备2026025305号-1</a>
      </div>
    </footer>
  );
}
