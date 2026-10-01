"use client";

import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import DashboardLoading from "@/app/dashboard/loading";
import { PolicyDisclosureGate } from "@/components/workbench/policy-disclosure";

export function DashboardContent({ children }: { children: ReactNode }) {
  const pathname = usePathname(), chat = pathname === "/dashboard/chats";
  const contentClass = chat ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 md:p-4";
  const content = <Suspense fallback={<div className={contentClass}><DashboardLoading /></div>}>
    <div className={contentClass}>{children}</div>
  </Suspense>;
  return <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none">
    {/* The RPC Platform policy does not describe the independent workspace Gateway. */}
    {pathname === "/dashboard/workspaces" ? content : <PolicyDisclosureGate compact>{content}</PolicyDisclosureGate>}
  </main>;
}
