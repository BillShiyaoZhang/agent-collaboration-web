"use client";
import { useEffect } from "react";
import Link from "next/link";
import { PublicFooter, PublicNavigation, usePublicLanguage, type PublicLanguage } from "@/components/public/public-navigation";
import { publicSupportEmail } from "@/lib/shared/support-email";
import { communityCopy } from "./community-copy";
export function CommunityDocument({ language }: { language: PublicLanguage }) {
 const copy = communityCopy[language], english = language === "en", supportEmail = publicSupportEmail();
 return <main id="main" className="privacy-main" tabIndex={-1} lang={english ? "en" : "zh-CN"}>
  <header className="privacy-heading"><p className="privacy-eyebrow">Agent Comm</p><h1 id="standards-title" tabIndex={-1}>{copy.title}</h1><p className="privacy-date">{english ? "Updated" : "更新日期"} <time dateTime="2026-09-27">2026-09-27</time></p><p className="privacy-introduction">{copy.intro}</p></header>
  <nav className="privacy-contents" aria-label={copy.contents}><h2>{copy.contents}</h2><ol>{copy.sections.map(section => <li key={section.id}><a href={"#" + section.id}>{section.title}</a></li>)}</ol></nav>
  <article aria-label={copy.title}>{copy.sections.map(section => <section key={section.id} id={section.id} className="privacy-section" aria-labelledby={section.id + "-title"} tabIndex={-1}><h2 id={section.id + "-title"}>{section.title}</h2>{"paragraphs" in section && section.paragraphs?.map(paragraph => <p key={paragraph}>{paragraph}</p>)}{"items" in section && <ul>{section.items?.map(item => <li key={item}>{item}</li>)}</ul>}{section.id === "review" && <div className="privacy-actions"><Link href="/dashboard/content-review">{english ? "Review pending content" : "审核待审内容"}</Link></div>}{section.id === "reports" && <div className="privacy-actions"><Link href="/dashboard/reports">{english ? "My reports" : "我的举报"}</Link></div>}{section.id === "contact" && <div className="privacy-actions"><Link href="/privacy">{english ? "Privacy policy & operator contact" : "隐私政策与运营者联系入口"}</Link>{supportEmail && <a href={"mailto:" + supportEmail}>{english ? "Contact support" : "联系人工客服"}</a>}</div>}</section>)}</article>
  <a className="privacy-back-to-top" href="#standards-title">{english ? "Back to the title" : "回到规范标题"}</a>
 </main>;
}
export default function CommunityContent() {
 const [language, setLanguage] = usePublicLanguage();
 useEffect(() => { document.documentElement.lang = language === "en" ? "en" : "zh-CN"; document.title = (language === "en" ? "Content standards" : "内容规范") + " · Agent Comm"; return () => { document.documentElement.lang = "zh-CN"; }; }, [language]);
 return <div className="public-site public-privacy" lang={language === "en" ? "en" : "zh-CN"}><PublicNavigation current="community" language={language} onLanguageChange={setLanguage} /><CommunityDocument language={language} /><PublicFooter language={language} /></div>;
}
