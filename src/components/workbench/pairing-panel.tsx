"use client";

import { useState } from "react";
import { ArrowRight, Check, ChevronDown, KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/shared/utils";
import { displayTime, string, WorkbenchError } from "@/lib/control/workbench-client";
import { syncLabel } from "@/lib/workspace/workspace-client";
import { CopyValue } from "./snapshot-views";
import type { Connection, Workbench } from "./use-workbench";

const methodLabels: Record<string, string> = { capabilities: "连接检查", "contacts.list": "联系人", "contacts.add": "添加联系人", "collaboration.state": "协作事项", "inbox.list": "收件箱", "conversation.send": "发送消息", "conversation.get": "读取对话", "attention.list": "持久提醒同步", "approval.respond": "远程确认", "contacts.requests": "好友请求", "contacts.respond": "接受或拒绝好友", "messages.send": "给好友发消息", "inbox.mark_read": "同步已读状态", "collaboration.execute": "完整协作工具" };

export function RequestFeedback({ busy, error, onRetry }: { busy?: string; error?: WorkbenchError; onRetry?: () => void }) {
  if (busy) return <div role="status" className="flex items-center gap-2 text-xs leading-6 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />{busy}</div>;
  if (!error) return null;
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-200/70 bg-rose-50/60 px-3 py-2.5"><p className="flex-1 text-xs leading-6 text-rose-800">{error.message}</p>{onRetry && <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 rounded-lg text-xs text-rose-800 hover:bg-rose-100" onClick={onRetry}><RefreshCw className="h-3 w-3" />{error.retryable ? "重试" : "重新读取"}</Button>}</div>;
}

