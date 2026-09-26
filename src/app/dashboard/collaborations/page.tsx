import { WorkspaceHub } from "@/components/workspace-hub";
import { getWorkspaceActivity } from "@/lib/product/workspace-activity";
import { workspaceUserId } from "@/lib/workspace/workspace-http";
export const dynamic = "force-dynamic";
export default async function CollaborationsPage() { return <WorkspaceHub mode="collaborations" initial={await getWorkspaceActivity(await workspaceUserId())} />; }
