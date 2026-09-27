"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createAgentSharingPermission, sharingStoppedMessage, type AgentSharingAccess, type SharingAgent, type SharingContext } from "@/lib/product/agent-sharing";

const SharingContextProvider = createContext<{
  permission: ReturnType<typeof createAgentSharingPermission>;
  open: (context: SharingContext) => void;
  changed: number;
} | null>(null);

export function AgentSharingPermissionProvider({ children, accountId, sessionVersion }: { children: ReactNode; accountId: string; sessionVersion: number }) {
  const [changed, setChanged] = useState(0), [displayed, setDisplayed] = useState<SharingContext | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [permission] = useState(() => createAgentSharingPermission(async () => {
    const session = await getSession({ broadcast: false });
    const user = session?.user;
    return user?.id === accountId && (user.sessionVersion ?? 0) === sessionVersion && user.loginSessionId ? { accountId: user.id, loginSessionId: user.loginSessionId,
      sessionVersion: user.sessionVersion ?? 0 } : null;
  }, () => typeof window === "undefined" ? "" : window.location.origin, () => setChanged(value => value + 1)));
  const open = useCallback((context: SharingContext) => { setDisplayed(context); setError(""); }, []);
  const allowed = !!displayed && permission.grant?.context === displayed;
  async function allow() {
    if (!displayed || busy) return;
    setBusy(true); setError("");
    const current = await permission.verify(displayed.agent);
    if (!current || JSON.stringify(current) !== JSON.stringify(displayed) || !permission.allow(displayed)) {
      setError("当前账户、登录会话或 Agent 已变化，请关闭并重新查看共享范围。");
    } else setDisplayed(null); // No retained send callback or draft: consent only returns to the page.
    setBusy(false);
  }
  return <SharingContextProvider.Provider value={{ permission, open, changed }}>
    {children}
    <Dialog open={!!displayed} onOpenChange={value => { if (!value && !busy) setDisplayed(null); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>管理内容共享许可</DialogTitle><DialogDescription>独立选择是否允许内容交给你的 Agent 及你配置的模型与工具。</DialogDescription></DialogHeader>
        {displayed && <div className="space-y-3 text-sm leading-6">
          <dl className="space-y-2"><div><dt className="text-xs text-muted-foreground">当前工作区</dt><dd className="break-all select-text">{displayed.origin}</dd></div><div><dt className="text-xs text-muted-foreground">你的 Agent</dt><dd className="font-medium">{displayed.agent.name}</dd><dd className="break-all select-text font-mono text-xs">{displayed.agent.urn}</dd></div></dl>
          <p>你发送的消息、对话上下文、联系人信息和协作内容会经此工作区交给以上 Agent。它可能按照你自行配置的模型与工具处理或转发这些内容；协作时还可能向你在具体操作中确认的接收方分享。</p>
          <p>请核对这个 Agent 的模型与工具配置。本工作台无法列出或核验其具体服务供应商，也无法发现其配置变化。配置改变时，请撤回本许可并重新核对。</p>
          <p>许可只用于本浏览器当前页面会话中的这个 Agent，刷新或重新打开页面、重新登录、切换 Agent 后需要重新同意。拒绝或撤回不影响阅读已有内容，也不妨碍阻止联系人。其他浏览器、设备及 Agent 本机授权需要分别管理。</p>
          <p>撤回会停止本页面之后的新内容发送和重试。已派发的请求及已分享的内容无法撤回。</p>
          <p className="text-muted-foreground">同意后返回原页面，由你再次点按发送或确认具体操作。此处不会派发内容，也不替代接收方和完整内容核对。</p>
          {allowed && <p role="status" className="font-medium">此 Agent 已获得本浏览器当前会话的共享许可。</p>}
          {error && <p role="alert" className="text-destructive">{error}</p>}
        </div>}
        <DialogFooter>
          <Button type="button" className="min-h-11" variant="outline" disabled={busy} onClick={() => { if (!allowed) permission.revoke(); setDisplayed(null); }}>{allowed ? "关闭" : "拒绝并返回"}</Button>
          {allowed ? <Button type="button" className="min-h-11" variant="destructive" disabled={busy} onClick={() => { permission.revoke(); setDisplayed(null); }}>撤回共享许可</Button>
            : <Button type="button" className="min-h-11" disabled={busy} onClick={() => void allow()}>{busy ? "正在核对会话…" : "同意共享并返回"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SharingContextProvider.Provider>;
}

export function useAgentSharingPermission(agent: SharingAgent): AgentSharingAccess {
  const shared = useContext(SharingContextProvider);
  if (!shared) throw new Error("AgentSharingPermissionProvider is required");
  const { permission, open } = shared;
  const [error, setError] = useState("");
  const expected = useRef(agent); expected.current = agent;
  useEffect(() => { permission.select(agent); }, [permission, agent]);
  const manage = useCallback(async () => { const context = await permission.verify(expected.current); if (context) { setError(""); open(context); } else setError("无法确认当前账户与登录会话，请刷新或重新登录后查看共享范围。"); }, [permission, open]);
  const request = useCallback(async () => {
    const current = expected.current;
    const captured = permission.capture(current);
    const context = await permission.verify(current);
    if (!context) { setError("无法确认当前账户与登录会话，本次尚未发送，请刷新或重新登录。"); return null; }
    setError("");
    // A permission accepted while this await was pending cannot authorize an older click.
    if (!captured) { if (!permission.capture(current)) open(context); return null; }
    if (captured === permission.capture(current)) return captured;
    setError(sharingStoppedMessage); return null;
  }, [permission, open]);
  const validate = useCallback((grant: Parameters<AgentSharingAccess["validate"]>[0]) => permission.validate(expected.current, grant), [permission]);
  return { allowed: !!permission.capture(agent), error, manage, request, validate };
}

export function AgentSharingPermissionButton({ access }: { access: AgentSharingAccess }) {
  return <div><Button type="button" size="sm" className="min-h-11" variant="outline" aria-label={access.allowed ? "管理共享许可，已允许，可撤回" : "管理共享许可，尚未允许"} onClick={() => void access.manage()}>管理共享许可</Button>{access.error && <p role="alert" className="mt-1 max-w-lg text-xs leading-6 text-destructive">{access.error}</p>}</div>;
}
