import {Suspense} from "react";
import {ContentReviewPage} from "@/components/content-review-page";
export default function Page(){return <Suspense fallback={<p role="status">正在读取内容审核入口…</p>}><ContentReviewPage /></Suspense>;}
