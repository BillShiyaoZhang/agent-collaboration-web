import type { Metadata } from "next";
import CommunityContent from "./community-content";
import "../privacy/privacy.css";
export const metadata: Metadata = { title: "内容规范 / Content standards", description: "正常交流、网站内容审核、举报与阻止联系人的规范。 Standards for communication, website content review, reports and blocking." };
export default function CommunityPage() { return <CommunityContent />; }
