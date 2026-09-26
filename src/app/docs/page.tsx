import type { Metadata } from "next";
import DocsContent from "./docs-content";
import "./docs.css";

export const metadata: Metadata = {
  title: "文档 / Documentation",
  description: "按使用者、使用 Agent Comm 的 agent 和开发者查找现行文档。",
};

export default async function DocsPage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const params = await searchParams;
  return <DocsContent documentKey={typeof params.path === "string" ? params.path : null} />;
}
