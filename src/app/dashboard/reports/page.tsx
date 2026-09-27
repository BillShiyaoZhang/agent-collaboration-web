"use client";
import {useEffect,useState} from "react";
import Link from "next/link";
import {Button} from "@/components/ui/button";
type Report={id:string;status:string;reason:string;target:{kind:string;id:string};createdAt:number;response:string};
export default function ReportsPage() {
  const [reports,setReports]=useState<Report[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function load() {setBusy(true);setError("");try{const response=await fetch("/api/moderation/reports?limit=20",{cache:"no-store",signal:AbortSignal.timeout(20000)}),body=await response.json();if(response.status!==200 || !Array.isArray(body.reports))throw new Error(body.error || "暂时无法读取举报。");setReports(body.reports);}catch(error){setError(error instanceof Error?error.message:"无法读取举报。");}finally{setBusy(false);}}
  useEffect(()=>{void load();},[]);
  const labels:Record<string,string>={pending:"等待运营者处理",reviewing:"正在处理",resolved:"已处理",dismissed:"已结案"};
  return <main className="mx-auto max-w-2xl space-y-5 p-4"><h1 className="text-xl font-semibold">我的举报</h1><p className="text-sm leading-6 text-muted-foreground">显示最近 20 份报告。处理状态与回复保存在此页面，系统不会代你发送邮件。紧急或持续问题也可通过公开支持入口联系运营者。</p><Button variant="outline" disabled={busy} onClick={()=>void load()}>{busy?"正在读取…":"刷新状态"}</Button>{error && <p role="alert">{error}</p>}{!busy && !error && !reports.length && <p>暂时没有举报。</p>}{reports.map(report=><article key={report.id} className="space-y-2 rounded-xl border p-4"><h2 className="font-medium">{labels[report.status] || "状态待核实"}</h2><p className="break-all text-xs text-muted-foreground">报告 {report.id} · {report.target.kind} / {report.target.id}</p><p className="text-sm">原因：{report.reason}</p><p className="whitespace-pre-wrap break-words text-sm leading-6">{report.response || "运营者尚未回复。"}</p></article>)}<Link href="/dashboard/settings" className="inline-flex min-h-11 items-center text-primary">返回账户设置</Link></main>;
}
