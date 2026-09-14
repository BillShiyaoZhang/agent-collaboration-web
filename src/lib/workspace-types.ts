import type { PendingCall, RemoteRecord, RpcMethod } from "./workbench-client";

export type WorkspaceSnapshot = { data: RemoteRecord; time: number; requestId?: string };
export type WorkspaceSync = {
  status: "waiting" | "syncing" | "ready" | "offline" | "needs_pairing";
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextSyncAt: number | null;
  error: string | null;
};
export type WorkspaceConnection = {
  id: string; name: string; urn: string; platformRegistered: boolean;
  lastActiveAt: string | null; createdAt: string; sync: WorkspaceSync;
};
export type WorkspaceConversation = { id: string; title: string; updatedAt: number; pending: boolean; turnCount: number };
export type WorkspaceSubmission = {
  call: PendingCall; text: string; conversationId: string; turnId: string;
  phase: "sending" | "uncertain"; retryable: boolean;
};
export type WorkspaceAgent = {
  agent: WorkspaceConnection;
  identity: { virtualUrn: string | null; virtualEd25519PublicKey: string | null };
  sync: WorkspaceSync;
  snapshots: Partial<Record<RpcMethod, WorkspaceSnapshot>>;
  conversations: WorkspaceConversation[];
  activeConversationId: string;
  conversation: RemoteRecord | null;
  hasEarlierTurns: boolean;
  submission: WorkspaceSubmission | null;
};
export type WorkspaceOverview = { connections: WorkspaceConnection[] };
