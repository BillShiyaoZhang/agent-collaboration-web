"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PendingCall, record, records, RemoteRecord, RpcMethod, string, WorkbenchClient, WorkbenchError } from "@/lib/control/workbench-client";

export type MutationMethod = "contacts.add" | "approval.respond" | "contacts.respond" | "messages.send" | "inbox.mark_read" | "collaboration.execute";
const mutationMethods = ["contacts.add", "approval.respond", "contacts.respond", "messages.send", "inbox.mark_read", "collaboration.execute"];
const subject = (call: PendingCall) => call.method === "contacts.add" ? "contact" : String(call.params.approval_id || call.params.request_id || call.params.message_id || call.params.recipient_urn || call.params.action || "");
export type MutationState = {
  call: PendingCall;
  phase: "sending" | "uncertain" | "failed" | "succeeded";
  message: string;
  retryable: boolean;
  result?: RemoteRecord;
};
type Invoke = (method: RpcMethod, params?: RemoteRecord, original?: PendingCall) => Promise<{ result?: RemoteRecord; error?: WorkbenchError }>;

function restored(value: unknown): MutationState[] {
  return records(value).flatMap(item => {
    const call = record(item.call), params = record(call.params);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(string(call.request_id)) || !mutationMethods.includes(string(call.method))) return [];
    if (call.method === "approval.respond" && (!string(params.approval_id) || !["approve", "deny"].includes(string(params.decision)))) return [];
    if (call.method === "contacts.add" && (!string(params.contact_id) || !string(params.urn) || !Array.isArray(params.aliases))) return [];
    return [{ call: call as PendingCall, phase: "uncertain" as const, retryable: item.retryable !== false,
      message: "上次提交的结果尚未核实。页面不会自动重复提交，请先刷新查看最新内容。" }];
  }).slice(-32);
}

