import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Footer } from "@/components/layout/footer";

export const metadata: Metadata = {
  title: { default: "Agent Comm · 我的工作空间", template: "%s · Agent Comm" },
  description: "连接自己的 agent，在一个工作空间里对话、查看联系人与协作事项。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="flex h-dvh flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          <Footer />
        </div>
      </body>
    </html>
  );
}
