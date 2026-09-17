import type { Metadata } from "next";
import { OnboardingClaim } from "@/components/onboarding-claim";

export const metadata: Metadata = { title: "连接 Hermes · Agent Comm", referrer: "no-referrer", robots: { index: false, follow: false } };
export default async function ConnectPage({ params }: { params: Promise<{ code: string }> }) {
  return <OnboardingClaim code={(await params).code} />;
}
