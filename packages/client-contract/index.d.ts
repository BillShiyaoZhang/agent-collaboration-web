export declare const CONTROL_PROTOCOL = "agent-comm-control/v1";
export declare const CONTRACT_VERSION = 1;
export declare const CONTROL_REQUEST_MS = 120000;
export declare const CONTROL_RETENTION_MS = 600000;
export declare const CONTROL_POLL_MS = 2000;
export declare const MAX_CONVERSATION_BYTES = 24000;
export declare const STABLE_ID_PATTERN = "^[A-Za-z0-9._:-]{1,128}$";
export declare const PAIRING_ERROR_CODES: readonly ["not_paired", "owner_mismatch", "pairing_expired", "pairing_revoked"];
export type SyncPlanItem = {
    method: string;
    params: RemoteRecord;
};
/** Remote numeric times may use seconds or milliseconds; workspace times are already milliseconds. */
export declare function remoteTimestamp(value: unknown): number;
export declare function isPairingError(code: unknown): boolean;
export declare function availableMethods(capabilities: unknown): RpcMethod[];
export declare const RPC_METHODS: readonly ["capabilities", "contacts.list", "collaboration.state", "inbox.list", "conversation.send", "conversation.get", "attention.list"];
export type RpcMethod = typeof RPC_METHODS[number];
export type RemoteRecord = Record<string, unknown>;
export type PendingCall = {
    request_id: string;
    method: RpcMethod;
    params: RemoteRecord;
};
export declare function record(value: unknown): RemoteRecord;
export declare function records(value: unknown): RemoteRecord[];
export declare function string(value: unknown, fallback?: string): string;
export declare function strings(value: unknown): string[];
export declare class WorkbenchError extends Error {
    readonly call: PendingCall;
    readonly retryable: boolean;
    readonly uncertain: boolean;
    constructor(message: string, call: PendingCall, retryable?: boolean, uncertain?: boolean);
}
export declare function pause(ms: number, signal: AbortSignal): Promise<void>;
/** One in-memory ledger per mounted agent. Ambiguous writes never receive a new ID. */
export declare class WorkbenchClient {
    private readonly agentId;
    private readonly request;
    private readonly wait;
    private readonly uuid;
    private calls;
    constructor(agentId: string, request?: typeof fetch, wait?: typeof pause, uuid?: () => string);
    prepare(method: RpcMethod, params?: RemoteRecord): PendingCall;
    execute(call: PendingCall, signal: AbortSignal, onPending?: () => void): Promise<RemoteRecord>;
}
export declare function conversationPending(result: unknown): boolean;
export declare function conversationSettled(result: unknown, trackedTurnIds: readonly string[]): boolean;
export type WorkspaceSnapshot = {
    data: RemoteRecord;
    time: number;
    requestId?: string;
};
export type WorkspaceSync = {
    status: "waiting" | "syncing" | "ready" | "offline" | "needs_pairing";
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    nextSyncAt: number | null;
    error: string | null;
};
export type WorkspaceConnection = {
    id: string;
    name: string;
    urn: string;
    platformRegistered: boolean;
    lastActiveAt: string | null;
    createdAt: string;
    sync: WorkspaceSync;
};
export type WorkspaceConversation = {
    id: string;
    title: string;
    updatedAt: number;
    pending: boolean;
    turnCount: number;
};
export type WorkspaceSubmission = {
    call: PendingCall;
    text: string;
    conversationId: string;
    turnId: string;
    phase: "sending" | "uncertain";
    retryable: boolean;
};
export type WorkspaceAgent = {
    agent: WorkspaceConnection;
    identity: {
        virtualUrn: string | null;
        virtualEd25519PublicKey: string | null;
    };
    sync: WorkspaceSync;
    snapshots: Partial<Record<RpcMethod, WorkspaceSnapshot>>;
    conversations: WorkspaceConversation[];
    activeConversationId: string;
    conversation: RemoteRecord | null;
    hasEarlierTurns: boolean;
    submission: WorkspaceSubmission | null;
};
export type WorkspaceOverview = {
    connections: WorkspaceConnection[];
    notifications?: { unread: number; pending: number };
};
export declare function mergeSnapshots<T extends Partial<Record<string, WorkspaceSnapshot>>>(previous: T, incoming: T): T;
export declare function mergeTurns(earlier: RemoteRecord[], latest: RemoteRecord[]): RemoteRecord[];
export declare function pairingAllowsSend(capabilities: RemoteRecord | undefined, sync: WorkspaceSync, now?: number): boolean;
export declare const SYNC_INTERVAL_MS = 30000;
export declare const CAPABILITY_INTERVAL_MS = 120000;
export declare const SYNC_LEASE_MS = 60000;
export declare const AUTOMATIC_METHODS: Set<string>;
/** Fixed read-only allowlist: advertised methods can never schedule a write. */
export declare function syncReadPlan(workspace: WorkspaceAgent, conversationIds: string[], now: number): SyncPlanItem[];
export declare function syncBackoff(failures: number): number;
export declare function nextCycleDelay(workspace: WorkspaceAgent): number;
export type ControlRequestBody = {
    protocol: typeof CONTROL_PROTOCOL;
    type: "request";
    request_id: string;
    agent_urn: string;
    console_urn: string;
    deadline: string;
    method: string;
    params: Record<string, unknown>;
};
export declare function validateControlResponse(value: unknown, expected: Omit<ControlRequestBody, "params" | "type" | "protocol">): Record<string, unknown>;

/** Stable JSON equality for parsed wire values; property order does not identify an action. */
export declare function canonicalJSON(value: unknown): string;

export type AttentionItem = {
    attention_id: string; kind: string; subject_id: string; task_id?: string;
    source_revision: string | number; revision: number;
    state: "open" | "resolved" | "superseded" | "expired";
    title: string; safe_summary: string; target: { kind: "task" | "inbox" | "approval"; id: string };
    created_at: number; updated_at: number; expires_at?: number | null;
};
export type AttentionPage = { schema: "agent-comm-attention/v1"; items: AttentionItem[]; cursor: number; has_more: boolean };
export declare function validateAttentionPage(value: unknown): AttentionPage;
export declare function attentionRequiresAction(kind: string, state: string): boolean;
export declare function notificationRoute(agentId: string, target: AttentionItem["target"]): string;
export type WorkspaceNotification = {
    id: string; agentId: string; agentName: string; revision: number; unread: boolean; requiresAction: boolean;
    kind: string; state: AttentionItem["state"]; title: string; summary: string;
    target: AttentionItem["target"]; href: string; updatedAt: number; observedAt: number; expiresAt: number | null;
    systemEligible: boolean; source: "attention" | "snapshot"; sync: WorkspaceSync;
};
export type NotificationPage = { items: WorkspaceNotification[]; unread: number; pending: number; before: number | null; hasMore: boolean };