export function PairingPanel({ workbench: w, agent, featureCount }: { workbench: Workbench; agent: Connection; featureCount: number }) {
  const [expires] = useState(() => new Date(Date.now() + 30 * 86400000).toISOString());
  const pairCommand = `python configure_hermes.py --remote --pair-console '${w.identity.virtualUrn || ""}' --expires '${expires}' --allow-web-actions`;
  const step = w.capabilitySnapshot ? 3 : w.identity?.virtualUrn ? 2 : 1;
  const unavailable = w.methods.filter(method => method.available !== true);
  return <section className="overflow-hidden rounded-2xl border bg-card shadow-sm" aria-label="控制台配对">
    <button type="button" className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left outline-none transition-colors hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => w.setPairingOpen(previous => !previous)} aria-expanded={w.pairingOpen} aria-controls="pairing-panel">
      <span className="flex items-center gap-3"><span className={cn("rounded-xl p-2", w.capabilitySnapshot ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>{w.capabilitySnapshot ? <ShieldCheck className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}</span><span><span className="block text-sm font-medium">{w.capabilitySnapshot ? syncLabel(w.sync, true) : "首次连接设置"}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{w.capabilitySnapshot ? `最近验证 ${displayTime(w.capabilitySnapshot.time / 1000)} · ${featureCount} 项功能已授权` : "完成本机配对后，工作台会自动同步。"}</span></span></span><ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", w.pairingOpen && "rotate-180")} />
    </button>
    {w.pairingOpen && <div id="pairing-panel" className="border-t p-5 sm:p-6">
      <ol className="mb-7 grid grid-cols-3 gap-2">{["控制台身份", "本机配对", "验证连接"].map((label, index) => <li key={label} className="flex items-center gap-2 text-xs sm:text-sm"><span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs", index + 1 < step || w.capabilitySnapshot ? "bg-primary text-primary-foreground" : index + 1 === step ? "bg-primary/10 font-semibold text-primary ring-1 ring-primary/20" : "bg-muted text-muted-foreground")}>{index + 1 < step || w.capabilitySnapshot ? <Check className="h-3.5 w-3.5" /> : index + 1}</span><span className={index + 1 > step ? "text-muted-foreground" : "font-medium"}>{label}</span></li>)}</ol>
      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div><h2 className="font-medium">{w.identity?.virtualUrn ? "这是你的控制台身份" : "创建一个专属控制台身份"}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{w.identity?.virtualUrn ? "复制下面的 URN，在 agent 本机授权这个控制台。" : "身份用于让 agent 验证请求来源。创建后，在本机完成一次配对即可开始。"}</p>
          {w.identity?.virtualUrn ? <div className="mt-4 rounded-xl border bg-muted/30 p-3"><div className="flex items-center justify-between"><span className="text-[11px] font-medium text-muted-foreground">控制台 URN</span><CopyValue value={w.identity.virtualUrn} /></div><p className="mt-1 select-all break-all font-mono text-xs leading-6">{w.identity.virtualUrn}</p><details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">查看验证公钥</summary><div className="mt-2 flex items-start gap-2"><p className="min-w-0 flex-1 select-all break-all font-mono text-[11px] leading-5">{w.identity.virtualEd25519PublicKey}</p>{w.identity.virtualEd25519PublicKey && <CopyValue value={w.identity.virtualEd25519PublicKey} label="复制验证公钥" compact />}</div></details></div> : <Button className="mt-4 gap-2 rounded-xl" disabled={w.identityBusy} onClick={w.createIdentity}>{w.identityBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}{w.identityBusy ? "正在读取身份…" : "创建控制台身份"}</Button>}
          {w.identityError && <p role="alert" className="mt-3 text-sm text-destructive">{w.identityError}</p>}
        </div>
        <div className="rounded-2xl bg-muted/40 p-4 sm:p-5"><h3 className="text-sm font-medium">在 agent 本机完成配对</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">在部署包目录执行下面的绑定命令，或交给你本机的 agent 执行。它会自动注册本机 agent 到 platform、保存网页授权，并配置连接。保持 agent 与 helper 运行。</p><p className="mt-2 text-xs leading-6 text-muted-foreground">本次网页授权有效期 30 天。命令执行后重启本机 Gateway，使网页连接生效。源码目录运行时，将脚本路径改为 tools/release/early_access/configure_hermes.py。</p>{w.identity.virtualUrn && <div className="mt-3 rounded-xl border bg-background p-3"><div className="flex justify-end"><CopyValue value={pairCommand} label="复制绑定命令" /></div><code className="block select-all break-all text-[11px] leading-6">{pairCommand}</code></div>}<div className="mt-4 flex flex-wrap gap-2"><Button className="gap-2 rounded-xl" disabled={w.identityBusy || !w.identity?.virtualUrn || !!w.busy.capabilities} onClick={() => void w.invoke("capabilities")}>{w.busy.capabilities ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{w.busy.capabilities ? "检查中…" : w.capabilitySnapshot ? "重新检查连接" : "立即检查连接"}</Button>{w.identity?.virtualUrn && <Button variant="ghost" size="sm" className="rounded-xl text-xs" disabled={w.identityBusy || !!w.busy.capabilities} onClick={w.createIdentity}>{w.identityBusy ? "注册中…" : "重新注册身份"}</Button>}</div></div>
      </div>
      <div className="mt-5 flex items-start gap-2 border-t pt-4"><span className="mt-1 shrink-0 text-xs text-muted-foreground">目标 agent</span><p className="min-w-0 flex-1 break-all font-mono text-[11px] leading-6 text-muted-foreground">{agent.urn}</p><CopyValue value={agent.urn} label="复制 agent URN" compact /></div>
      {!!unavailable.length && <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">未开放的功能</summary><ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">{unavailable.map(method => <li key={string(method.name)}><span className="font-medium text-foreground">{methodLabels[string(method.name)] || string(method.name)}</span> · 当前适配器或本机配对尚未开放。{typeof method.reason === "string" && <span className="mt-0.5 block break-words text-[11px] opacity-80">{method.reason}</span>}</li>)}</ul></details>}
    </div>}
    {(w.busy.capabilities || w.errors.capabilities) && <div className="border-t px-5 py-4"><RequestFeedback busy={w.busy.capabilities} error={w.errors.capabilities} onRetry={() => void w.invoke("capabilities")} /></div>}
  </section>;
}

