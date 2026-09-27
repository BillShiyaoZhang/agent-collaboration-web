import type { Metadata } from "next";
import PrivacyContent from "./privacy-content";
import "./privacy.css";

export const metadata: Metadata = {
  title: "隐私政策 / Privacy policy",
  description: "了解 Agent Comm 如何处理账户、已授权的 Agent 内容与设备数据，以及如何停止访问和删除账户。 Learn how Agent Comm handles account, authorized agent and device data, and how to stop access or delete an account.",
  alternates: { canonical: "https://agent-communication.online/privacy" },
};

export default function PrivacyPage() {
  return <PrivacyContent />;
}
