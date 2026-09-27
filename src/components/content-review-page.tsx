"use client";
import {useEffect,useRef,useState} from "react";
import {useSearchParams} from "next/navigation";
import Link from "next/link";
import {getSession} from "next-auth/react";
import {Button} from "@/components/ui/button";
import {record,records,string,WorkbenchClient,type RemoteRecord,type PendingCall} from "@/lib/control/workbench-client";
import {availableMethods} from "@agent-comm/client-contract";
import {nativeReviewCandidates,websiteReviewPreview,matchingNativeReview,type ReviewItem,type ReviewPreview} from "@/lib/moderation/native-review-preview";
type Item=ReviewItem;
type Preview=ReviewPreview & {remote?:RemoteRecord};
export function ContentReviewPage() {
  const params=useSearchParams(),agentId=params.get("agentId") || "",messageId=params.get("messageId") || "";
  const [workspace,setWorkspace]=useState<RemoteRecord>({}),[items,setItems]=useState<Item[]>([]),[preview,setPreview]=useState<Preview|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[consent,setConsent]=useState(false),[uncertain,setUncertain]=useState(false);
  const client=useRef<WorkbenchClient|null>(null),write=useRef<PendingCall|null>(null),active=useRef(false),scope=useRef<string|null>(null),previewGeneration=useRef(0),recovery=useRef<{item:Item;remote?:RemoteRecord}|null>(null);
  async function requireScope() {const session=await getSession(),current=session?.user?.id && JSON.stringify([session.user.id,session.user.sessionVersion,session.user.loginSessionId,agentId]);if(!current || scope.current && scope.current!==current){setWorkspace({});setItems([]);setPreview(null);setConsent(false);setUncertain(true);throw new Error("登录账户或会话已改变，请重新载入网站核对所属内容。");}scope.current ||= current;return current;}
  async function load() {if(!agentId){setError("请从待审核消息的入口进入此页。");return;}setError("");try{await requireScope();const responses=await Promise.all([fetch(`/api/agents/${encodeURIComponent(agentId)}/workspace`,{cache:"no-store"}),fetch(`/api/moderation/content?agentId=${encodeURIComponent(agentId)}`,{cache:"no-store"})]);const [saved,queue]=await Promise.all(responses.map(response=>response.json()));if(responses.some(response=>response.status!==200))throw new Error(saved.error || queue.error || "无法读取所属审核队列。");await requireScope();setWorkspace(saved);setItems(Array.isArray(queue.items)?queue.items:[]);await reconcile(queue.items);}catch(error){setError(error instanceof Error?error.message:"无法读取队列。");}}
  async function reconcile(queue:Item[]) {
    const originalPreview=preview || recovery.current;if(!uncertain || !originalPreview)return;
    const generation=previewGeneration.current,latest=Array.isArray(queue)?queue.find(item=>item.id===originalPreview.item.id && item.digest===originalPreview.item.digest):undefined;
    if(latest && ["approved","rejected"].includes(latest.status)){setPreview(null);setUncertain(false);setConsent(false);write.current=null;recovery.current=null;setError("已只读核实网站的原审核决定。");return;}
    const original=write.current;
    if(!original || !originalPreview.remote)return;
    // GET observes the original signed result; it never submits the review again.
    const response=await fetch(`/api/agents/${encodeURIComponent(agentId)}/control?request_id=${encodeURIComponent(original.request_id)}`,{cache:"no-store",signal:AbortSignal.timeout(20000)}),body=await response.json(),result=record(record(body.response).result);
    await requireScope();
    if(response.status===200 && body.status==="complete" && result.message_id===originalPreview.item.target.id && result.status===(original.params.decision==="approve"?"approved":"rejected") && result.fingerprint===originalPreview.remote.fingerprint && result.sender_urn===originalPreview.remote.sender_urn){if(preview && generation===previewGeneration.current)setPreview({...preview,remote:{...preview.remote,status:result.status}});setUncertain(false);setConsent(false);write.current=null;recovery.current=null;setError("已核实 Agent 的原决定。网站展示决定尚未确认，请重新明确预览与同意后完成网站决定。");}
  }
  useEffect(()=>{client.current=new WorkbenchClient(agentId);scope.current=null;write.current=null;recovery.current=null;setWorkspace({});setItems([]);setPreview(null);setConsent(false);setUncertain(false);void load();},[agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{const hide=()=>{previewGeneration.current++;setPreview(null);setConsent(false);};window.addEventListener("blur",hide);return()=>window.removeEventListener("blur",hide);},[]);
  async function show(item?:Item,pendingId?:string) {
    if(active.current || uncertain)return;const generation=previewGeneration.current;active.current=true;setBusy(true);setError("");setPreview(null);setConsent(false);
    try {
      async function guard() {await requireScope();if(generation!==previewGeneration.current)throw new Error("页面焦点已改变，请重新明确查看证据。");}
      async function read(chosen:Item) {
        await guard();
        const response=await fetch("/api/moderation/content",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"preview",id:chosen.id}),cache:"no-store"}),body=await response.json();
        await guard();if(response.status!==200)throw new Error(body.error || "无法读取完整预览。");
        return websiteReviewPreview(chosen,body);
      }
      await guard();write.current=null;let remote:RemoteRecord|undefined,selected:ReviewPreview|undefined;
      const capabilities=record(record(record(workspace.snapshots).capabilities).data),allowed=availableMethods(capabilities);
      if(pendingId) {
        if(!allowed.includes("inbox.review_preview"))throw new Error("本机配对尚未开放安全预览，请在 Agent 本机核对并授权 inbox.review_preview。");
        remote=await client.current!.execute(client.current!.prepare("inbox.review_preview",{message_id:pendingId}),new AbortController().signal);
        await guard();
        const response=await fetch(`/api/moderation/content?agentId=${encodeURIComponent(agentId)}`,{cache:"no-store"}),queue=await response.json();
        await guard();if(response.status!==200)throw new Error(queue.error || "无法读取所属审核队列。");
        const candidates=nativeReviewCandidates(queue.items,remote,pendingId,agentId),previews:ReviewPreview[]=[];
        for(const candidate of candidates)previews.push(await read(candidate));
        selected=matchingNativeReview(previews,remote);
      }else if(item)selected=await read(item);
      if(!selected)throw new Error("尚未保存与本机原文一致的完整审核内容，请刷新后核实；不会以不完整预览批准。");
      await guard();setPreview({...selected,remote});setUncertain(false);
    }catch(error){setError(error instanceof Error?error.message:"无法核实内容。");}finally{active.current=false;setBusy(false);}
  }
  async function decide(decision:"approve"|"reject") {
    if(!preview || active.current || uncertain || !consent)return;const generation=previewGeneration.current;active.current=true;setBusy(true);setError("");
    let dispatched=false;
    try {
      async function guard() {await requireScope();if(generation!==previewGeneration.current)throw new Error("页面焦点已改变，网站决定尚未提交，请重新明确核对。");}
      await guard();
      if(preview.item.status==="rejected" && decision==="approve")throw new Error("这份网站内容已被拒绝，不能恢复展示。");
      recovery.current={item:preview.item,remote:preview.remote?{fingerprint:preview.remote.fingerprint,sender_urn:preview.remote.sender_urn,status:preview.remote.status}:undefined};
      if(preview.remote?.status==="rejected" && decision==="approve")throw new Error("Agent 本机已拒绝这份内容，不能批准 App 展示。");
      if(preview.remote?.status==="pending") {
        const allowed=availableMethods(record(record(record(workspace.snapshots).capabilities).data));if(!allowed.includes("inbox.review"))throw new Error("本机未授权 inbox.review；没有改变本机或网页审核决定。");
        write.current ||= client.current!.prepare("inbox.review",{message_id:preview.item.target.id,decision});
        dispatched=true;const result=await client.current!.execute(write.current,new AbortController().signal);
        if(result.message_id!==preview.item.target.id || result.status!== (decision==="approve"?"approved":"rejected") || result.fingerprint!==preview.remote.fingerprint || result.sender_urn!==preview.remote.sender_urn)throw new Error("本机回执未匹配原内容，结果尚未确认。");
      }
      await guard();dispatched=true;const response=await fetch("/api/moderation/content",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"decide",id:preview.item.id,digest:preview.item.digest,decision,previewToken:preview.previewToken,consent:true}),cache:"no-store",signal:AbortSignal.timeout(30000)}),body=await response.json().catch(()=>({}));
      if(response.status!==200 || body.item?.id!==preview.item.id || body.item?.digest!==preview.item.digest || body.item?.status!== (decision==="approve"?"approved":"rejected")) {if([400,401,403,404,409,413,429].includes(response.status))throw new Error(body.error || "审核决定未被接受。");setUncertain(true);throw new Error("尚未确认审核决定，请刷新核实原记录，不要重复提交。");}
      await requireScope();setPreview(null);write.current=null;recovery.current=null;await load();
    }catch(error){const detail=error as {uncertain?:boolean};if(detail.uncertain || dispatched) setUncertain(true);setError(error instanceof Error?error.message:"结果未确认，请先核实。");}finally{active.current=false;setBusy(false);}
  }
  const snapshots=record(workspace.snapshots),pending=records(record(record(snapshots["inbox.list"]).data).pending_review ?? record(record(snapshots["collaboration.state"]).data).pending_review);
  return <main className="mx-auto max-w-3xl space-y-5 p-4"><h1 className="text-xl font-semibold">核对对端内容</h1><Link href="/community" className="inline-flex min-h-11 items-center text-primary underline">查看内容规范与审核判断依据</Link><p className="text-sm leading-7 text-muted-foreground">App 默认隐藏尚未核对的对端正文。在此网站明确查看内容，确认适合后才允许 App 展示。查看可能包含令人不适的内容；批准只针对这份内容，不授予协作权限。新版 Agent 的本机内容使用审核是独立边界；旧 Agent 的本地模型不受网页展示审核控制。</p>{error && <p role="alert" className="text-sm">{error}</p>}<Button variant="outline" disabled={busy} onClick={()=>void load()}>刷新队列与决定</Button>{pending.filter(item=>!messageId || item.message_id===messageId).map(item=><article key={string(item.message_id)} className="rounded-xl border p-4"><p className="break-all text-sm">待本机主人审核 · {string(item.sender_urn)} · {string(item.message_id)}</p><Button className="mt-3" disabled={busy} onClick={()=>void show(undefined,string(item.message_id))}>我理解风险，查看完整待审核内容</Button></article>)}{items.filter(item=>!messageId || item.target.id===messageId).map(item=><article key={item.id} className="rounded-xl border p-4"><p className="break-all text-sm">{item.target.kind} / {item.target.id} · {item.status==="approved"?"已允许网页展示":item.status==="rejected"?"已拒绝展示":"正文待审核"}</p><Button className="mt-3" variant="outline" disabled={busy} onClick={()=>void show(item,item.target.kind==="inbox" && pending.some(value=>value.message_id===item.target.id)?item.target.id:undefined)}>我理解风险，查看这份内容</Button></article>)}{preview && <section className="space-y-4 rounded-xl border border-amber-300 p-4"><h2 className="font-semibold">完整证据预览</h2><pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{JSON.stringify(preview.body,null,2)}</pre><label className="flex gap-3 text-sm"><input type="checkbox" checked={consent} disabled={busy || uncertain} onChange={event=>setConsent(event.target.checked)}/>我已核对这份内容，愿意保存对它的展示决定；如果同时操作新版 Agent，本机审核只影响这份内容的本地使用。</label>{uncertain?<Button variant="outline" disabled={busy} onClick={()=>void load()}>只读核实原记录状态</Button>:<div className="flex flex-wrap gap-3"><Button disabled={busy || !consent || preview.item.status==="rejected"} onClick={()=>void decide("approve")}>内容合适，允许 App 展示</Button><Button variant="destructive" disabled={busy || !consent} onClick={()=>void decide("reject")}>拒绝展示这份内容</Button></div>}</section>}<Link className="inline-flex min-h-11 items-center text-primary" href={`/dashboard/agents/${encodeURIComponent(agentId)}?tab=inbox`}>返回收件箱</Link></main>;
}
