"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PolicyDisclosureGate } from "@/components/workbench/policy-disclosure";

export function DashboardContent({ children }: { children: ReactNode }) {
  const chat = usePathname() === "/dashboard/chats";
  return <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none">
    <PolicyDisclosureGate compact>
      <div className={chat ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 md:p-4"}>{children}</div>
    </PolicyDisclosureGate>
  </main>;
}
