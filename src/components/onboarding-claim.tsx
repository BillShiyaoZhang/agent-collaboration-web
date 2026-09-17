"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck } from "lucide-react";

type Preview = { name: string; agent_urn: string; methods: string[]; expires_at: string; ticket_expires_at: string;
  status: "pending" | "approved" | "completed"; agent_id: string | null };
const labels: Record<string, string> = { capabilities: "检查连接", "contacts.list": "读取联系人", "contacts.requests": "读取好友请求", "collaboration.state": "读取协作事项", "inbox.list": "读取收件箱", "attention.list": "同步提醒", "conversation.send": "与 Hermes 对话", "conversation.get": "读取对话进展", "contacts.add": "添加联系人", "contacts.respond": "接受或拒绝好友", "messages.send": "给好友发消息", "inbox.mark_read": "同步已读", "approval.respond": "处理审批", "collaboration.execute": "执行协作工具" };

export function OnboardingClaim({ code }: { code: string }) {
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url = `/api/onboarding/claim/${encodeURIComponent(code)}`;
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "暂时无法读取连接申请。");
        if (!stopped) { setPreview(value); setError(""); if (value.status === "approved") timer = setTimeout(load, 2000); }
      } catch (cause) { if (!stopped) {
        setError(cause instanceof Error ? cause.message : "暂时无法读取连接申请。");
        if (preview?.status === "approved") timer = setTimeout(load, 4000);
      } }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [url, preview?.status]);
  async function approve() {
    setBusy(true); setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "暂时无法确认连接。");
      setPreview(previous => previous ? { ...previous, ...value } : previous);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "暂时无法确认连接。"); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-5 py-12">
    <Link href="/dashboard" className="mb-8 text-sm font-semibold text-primary">Agent Comm</Link>
    <section className="rounded-3xl border bg-card p-6 shadow-sm sm:p-9">
      <ShieldCheck className="mb-4 h-8 w-8 text-primary" />
      <h1 className="text-2xl font-semibold">{preview?.status === "completed" ? "Hermes 已完成本机配对" : preview?.status === "approved" ? "等待 Hermes 完成连接" : "把 Hermes 连接到你的工作台"}</h1>
      <p className="mt-3 text-sm leading-7 text-muted-foreground">{preview?.status === "pending" ? "这是 Hermes 在本机发起的连接申请。确认下面的 agent、可用功能和到期时间后，Hermes 会自动完成本机配置。" : preview?.status === "approved" ? "网页已确认授权。保持 Hermes 运行，它会自动接收结果并完成配对，无需复制命令。" : preview?.status === "completed" ? "本机已保存授权。打开工作台检查连接，并等待 Hermes 对你的消息给出真实回复。" : "正在读取这次连接申请…"}</p>
      {preview && <><dl className="mt-6 space-y-4 text-sm"><div><dt className="text-muted-foreground">连接名称</dt><dd className="mt-1 font-medium">{preview.name}</dd></div><div><dt className="text-muted-foreground">Agent 地址 · 已验证签名</dt><dd className="mt-1 break-all font-mono text-xs leading-6">{preview.agent_urn}</dd></div><div><dt className="text-muted-foreground">网页授权到期时间</dt><dd className="mt-1">{new Date(preview.expires_at).toLocaleString()}</dd></div></dl>
        <h2 className="mt-6 text-sm font-medium">本次授权的功能</h2><ul className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">{preview.methods.map(method => <li key={method}>✓ {labels[method] || method}</li>)}</ul>
        {preview.status === "pending" ? <><p className="mt-6 text-xs leading-6 text-muted-foreground">仅确认你刚刚让 Hermes 发起的申请。确认后，本账户可在上述期限内使用所列功能。申请链接于 {new Date(preview.ticket_expires_at).toLocaleTimeString()} 失效。</p><Button className="mt-5 w-full rounded-xl" onClick={approve} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}授权并连接这个 Hermes</Button></>
          : preview.agent_id && <Button asChild className="mt-6 w-full rounded-xl"><Link href={`/dashboard/agents/${preview.agent_id}`}>打开工作台</Link></Button>}
      </>}
      {error && <p role="alert" className="mt-5 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    </section>
  </main>;
}
