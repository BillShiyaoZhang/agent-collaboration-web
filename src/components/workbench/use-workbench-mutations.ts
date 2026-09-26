"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { canRestartMutation, presentedMutationActions } from "@/lib/workspace/workspace-mutation-policy";
import type { WorkspaceOperation } from "@/lib/workspace/workspace-types";
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
  reusedContact?: boolean;
  conversationId?: string;
  createdAt?: number;
  updatedAt?: number;
};
type Invoke = (method: RpcMethod, params?: RemoteRecord, original?: PendingCall) => Promise<{ result?: RemoteRecord; error?: WorkbenchError }>;

function restored(value: unknown): MutationState[] {
  return records(value).flatMap(item => {
    const call = record(item.call), params = record(call.params);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(string(call.request_id)) || !mutationMethods.includes(string(call.method))) return [];
    if (call.method === "approval.respond" && (!string(params.approval_id) || !["approve", "deny"].includes(string(params.decision)))) return [];
    if (call.method === "contacts.add" && (!string(params.contact_id) || !string(params.urn) || !Array.isArray(params.aliases))) return [];
    return [{ call: call as PendingCall, phase: "uncertain" as const, retryable: item.retryable !== false,
      ...(item.reusedContact === true ? { reusedContact: true } : {}),
      message: "上次提交的结果尚未核实。页面不会自动重复提交，请先刷新查看最新内容。" }];
  }).slice(-32);
}

