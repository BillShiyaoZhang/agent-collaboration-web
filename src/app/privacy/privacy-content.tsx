"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PublicFooter, PublicNavigation, usePublicLanguage, type PublicLanguage } from "@/components/public/public-navigation";
import { publicSupportEmail } from "@/lib/shared/support-email";
import { privacyCopy } from "./privacy-copy";

export function PrivacyDocument({ language, supportEmail = "" }: { language: PublicLanguage; supportEmail?: string }) {
  const copy = privacyCopy[language];
  const english = language === "en";
  const configuredEmail = publicSupportEmail(supportEmail);
  return <main id="main" className="privacy-main" tabIndex={-1} lang={english ? "en" : "zh-CN"}>
    <header className="privacy-heading">
      <p className="privacy-eyebrow">Agent Comm</p>
      <h1 id="policy-title" tabIndex={-1}>{copy.title}</h1>
      <p className="privacy-date">{copy.updated} <time dateTime="2026-09-27">2026-09-27</time></p>
      <p className="privacy-introduction">{copy.introduction}</p>
    </header>
    <nav className="privacy-contents" aria-label={copy.contents}>
      <h2>{copy.contents}</h2>
      <ol>{copy.sections.map(section => <li key={section.id}><a href={"#" + section.id}>{section.title}</a></li>)}</ol>
    </nav>
    <article aria-label={copy.title}>
      {copy.sections.map(section => <section className="privacy-section" key={section.id} id={section.id} aria-labelledby={section.id + "-title"} tabIndex={-1}>
        <h2 id={section.id + "-title"}>{section.title}</h2>
        {section.paragraphs?.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        {section.entries && <dl className="privacy-data-list">{section.entries.map(([label, detail]) => <div key={label}><dt>{label}</dt><dd>{detail}</dd></div>)}</dl>}
        {section.items && <ul>{section.items.map(item => <li key={item}>{item}</li>)}</ul>}
        {section.id === "choices" && <div className="privacy-actions">
          <Link href="/dashboard/settings">{english ? "Open account settings" : "进入账户设置"}</Link>
          <Link href="/dashboard/notifications">{english ? "Manage browser notifications" : "管理浏览器提醒"}</Link>
          <Link href="/docs/">{english ? "Read connection and revocation instructions" : "查看连接与撤销说明"}</Link>
        </div>}
        {section.id === "contact" && <>
          {configuredEmail ? <p><a className="privacy-contact" href={"mailto:" + configuredEmail}>{configuredEmail}</a></p> : <p>{english
            ? "This deployment has not configured its own public support address. For a self-hosted service, contact its operator. The official hosted service at agent-communication.online publishes the following contact address on its website: "
            : "本部署未配置自己的公开人工邮箱。自行部署的服务请向实际运营者联系；agent-communication.online 官方托管服务在官网公开以下联系地址： "}
            <a className="privacy-contact" href="mailto:support@agent-communication.online">support@agent-communication.online</a></p>}
          <p><a className="privacy-contact" href="https://github.com/BillShiyaoZhang/agent-collaboration-deploy/issues">{english ? "Official project issue page" : "官方项目问题入口"}</a></p>
          <p>{english ? "If you need another contact channel, request one through the official project issue page. Issues are public: do not post your email address, conversations, passwords, keys or verification links." : "如需其他联系渠道，可通过官方项目问题入口提出请求。问题页面是公开的，请勿发布邮箱、对话、密码、密钥或验证链接。"}</p>
          <p>{english ? "For a privacy request, describe the action you need and the relevant service or record. Verify account ownership through the service; never send a password, private key or email action link to support." : "提交隐私请求时，请说明希望采取的操作与涉及的服务或记录，并通过服务核对账户归属；请勿向客服发送密码、私钥或邮件操作链接。"}</p>
        </>}
      </section>)}
    </article>
    <a className="privacy-back-to-top" href="#policy-title">{english ? "Back to the policy title" : "回到政策标题"}</a>
  </main>;
}

export default function PrivacyContent() {
  const [language, setLanguage] = usePublicLanguage();
  useEffect(() => {
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    document.title = (language === "en" ? "Privacy policy" : "隐私政策") + " · Agent Comm";
    return () => { document.documentElement.lang = "zh-CN"; };
  }, [language]);
  return <div className="public-site public-privacy" lang={language === "en" ? "en" : "zh-CN"}>
    <PublicNavigation current="privacy" language={language} onLanguageChange={setLanguage} />
    <PrivacyDocument language={language} supportEmail={publicSupportEmail()} />
    <PublicFooter language={language} />
  </div>;
}
