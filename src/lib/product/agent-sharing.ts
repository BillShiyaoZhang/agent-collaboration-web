export type SharingAgent = { id: string; name: string; urn: string };
export type SharingSession = { accountId: string; loginSessionId: string; sessionVersion: number };
export type SharingContext = SharingSession & { origin: string; agent: SharingAgent };
export type SharingGrant = { readonly context: SharingContext; readonly sequence: number };
export const sharingStoppedMessage = "内容共享许可已变化，本次浏览器未继续派发。若原请求已保存，请先核实记录；重新核对并允许共享后，由你明确提交。";

export function contentRequiresSharing(method: string, params: Record<string, unknown> = {}) {
  if (method === "collaboration.execute") return params.action !== "describe";
  // New methods fail closed until their read/safety-only contract is explicitly reviewed.
  return !["capabilities", "contacts.list", "contacts.requests", "collaboration.state", "inbox.list", "inbox.review_preview",
    "attention.list", "conversation.get", "contacts.block", "contacts.unblock", "inbox.mark_read", "inbox.review"].includes(method);
}
const sameAgent = (a: SharingAgent | null, b: SharingAgent) => !!a && a.id === b.id && a.urn === b.urn && a.name === b.name;
const contextKey = (value: SharingContext) => JSON.stringify([value.origin, value.accountId, value.loginSessionId,
  value.sessionVersion, value.agent.id, value.agent.name, value.agent.urn]);

/** One browser document's permission, with no localStorage, cookie or database grant.
 * Session checks cannot recall a request already handed to the network. */
export function createAgentSharingPermission(readSession: () => Promise<SharingSession | null>, origin: () => string,
  changed: () => void = () => {}) {
  let agent: SharingAgent | null = null, context: SharingContext | null = null, grant: SharingGrant | null = null, sequence = 0;
  let selection = 0, verification = 0;
  function revoke() { grant = null; sequence++; changed(); }
  return {
    select(next: SharingAgent) {
      if (sameAgent(agent, next)) return;
      agent = { ...next }; context = null; selection++; verification++; revoke();
    },
    revoke,
    get context() { return context; },
    get grant() { return grant; },
    capture(expected: SharingAgent) { return sameAgent(agent, expected) ? grant : null; },
    allow(displayed: SharingContext) {
      if (!context || contextKey(context) !== contextKey(displayed) || !sameAgent(agent, displayed.agent)) return false;
      grant = { context, sequence: ++sequence }; changed(); return true;
    },
    async verify(expected: SharingAgent): Promise<SharingContext | null> {
      if (!sameAgent(agent, expected)) return null;
      const selected = selection, request = ++verification;
      let session: SharingSession | null;
      try { session = await readSession(); } catch { session = null; }
      if (selected !== selection || request !== verification || !sameAgent(agent, expected)) return null;
      if (!session || !session.accountId || !session.loginSessionId || !Number.isInteger(session.sessionVersion)) {
        context = null; revoke(); return null;
      }
      const current = { ...session, origin: origin(), agent: { ...expected } };
      if (!current.origin || !expected.id || !expected.urn) { context = null; revoke(); return null; }
      if (!context || contextKey(context) !== contextKey(current)) { context = current; revoke(); }
      return context;
    },
    async validate(expected: SharingAgent, captured: SharingGrant) {
      const current = await this.verify(expected);
      return !!current && grant === captured && contextKey(current) === contextKey(captured.context);
    },
  };
}

export type AgentSharingAccess = {
  allowed: boolean;
  error?: string;
  manage: () => Promise<void>;
  request: () => Promise<SharingGrant | null>;
  validate: (grant: SharingGrant) => Promise<boolean>;
};
