import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth/auth";
import { DashboardSidebar, MobileNavigation } from "@/components/layout/dashboard-sidebar";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { WorkspaceProvider } from "@/components/workspace-provider";
import { NotificationProvider } from "@/components/notification-provider";
import { getWorkspaceOverview } from "@/lib/workspace/workspace-store";
import { DashboardContent } from "@/components/layout/dashboard-content";
import { AppFrame } from "@/components/layout/app-frame";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    redirect("/login");
  }

  const workspace = await getWorkspaceOverview(session.user.id);
  return (
    <AppFrame footer={false}>
    <WorkspaceProvider key={session.user.id} initial={workspace}>
    <NotificationProvider accountId={session.user.id}>
    <div className="flex h-full min-h-0">
      <a href="#main-content" className="sr-only z-50 rounded-lg bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:left-4 focus:top-4">跳转到主要内容</a>
      <DashboardSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader user={session.user} />
        <DashboardContent>{children}</DashboardContent>
        <MobileNavigation />
      </div>
    </div>
    </NotificationProvider>
    </WorkspaceProvider>
    </AppFrame>
  );
}
