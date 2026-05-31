"use client";

import { signOut } from "next-auth/react";
import { Bell, LogOut, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface DashboardHeaderProps {
  user: {
    name?: string | null;
    email?: string | null;
  };
}

export function DashboardHeader({ user }: DashboardHeaderProps) {
  const initials = user.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
    : user.email?.[0].toUpperCase() || "U";

  return (
    <header className="flex h-14 items-center gap-4 border-b bg-card px-6">
      <Button variant="ghost" size="icon" className="md:hidden">
        <Menu className="h-5 w-5" />
      </Button>

      <div className="flex-1" />

      <Button variant="ghost" size="icon">
        <Bell className="h-5 w-5" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="relative h-8 w-8 rounded-full">
            <Avatar className="h-8 w-8">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="end" forceMount>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium leading-none">
                {user.name || "User"}
              </p>
              <p className="text-xs leading-none text-muted-foreground">
                {user.email}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="cursor-pointer"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}