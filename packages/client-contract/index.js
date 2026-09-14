"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUTOMATIC_METHODS = exports.SYNC_LEASE_MS = exports.CAPABILITY_INTERVAL_MS = exports.SYNC_INTERVAL_MS = exports.WorkbenchClient = exports.WorkbenchError = exports.RPC_METHODS = exports.PAIRING_ERROR_CODES = exports.STABLE_ID_PATTERN = exports.MAX_CONVERSATION_BYTES = exports.CONTROL_POLL_MS = exports.CONTROL_RETENTION_MS = exports.CONTROL_REQUEST_MS = exports.CONTRACT_VERSION = exports.CONTROL_PROTOCOL = void 0;
exports.remoteTimestamp = remoteTimestamp;
exports.isPairingError = isPairingError;
exports.availableMethods = availableMethods;
exports.record = record;
exports.records = records;
exports.string = string;
exports.strings = strings;
exports.pause = pause;
exports.conversationPending = conversationPending;
exports.conversationSettled = conversationSettled;
exports.mergeSnapshots = mergeSnapshots;
exports.mergeTurns = mergeTurns;
exports.pairingAllowsSend = pairingAllowsSend;
exports.syncReadPlan = syncReadPlan;
exports.syncBackoff = syncBackoff;
exports.nextCycleDelay = nextCycleDelay;
exports.validateControlResponse = validateControlResponse;
exports.canonicalJSON = canonicalJSON;
exports.CONTROL_PROTOCOL = "agent-comm-control/v1";
exports.CONTRACT_VERSION = 1;
exports.CONTROL_REQUEST_MS = 120_000;
exports.CONTROL_RETENTION_MS = 600_000;
exports.CONTROL_POLL_MS = 2_000;
exports.MAX_CONVERSATION_BYTES = 24_000;
exports.STABLE_ID_PATTERN = "^[A-Za-z0-9._:-]{1,128}$";
exports.PAIRING_ERROR_CODES = ["not_paired", "owner_mismatch", "pairing_expired", "pairing_revoked"];
/** Remote numeric times may use seconds or milliseconds; workspace times are already milliseconds. */
function remoteTimestamp(value) {
    return typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;
}
function isPairingError(code) {
    return typeof code === "string" && exports.PAIRING_ERROR_CODES.includes(code);
}
function availableMethods(capabilities) {
    return records(record(capabilities).methods).filter(item => item.available === true && exports.RPC_METHODS.includes(string(item.name))).map(item => item.name);
}
exports.RPC_METHODS = ["capabilities", "contacts.list", "collaboration.state", "inbox.list", "conversation.send", "conversation.get"];
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function records(value) {
    return Array.isArray(value) ? value.filter(item => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
}
function string(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
function strings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
class WorkbenchError extends Error {
    call;
    retryable;
    uncertain;
    constructor(message, call, retryable = true, uncertain = false) {
        super(message);
        this.call = call;
        this.retryable = retryable;
        this.uncertain = uncertain;
        this.name = "WorkbenchError";
    }
}
exports.WorkbenchError = WorkbenchError;
const remoteErrors = {
    not_paired: "这个控制台尚未配对，或本机配对已过期。请在 agent 本机检查授权后重试。",
    owner_mismatch: "本机配对属于另一个 agent 配置，请检查配对时选择的配置。",
    method_not_allowed: "本机配对没有开放这项功能，请检查授权范围后重新读取能力。",
    unsupported_method: "这个 agent 暂不支持这项功能。",
    queue_full: "Agent 正在处理较多消息，请等待已有回合结束。",
    result_too_large: "返回内容过多，请指定一个事项或对话后重新读取。",
};
function pause(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const cancel = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
        signal.addEventListener("abort", cancel, { once: true });
    });
}
/** One in-memory ledger per mounted agent. Ambiguous writes never receive a new ID. */
class WorkbenchClient {
    agentId;
    request;
    wait;
    uuid;
    calls = new Map();
    constructor(agentId, request = (...args) => fetch(...args), wait = pause, uuid = () => crypto.randomUUID()) {
        this.agentId = agentId;
        this.request = request;
        this.wait = wait;
        this.uuid = uuid;
    }
    prepare(method, params = {}) {
        const key = canonicalJSON([method, params]);
        const previous = this.calls.get(key);
        if (previous)
            return previous;
        const call = { request_id: this.uuid(), method, params };
        this.calls.set(key, call);
        return call;
    }
    async execute(call, signal, onPending) {
        const key = canonicalJSON([call.method, call.params]);
        const base = `/api/agents/${encodeURIComponent(this.agentId)}/control`;
        let authenticated = false;
        const read = async (url, init) => {
            const timeout = new AbortController();
            const cancel = () => timeout.abort();
            if (signal.aborted)
                cancel();
            signal.addEventListener("abort", cancel, { once: true });
            const timer = setTimeout(cancel, 30000);
            try {
                const response = await this.request(url, { ...init, signal: timeout.signal });
                const body = record(await response.json());
                if (!response.ok) {
                    const terminal = [400, 401, 403, 404, 410, 413].includes(response.status);
                    // Expired reads can be refreshed. An expired write must first be reconciled.
                    if (terminal && call.method !== "conversation.send")
                        this.calls.delete(key);
                    throw new WorkbenchError(string(body.error, "连接暂时没有响应，请稍后重试。"), call, !terminal, call.method === "conversation.send");
                }
                return body;
            }
            finally {
                clearTimeout(timer);
                signal.removeEventListener("abort", cancel);
            }
        };
        try {
            let body = await read(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(call) });
            for (let attempt = 0; body.status === "pending" && attempt < 65; attempt++) {
                onPending?.();
                await this.wait(exports.CONTROL_POLL_MS, signal);
                body = await read(`${base}?request_id=${encodeURIComponent(call.request_id)}`, { cache: "no-store" });
            }
            if (body.status !== "complete") {
                if (call.method !== "conversation.send" && body.status === "expired")
                    this.calls.delete(key);
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
        }
        catch (error) {
            if (signal.aborted)
                throw new DOMException("Aborted", "AbortError");
            if (error instanceof WorkbenchError)
                throw error;
            throw new WorkbenchError("连接暂时中断。重试会继续查询同一次请求。", call, true, call.method === "conversation.send" && !authenticated);
        }
    }
}
exports.WorkbenchClient = WorkbenchClient;
function conversationPending(result) {
    return records(record(result).turns).some(turn => turn.status === "submitted" || turn.status === "running");
}
function conversationSettled(result, trackedTurnIds) {
    const turns = records(record(result).turns);
    const terminal = new Set(["completed", "failed", "interrupted"]);
    return turns.length > 0 && trackedTurnIds.every(id => turns.some(turn => turn.turn_id === id && terminal.has(string(turn.status)))) &&
        turns.every(turn => terminal.has(string(turn.status)));
}
function mergeSnapshots(previous, incoming) {
    const merged = { ...previous };
    for (const [method, snapshot] of Object.entries(incoming)) {
        if (snapshot && (!merged[method] || snapshot.time >= merged[method].time))
            merged[method] = snapshot;
    }
    return merged;
}
function mergeTurns(earlier, latest) {
    const byId = new Map(earlier.map(turn => [string(turn.turn_id), turn]));
    for (const turn of latest) {
        const id = string(turn.turn_id), saved = byId.get(id);
        // A delayed cache read cannot make a completed turn look pending again.
        const terminal = saved && (["completed", "failed"].includes(string(saved.status)) || saved.status === "interrupted" && saved.locally_unconfirmed !== true);
        if (terminal && ["submitted", "running"].includes(string(turn.status)))
            continue;
        byId.set(id, turn);
    }
    return Array.from(byId.values()).sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0) || string(a.turn_id).localeCompare(string(b.turn_id)));
}
function pairingAllowsSend(capabilities, sync, now = Date.now()) {
    if (sync.status === "needs_pairing")
        return false;
    const expiry = record(capabilities?.pairing).expires_at;
    if (expiry === undefined || expiry === null)
        return true;
    const expiresAt = remoteTimestamp(expiry);
    return Number.isFinite(expiresAt) && expiresAt > now;
}
exports.SYNC_INTERVAL_MS = 30_000;
exports.CAPABILITY_INTERVAL_MS = 120_000;
exports.SYNC_LEASE_MS = 60_000;
exports.AUTOMATIC_METHODS = new Set(["capabilities", "contacts.list", "collaboration.state", "inbox.list", "conversation.get"]);
/** Fixed read-only allowlist: advertised methods can never schedule a write. */
function syncReadPlan(workspace, conversationIds, now) {
    const capability = workspace.snapshots.capabilities;
    const expiry = record(capability?.data.pairing).expires_at;
    const expiresAt = remoteTimestamp(expiry);
    if (!capability || now - capability.time >= exports.CAPABILITY_INTERVAL_MS || (Number.isFinite(expiresAt) && expiresAt <= now) || ["offline", "needs_pairing"].includes(workspace.sync.status)) {
        return [{ method: "capabilities", params: {} }];
    }
    const allowed = new Set(records(capability.data.methods).filter(item => item.available === true).map(item => string(item.name)));
    const plan = [];
    const stale = (method) => now - (workspace.snapshots[method]?.time || 0) >= exports.SYNC_INTERVAL_MS;
    if (allowed.has("collaboration.state")) {
        if (stale("collaboration.state"))
            plan.push({ method: "collaboration.state", params: {} });
    }
    else {
        if (allowed.has("contacts.list") && stale("contacts.list"))
            plan.push({ method: "contacts.list", params: {} });
        if (allowed.has("inbox.list") && stale("inbox.list"))
            plan.push({ method: "inbox.list", params: {} });
    }
    if (allowed.has("conversation.get")) {
        for (const id of Array.from(new Set(conversationIds)).slice(0, 5)) {
            if (/^[A-Za-z0-9._:-]{1,128}$/.test(id))
                plan.push({ method: "conversation.get", params: { conversation_id: id } });
        }
    }
    return plan;
}
function syncBackoff(failures) {
    return Math.min(300_000, 30_000 * 2 ** Math.min(Math.max(failures - 1, 0), 4));
}
function nextCycleDelay(workspace) {
    return workspace.submission || workspace.conversations.some(item => item.pending) ? 5_000 : exports.SYNC_INTERVAL_MS;
}
function validateControlResponse(value, expected) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid control response");
    const response = value;
    const fields = ["protocol", "type", "request_id", "agent_urn", "console_urn", "deadline", "method", "result", "error"];
    if (Object.keys(response).some(key => !fields.includes(key)) || response.protocol !== exports.CONTROL_PROTOCOL || response.type !== "response") {
        throw new Error("Invalid control response protocol");
    }
    for (const key of ["request_id", "agent_urn", "console_urn", "deadline", "method"]) {
        if (response[key] !== expected[key])
            throw new Error(`Control response ${key} does not match request`);
    }
    if (Object.hasOwn(response, "result") === Object.hasOwn(response, "error"))
        throw new Error("Response must contain exactly one result or error");
    if (Object.hasOwn(response, "error")) {
        if (!response.error || typeof response.error !== "object" || Array.isArray(response.error) ||
            typeof response.error.code !== "string" ||
            typeof response.error.message !== "string")
            throw new Error("Invalid control error");
    }
    return response;
}

/** Stable JSON equality for parsed wire values; property order does not identify an action. */
function canonicalJSON(value) {
    const encoded = JSON.stringify(value, (_key, item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    });
    if (encoded === undefined) throw new TypeError("Value is not JSON serializable");
    return encoded;
}
