"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PendingCall, record, records, RemoteRecord, RpcMethod, string, WorkbenchClient, WorkbenchError } from "@/lib/control/workbench-client";

type MutationMethod = "contacts.add" | "approval.respond";
export type MutationState = {
  call: PendingCall;
  phase: "sending" | "uncertain" | "failed" | "succeeded";
  message: string;
  retryable: boolean;
};
type Invoke = (method: RpcMethod, params?: RemoteRecord, original?: PendingCall) => Promise<{ result?: RemoteRecord; error?: WorkbenchError }>;

function restored(value: unknown): MutationState[] {
  return records(value).flatMap(item => {
    const call = record(item.call), params = record(call.params);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(string(call.request_id)) || !["contacts.add", "approval.respond"].includes(string(call.method))) return [];
    if (call.method === "approval.respond" && (!string(params.approval_id) || !["approve", "deny"].includes(string(params.decision)))) return [];
    if (call.method === "contacts.add" && (!string(params.contact_id) || !string(params.urn) || !Array.isArray(params.aliases))) return [];
    return [{ call: call as PendingCall, phase: "uncertain" as const, retryable: item.retryable !== false,
      message: "上次提交的结果尚未核实。页面不会自动重复提交，请先刷新查看最新内容。" }];
  }).slice(-32);
}

export function useWorkbenchMutations({ agentId, consoleUrn, client, invoke, canAddContact, canRespondApproval, refresh, contacts, approvalDecisions }: {
  agentId: string; consoleUrn: string; client: WorkbenchClient; invoke: Invoke;
  canAddContact: boolean; canRespondApproval: boolean; refresh: () => Promise<void>; contacts: RemoteRecord[]; approvalDecisions: RemoteRecord[];
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
        replace({ ...item, phase: "succeeded", retryable: false, message: "联系人已添加，并已从 agent 同步。" });
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

  async function run(method: MutationMethod, params: RemoteRecord, original?: MutationState) {
    if (!ready || storageError || active.current.has(method) || !(method === "contacts.add" ? canAddContact : canRespondApproval)) return;
    if (!original && current.current.some(item => item.call.method === method && ["sending", "uncertain"].includes(item.phase) &&
      (method === "contacts.add" || item.call.params.approval_id === params.approval_id))) return;
    const call = original?.call || client.prepare(method, params);
    const pending: MutationState = { call, phase: "sending", retryable: true, message: "正在提交，等待 agent 确认…" };
    // Persist before submitting, so a refresh can recover the same request without replaying it.
    try { save([...current.current.filter(item => item.call.request_id !== call.request_id &&
      !(method === "contacts.add" && item.call.method === method) &&
      !(method === "approval.respond" && item.call.method === method && item.call.params.approval_id === params.approval_id)), pending]); }
    catch { setStorageError("浏览器暂时无法保存操作记录，本次尚未提交。请允许此站点保存数据后刷新。"); return; }
    active.current.add(method);
    try {
      const { result, error } = await invoke(method, call.params, call);
      const accepted = result && (method === "contacts.add"
        ? result.decision === "allow" && ["confirmed", "already_confirmed"].includes(string(result.status)) &&
          record(result.contact).contact_id === call.params.contact_id && record(result.contact).urn === call.params.urn
        : result.approval_id === call.params.approval_id && (call.params.decision === "approve"
          ? result.decision === "allow" && result.status === "approved_once"
          : result.decision === "deny" && result.status === "denied"));
      if (accepted) replace({ ...pending, phase: "succeeded", retryable: false, message: method === "contacts.add"
        ? "Agent 已确认添加联系人，列表正在同步。" : call.params.decision === "approve"
          ? "Agent 已记录你的同意，事项进展正在同步。" : "Agent 已记录你的拒绝，事项进展正在同步。" });
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
    approvalActions: items.filter(item => item.call.method === "approval.respond"),
    approvalBusy: items.some(item => item.call.method === "approval.respond" && item.phase === "sending"),
    addContact: (params: RemoteRecord) => run("contacts.add", params),
    respondApproval: (approvalId: string, decision: "approve" | "deny") => run("approval.respond", { approval_id: approvalId, decision }),
    retry: (item: MutationState) => item.retryable ? run(item.call.method as MutationMethod, item.call.params, item) : Promise.resolve(),
    // A fresh, explicit decision after the transport receipt expires keeps the business identity and payload.
    restart: (item: MutationState) => item.phase === "uncertain" && !item.retryable
      ? run(item.call.method as MutationMethod, item.call.params, { ...item, call: { ...item.call, request_id: crypto.randomUUID() }, retryable: true }) : Promise.resolve(),
    clearContact, refresh, recoverStorage,
  };
}
