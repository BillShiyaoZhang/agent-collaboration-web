import { getServerSession } from "next-auth";
import { notFound, redirect } from "next/navigation";
import { authOptions } from "@/lib/auth/auth";
import { getWorkspaceAgent } from "@/lib/workspace/workspace-store";

/** Keep saved notifications and bookmarks usable without restoring the mixed workbench. */
export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params, query = await searchParams, session = await getServerSession(authOptions);
  const workspace = session?.user?.id ? await getWorkspaceAgent(session.user.id, id) : null;
  if (!workspace) notFound();
  const tab = typeof query.tab === "string" ? query.tab : "conversation";
  const page = tab === "contacts" || tab === "inbox" ? "contacts" : tab === "tasks" ? "collaborations" : "chats";
  const target = new URLSearchParams({ agent: id });
  for (const name of ["subject", "conversation", "turn", "new", "filter"]) if (typeof query[name] === "string") target.set(name, query[name]);
  if (tab === "inbox") target.set("inbox", "1");
  redirect(`/dashboard/${page}?${target}`);
}
