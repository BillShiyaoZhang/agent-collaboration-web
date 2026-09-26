"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { conversationPending, PendingCall, records, RemoteRecord, RpcMethod, string, WorkbenchClient, WorkbenchError } from "@/lib/control/workbench-client";
import { mergeSnapshots, mergeTurns, pairingAllowsSend } from "@/lib/workspace/workspace-client";
import type { WorkspaceAgent, WorkspaceSubmission, WorkspaceConversationState } from "@/lib/workspace/workspace-types";
import { useWorkspace, workspaceRequest } from "@/components/workspace-provider";
import { useWorkbenchMutations } from "./use-workbench-mutations";
import { createMetadataQueue } from "@/lib/product/metadata-queue";
import { acknowledgeDraft, chooseDraft, draftReadCanRestore, editDraft, type LocalDraft } from "@/lib/product/draft-cache";
import { usePolicyAccess } from "./policy-disclosure";
import { useHydrated } from "@/components/local-time";

export type Connection = { id: string; name: string; urn: string };
type Outcome = { result?: RemoteRecord; error?: WorkbenchError };

async function expectedTurnId(consoleUrn: string, requestId: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${consoleUrn}\0${requestId}`));
  return `turn-${Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
}

export function useWorkbench(agent: Connection, initial: WorkspaceAgent) {
  const hydrated = useHydrated();
  const policyAllowed = usePolicyAccess();
  const { cacheAgent, requestSync, getDraft, saveDraft, error: workspaceError } = useWorkspace();
  const [seed] = useState(() => {
    // The current server seed is authoritative; provider snapshots may predate
    // edits made on another device. Unsaved local drafts are handled separately.
    const saved = initial;
    const id = saved.submission?.conversationId || saved.activeConversationId;
    return { ...saved, activeConversationId: id, activeConversationState: id === saved.activeConversationId ? saved.activeConversationState : undefined, conversation: saved.conversation?.conversation_id === id ? saved.conversation : null };
  });
  const [client] = useState(() => new WorkbenchClient(agent.id));
  const lifecycle = useRef(new AbortController());
  const activeCalls = useRef(new Set<RpcMethod>());
  const sending = useRef(false), savedReadVersion = useRef(0), selecting = useRef(false);
  const selectionVersion = useRef(0);
  const selected = useRef(seed.activeConversationId);
  const resolvedCalls = useRef(new Set<string>());
  const checkedSubmissions = useRef(new Set<string>());
  const hadCapabilities = useRef(!!seed.snapshots.capabilities);
  const timeline = useRef(new Map<string, RemoteRecord>());
  const [identity, setIdentity] = useState(seed.identity);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityError, setIdentityError] = useState("");
  const [pairingOpen, setPairingOpen] = useState(!seed.snapshots.capabilities);
  const [snapshots, setSnapshots] = useState(seed.snapshots);
  const [sync, setSync] = useState(seed.sync);
  const [cacheError, setCacheError] = useState("");
  const [busy, setBusy] = useState<Partial<Record<RpcMethod, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<RpcMethod, WorkbenchError>>>({});
  const [initialDraft] = useState(() => chooseDraft(seed.activeConversationState?.draft || "", getDraft(agent.id + ":" + seed.activeConversationId)));
  const draftCache = useRef(new Map<string, LocalDraft>([[seed.activeConversationId, initialDraft]]));
  const draftDirty = useRef(initialDraft.dirty);
  const draftEpoch = useRef(0);
  const textValue = useRef(initialDraft.text);
  const [text, setTextState] = useState(initialDraft.text);
  const [conversationState, setConversationState] = useState<WorkspaceConversationState>(seed.activeConversationState || {archived:false,readAt:0,draft:"",scrollTop:null});
  const [operations,setOperations] = useState(seed.operations || []);
  const [recordStates,setRecordStates] = useState(seed.recordStates || []);
  const setText = useCallback((value: string | ((previous:string)=>string)) => {
    const nextText = typeof value === "function" ? value(textValue.current) : value;
    const id = selected.current, draft = editDraft(draftCache.current.get(id), nextText);
    draftCache.current.set(id, draft); textValue.current = nextText; draftDirty.current = true; draftEpoch.current++;
    // Preserve edits immediately, including navigation before the debounce fires.
    saveDraft(agent.id + ":" + id, draft); setTextState(nextText);
  }, [agent.id, saveDraft]);
  const [conversationId, setConversationId] = useState(seed.activeConversationId);
  const [conversationInput, setConversationInput] = useState(seed.activeConversationId);
  const [conversationError, setConversationError] = useState("");
  const [conversations, setConversations] = useState(seed.conversations);
  const [currentSnapshot, setCurrentSnapshot] = useState(seed.conversation);
  const [hasEarlierTurns, setHasEarlierTurns] = useState(seed.hasEarlierTurns);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [selectingConversation, setSelectingConversation] = useState(false);
  const [dismissingSubmission, setDismissingSubmission] = useState(false);
  const [submission, setSubmission] = useState<WorkspaceSubmission | null>(() => seed.submission ? { ...seed.submission, phase: "uncertain" } : null);
  const [submittedTurns, setSubmittedTurns] = useState<RemoteRecord[]>([]);
  const composer = useRef<HTMLTextAreaElement>(null);
  const earlierLoaded = useRef(false);
  const workspaceUrl = `/api/agents/${encodeURIComponent(agent.id)}/workspace`;

  const metadataQueue=useRef(createMetadataQueue());
  const saveConversationState = useCallback((patch: Partial<WorkspaceConversationState>, id = selected.current) => metadataQueue.current(id,async () => {
    const data = await workspaceRequest<{state:WorkspaceConversationState}>(workspaceUrl + "/conversations", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({conversationId:id||null,...patch}),signal:lifecycle.current.signal});
    if (!lifecycle.current.signal.aborted && id === selected.current) setConversationState(data.state);
    return data.state;
  }),[workspaceUrl]);
  const persistDraft = useCallback(async (id: string, draft: LocalDraft) => {
    await saveConversationState({ draft: draft.text }, id);
    if (lifecycle.current.signal.aborted) return;
    draftEpoch.current++; // A read started before this save cannot restore pre-save text.
    const current = acknowledgeDraft(draftCache.current.get(id), draft);
    if (current) { draftCache.current.set(id, current); saveDraft(agent.id + ":" + id, current); }
    if (selected.current === id) draftDirty.current = current?.dirty === true;
  }, [agent.id, saveDraft, saveConversationState]);
  const restoreDraft = useCallback((id: string, serverText: string) => {
    const draft = chooseDraft(serverText, draftCache.current.get(id) || getDraft(agent.id + ":" + id));
    draftCache.current.set(id, draft); saveDraft(agent.id + ":" + id, draft);
    draftDirty.current = draft.dirty; textValue.current = draft.text; setTextState(draft.text);
  }, [agent.id, getDraft, saveDraft]);
  useEffect(() => {
    if (selecting.current || selectingConversation || !draftDirty.current) return;
    const id = conversationId, draft = draftCache.current.get(id);
    if (!draft?.dirty) return;
    const timer = setTimeout(() => { void persistDraft(id, draft).catch(error => {
      if (!lifecycle.current.signal.aborted) setConversationError(error.message);
    }); }, 700);
    return () => clearTimeout(timer);
  }, [text, conversationId, selectingConversation, persistDraft]);

  const clearDeletedConversation = useCallback((id: string) => {
    draftCache.current.delete(id); timeline.current.delete(id);
    saveDraft(agent.id + ":" + id, { text: "", dirty: false, revision: 0 });
    setConversations(previous => previous.filter(value => value.id !== id));
    if (selected.current !== id) return;
    selected.current = ""; selectionVersion.current++; draftEpoch.current++;
    earlierLoaded.current = false; draftDirty.current = false; textValue.current = "";
    draftCache.current.set("", { text: "", dirty: false, revision: 0 });
    saveDraft(agent.id + ":", { text: "", dirty: false, revision: 0 });
    setConversationId(""); setConversationInput(""); setTextState("");
    setCurrentSnapshot(null); setHasEarlierTurns(false); setSubmittedTurns([]);
    setConversationState({ archived: false, deleted: false, readAt: 0, draft: "", scrollTop: null });
    setErrors(previous => ({ ...previous, "conversation.get": undefined, "conversation.send": undefined }));
    setConversationError("");
  }, [agent.id, saveDraft]);

  const applyWorkspace = useCallback((data: WorkspaceAgent, version: number, draftRead?: {epoch:number;dirty:boolean}) => {
    cacheAgent(data); setIdentity(data.identity); setSync(data.sync); setConversations(data.conversations); setOperations(data.operations || []); setRecordStates(data.recordStates || []);
    if (version === selectionVersion.current && data.activeConversationId === selected.current && data.activeConversationState?.deleted && selected.current) clearDeletedConversation(selected.current);
    setSnapshots(previous => mergeSnapshots(previous, data.snapshots));
    if (data.snapshots.capabilities && !hadCapabilities.current) { hadCapabilities.current = true; setPairingOpen(false); }
    if (data.conversation) timeline.current.set(string(data.conversation.conversation_id), data.conversation);
    if (version === selectionVersion.current && data.activeConversationId === selected.current) {
      if (data.activeConversationState) {
        setConversationState(data.activeConversationState);
        if (draftRead && !selecting.current && draftReadCanRestore(draftRead, {epoch:draftEpoch.current,dirty:draftDirty.current})) restoreDraft(selected.current, data.activeConversationState.draft);
      }
      if (data.conversation?.conversation_id === selected.current) {
        setCurrentSnapshot(previous => previous?.conversation_id === selected.current
          ? { ...data.conversation, turns: mergeTurns(records(previous.turns), records(data.conversation?.turns)) }
          : data.conversation);
      }
      if (!earlierLoaded.current) setHasEarlierTurns(data.hasEarlierTurns);
    }
    if (!sending.current) {
      setSubmission(previous => {
        if (data.submission && !resolvedCalls.current.has(data.submission.call.request_id)) return { ...data.submission, phase: "uncertain" };
        // Keep a locally ambiguous write until the server has its authenticated turn.
        if (previous && !resolvedCalls.current.has(previous.call.request_id) && !records(data.conversation?.turns).some(turn => turn.turn_id === previous.turnId)) return previous;
        return null;
      });
    }
  }, [cacheAgent, restoreDraft, clearDeletedConversation]);

  const refreshSaved = useCallback(async () => {
    if (lifecycle.current.signal.aborted) return;
    const readVersion = ++savedReadVersion.current;
    const signal = lifecycle.current.signal, version = selectionVersion.current;
    const draftRead = {epoch:draftEpoch.current,dirty:draftDirty.current};
    const query = new URLSearchParams({ conversation_id: selected.current });
    try {
      const data = await workspaceRequest<WorkspaceAgent>(`${workspaceUrl}?${query}`, { signal });
      if (!signal.aborted && readVersion === savedReadVersion.current) { applyWorkspace(data, version, draftRead); setCacheError(""); }
    } catch (error) { if (!signal.aborted && readVersion === savedReadVersion.current) setCacheError(error instanceof Error ? error.message : "暂时无法更新，显示已保存的内容。"); }
  }, [workspaceUrl, applyWorkspace]);

  const afterConversationDeleted = useCallback(async (id: string) => {
    clearDeletedConversation(id);
    await refreshSaved();
    window.dispatchEvent(new CustomEvent("workspace-records-changed", { detail: { agentId: agent.id } }));
  }, [agent.id, clearDeletedConversation, refreshSaved]);

  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    if (seed.conversation) timeline.current.set(string(seed.conversation.conversation_id), seed.conversation);
    let timer: ReturnType<typeof setTimeout>;
    let generation = 0;
    const run = async () => {
      const current = ++generation; clearTimeout(timer);
      await refreshSaved();
      if (!controller.signal.aborted && current === generation) timer = setTimeout(run, document.hidden ? 30000 : 4000);
    };
    void run();
    const resume = () => { void run(); };
    const offline = () => setCacheError("网络已断开，显示已保存的内容。恢复连接后会自动更新。");
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume); window.addEventListener("offline", offline);
    return () => { generation++; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); window.removeEventListener("offline", offline); };
  }, [refreshSaved, seed]);

  const invoke = useCallback(async (method: RpcMethod, params: RemoteRecord = {}, original?: PendingCall): Promise<Outcome> => {
    if (!policyAllowed) return {};
    if (activeCalls.current.has(method)) return {};
    activeCalls.current.add(method);
    const signal = lifecycle.current.signal, call = original || client.prepare(method, params);
    const mutation = ["contacts.add", "approval.respond", "contacts.respond", "messages.send", "inbox.mark_read", "collaboration.execute"].includes(method) && !(method === "collaboration.execute" && call.params.action === "describe");
    setBusy(previous => ({ ...previous, [method]: mutation ? "正在提交，等待 agent 确认…" : "正在读取最新内容…" }));
    setErrors(previous => ({ ...previous, [method]: undefined }));
    try {
      const result = await client.execute(call, signal, () => setBusy(previous => previous[method] === "等待 agent 响应…" ? previous : { ...previous, [method]: "等待 agent 响应…" }));
      if (signal.aborted) return {};
      if (method === "capabilities") { setPairingOpen(false); void requestSync(agent.id); }
      if (method === "conversation.get" && result.conversation_id === selected.current) {
        setCurrentSnapshot(previous => ({ ...result, turns: mergeTurns(previous?.conversation_id === selected.current ? records(previous.turns) : [], records(result.turns)) }));
      }
      if (method === "conversation.get") {
        setSubmission(previous => {
          if (previous && result.conversation_id === previous.conversationId && records(result.turns).some(turn => turn.turn_id === previous.turnId)) {
            resolvedCalls.current.add(previous.call.request_id);
            return null;
          }
          return previous;
        });
      }
      // Success timestamps come from the durable server snapshot, never from a cache read.
      await refreshSaved();
      return { result };
    } catch (error) {
      if (signal.aborted) return {};
      const failure = error instanceof WorkbenchError ? error : new WorkbenchError("请求暂时未能完成。", call, true, mutation);
      setErrors(previous => ({ ...previous, [method]: failure }));
      return { error: failure };
    } finally { activeCalls.current.delete(method); if (!signal.aborted) setBusy(previous => ({ ...previous, [method]: undefined })); }
  }, [agent.id, client, refreshSaved, requestSync, policyAllowed]);

  const capabilitySnapshot = snapshots.capabilities;
  const methods = records(capabilitySnapshot?.data.methods);
  const available = (name: string) => policyAllowed && methods.some(method => method.name === name && method.available === true);
  const canSend = available("conversation.send") && pairingAllowsSend(capabilitySnapshot?.data, sync);
  const canAddContact = available("contacts.add") && pairingAllowsSend(capabilitySnapshot?.data, sync);
  const canRespondApproval = available("approval.respond") && pairingAllowsSend(capabilitySnapshot?.data, sync);
  const canReadCollaboration = available("collaboration.state"), canReadContacts = available("contacts.list");
  const refreshMutations = useCallback(async () => {
    await requestSync(agent.id);
    if (canReadCollaboration) await invoke("collaboration.state");
    else if (canReadContacts) await invoke("contacts.list");
    else await refreshSaved();
  }, [agent.id, requestSync, canReadCollaboration, canReadContacts, invoke, refreshSaved]);
  const mutations = useWorkbenchMutations({ agentId: agent.id, consoleUrn: identity.virtualUrn || "", client, invoke,
    canAddContact, canRespondApproval, canMutate: name => available(name) && pairingAllowsSend(capabilitySnapshot?.data, sync), refresh: refreshMutations, contacts: records(snapshots["contacts.list"]?.data.contacts),
    approvalDecisions: records(snapshots["collaboration.state"]?.data.approval_decisions), requests: records(snapshots["contacts.requests"]?.data.contact_requests ?? snapshots["contacts.requests"]?.data.requests),
    messages: records(snapshots["inbox.list"]?.data.messages), sentMessages: records(snapshots["collaboration.state"]?.data.sent_messages), savedOperations:operations });
  const canReadConversation = available("conversation.get");
  const remoteTurns = currentSnapshot?.conversation_id === conversationId ? records(currentSnapshot.turns) : [];
  const turns = mergeTurns(remoteTurns, submittedTurns.filter(turn => turn.conversation_id === conversationId && !remoteTurns.some(remote => remote.turn_id === turn.turn_id)));
  const watching = conversationPending({ turns }) || !!submission;

  useEffect(() => {
    if (!submission || submission.phase !== "uncertain" || !canReadConversation || checkedSubmissions.current.has(submission.call.request_id)) return;
    checkedSubmissions.current.add(submission.call.request_id);
    // Recovery only reads the deterministic conversation. It never resends a write.
    void invoke("conversation.get", { conversation_id: submission.conversationId });
  }, [submission, canReadConversation, invoke]);

  const reconciled = !!submission?.turnId && remoteTurns.some(turn => turn.turn_id === submission.turnId);
  useEffect(() => {
    if (submission?.phase === "uncertain" && reconciled) {
      resolvedCalls.current.add(submission.call.request_id);
      setSubmission(null); setText(previous => previous.trim() === submission.text ? "" : previous);
      setErrors(previous => ({ ...previous, "conversation.send": undefined }));
    }
  }, [reconciled, submission, setText]);

  async function createIdentity() {
    if (!policyAllowed) return;
    setIdentityBusy(true); setIdentityError("");
    const signal = lifecycle.current.signal;
    try {
      const body = await workspaceRequest<WorkspaceAgent["identity"]>(`/api/agents/${encodeURIComponent(agent.id)}/bind-owner`, { method: "POST", signal });
      if (!signal.aborted) { setIdentity(body); await requestSync(agent.id); await refreshSaved(); }
    } catch (error) { if (!signal.aborted) setIdentityError(error instanceof Error ? error.message : "暂时无法注册控制台身份。"); }
    finally { if (!signal.aborted) setIdentityBusy(false); }
  }

  const identityAttempted = useRef(false);
  useEffect(() => {
    if (policyAllowed && !identity.virtualUrn && !identityAttempted.current) {
      identityAttempted.current = true;
      void createIdentity();
    }
    // Create the console identity once on first binding; a failed registration remains explicitly retryable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.virtualUrn, policyAllowed]);

  async function selectConversation(id: string) {
    if (selecting.current || sending.current || submission) return false;
    selecting.current = true; setSelectingConversation(true); setConversationError("");
    const version = ++selectionVersion.current;
    try { const draft = draftCache.current.get(selected.current); if (draft?.dirty) await persistDraft(selected.current, draft); } catch(error) {setConversationError(error instanceof Error ? error.message : "草稿暂未保存。"); selecting.current=false;setSelectingConversation(false);return false;}
    try {
      const data = await workspaceRequest<WorkspaceAgent>(workspaceUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select_conversation", conversationId: id || null }), signal: lifecycle.current.signal });
      if (!lifecycle.current.signal.aborted && version===selectionVersion.current) {
        if(data.activeConversationId!==id) throw new Error("会话选择结果已更新，请重新打开目标对话。");
        if (data.activeConversationState?.deleted) {
          clearDeletedConversation(id);
          setConversationError("这段聊天已被删除，请先从已删除列表恢复后再打开。");
          return false;
        }
        selected.current=id;earlierLoaded.current=false;
        setConversationId(id);setConversationInput(id);setHasEarlierTurns(false);
        setCurrentSnapshot(timeline.current.get(id) || data.conversation);
        setErrors(previous=>({...previous,"conversation.get":undefined,"conversation.send":undefined}));
        applyWorkspace(data,version);restoreDraft(id, data.activeConversationState?.draft || "");
      }
      return true;
    } catch (error) { if (!lifecycle.current.signal.aborted) setConversationError(error instanceof Error ? error.message : "当前会话选择尚未保存，请恢复网络后重试。"); return false; }
    finally { selecting.current = false; if (!lifecycle.current.signal.aborted) setSelectingConversation(false); }
  }

  async function sendMessage(original?: WorkspaceSubmission) {
    if (!canSend || sending.current || selecting.current || activeCalls.current.has("conversation.send") || (!original && submission)) return;
    const message = original?.text || text.trim();
    if (!message || !identity.virtualUrn) return;
    sending.current = true;
    const call = original?.call || client.prepare("conversation.send", { text: message, ...(conversationId ? { conversation_id: conversationId } : {}) });
    const item: WorkspaceSubmission = { call, text: message, conversationId: string(call.params.conversation_id, call.request_id), turnId: original?.turnId || "", phase: "sending", retryable: true };
    setSubmission(item); setConversationError("");
    try {
      item.turnId = await expectedTurnId(identity.virtualUrn, call.request_id);
      const { result, error } = await invoke("conversation.send", call.params, call);
      if (lifecycle.current.signal.aborted) return;
      if (result && result.status === "submitted" && result.conversation_id === item.conversationId && result.turn_id === item.turnId) {
        resolvedCalls.current.add(call.request_id);
        selected.current = result.conversation_id; selectionVersion.current++;
        setConversationId(result.conversation_id); setConversationInput(result.conversation_id);
        setSubmittedTurns(previous => [...previous.filter(turn => turn.turn_id !== result.turn_id), { ...result, text: message, created_at: Date.now() / 1000 }]);
        setText(previous => previous.trim() === message ? "" : previous); setSubmission(null);
        if (!conversationId) {
          const empty = editDraft(draftCache.current.get(""), ""); draftCache.current.set("", empty); saveDraft(agent.id + ":", empty);
          void persistDraft("", empty).catch(() => {});
        }
        void requestSync(agent.id);
        requestAnimationFrame(() => composer.current?.focus());
      } else if (error && !error.uncertain) { resolvedCalls.current.add(call.request_id); setSubmission(null); }
      else {
        selected.current = item.conversationId; selectionVersion.current++;
        setConversationId(item.conversationId); setConversationInput(item.conversationId);
        setSubmission({ ...item, phase: "uncertain", retryable: error?.retryable ?? false });
        if (result) setConversationError("暂时无法确认这条消息的受理结果，正在读取对话核实。");
      }
    } catch { if (!lifecycle.current.signal.aborted) { setSubmission(null); setConversationError("浏览器暂时无法创建安全请求，请刷新后重试。"); } }
    finally { sending.current = false; void refreshSaved(); }
  }

  function inspectSubmission() {
    if (!submission) return;
    selected.current = submission.conversationId; selectionVersion.current++;
    setConversationId(submission.conversationId); setConversationInput(submission.conversationId);
    setCurrentSnapshot(timeline.current.get(submission.conversationId) || null);
    void invoke("conversation.get", { conversation_id: submission.conversationId });
  }

  async function dismissSubmission() {
    if (!submission || submission.retryable || dismissingSubmission) return;
    const requestId = submission.call.request_id;
    setDismissingSubmission(true); setConversationError("");
    try {
      const data = await workspaceRequest<WorkspaceAgent>(workspaceUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss_submission", requestId }), signal: lifecycle.current.signal });
      if (!lifecycle.current.signal.aborted) {
        resolvedCalls.current.add(requestId); setSubmission(null);
        setErrors(previous => ({ ...previous, "conversation.send": undefined }));
        applyWorkspace(data, selectionVersion.current);
      }
    } catch (error) { if (!lifecycle.current.signal.aborted) setConversationError(error instanceof Error ? error.message : "暂时无法保存这条记录，请稍后重试。"); }
    finally { if (!lifecycle.current.signal.aborted) setDismissingSubmission(false); }
  }

  async function readConversation(id = conversationId) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) { setConversationError("请输入有效的对话 ID（字母、数字或 . _ : -，最长 128 位）。"); return; }
    if (id !== conversationId && !conversations.some(conversation => conversation.id === id)) {
      // A valid remote conversation may predate the account's persisted history.
      const { result } = await invoke("conversation.get", { conversation_id: id });
      if (result) return selectConversation(id);
      return false;
    }
    if (id !== conversationId && !(await selectConversation(id))) return false;
    setConversationError("");
    return !!(await invoke("conversation.get", { conversation_id: id })).result;
  }

  async function loadEarlier() {
    const first = turns[0];
    if (loadingEarlier || !hasEarlierTurns || !first || !conversationId) return;
    setLoadingEarlier(true); setConversationError("");
    const version = selectionVersion.current;
    try {
      const query = new URLSearchParams({ conversation_id: conversationId, before: string(first.turn_id) });
      const data = await workspaceRequest<WorkspaceAgent>(`${workspaceUrl}?${query}`, { signal: lifecycle.current.signal });
      if (!lifecycle.current.signal.aborted && version === selectionVersion.current) {
        earlierLoaded.current = true; setHasEarlierTurns(data.hasEarlierTurns);
        setCurrentSnapshot(previous => ({ ...previous, ...data.conversation, turns: mergeTurns(records(data.conversation?.turns), records(previous?.turns)) }));
      }
    } catch (error) { if (!lifecycle.current.signal.aborted) setConversationError(error instanceof Error ? error.message : "暂时无法读取更早记录。"); }
    finally { if (!lifecycle.current.signal.aborted) setLoadingEarlier(false); }
  }

  function newConversation() { void selectConversation("").then(saved => { if (saved) composer.current?.focus(); }); }
  return { agentId:agent.id, conversationState, saveConversationState, afterConversationDeleted, recordStates, operations, policyAllowed, identity, identityBusy, identityError, createIdentity, pairingOpen, setPairingOpen, snapshots, busy, errors, invoke,
    capabilitySnapshot, methods, available, canSend, canAddContact, canRespondApproval, mutations, canReadConversation, text, setText, composer, conversationId, conversationInput,
    setConversationInput, conversationError, submission, turns, currentSnapshot, watching,
    sendMessage, inspectSubmission, readConversation, newConversation, conversations, selectConversation, selectingConversation,
    hasEarlierTurns, loadingEarlier, loadEarlier, dismissSubmission, dismissingSubmission, sync,
    // The outer provider can report an error before this page hydrates. Its SSR
    // snapshot was empty; local errors and all post-hydration errors stay visible.
    cacheError: cacheError || (hydrated ? workspaceError : ""), refreshSaved };
}

export type Workbench = ReturnType<typeof useWorkbench>;

