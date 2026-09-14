"use client";
import {useEffect,useState} from "react";
import Link from "next/link";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
type Agent={id:string;name:string;urn:string};
export default function AgentsPage(){
  const [agents,setAgents]=useState<Agent[]>([]),[name,setName]=useState(""),[urn,setUrn]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function load(){const response=await fetch("/api/agents",{cache:"no-store"});const data=await response.json();if(!response.ok)throw new Error(data.error);setAgents(data);}
  useEffect(()=>{load().catch(error=>setError(error.message));},[]);
  async function connect(event:React.FormEvent){event.preventDefault();setBusy(true);setError("");try{
    const response=await fetch("/api/agents",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,urn})});
    const data=await response.json();if(!response.ok)throw new Error(data.error);setName("");setUrn("");await load();
  }catch(error){setError(error instanceof Error?error.message:"无法保存连接。");}finally{setBusy(false);}}
  return <div className="mx-auto max-w-4xl space-y-8"><div><p className="text-sm text-muted-foreground">Agent Comm</p><h1 className="mt-1 text-3xl font-semibold">连接自己的 agent</h1><p className="mt-3 text-muted-foreground">从这里查看 agent 的联系人、事项与收件箱，并使用它提供的远程对话能力。</p></div>
    <form onSubmit={connect} className="space-y-4 rounded-xl border bg-card p-6"><h2 className="text-lg font-medium">添加连接</h2><p className="text-sm text-muted-foreground">先在运行 agent 的设备上安装 agent-comm 并启动 helper，然后填写它的完整 URN。</p>
      <Input aria-label="连接名称" maxLength={100} placeholder="连接名称，例如：我的 Hermes" value={name} onChange={event=>setName(event.target.value)} required/>
      <Input aria-label="Agent URN" maxLength={256} placeholder="urn:hermes:agent:…" value={urn} onChange={event=>setUrn(event.target.value)} required/>
      <Button disabled={busy}>{busy?"验证身份中…":"验证身份并保存连接"}</Button>
    </form>
    {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="grid gap-4 sm:grid-cols-2">{agents.map(agent=><Link href={"/dashboard/agents/"+agent.id} key={agent.id} className="rounded-xl border p-6 transition-colors hover:bg-muted"><h2 className="font-medium">{agent.name}</h2><p className="mt-2 break-all text-xs text-muted-foreground">{agent.urn}</p><p className="mt-5 text-sm">打开远程工作台 →</p></Link>)}</div>
    {!agents.length&&<p className="text-sm text-muted-foreground">还没有保存连接。保存后需要在 agent 本机配对这个控制台。</p>}
  </div>;
}