export function useWorkbenchMutations({ agentId, consoleUrn, client, invoke, canAddContact, canRespondApproval, canMutate, refresh, contacts, approvalDecisions, requests, messages, sentMessages, savedOperations }: {
  savedOperations?: WorkspaceOperation[];
  agentId: string; consoleUrn: string; client: WorkbenchClient; invoke: Invoke;
  canAddContact: boolean; canRespondApproval: boolean; canMutate: (method: MutationMethod) => boolean; requests: RemoteRecord[]; messages: RemoteRecord[]; sentMessages: RemoteRecord[]; refresh: () => Promise<void>; contacts: RemoteRecord[]; approvalDecisions: RemoteRecord[];
}) {
  const [items, setItems] = useState<MutationState[]>([]);
  const current = useRef<MutationState[]>([]);
  const active = useRef(new Set<MutationMethod>());
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const key = `workbench-pending-actions:${consoleUrn}:${agentId}`;
  const dismissedContacts = useRef(new Set<string>());

  const operationsUrl = `/api/agents/${encodeURIComponent(agentId)}/workspace/operations`;
  const save = useCallback((next: MutationState[]) => {
    const shown = presentedMutationActions(next, dismissedContacts.current);
    current.current = shown; setItems(shown);
  }, []);
  const ledgerRequest = useCallback(async (body?: RemoteRecord) => {
    const response = await fetch(operationsUrl, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" } : { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(string(data.error, "无法保存账户操作记录。"));
    return data;
  }, [operationsUrl]);

  const loadSaved = useCallback(async () => {
    const response = await ledgerRequest();
    save(records(response.items) as MutationState[]);
    setStorageError(""); setReady(true);
  }, [ledgerRequest, save]);

  useEffect(() => {
    let alive = true;
    dismissedContacts.current.clear(); setReady(false); save([]);
    const restore = async () => {
      try {
        let legacy: MutationState[] = [];
        try { legacy = restored(JSON.parse(sessionStorage.getItem(key) || "[]")); } catch { /* Browser storage is optional. */ }
        for (const item of legacy) await ledgerRequest({ action: "import_legacy", call: item.call, reusedContact: item.reusedContact === true });
        if (legacy.length) { try { sessionStorage.removeItem(key); } catch { /* Durable account copy exists. */ } }
        const response = await ledgerRequest();
        if (alive) { save(records(response.items).map(item => item.phase === "sending" ? { ...item, phase: "uncertain", message: "原操作已保留，提交结果尚未核实。请先查看最新状态。" } : item) as MutationState[]); setReady(true); setStorageError(""); }
      } catch (error) {
        if (alive) { setStorageError(error instanceof Error ? error.message : "暂时无法恢复账户操作记录。已有内容仍可查看。"); setReady(true); }
      }
    };
    void restore();
    return () => { alive = false; };
  }, [key, ledgerRequest, save]);

  useEffect(() => {
    if (!savedOperations || !ready) return;
    const incoming = new Map(savedOperations.map(item => [item.call.request_id, item]));
    const next = current.current.map(item => {
      const saved = incoming.get(item.call.request_id); incoming.delete(item.call.request_id);
      if (!saved || active.current.has(item.call.method as MutationMethod)) return item;
      return saved.updatedAt >= (item.updatedAt || 0) ? (saved.phase === "sending" ? { ...saved, phase: "uncertain" as const, message: "原操作已保留，等待核实提交结果。" } : saved) : item;
    });
    save([...next, ...Array.from(incoming.values()).map(item => item.phase === "sending" ? { ...item, phase: "uncertain" as const, message: "原操作已保留，等待核实提交结果。" } : item)]);
  }, [savedOperations, ready, save]);

  const replace = useCallback((item: MutationState) => {
    const value = { ...item, updatedAt: Date.now() };
    save([value, ...current.current.filter(previous => previous.call.request_id !== item.call.request_id)]);
    // Only authenticated receipt/snapshot projections settle terminal facts.
    void ledgerRequest({ action: "update", requestId: item.call.request_id, phase: item.phase, message: item.message, retryable: item.retryable })
      .catch(() => setStorageError("原请求已保存在账户中，暂时未能保存最新显示状态。请刷新核实结果。"));
  }, [ledgerRequest, save]);

  useEffect(() => {
    // Only an agent-synced contact with this request's exact ID and mapping resolves an ambiguous add.
    for (const item of current.current) {
      if (item.call.method !== "contacts.add" || item.phase !== "uncertain") continue;
      // This contact predates a rejected-request retry. A refreshed contact or
      // another local surface's new request cannot prove this exact RPC ran.
      if (item.reusedContact) continue;
      const params = item.call.params;
      const sameContact = contacts.some(contact => contact.contact_id === params.contact_id && contact.urn === params.urn &&
        Array.isArray(params.aliases) && params.aliases.every(alias => Array.isArray(contact.aliases) && contact.aliases.includes(alias)));
      if (sameContact) {
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
    const reusedContact = original?.reusedContact ?? (method === "contacts.add" && contacts.some(contact =>
      contact.contact_id === params.contact_id && contact.urn === params.urn && contact.connection_status === "rejected"));
    const pending: MutationState = { call, phase: "sending", retryable: true, message: "正在提交，等待 agent 确认…", reusedContact, createdAt: original?.createdAt || Date.now(), updatedAt: Date.now() };
    active.current.add(method);
    let reserved = false;
    try {
      const saved = await ledgerRequest({ action: "reserve", call, reusedContact: reusedContact === true, ...(string(call.params.source_conversation_id) ? { conversationId: call.params.source_conversation_id } : {}) });
      if (!saved.item) throw new Error("无法保存原操作记录，本次尚未提交。");
      reserved = true;
      save([pending, ...current.current.filter(item => item.call.request_id !== call.request_id && !(item.call.method === method && subject(item.call) === subject(call)))]);
      const { result, error } = await invoke(method, call.params, call);
      const rejected = result && (result.error || ["not_executed", "unsupported", "unavailable", "denied", "rejected"].includes(string(result.status)) && method !== "contacts.respond" && method !== "approval.respond" || result.decision === "deny" && method !== "approval.respond");
      const uncertain = result?.status === "uncertain";
      const accepted = result && !rejected && !uncertain && (method === "collaboration.execute" ? Object.keys(result).length > 0 : method === "contacts.add"
        ? result.decision === "allow" && ["requested", "request_sent", "pending", "already_requested", "already_connected", "confirmed", "already_confirmed"].includes(string(result.status))
        : method === "approval.respond" ? result.approval_id === call.params.approval_id && (call.params.decision === "approve"
          ? result.decision === "allow" && result.status === "approved_once" : result.decision === "deny" && result.status === "denied")
        : method === "contacts.respond" ? result.request_id === call.params.request_id && result.status === (call.params.decision === "accept" ? "accepted" : "rejected")
        : method === "inbox.mark_read" ? result.message_id === call.params.message_id && (result.status === "read" || result.read === true)
        : result.message_id === call.params.message_id && ["sent", "queued", "accepted"].includes(string(result.status)));
      if (accepted) replace({ ...pending, result, phase: "succeeded", retryable: false, message: method === "contacts.add"
        ? ["already_connected", "confirmed", "already_confirmed"].includes(string(result?.status)) ? "Agent 已确认连接，通讯录正在同步。"
          : result?.status === "already_requested" ? "Agent 确认已有待处理的好友请求，本次没有另建申请；请查看好友请求的最新状态。"
            : "Agent 已在本机排队新的好友请求，正在尝试投递；对方收到并接受后才会建立连接。"
        : method === "collaboration.execute" ? result?.status === "approval_required" ? "请在下方待确认请求中核对并授权。" : "Agent 已返回执行结果，数据正在同步。"
        : method === "contacts.respond" ? call.params.decision === "accept" ? "Agent 已记录接受好友请求，通讯录正在同步；协作权限需另行授权。" : "已拒绝好友请求。"
        : method === "inbox.mark_read" ? "Agent 已记录已读，其他端的提醒将同步关闭。"
        : method === "messages.send" ? "Agent 已受理消息，发送记录正在同步。"
        : call.params.decision === "approve" ? "Agent 已记录你的同意，事项进展正在同步。" : "Agent 已记录你的拒绝，事项进展正在同步。" });
      else if (uncertain) replace({ ...pending, result, phase: "uncertain", retryable: false, message: string(result?.instruction, "Agent 尚不能确认此动作是否已执行。请先查询事项和消息记录核实。") });
      else if (rejected) replace({ ...pending, result, phase: "failed", retryable: false, message: string(result?.error, "Agent 未执行此操作，请核对当前状态与授权。") });
      else if (error) replace({ ...pending, phase: error.uncertain ? "uncertain" : "failed", retryable: error.retryable,
        message: error.uncertain ? `尚未确认提交结果。${error.message}` : error.message });
      else replace({ ...pending, phase: "uncertain", retryable: !result, message: result ? "Agent 返回的结果不足以确认此操作。请核查原对象；原请求已保留。" : "尚未收到可核实的处理结果。请刷新内容，或重试本次提交。" });
    } catch (error) {
      if (reserved) replace({ ...pending, phase: "uncertain", message: error instanceof Error ? error.message : "提交结果尚未核实。原请求已保留。", retryable: true });
      else setStorageError(error instanceof Error ? error.message : "暂时无法保存账户操作记录，本次尚未提交。");
    } finally { active.current.delete(method); }
    // The write has settled before background reads start, so visible retry/new-action buttons work immediately.
    // Reads update the durable workspace snapshots; mutation responses never populate lists.
    await refresh();
  }

  function clearContact() {
    if (current.current.some(item => item.call.method === "contacts.add" && ["sending", "uncertain"].includes(item.phase))) return;
    try {
      for (const item of current.current) if (item.call.method === "contacts.add" && ["succeeded", "failed"].includes(item.phase)) dismissedContacts.current.add(item.call.request_id);
      save(current.current);
    }
    catch { /* A completed action does not require request recovery. */ }
  }

  function recoverStorage() {
    void loadSaved().catch(error => setStorageError(error instanceof Error ? error.message : "暂时无法恢复账户操作记录。"));
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
    canRestart: (item: MutationState) => item.phase === "uncertain" && !item.retryable && canRestartMutation(item.call),
    restart: (item: MutationState) => canRestartMutation(item.call) && item.phase === "uncertain" && !item.retryable
      ? run(item.call.method as MutationMethod, item.call.params, { ...item, call: { ...item.call, request_id: crypto.randomUUID() }, createdAt: Date.now(), retryable: true }) : Promise.resolve(),
    clearContact, refresh, recoverStorage,
  };
}
