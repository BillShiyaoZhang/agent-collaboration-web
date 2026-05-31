"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Users,
  MessageSquare,
  Shield,
  Phone,
  CreditCard,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";

const navItems = [
  { href: "/dashboard/agents", label: "Agents", icon: Users },
  { href: "/dashboard/messages", label: "Messages", icon: MessageSquare },
  { href: "/dashboard/hitl", label: "HITL", icon: Shield },
  { href: "/dashboard/oncall", label: "Services", icon: Phone },
  { href: "/dashboard/transactions", label: "Transactions", icon: CreditCard },
];

export function DashboardSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 flex-col border-r bg-card md:flex">
      <div className="p-6">
        <h1 className="text-xl font-bold">Agent Collab</h1>
      </div>
      <nav className="flex-1 px-4">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t p-4">
        <Link
          href="/dashboard/settings"
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
      </div>
    </aside>
  );
}