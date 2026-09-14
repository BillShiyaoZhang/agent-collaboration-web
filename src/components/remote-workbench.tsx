"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Connection = { id: string; name: string; urn: string };
type Method = { name: string; available: boolean; reason?: string };
type Identity = { virtualUrn: string | null; virtualEd25519PublicKey: string | null };
type PendingCall = {request_id:string;method:string;params:Record<string,unknown>};

export function RemoteWorkbench({ agent }: {agent: Connection}) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [methods, setMethods] = useState<Method[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("连接已保存。请先在 agent 本机配对控制台，再读取能力。");
  const [error, setError] = useState("");
  const [data, setData] = useState<Record<string, unknown>>({});
  const [text, setText] = useState("");
  const [conversationId, setConversationId] = useState("");
  const calls = useRef(new Map<string, PendingCall>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    fetch(`/api/agents/${agent.id}/bind-owner`, {cache:"no-store",signal:controller.signal}).then(async response => {
      const body = await response.json(); if (response.ok) setIdentity(body);
    }).catch(()=>{});
    return () => { mounted.current = false; controller.abort(); };
  }, [agent.id]);

  async function createIdentity() {
    setBusy("identity"); setError("");
    try {
      const response = await fetch(`/api/agents/${agent.id}/bind-owner`, {method:"POST"});
      const body = await response.json();
      if(!response.ok) throw new Error(body.error);
      setIdentity(body);setMessage(body.note);
    } catch(error) { setError(error instanceof Error ? error.message : "请求失败。"); }
    finally {setBusy("");}
  }

  async function rpc(method: string, params: Record<string, unknown> = {}) {
    setBusy(method);setError("");
    const key = JSON.stringify([method,params]);
    const call = calls.current.get(key) || {request_id:crypto.randomUUID(),method,params};
    calls.current.set(key,call);
    try {
      let response = await fetch(`/api/agents/${agent.id}/control`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(call)});
      let body = await response.json();
      if(!response.ok) {if(response.status===410 || response.status===404) calls.current.delete(key); throw new Error(body.error);}
      setMessage("请求已入队，正在等待 agent 的认证响应。请保持 agent 和 helper 在线。");
      for(let attempt=0; body.status==="pending" && attempt<65; attempt++) {
        await new Promise(resolve=>setTimeout(resolve,2000));
        if(!mounted.current) return;
        response=await fetch(`/api/agents/${agent.id}/control?request_id=${encodeURIComponent(call.request_id)}`,{cache:"no-store"});
        body=await response.json();
        if(!response.ok) throw new Error(body.error);
      }
      if(!mounted.current) return;
      if(body.status!=="complete") {calls.current.delete(key);throw new Error("尚未收到有效响应。重新操作前请检查 agent 端状态，已提交动作可能仍在处理。");}
      calls.current.delete(key);
      if(body.response.error) throw new Error(`${body.response.error.code}: ${body.response.error.message}`);
      const result=body.response.result;
      setData(previous=>({...previous,[method]:result}));
      if(method==="capabilities") setMethods(Array.isArray(result?.methods)?result.methods.filter((entry:Method)=>typeof entry.name==="string" && typeof entry.available==="boolean"):[]);
      if(method==="conversation.send" && typeof result?.conversation_id==="string") setConversationId(result.conversation_id);
      setMessage(method==="conversation.send" ? "Agent 已受理这一回合。点击读取对话查看处理结果。" : "已收到 agent 的认证响应。页面展示本次读取的快照。");
    } catch(error) { if(mounted.current) setError(error instanceof Error ? error.message : "请求失败；可用同一按钮重试原请求。"); }
    finally { if(mounted.current) setBusy(""); }
  }
  const available = (name:string) => methods.some(method=>method.name===name && method.available);
  const labels:Record<string,string>={"contacts.list":"联系人","collaboration.state":"事项与授权状态","inbox.list":"收件箱"};

  return <div className="space-y-6">
    <div><p className="text-sm text-muted-foreground">远程工作台</p><h1 className="mt-1 text-3xl font-semibold">{agent.name}</h1><p className="mt-2 break-all font-mono text-sm text-muted-foreground">{agent.urn}</p></div>
    <section className="rounded-xl border bg-card p-6">
      <h2 className="text-lg font-medium">控制台配对</h2>
      <p className="mt-2 text-sm text-muted-foreground">在 agent 本机授权这个控制台的 URN，并将其加入 connector 的 allow_from。联系人、事项和对话保存在 agent 侧。</p>
      {identity?.virtualUrn && <div className="my-4 space-y-2 rounded-lg bg-muted p-3"><p className="break-all font-mono text-sm">{identity.virtualUrn}</p><p className="break-all text-xs text-muted-foreground">Ed25519: {identity.virtualEd25519PublicKey}</p></div>}
      <div className="mt-4 flex flex-wrap gap-3"><Button variant="outline" disabled={!!busy} onClick={createIdentity}>{identity?.virtualUrn?"确认身份注册":"创建控制台身份"}</Button><Button disabled={!!busy || !identity?.virtualUrn} onClick={()=>rpc("capabilities")}>读取 agent 能力</Button></div>
    </section>
    <div role="status" className="rounded-lg bg-muted px-4 py-3 text-sm">{busy && <span className="mr-2">处理中…</span>}{message}</div>
    {error && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
    {!!methods.length && <section className="rounded-xl border p-6"><h2 className="text-lg font-medium">来自 agent 的功能</h2>
      <div className="mt-4 flex flex-wrap gap-3">{Object.entries(labels).filter(([method])=>available(method)).map(([method,label])=><Button key={method} variant="outline" disabled={!!busy} onClick={()=>rpc(method)}>{label}</Button>)}</div>
      {methods.filter(method=>!method.available).map(method=><p key={method.name} className="mt-3 text-sm text-muted-foreground">{method.name}：{method.reason||"当前 agent 未提供"}</p>)}
    </section>}
    {(available("conversation.send") || available("conversation.get")) && <section className="space-y-4 rounded-xl border p-6"><h2 className="text-lg font-medium">与这个 agent 对话</h2>
      <p className="text-sm text-muted-foreground">使用 agent 的独立远程会话。需主人确认的协作操作仍通过已适配的原生渠道处理。</p>
      <Input aria-label="对话 ID" placeholder="对话 ID；首次发送可留空" value={conversationId} onChange={event=>setConversationId(event.target.value)}/>
      {available("conversation.send") && <Textarea aria-label="给 agent 的消息" maxLength={8000} value={text} onChange={event=>setText(event.target.value)} placeholder="告诉自己的 agent 你想做什么…"/>}
      <div className="flex gap-3">{available("conversation.send") && <Button disabled={!!busy || !text.trim()} onClick={()=>rpc("conversation.send",{text,...(conversationId?{conversation_id:conversationId}:{})})}>发送给 agent</Button>}{available("conversation.get") && <Button variant="outline" disabled={!!busy || !conversationId} onClick={()=>rpc("conversation.get",{conversation_id:conversationId})}>读取对话</Button>}</div>
    </section>}
    {Object.entries(data).filter(([method])=>method!=="capabilities").map(([method,value])=><section key={method} className="rounded-xl border p-6"><h2 className="mb-3 font-medium">{labels[method]||method}</h2><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm">{JSON.stringify(value,null,2)}</pre></section>)}
    <p className="text-xs text-muted-foreground">页面不保存业务历史。刷新后重新向 agent 读取；离线、未配对或不支持的能力不会显示为成功。</p>
  </div>;
}
