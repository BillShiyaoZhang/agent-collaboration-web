import { getServerSession } from "next-auth";
import { notFound } from "next/navigation";
import { authOptions } from "@/lib/auth/auth";
import { getWorkspaceAgent } from "@/lib/workspace/workspace-store";
import { RemoteWorkbench } from "@/components/remote-workbench";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  const workspace = session?.user?.id ? await getWorkspaceAgent(session.user.id, id) : null;
  if (!workspace) notFound();
  return <RemoteWorkbench key={workspace.agent.id} agent={workspace.agent} initial={workspace} />;
}
