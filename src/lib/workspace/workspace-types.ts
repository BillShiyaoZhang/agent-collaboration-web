import type { PendingCall, RemoteRecord, WorkspaceAgent as BaseWorkspaceAgent, WorkspaceConversation as BaseWorkspaceConversation } from "@agent-comm/client-contract";
export type { WorkspaceSnapshot, WorkspaceSync, WorkspaceConnection, WorkspaceSubmission, WorkspaceOverview } from "@agent-comm/client-contract";

export type WorkspaceOperation = {
  call: PendingCall;
  phase: "sending" | "uncertain" | "failed" | "succeeded";
  message: string;
  retryable: boolean;
  result?: RemoteRecord;
  reusedContact?: boolean;
  conversationId?: string;
  createdAt: number;
  updatedAt: number;
};
export type WorkspaceConversationState = {
  title?: string;
  archived: boolean;
  readAt: number;
  draft: string;
  scrollTop: number | null;
};
export type WorkspaceConversation = BaseWorkspaceConversation & { archived?: boolean; readAt?: number; unread?: boolean };
export type WorkspaceConversationMatch = { turnId: string; field: "text" | "response"; excerpt: string };
export type WorkspaceConversationPage = {
  items: (WorkspaceConversation & { match?: WorkspaceConversationMatch })[];
  before: string | null;
  hasMore: boolean;
  scope: "saved_account_history";
};
export type WorkspaceAgent = Omit<BaseWorkspaceAgent, "conversations"> & {
  conversations: WorkspaceConversation[];
  operations?: WorkspaceOperation[];
  activeConversationState?: WorkspaceConversationState;
};
