import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { DashboardSidebar } from "@/components/layout/dashboard-sidebar";
import { DashboardHeader } from "@/components/layout/dashboard-header";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="flex h-full min-h-0">
      <a href="#main-content" className="sr-only z-50 rounded-lg bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:left-4 focus:top-4">跳转到主要内容</a>
      <DashboardSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader user={session.user} />
        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 outline-none sm:p-8"><div className="mx-auto w-full max-w-6xl">{children}</div></main>
      </div>
    </div>
  );
}
