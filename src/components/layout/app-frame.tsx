import type { ReactNode } from "react";
import { Footer } from "./footer";

export function AppFrame({ children, footer = true }: { children: ReactNode; footer?: boolean }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer && <Footer />}
    </div>
  );
}
