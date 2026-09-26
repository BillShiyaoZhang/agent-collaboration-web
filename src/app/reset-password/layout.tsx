import type { Metadata } from "next";
import { AppFrame } from "@/components/layout/app-frame";

export const metadata: Metadata = { title: "重置密码", referrer: "no-referrer", robots: { index: false, follow: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
