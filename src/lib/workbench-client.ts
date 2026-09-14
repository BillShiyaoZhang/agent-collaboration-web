export type RpcMethod = "capabilities" | "contacts.list" | "collaboration.state" | "inbox.list" | "conversation.send" | "conversation.get";
export type RemoteRecord = Record<string, unknown>;
export type PendingCall = { request_id: string; method: RpcMethod; params: RemoteRecord };

export function record(value: unknown): RemoteRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RemoteRecord : {};
}
export function records(value: unknown): RemoteRecord[] {
  return Array.isArray(value) ? value.filter(item => item !== null && typeof item === "object" && !Array.isArray(item)) as RemoteRecord[] : [];
}
export function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export class WorkbenchError extends Error {
  constructor(message: string, public readonly call: PendingCall, public readonly retryable = true, public readonly uncertain = false) {
    super(message);
    this.name = "WorkbenchError";
  }
}

const remoteErrors: Record<string, string> = {
  not_paired: "这个控制台尚未配对，或本机配对已过期。请在 agent 本机检查授权后重试。",
  owner_mismatch: "本机配对属于另一个 agent 配置，请检查配对时选择的配置。",
  method_not_allowed: "本机配对没有开放这项功能，请检查授权范围后重新读取能力。",
  unsupported_method: "这个 agent 暂不支持这项功能。",
  queue_full: "Agent 正在处理较多消息，请等待已有回合结束。",
  result_too_large: "返回内容过多，请指定一个事项或对话后重新读取。",
};

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const cancel = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** One in-memory ledger per mounted agent. Ambiguous writes never receive a new ID. */
export class WorkbenchClient {
  private calls = new Map<string, PendingCall>();
  constructor(private readonly agentId: string, private readonly request: typeof fetch = (...args) => fetch(...args),
    private readonly wait = pause, private readonly uuid = () => crypto.randomUUID()) {}

  prepare(method: RpcMethod, params: RemoteRecord = {}): PendingCall {
    const key = JSON.stringify([method, params]);
    const previous = this.calls.get(key);
    if (previous) return previous;
    const call = { request_id: this.uuid(), method, params };
    this.calls.set(key, call);
    return call;
  }

  async execute(call: PendingCall, signal: AbortSignal, onPending?: () => void): Promise<RemoteRecord> {
    const key = JSON.stringify([call.method, call.params]);
    const base = `/api/agents/${encodeURIComponent(this.agentId)}/control`;
    let authenticated = false;
    const read = async (url: string, init: RequestInit) => {
      const timeout = new AbortController();
      const cancel = () => timeout.abort();
      if (signal.aborted) cancel();
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, 30000);
      try {
        const response = await this.request(url, { ...init, signal: timeout.signal });
        const body = record(await response.json());
        if (!response.ok) {
          const terminal = [400, 401, 403, 404, 410, 413].includes(response.status);
          // Expired reads can be refreshed. An expired write must first be reconciled.
          if (terminal && call.method !== "conversation.send") this.calls.delete(key);
          throw new WorkbenchError(string(body.error, "连接暂时没有响应，请稍后重试。"), call, !terminal, call.method === "conversation.send");
        }
        return body;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      }
    };
    try {
      let body = await read(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(call) });
      for (let attempt = 0; body.status === "pending" && attempt < 65; attempt++) {
        onPending?.();
        await this.wait(2000, signal);
        body = await read(`${base}?request_id=${encodeURIComponent(call.request_id)}`, { cache: "no-store" });
      }
      if (body.status !== "complete") {
        if (call.method !== "conversation.send" && body.status === "expired") this.calls.delete(key);
        throw new WorkbenchError("尚未收到 agent 的有效响应。请检查本机配对、agent 和 helper 状态；已提交的动作可能仍在处理。", call, body.status !== "expired", call.method === "conversation.send");
      }
      const response = record(body.response);
      if (body.request_id !== call.request_id || response.request_id !== call.request_id || response.method !== call.method ||
          (Object.hasOwn(response, "result") === Object.hasOwn(response, "error"))) {
        throw new WorkbenchError("返回内容与本次请求不匹配，尚不能确认结果。", call, true, call.method === "conversation.send");
      }
      authenticated = true;
      this.calls.delete(key);
      if (response.error) {
        const error = record(response.error), code = string(error.code);
        throw new WorkbenchError(remoteErrors[code] || string(error.message, "Agent 未能完成这次请求。"), call, false, false);
      }
      return record(response.result);
    } catch (error) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError("连接暂时中断。重试会继续查询同一次请求。", call, true, call.method === "conversation.send" && !authenticated);
    }
  }
}

export function conversationPending(result: unknown): boolean {
  return records(record(result).turns).some(turn => turn.status === "submitted" || turn.status === "running");
}

export function conversationSettled(result: unknown, trackedTurnIds: readonly string[]): boolean {
  const turns = records(record(result).turns);
  const terminal = new Set(["completed", "failed", "interrupted"]);
  return turns.length > 0 && trackedTurnIds.every(id => turns.some(turn => turn.turn_id === id && terminal.has(string(turn.status)))) &&
    turns.every(turn => terminal.has(string(turn.status)));
}

export function displayTime(value: unknown): string {
  const date = typeof value === "number" ? new Date(value * 1000) : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
}

export function stateLabel(value: unknown): string {
  const status = string(value);
  return ({ submitted: "等待处理", running: "处理中", completed: "本回合已完成", failed: "处理失败", interrupted: "结果待核实", pending: "待确认", presenting: "等待本机确认", expired: "已过期", active: "已授权", revoked: "已撤销", ready: "准备发送", sending: "正在投递", accepted: "本机队列已接收", awaiting_approval: "待确认", denied: "已拒绝", approved: "已确认" } as Record<string, string>)[status] || status || "未提供状态";
}