export function useWorkbenchMutations({ agentId, consoleUrn, client, invoke, canAddContact, canRespondApproval, canMutate, refresh, contacts, approvalDecisions, requests, messages, sentMessages }: {
  agentId: string; consoleUrn: string; client: WorkbenchClient; invoke: Invoke;
  canAddContact: boolean; canRespondApproval: boolean; canMutate: (method: MutationMethod) => boolean; requests: RemoteRecord[]; messages: RemoteRecord[]; sentMessages: RemoteRecord[]; refresh: () => Promise<void>; contacts: RemoteRecord[]; approvalDecisions: RemoteRecord[];
}) {
  const [items, setItems] = useState<MutationState[]>([]);
  const current = useRef<MutationState[]>([]);
  const active = useRef(new Set<MutationMethod>());
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const key = `workbench-pending-actions:${consoleUrn}:${agentId}`;

  const save = useCallback((next: MutationState[]) => {
    // Store only the original request needed for a user-initiated retry; never save approval questions.
    const unresolved = next.filter(item => item.phase === "sending" || item.phase === "uncertain")
      .map(({ call, retryable }) => ({ call, retryable }));
    sessionStorage.setItem(key, JSON.stringify(unresolved));
    current.current = next; setItems(next);
  }, [key]);

  useEffect(() => {
    try {
      const saved = restored(JSON.parse(sessionStorage.getItem(key) || "[]"));
      current.current = saved; setItems(saved); setStorageError("");
    } catch { setStorageError("浏览器暂时无法保存操作记录，请允许此站点保存数据后刷新。已有内容仍可查看。"); }
    setReady(true);
  }, [key]);

  const replace = useCallback((item: MutationState) => {
    const next = [...current.current.filter(previous => previous.call.request_id !== item.call.request_id), item];
    try { save(next); }
    catch { current.current = next; setItems(next); setStorageError("浏览器暂时无法保存操作记录。请保留此页面，先刷新内容核实本次结果。"); }
  }, [save]);

  useEffect(() => {
    // Only an agent-synced contact with this request's exact ID and mapping resolves an ambiguous add.
    for (const item of current.current) {
      if (item.call.method !== "contacts.add" || item.phase !== "uncertain") continue;
      const params = item.call.params;
      if (contacts.some(contact => contact.contact_id === params.contact_id && contact.urn === params.urn &&
        Array.isArray(params.aliases) && params.aliases.every(alias => Array.isArray(contact.aliases) && contact.aliases.includes(alias)))) {
        replace({ ...item, phase: "succeeded", retryable: false, message: "好友请求的最新状态已从 agent 同步，请在通讯录查看是否已建立连接。" });
      }
    }
  }, [contacts, replace]);

  useEffect(() => {
    for (const item of current.current) {
      if (item.call.method !== "approval.respond" || item.phase !== "uncertain") continue;
      const decision = approvalDecisions.find(approval => approval.approval_id === item.call.params.approval_id && ["approved", "denied"].includes(string(approval.status)));
      if (!decision) continue;
      const matches = decision.status === (item.call.params.decision === "approve" ? "approved" : "denied");
      replace({ ...item, phase: matches ? "succeeded" : "failed", retryable: false,
        message: matches ? `Agent 已同步此请求的${decision.status === "approved" ? "同意" : "拒绝"}记录。`
          : `Agent 最新记录为${decision.status === "approved" ? "同意" : "拒绝"}，与此前提交的选择不同。请查看事项进展核实。` });
    }
  }, [approvalDecisions, replace]);

  useEffect(() => {
    for (const item of current.current) {
      if (item.phase !== "uncertain") continue;
      const params = item.call.params;
      const confirmed = item.call.method === "contacts.respond"
        ? requests.some(request => request.request_id === params.request_id && request.status === (params.decision === "accept" ? "accepted" : "rejected"))
        : item.call.method === "inbox.mark_read" ? messages.some(message => message.message_id === params.message_id && message.read === true)
        : item.call.method === "messages.send" ? sentMessages.some(message => message.message_id === params.message_id && ["sent", "queued", "accepted"].includes(string(message.status))) : false;
      if (confirmed) replace({ ...item, phase: "succeeded", retryable: false, message: "处理结果已从 agent 同步。" });
    }
  }, [requests, messages, sentMessages, replace]);

  async function run(method: MutationMethod, params: RemoteRecord, original?: MutationState) {
    if (!ready || storageError || active.current.has(method) || !canMutate(method)) return;
    if (!original && current.current.some(item => item.call.method === method && ["sending", "uncertain"].includes(item.phase) &&
      subject(item.call) === subject({ method, params } as PendingCall))) return;
    const call = original?.call || client.prepare(method, params);
    const pending: MutationState = { call, phase: "sending", retryable: true, message: "正在提交，等待 agent 确认…" };
    // Persist before submitting, so a refresh can recover the same request without replaying it.
    try { save([...current.current.filter(item => item.call.request_id !== call.request_id &&
      !(item.call.method === method && subject(item.call) === subject(call))), pending]); }
    catch { setStorageError("浏览器暂时无法保存操作记录，本次尚未提交。请允许此站点保存数据后刷新。"); return; }
    active.current.add(method);
    try {
      const { result, error } = await invoke(method, call.params, call);
      const rejected = result && (result.error || ["not_executed", "unsupported", "unavailable", "denied", "rejected"].includes(string(result.status)) && method !== "contacts.respond" && method !== "approval.respond" || result.decision === "deny" && method !== "approval.respond");
      const uncertain = result?.status === "uncertain";
      const accepted = result && !rejected && !uncertain && (method === "collaboration.execute" ? true : method === "contacts.add"
        ? result.decision === "allow" && ["requested", "request_sent", "pending", "already_requested", "already_connected", "confirmed", "already_confirmed"].includes(string(result.status))
        : method === "approval.respond" ? result.approval_id === call.params.approval_id && (call.params.decision === "approve"
          ? result.decision === "allow" && result.status === "approved_once" : result.decision === "deny" && result.status === "denied")
        : method === "contacts.respond" ? result.request_id === call.params.request_id && result.status === (call.params.decision === "accept" ? "accepted" : "rejected")
        : method === "inbox.mark_read" ? result.message_id === call.params.message_id && (result.status === "read" || result.read === true)
        : result.message_id === call.params.message_id && ["sent", "queued", "accepted"].includes(string(result.status)));
      if (accepted) replace({ ...pending, result, phase: "succeeded", retryable: false, message: method === "contacts.add"
        ? ["already_connected", "confirmed", "already_confirmed"].includes(string(result?.status)) ? "Agent 已确认连接，通讯录正在同步。" : "Agent 已在本机排队好友请求，正在尝试投递；对方收到并接受后才会建立连接。"
        : method === "collaboration.execute" ? result?.status === "approval_required" ? "请在下方待确认请求中核对并授权。" : "Agent 已返回执行结果，数据正在同步。"
        : method === "contacts.respond" ? call.params.decision === "accept" ? "Agent 已记录接受好友请求，通讯录正在同步；协作权限需另行授权。" : "已拒绝好友请求。"
        : method === "inbox.mark_read" ? "Agent 已记录已读，其他端的提醒将同步关闭。"
        : method === "messages.send" ? "Agent 已受理消息，发送记录正在同步。"
        : call.params.decision === "approve" ? "Agent 已记录你的同意，事项进展正在同步。" : "Agent 已记录你的拒绝，事项进展正在同步。" });
      else if (uncertain) replace({ ...pending, result, phase: "uncertain", retryable: false, message: string(result?.instruction, "Agent 尚不能确认此动作是否已执行。请先查询事项和消息记录核实。") });
      else if (rejected) replace({ ...pending, result, phase: "failed", retryable: false, message: string(result?.error, "Agent 未执行此操作，请核对当前状态与授权。") });
      else if (error) replace({ ...pending, phase: error.uncertain ? "uncertain" : "failed", retryable: error.retryable,
        message: error.uncertain ? `尚未确认提交结果。${error.message}` : error.message });
      else replace({ ...pending, phase: "uncertain", retryable: true, message: "尚未收到可核实的处理结果。请刷新内容，或重试本次提交。" });
    } finally { active.current.delete(method); }
    // The write has settled before background reads start, so visible retry/new-action buttons work immediately.
    // Reads update the durable workspace snapshots; mutation responses never populate lists.
    await refresh();
  }

  function clearContact() {
    if (current.current.some(item => item.call.method === "contacts.add" && ["sending", "uncertain"].includes(item.phase))) return;
    try { save(current.current.filter(item => item.call.method !== "contacts.add")); }
    catch { /* A completed action does not require request recovery. */ }
  }

  function recoverStorage() {
    try { save(current.current); setStorageError(""); }
    catch { setStorageError("浏览器仍无法保存操作记录，请允许此站点保存数据后再试。"); }
  }

  return {
    ready: ready && !storageError, storageError, contactAction: items.find(item => item.call.method === "contacts.add"),
    actions: items, canMutate, run,
    approvalActions: items.filter(item => item.call.method === "approval.respond"),
    approvalBusy: items.some(item => item.call.method === "approval.respond" && item.phase === "sending"),
    addContact: (params: RemoteRecord) => run("contacts.add", params),
    respondApproval: (approvalId: string, decision: "approve" | "deny") => run("approval.respond", { approval_id: approvalId, decision }),
    retry: (item: MutationState) => item.retryable ? run(item.call.method as MutationMethod, item.call.params, item) : Promise.resolve(),
    // A fresh, explicit decision after the transport receipt expires keeps the business identity and payload.
    restart: (item: MutationState) => item.call.method !== "collaboration.execute" && item.phase === "uncertain" && !item.retryable
      ? run(item.call.method as MutationMethod, item.call.params, { ...item, call: { ...item.call, request_id: crypto.randomUUID() }, retryable: true }) : Promise.resolve(),
    clearContact, refresh, recoverStorage,
  };
}
