"use client";

import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import DashboardLoading from "@/app/dashboard/loading";
import { PolicyDisclosureGate } from "@/components/workbench/policy-disclosure";

export function DashboardContent({ children }: { children: ReactNode }) {
  const chat = usePathname() === "/dashboard/chats";
  const contentClass = chat ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 md:p-4";
  return <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none">
    <PolicyDisclosureGate compact>
      {/* Flight can suspend before the router installs its inner loading boundary. */}
      <Suspense fallback={<div className={contentClass}><DashboardLoading /></div>}>
        <div className={contentClass}>{children}</div>
      </Suspense>
    </PolicyDisclosureGate>
  </main>;
}
