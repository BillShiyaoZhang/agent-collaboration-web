import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth/auth";
import { WorkspaceClaim, WorkspaceEnrollment } from "@/components/workspace-nodes";
import { AppFrame } from "@/components/layout/app-frame";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "连接本地工作区 · Agent Comm", referrer: "no-referrer", robots: { index: false, follow: false } };
export default async function ConnectWorkspacePage({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  const { code } = await searchParams;
  const value = typeof code === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(code) ? code : "";
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login?callbackUrl=" + encodeURIComponent("/connect-workspace" + (value ? "?code=" + encodeURIComponent(value) : "")));
  return <AppFrame><main className="mx-auto max-w-2xl space-y-6 px-5 py-12"><Link href="/dashboard/workspaces" className="text-sm font-medium text-primary">Agent Comm · 本地工作区</Link>{!value && <WorkspaceEnrollment key={"enroll-" + session.user.id} accountId={session.user.id} accountLabel={session.user.email || session.user.id} />}<WorkspaceClaim key={session.user.id} accountId={session.user.id} accountLabel={session.user.email || session.user.id} initialCode={value} /></main></AppFrame>;
}
