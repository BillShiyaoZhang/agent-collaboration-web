"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { conversationSettled, PendingCall, record, records, RemoteRecord, RpcMethod, string, WorkbenchClient, WorkbenchError } from "@/lib/workbench-client";

export type Connection = { id: string; name: string; urn: string };
type Identity = { virtualUrn: string | null; virtualEd25519PublicKey: string | null };
type Snapshot = { data: RemoteRecord; time: number };
type Submission = { call: PendingCall; text: string; conversationId: string; turnId: string; phase: "sending" | "uncertain"; retryable: boolean };
type Outcome = { result?: RemoteRecord; error?: WorkbenchError };

async function expectedTurnId(consoleUrn: string, requestId: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${consoleUrn}\0${requestId}`));
  return `turn-${Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
}

export function useWorkbench(agent: Connection) {
  const [client] = useState(() => new WorkbenchClient(agent.id));
  const lifecycle = useRef(new AbortController());
  const activeCalls = useRef(new Set<RpcMethod>());
  const sending = useRef(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [identityBusy, setIdentityBusy] = useState(true);
  const [identityError, setIdentityError] = useState("");
  const [pairingOpen, setPairingOpen] = useState(true);
  const [snapshots, setSnapshots] = useState<Partial<Record<RpcMethod, Snapshot>>>({});
  const [busy, setBusy] = useState<Partial<Record<RpcMethod, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<RpcMethod, WorkbenchError>>>({});
  const [text, setText] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [conversationInput, setConversationInput] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [submittedTurns, setSubmittedTurns] = useState<RemoteRecord[]>([]);
  const [watching, setWatching] = useState(false);
  const [watchPaused, setWatchPaused] = useState(false);
  const [watchVersion, setWatchVersion] = useState(0);
  const watchStarted = useRef(0);
  const watchCount = useRef(0);
  const watchedTurnIds = useRef<string[]>([]);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    fetch(`/api/agents/${encodeURIComponent(agent.id)}/bind-owner`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = record(await response.json());
      if (!response.ok) throw new Error(string(body.error, "暂时无法读取控制台身份。"));
      if (!controller.signal.aborted) setIdentity({ virtualUrn: string(body.virtualUrn) || null, virtualEd25519PublicKey: string(body.virtualEd25519PublicKey) || null });
    }).catch(error => { if (!controller.signal.aborted) setIdentityError(error instanceof Error ? error.message : "暂时无法读取控制台身份。"); })
      .finally(() => { if (!controller.signal.aborted) setIdentityBusy(false); });
    return () => controller.abort();
  }, [agent.id]);

  const invoke = useCallback(async (method: RpcMethod, params: RemoteRecord = {}, original?: PendingCall): Promise<Outcome> => {
    if (activeCalls.current.has(method)) return {};
    activeCalls.current.add(method);
    const signal = lifecycle.current.signal, call = original || client.prepare(method, params);
    setBusy(previous => ({ ...previous, [method]: "正在提交请求…" }));
    setErrors(previous => ({ ...previous, [method]: undefined }));
    try {
      const result = await client.execute(call, signal, () => setBusy(previous => previous[method] === "等待 agent 的认证响应…" ? previous : { ...previous, [method]: "等待 agent 的认证响应…" }));
      if (signal.aborted) return {};
      setSnapshots(previous => ({ ...previous, [method]: { data: result, time: Date.now() } }));
      if (method === "capabilities") setPairingOpen(false);
      return { result };
    } catch (error) {
      if (signal.aborted) return {};
      const failure = error instanceof WorkbenchError ? error : new WorkbenchError("请求暂时未能完成。", call);
      setErrors(previous => ({ ...previous, [method]: failure }));
      return { error: failure };
    } finally {
      activeCalls.current.delete(method);
      if (!signal.aborted) setBusy(previous => ({ ...previous, [method]: undefined }));
    }
  }, [client]);

  const capabilitySnapshot = snapshots.capabilities;
  const methods = records(capabilitySnapshot?.data.methods);
  const available = (name: string) => methods.some(method => method.name === name && method.available === true);
  const canSend = available("conversation.send"), canReadConversation = available("conversation.get");
  const currentSnapshot = snapshots["conversation.get"]?.data;
  const remoteTurns = currentSnapshot?.conversation_id === conversationId ? records(currentSnapshot.turns) : [];
  const turns = [...remoteTurns, ...submittedTurns.filter(turn => turn.conversation_id === conversationId && !remoteTurns.some(remote => remote.turn_id === turn.turn_id))];

  function startWatching(turnIds?: string[]) {
    if (turnIds) watchedTurnIds.current = turnIds;
    watchStarted.current = Date.now(); watchCount.current = 0;
    setWatchPaused(false); setWatching(true); setWatchVersion(previous => previous + 1);
  }

  useEffect(() => {
    if (!watching || !conversationId || !canReadConversation || busy["conversation.get"] || errors["conversation.get"]) return;
    if (Date.now() - watchStarted.current > 8 * 60 * 1000 || watchCount.current >= 20) {
      setWatching(false); setWatchPaused(true); return;
    }
    const timer = setTimeout(() => {
      if (document.hidden) { setWatchVersion(previous => previous + 1); return; }
      watchCount.current++;
      void invoke("conversation.get", { conversation_id: conversationId }).then(({ result }) => {
        if (!result) { setWatching(false); return; }
        // Older completed turns cannot settle a newer or uncertain submission.
        if (conversationSettled(result, watchedTurnIds.current)) setWatching(false);
        setWatchVersion(previous => previous + 1);
      });
    }, watchCount.current === 0 ? 800 : watchCount.current < 4 ? 5000 : watchCount.current < 10 ? 15000 : 30000);
    return () => clearTimeout(timer);
  }, [watching, conversationId, canReadConversation, busy, errors, invoke, watchVersion]);

  const reconciled = !!submission?.turnId && remoteTurns.some(turn => turn.turn_id === submission.turnId);
  useEffect(() => {
    if (submission?.phase === "uncertain" && reconciled) {
      setSubmission(null); setText(previous => previous.trim() === submission.text ? "" : previous);
      setErrors(previous => ({ ...previous, "conversation.send": undefined }));
    }
  }, [reconciled, submission]);

  async function createIdentity() {
    setIdentityBusy(true); setIdentityError("");
    const signal = lifecycle.current.signal;
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/bind-owner`, { method: "POST", signal });
      const body = record(await response.json());
      if (!response.ok) throw new Error(string(body.error, "暂时无法注册控制台身份。"));
      if (!signal.aborted) setIdentity({ virtualUrn: string(body.virtualUrn) || null, virtualEd25519PublicKey: string(body.virtualEd25519PublicKey) || null });
    } catch (error) { if (!signal.aborted) setIdentityError(error instanceof Error ? error.message : "暂时无法注册控制台身份。"); }
    finally { if (!signal.aborted) setIdentityBusy(false); }
  }

  async function sendMessage(original?: Submission) {
    if (sending.current || activeCalls.current.has("conversation.send") || (!original && submission)) return;
    const message = original?.text || text.trim();
    if (!message || !identity?.virtualUrn) return;
    sending.current = true;
    const call = original?.call || client.prepare("conversation.send", { text: message, ...(conversationId ? { conversation_id: conversationId } : {}) });
    const initial: Submission = { call, text: message, conversationId: string(call.params.conversation_id, call.request_id), turnId: original?.turnId || "", phase: "sending", retryable: true };
    setSubmission(initial); setConversationError("");
    try {
      const item = { ...initial, turnId: await expectedTurnId(identity.virtualUrn, call.request_id) };
      const { result, error } = await invoke("conversation.send", call.params, call);
      if (lifecycle.current.signal.aborted) return;
      if (result && result.status === "submitted" && typeof result.conversation_id === "string" && typeof result.turn_id === "string") {
        setConversationId(result.conversation_id); setConversationInput(result.conversation_id);
        setSubmittedTurns(previous => [...previous.filter(turn => turn.turn_id !== result.turn_id), { ...result, text: message, created_at: Date.now() / 1000 }]);
        setText(previous => previous.trim() === message ? "" : previous); setSubmission(null);
        if (canReadConversation) startWatching([result.turn_id]);
        requestAnimationFrame(() => composer.current?.focus());
      } else if (error && !error.uncertain) {
        setSubmission(null);
      } else {
        setSubmission({ ...item, phase: "uncertain", retryable: error?.retryable ?? false });
        if (result) setConversationError("响应未提供有效的回合编号，请先读取对话核实结果。");
      }
    } catch {
      if (!lifecycle.current.signal.aborted) { setSubmission(null); setConversationError("浏览器暂时无法创建安全请求，请刷新后重试。"); }
    } finally { sending.current = false; }
  }

  function inspectSubmission() {
    if (!submission) return;
    setConversationId(submission.conversationId); setConversationInput(submission.conversationId);
    setErrors(previous => ({ ...previous, "conversation.get": undefined }));
    startWatching([submission.turnId]);
  }

  async function readConversation(id = conversationId) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) { setConversationError("请输入有效的对话 ID（字母、数字或 . _ : -，最长 128 位）。"); return; }
    if (activeCalls.current.has("conversation.get")) return;
    setConversationError(""); setWatching(false); setWatchPaused(false); setConversationId(id); setConversationInput(id);
    const { result } = await invoke("conversation.get", { conversation_id: id });
    if (result) {
      const readTurns = records(result.turns);
      const pendingIds = readTurns.filter(turn => turn.status === "submitted" || turn.status === "running").map(turn => string(turn.turn_id));
      const missingIds = submittedTurns.filter(turn => turn.conversation_id === id && !readTurns.some(remote => remote.turn_id === turn.turn_id)).map(turn => string(turn.turn_id));
      if (pendingIds.length || missingIds.length) startWatching([...pendingIds, ...missingIds]);
    }
  }

  function newConversation() {
    if (submission || activeCalls.current.has("conversation.get") || sending.current) return;
    setWatching(false); setWatchPaused(false); setConversationId(""); setConversationInput(""); setSubmittedTurns([]); setConversationError("");
    setErrors(previous => ({ ...previous, "conversation.get": undefined, "conversation.send": undefined }));
    composer.current?.focus();
  }

  return { identity, identityBusy, identityError, createIdentity, pairingOpen, setPairingOpen, snapshots, busy, errors, invoke,
    capabilitySnapshot, methods, available, canSend, canReadConversation, text, setText, composer, conversationId, conversationInput,
    setConversationInput, conversationError, submission, turns, currentSnapshot, watching, watchPaused, startWatching,
    sendMessage, inspectSubmission, readConversation, newConversation };
}

export type Workbench = ReturnType<typeof useWorkbench>;
