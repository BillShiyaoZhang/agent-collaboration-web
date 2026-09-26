"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { homeContentHtml } from "./home-content";
import { PublicFooter, PublicNavigation, usePublicLanguage } from "./public-navigation";
import "./home.css";

function legacyCopy(value: string): boolean {
  const temporary = document.createElement("textarea");
  temporary.value = value;
  temporary.readOnly = true;
  temporary.style.position = "fixed";
  temporary.style.left = "-9999px";
  document.body.appendChild(temporary);
  temporary.select();
  let copied = false;
  try { copied = document.execCommand("copy") === true; } catch { copied = false; }
  temporary.remove();
  return copied;
}

export function HomeExperience() {
  const [language, setLanguage] = usePublicLanguage();
  const [hydrated, setHydrated] = useState(false);
  const main = useRef<HTMLElement>(null);
  const router = useRouter();

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (!main.current) return;
    const expanded = Array.from(main.current.querySelectorAll<HTMLDetailsElement>("details"))
      .flatMap((element, index) => element.open ? [index] : []);
    // Rebuild from the immutable Chinese source before translating. Some labels
    // contain nested markup, so mutating a parent must not leave stale nodes for
    // a later zh → en → zh switch.
    main.current.innerHTML = homeContentHtml;
    const translations = Array.from(main.current.querySelectorAll<HTMLElement>("[data-en]")).map(element => ({
        element,
        chinese: element.tagName === "TEXTAREA" ? (element as HTMLTextAreaElement).value : element.innerHTML,
        english: element.dataset.en || "",
      }));
    for (const { element, chinese, english } of translations) {
      if (element.tagName === "TEXTAREA") (element as HTMLTextAreaElement).value = language === "en" ? english : chinese;
      else if (language === "en") element.textContent = english;
      else element.innerHTML = chinese;
    }
    const details = main.current.querySelectorAll<HTMLDetailsElement>("details");
    for (const index of expanded) if (details[index]) details[index].open = true;
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    document.title = language === "en" ? "Agent Comm · Let your agents work together" : "Agent Comm · 让 agent 一起办事";
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = language === "en"
      ? "Connect your agent with other agents, and keep using your own agent from a browser or iPhone. Understand the four Agent Comm projects and start with Hermes."
      : "让你的 agent 联系其他 agent，并从浏览器或 iPhone 继续使用自己的 agent。了解 Agent Comm 的四个项目，从 Hermes 接入开始。";
  }, [language]);

  useEffect(() => () => { document.documentElement.lang = "zh-CN"; }, []);

  useEffect(() => {
    const button = main.current?.querySelector<HTMLButtonElement>("#copy-prompt");
    const prompt = main.current?.querySelector<HTMLTextAreaElement>("#install-prompt");
    const status = main.current?.querySelector<HTMLElement>("#copy-status");
    if (!button || !prompt || !status) return;
    const copy = async () => {
      button.disabled = true;
      status.textContent = "";
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          try { await navigator.clipboard.writeText(prompt.value); copied = true; }
          catch { copied = legacyCopy(prompt.value); }
        } else copied = legacyCopy(prompt.value);
      } finally {
        button.disabled = false;
        status.textContent = copied
          ? (language === "en" ? "Copied. Paste it into your agent." : "已复制，可以粘贴给你的 agent。")
          : (language === "en" ? "Automatic copy failed. The text is selected; please copy it manually." : "自动复制未成功，已选中文字，请手动复制。");
        if (copied) button.focus({ preventScroll: true });
        else { const details = prompt.closest("details"); if (details) details.open = true; prompt.focus({ preventScroll: true }); prompt.select(); }
      }
    };
    button.addEventListener("click", copy);
    return () => button.removeEventListener("click", copy);
  }, [language]);

  function navigateWithinApp(event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
    if (anchor.getAttribute("href") === "#projects") {
      const details = main.current?.querySelector<HTMLDetailsElement>(".project-disclosure");
      if (details) details.open = true;
      return;
    }
    const destination = new URL(anchor.href, location.href);
    if (destination.origin !== location.origin || !/^\/(dashboard|docs|login|register|connect)(\/|$)/.test(destination.pathname)) return;
    event.preventDefault();
    router.push(destination.pathname + destination.search + destination.hash);
  }

  return (
    <div className={`public-site public-home${hydrated ? "" : " no-js"}`} onClick={navigateWithinApp}>
      <PublicNavigation current="home" language={language} onLanguageChange={setLanguage} homeSections />
      <p className="wrap agent-install-banner"><a href="/agent-install.md">{language === "en" ? "Installing from an agent? Read the current guide: one setup command, then confirm in Web." : "让 agent 安装？阅读当前接入指南：一条安装命令，网页确认后自动完成配对。"}</a></p>
      <main id="main" ref={main} dangerouslySetInnerHTML={{ __html: homeContentHtml }} />
      <PublicFooter language={language} />
    </div>
  );
}
