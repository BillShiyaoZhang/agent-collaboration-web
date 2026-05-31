import * as React from "react";
import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("relative overflow-auto", className)}
    {...props}
  >
    <div className="min-h-full">{children}</div>
  </div>
));
ScrollArea.displayName = "ScrollArea";

export { ScrollArea };