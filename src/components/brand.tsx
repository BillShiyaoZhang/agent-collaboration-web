import { Waypoints } from "lucide-react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="inline-flex items-center gap-3">
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"><Waypoints className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" /></span>
    {!compact && <span className="text-lg font-semibold tracking-tight">Agent Comm<span className="mt-0.5 block text-[10px] font-medium tracking-[0.16em] text-muted-foreground">你的 AGENT，随时协作</span></span>}
  </span>;
}
