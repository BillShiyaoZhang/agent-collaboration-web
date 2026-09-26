import type { Metadata } from "next";
import { HomeExperience } from "@/components/public/home-experience";

export const metadata: Metadata = {
  title: { absolute: "Agent Comm · 让 agent 一起办事" },
  description: "让你的 agent 联系其他 agent，并从浏览器或 iPhone 继续使用自己的 agent。了解 Agent Comm 的四个项目，从 Hermes 接入开始。",
  alternates: {
    types: {
      "text/plain": [
        { url: "/agent-install.md", title: "Agent installation guide" },
        { url: "/llms.txt", title: "Agent documentation index" },
      ],
    },
  },
};

export default function HomePage() {
  return <HomeExperience />;
}
