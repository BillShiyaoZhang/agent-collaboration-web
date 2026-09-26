import { MyAgentsWorkspace } from "@/components/my-agents-workspace";
import { getWorkspaceActivity } from "@/lib/product/workspace-activity";
import { workspaceUserId } from "@/lib/workspace/workspace-http";
export const dynamic = "force-dynamic";
export default async function ChatsPage() { return <MyAgentsWorkspace initial={await getWorkspaceActivity(await workspaceUserId())} />; }
