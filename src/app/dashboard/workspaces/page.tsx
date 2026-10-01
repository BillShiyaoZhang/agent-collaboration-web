import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth/auth";
import { WorkspaceNodes } from "@/components/workspace-nodes";

export const dynamic = "force-dynamic";
export default async function LocalWorkspacesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login?callbackUrl=%2Fdashboard%2Fworkspaces");
  return <WorkspaceNodes key={session.user.id} accountId={session.user.id} accountLabel={session.user.email || session.user.id} />;
}
