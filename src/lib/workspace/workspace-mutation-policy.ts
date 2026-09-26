import type { PendingCall } from "@agent-comm/client-contract";
import { STABLE_ID_PATTERN } from "@agent-comm/client-contract";

const stableId = (value: unknown) => typeof value === "string" && new RegExp(STABLE_ID_PATTERN).test(value);

/** A new transport ID is allowed only for an explicitly rechecked, stable object.
 * An unknown contact add can create a later friend request; execute can create arbitrary effects.
 */
export function canRestartMutation(call: PendingCall): boolean {
  const params = call.params;
  if (call.method === "approval.respond") return stableId(params.approval_id) && ["approve", "deny"].includes(String(params.decision));
  if (call.method === "contacts.respond") return stableId(params.request_id) && ["accept", "reject"].includes(String(params.decision));
  if (call.method === "inbox.mark_read") return stableId(params.message_id);
  if (call.method === "messages.send") return stableId(params.message_id) && typeof params.recipient_urn === "string" &&
    /^urn:[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(params.recipient_urn) &&
    typeof params.text === "string" && params.text.trim().length > 0;
  return false;
}

// Dismissing completed feedback is local presentation only. New authenticated
// uncertainty must remain visible, and the account audit is never deleted.
export function presentedMutationActions<T extends { call: { request_id: string; method: string }; phase: string }>(items: T[], dismissed: ReadonlySet<string>): T[] {
  return items.filter(item => !(item.call.method === "contacts.add" && ["succeeded", "failed"].includes(item.phase) && dismissed.has(item.call.request_id)));
}
