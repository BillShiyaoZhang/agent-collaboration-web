import type { ReactNode } from "react";
import { Footer } from "./footer";

export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      <Footer />
    </div>
  );
}
