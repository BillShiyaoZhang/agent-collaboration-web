import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Collaboration",
  description: "Human-In-The-Loop Agent Collaboration Platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}