"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { record, RemoteRecord, string, strings } from "@/lib/control/workbench-client";
import { ActionFeedback } from "./mutation-panels";
import type { Workbench } from "./use-workbench";

const labels: Record<string, string> = {
  state: "查看协作状态", collaborations: "查看协作记录", attention: "查看待处理提醒", inbox: "查看收件箱",
  prepare_collaboration: "创建协作提议", revoke_collaboration_maintenance: "停止协作维护", import_proposal: "导入协作提议",
  register_resource: "添加可分享资料", resolve_contact: "查找联系人", export_contact: "分享联系人信息", prepare_contact: "准备联系人授权",
  prepare_task: "创建协作事项", prepare_worker_policy: "设置自动协作范围", pause_worker: "暂停自动协作", revoke_worker: "撤销自动协作",
  prepare_action: "准备协作动作", confirm: "查看授权结果", dispatch: "执行已授权动作", revoke: "撤销事项",
  memory_search: "搜索本机记忆", memory_snapshot: "查看记忆内容", snapshot_resource: "创建记忆资料",
  prepare_message: "准备消息", send_message: "发送消息", contact_requests: "查看好友请求", prepare_contact_response: "回应好友请求", mark_read: "将消息标为已读",
};
const fieldLabels: Record<string, string> = { task_id: "事项 ID", collaboration_id: "协作 ID", operation_id: "动作 ID", resource_id: "资料 ID", approval_id: "授权 ID", message_id: "消息 ID", request_id: "请求 ID", contact_id: "联系人 ID", recipient_urn: "接收者 URN", urn: "URN", aliases: "称呼列表", title: "标题", text: "内容", name: "姓名或称呼", scope: "协作范围", policy: "执行规则", operation: "协作动作内容", payload: "提议内容", kind: "提议类型", query: "搜索内容", reference: "资料引用", limit: "数量", max_chars: "最多字符数", after: "提醒游标", platform_url: "平台地址" };
const structured = new Set(["scope", "policy", "operation", "payload", "aliases"]);
const numeric = new Set(["limit", "max_chars", "after"]);

export function CollaborationActions({ workbench: w }: { workbench: Workbench }) {
  const [description, setDescription] = useState<RemoteRecord>({}), [action, setAction] = useState(""), [values, setValues] = useState<Record<string, string>>({}), [error, setError] = useState("");
  const available = w.mutations.canMutate("collaboration.execute"), fields = record(record(description.action_fields)[action]);
  const required = strings(fields.required), optional = strings(fields.optional);
  const result = w.mutations.actions.slice().reverse().find(item => item.call.method === "collaboration.execute");
  async function load() {
    const outcome = await w.invoke("collaboration.execute", { action: "describe" });
    if (outcome.result) { setDescription(outcome.result); setAction(strings(outcome.result.actions).find(value => value !== "describe") || ""); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    try {
      const params: RemoteRecord = { action };
      for (const field of [...required, ...optional]) {
        const value = values[field]?.trim();
        if (!value) { if (required.includes(field)) throw new Error(`请填写${fieldLabels[field] || field}。`); continue; }
        params[field] = structured.has(field) ? JSON.parse(value) : numeric.has(field) ? Number(value) : value;
      }
      await w.mutations.run("collaboration.execute", params);
    } catch { setError("请填写所有必填内容，并检查结构化参数是否是有效 JSON。"); }
  }
  if (!w.available("collaboration.execute")) return null;
  return <details className="mx-5 mb-5 rounded-2xl border p-4"><summary className="cursor-pointer text-sm font-medium">更多 agent-comm 功能</summary><p className="mt-2 text-xs leading-6 text-muted-foreground">这里与本机对话使用同一套协作功能；需要授权的操作会进入下方确认列表。</p><Button className="mt-3" variant="outline" size="sm" disabled={!available || !!w.busy["collaboration.execute"]} onClick={() => void load()}>读取本机可用功能</Button>{w.errors["collaboration.execute"] && <p role="alert" className="mt-2 text-xs text-destructive">{w.errors["collaboration.execute"]?.message}</p>}{strings(description.actions).length > 0 && <form className="mt-4 space-y-3" onSubmit={submit}><label className="block text-xs">选择功能<select aria-label="选择 agent-comm 功能" className="mt-1 block w-full rounded-md border bg-background p-2 text-sm" value={action} onChange={event => { setAction(event.target.value); setValues({}); }}>{strings(description.actions).filter(value => value !== "describe").map(value => <option key={value} value={value}>{labels[value] || value}</option>)}</select></label>{[...required, ...optional].map(field => <label key={field} className="block text-xs">{fieldLabels[field] || field}{required.includes(field) ? " *" : "（可选）"}{structured.has(field) ? <Textarea className="mt-1 font-mono" aria-label={fieldLabels[field] || field} placeholder="JSON" value={values[field] || ""} onChange={event => setValues(previous => ({ ...previous, [field]: event.target.value }))} /> : <Input className="mt-1" value={values[field] || ""} onChange={event => setValues(previous => ({ ...previous, [field]: event.target.value }))} />}</label>)}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}<Button size="sm" disabled={!available || !w.mutations.ready || !!w.busy["collaboration.execute"]} type="submit">执行所选功能</Button></form>}{result && <><ActionFeedback action={result} onRetry={() => void w.mutations.retry(result)} onRestart={() => void w.mutations.restart(result)} onRefresh={() => void w.mutations.refresh()} retryDisabled={!available} />{result.result && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted p-3 text-xs leading-6">{JSON.stringify(result.result, null, 2)}</pre>}</>}</details>;
}
