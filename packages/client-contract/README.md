# @agent-comm/client-contract

`0.1.0` contains the framework-independent behavior used by the Web workbench and its backend synchronization worker. It has **no runtime dependencies** and runs without React, Next.js, Prisma, local storage, Node crypto, or a build step. The package ships CommonJS JavaScript and TypeScript declarations; a browser bundler can import its named exports. `contract.schema.json` and `fixtures/` are the equivalent integration boundary for Swift, Kotlin, Rust, or other clients.

This package is an extraction of the existing production code. `index.js` is the maintained implementation and `index.d.ts` is its public type surface. Changes to protocol behavior should update the schema, fixtures, declarations and conformance tests together. Contract v1 preserves extension fields in remote result objects; clients should retain unfamiliar fields and render only capabilities they understand.

## Use in JavaScript / TypeScript

Within this repository npm workspaces links the package automatically after `npm ci`. To use it from a separate project, install the local package path or run `npm pack --workspace @agent-comm/client-contract` and install the resulting tarball. Publication to a registry is a separate release action.

```ts
import {
  WorkbenchClient, WorkbenchError, availableMethods,
  pairingAllowsSend, mergeSnapshots, mergeTurns,
  type WorkspaceAgent,
} from "@agent-comm/client-contract";

const client = new WorkbenchClient("saved-agent-id");
const call = client.prepare("conversation.send", {
  text: "Summarize today's progress",
  conversation_id: "chat-1",
});
try {
  const acknowledgement = await client.execute(call, new AbortController().signal);
  // acknowledgement.status === "submitted" means queued. Read the conversation
  // until this acknowledgement.turn_id has a terminal result.
} catch (error) {
  if (error instanceof WorkbenchError && error.uncertain) {
    // Keep the original call. Reconcile before considering a new request ID.
  }
}
```

`WorkbenchClient` accepts injected `fetch`, `wait` and UUID functions. Browser defaults use relative BFF URLs and the existing same-origin cookie session. A desktop/Node adapter must resolve those paths against the trusted configured server and supply its authenticated cookie transport and exact `Origin` for mutations. The shared client does not acquire credentials or persist a session. Existing Chinese error text is retained for Web compatibility; native views should map structured transport/RPC errors into their own localization.

| Export | Responsibility |
| --- | --- |
| `RpcMethod`, `PendingCall`, `WorkspaceAgent`, related types | Exact JSON field names and optional/null fields |
| `WorkbenchClient`, `WorkbenchError` | Stable IDs, uncertain-write retry, polling, cancellation, response correlation |
| `validateControlResponse` | Full control envelope field correlation and result/error exclusivity; cryptographic verification remains the transport's responsibility |
| `canonicalJSON` | Stable semantic comparison of JSON object keys without changing array order or payload values |
| `mergeSnapshots`, `mergeTurns` | Preserve fresh snapshots, loaded history and terminal turns during delayed responses |
| `pairingAllowsSend`, `availableMethods`, `isPairingError` | Expiry and explicit capability gating |
| `syncReadPlan`, `syncBackoff`, `nextCycleDelay` | Fixed read-only scheduling policy and offline backoff |
| `CONTROL_*`, `RPC_METHODS`, `STABLE_ID_PATTERN` | Shared protocol version, method allowlist, timing and stable ID constraints |

A workspace synchronization worker uses `syncReadPlan`; clients of the Web BFF normally read its durable workspace instead of duplicating those remote calls. Backend leases, encrypted database storage, NextAuth, and envelope signing stay in their server-specific modules.

## HTTP integration contract

All routes below are relative to the configured Web console origin. The account's NextAuth cookie selects the user, and the saved connection ID selects the target agent. Control POST bodies never accept an overriding user ID or URN.

Authentication is the existing NextAuth credentials flow: GET `/api/auth/csrf`, retain its cookies, then POST URL-encoded `csrfToken`, `email`, `password`, `callbackUrl`, and `json=true` to `/api/auth/callback/credentials`, retaining returned session cookies. Verify with GET `/api/auth/session`; a callback JSON body alone is not proof of login. All mutating application requests must include `Origin` matching the public origin configured in `NEXTAUTH_URL`, including from native clients. There is no bearer-token API. Native session/cookie persistence must be isolated per server/account; a sign-out should call the existing CSRF-protected NextAuth sign-out endpoint and clear local session state.

| Route | Input | Result |
| --- | --- | --- |
| GET `/api/workspace` | — | `{connections: WorkspaceConnection[]}` |
| GET `/api/agents/:id/workspace` | Optional `conversation_id`, `before` query | `WorkspaceAgent`, persisted account content plus sync status |
| POST `/api/agents/:id/workspace` | `{action:"select_conversation",conversationId:string|null}` or `{action:"dismiss_submission",requestId:UUID}` | Updated `WorkspaceAgent` |
| POST `/api/workspace/sync` | `{agentId?:string}` | `202 {scheduled:true}`; schedules reads, no model invocation |
| POST `/api/agents` | `{name,urn}` | `201` saved connection after registry identity verification |
| GET `/api/agents/:id/bind-owner` | — | Public console identity or null fields |
| POST `/api/agents/:id/bind-owner` | Empty body | Registers/retries the existing console identity; local pairing is still required |
| POST `/api/agents/:id/control` | `{request_id:UUID,method,params:{}}` | `202 pending` or `200 complete` receipt |
| GET `/api/agents/:id/control` | Required `request_id` query | `pending`, `expired`, or `complete` receipt |

Workspace mutation bodies are strict and limited to 4,096 UTF-8 bytes. Control POST bodies are strict and limited to 32,768 bytes. The server accepts omitted control `params` as `{}`; canonical clients always send the field. API failures return `{error:string}` with a non-2xx status. A successful HTTP response containing a correlated remote `error` is still a failed RPC.

### Conversations and pagination

`conversation.send` accepts only nonblank `text` (at most 24,000 UTF-8 bytes) and optional `conversation_id`. If omitted, the conversation ID is the request ID. `conversation.get` accepts only `conversation_id`; it does not accept `turn_id`. Track the acknowledged turn ID locally. `submitted` and `running` are pending; `completed`, `failed`, and `interrupted` are terminal. An older completed turn or an empty result cannot settle a newly submitted turn.

On workspace GET, omit `conversation_id` to restore the server's selected conversation. An explicit `conversation_id=` requests a new/empty conversation; do not discard that empty query value. Send `before=<earliest-loaded-turn-id>` with the conversation ID to retrieve up to 100 earlier saved turns. Merge pages by turn ID and retain newer terminal state. `hasEarlierTurns` determines whether another page exists. The workspace conversations list includes up to 50 saved conversations; each conversation's raw history remains server-persisted.

The `submission` field restores an unresolved send after a process restart. Keep its exact `call` and text. `dismiss_submission` removes the unresolved-send blocker but preserves the text as locally unconfirmed history; it does not cancel execution on the agent.

### Control receipts, pairing and synchronization

A pending receipt proves transport admission only. Completed receipts have matching outer and inner `request_id`, matching `method`, and exactly one `result` or `error`. Before returning completion, the BFF verifies the signed encrypted response and correlates protocol, type, both URNs, request ID, method, deadline and reply metadata. Direct helper/SDK implementations must perform the same cryptographic checks themselves; this JSON package is not a replacement for them.

The request deadline is 120 seconds and encrypted delivery cache retention is 10 minutes. Retry an uncertain mutation with the same ID and byte-equivalent parameters. Expired/404/410 write cache is not evidence that the action failed: reconcile through the durable workspace/conversation and require a new user intent before issuing another ID. Successful read snapshots never imply that the agent is currently online.

`capabilities.methods[].available` must be exactly `true`. An advertised custom method or write cannot be scheduled automatically. `collaboration.state` replaces separate contacts/inbox reads when available. The normal sync interval is 30 seconds, capabilities refresh every 120 seconds, pending conversations every 5 seconds; offline failures back off from 30 seconds to 5 minutes. Pairing errors `not_paired`, `owner_mismatch`, `pairing_expired`, and `pairing_revoked` retain cached data and require authorization on the agent's local host.

`policy_paused` means Web account consent is pending or subsequent control/sync was paused. `policy_unavailable` means the signed policy or managed console enrollment could not be verified. These states retain cached data and never imply that the agent needs re-pairing. Explicit confirmation or resume wakes existing connections; the first recovered read checks `capabilities` again.

### Explicit Web actions

New agent versions can separately grant `contacts.add` and `approval.respond` in local pairing. Existing pairings gain no permissions automatically. Both methods require an explicit user action and are excluded from every automatic sync plan.

- `contacts.add`: `{ contact_id, aliases, urn }`. The user confirms the displayed name/address binding; the local agent sends a friendship request through its persistent outbox. Returns `{ decision: "allow", status: "requested" | "already_requested" | "already_connected", contact, request_id? }`. A new request is pending until the peer accepts.
- `approval.respond`: `{ approval_id, decision: "approve" | "deny" }`. Display the complete agent-provided question before submitting. The immutable approval ID binds the question, owner and payload; the agent revalidates the owner, task version, expiry and current decision. Returns `{ approval_id, decision: "allow" | "deny", status: "approved_once" | "denied" }`. An expired presentation lease can be renewed by an explicit decision, while the underlying task's expiry remains enforced.

Preserve the original request ID and parameters after an uncertain result. A successful receipt schedules fresh agent reads; it does not fabricate contact or approval snapshots. Snapshot `sourceAt` is the read request's creation time in milliseconds, so a read already in flight before a mutation receipt is refreshed again. `collaboration.state.approval_decisions` supplies explicit terminal decisions for clients without `attention.list`; missing records alone never resolve a notification. Native confirmation and Web confirmation share the same agent state and cannot overwrite an already completed decision.

**Time units:** workspace snapshot `time`, conversation `updatedAt`, and sync times are Unix **milliseconds**. Raw remote turn timestamps are Unix **seconds**. Connection times, control deadlines and pairing expiry use RFC 3339 strings. `remoteTimestamp` and `pairingAllowsSend` additionally tolerate legacy numeric pairing timestamps in seconds or milliseconds; invalid expiry cannot authorize sending.

## Cross-client retries and rollout

The BFF now hashes canonical JSON for new request fingerprints and compares persisted submission bodies without depending on object key order. A request restored by another language can therefore preserve its ID and values even if that language encodes dictionary keys in a different order. Identity, request ID, method, text and conversation remain bound. The retry still sends the originally persisted ciphertext and keeps its original deadline.

Existing ten-minute delivery-cache records require no database rewrite: the BFF recognizes both legacy key orders for valid two-field `conversation.send` parameters (`text` and `conversation_id`), plus the original incoming order. Unknown extra fields or changed values do not qualify for this compatibility fallback. Existing encrypted workspace submissions are compared canonically after decryption.

**Deployment requirement:** this backend correction takes effect only after rebuilding and deploying the updated Web service to every serving replica. Merely updating iOS or copying the package does not change a currently running BFF. The iOS adapter retains Web's historical `text`-then-`conversation_id` wire order to interoperate with the existing deployment; general key-order-independent recovery requires the updated BFF. This change does not require clearing request caches, rotating identity keys, or deleting workspace data. Current online release records do not imply this working-tree change has been deployed.

## Conformance fixtures and testing

### Attention and notification additions

`attention.list` is an additional **read-only** RPC and must be explicitly available in the agent's actual pairing. It accepts `{after?: nonnegativeSafeInteger, limit?: 1..100}` and returns `AttentionPage` (`agent-comm-attention/v1`). Times are seconds; `revision` and `cursor` are safe integers. Each page contains latest item states, including `resolved`, `superseded`, and `expired`, rather than instructions to delete missing items. `validateAttentionPage` checks bounded fields before persistence. `syncReadPlan` resumes the saved cursor and drains `has_more` pages; facts and the automatic worker's cursor commit together. An arbitrary manual read cannot advance that continuation.

`GET /api/notifications?filter=all|unread|pending&before=<sequence>` returns `NotificationPage` with up to 50 records and account-wide counts. Web notification times are milliseconds. `POST /api/notifications` accepts `{action:"read",agentId,id,revision}` or `{action:"claim",agentId,id,revision,deviceId:UUID}`; it requires the authenticated account and exact same Origin. A read acknowledges only that version; it never approves or resolves the source item. A device claim coordinates attempts between tabs and does not prove display or readership. Payloads are encrypted per account/connection. The browser explicitly requests device notification permission; closed-page Push is not implemented.

Schema/types and `fixtures/attention-page.json` cover the new feed. Apply the additive `prisma/remote-console.sql` migration before starting the new Web build; preserve existing storage keys and records. Existing pairings remain unchanged. These source changes require a new release and do not imply the public service or downloadable packages already include them.

`fixtures/workspace-agent.json` deliberately contains Unicode, null response fields, saved contacts/inbox, a pending confirmation, mixed terminal/pending turns and an uncertain submission. `control-*` fixtures cover canonical send, pending admission, submitted acknowledgement and authenticated pairing rejection. `policy-cases.json` is language-independent expected behavior for time units, expiry, terminal statuses and backoff.

Native test suites should copy or load these fixtures, record their source path, and run decoder/policy tests on them. They contain synthetic identities only, not working cryptographic identity vectors. Signed encryption compatibility tests remain in the Web `tests/fixtures/protocol-go.json` fixture and the platform SDK tests.

```sh
npm test --workspace @agent-comm/client-contract
npm test                     # Web and shared package regression tests
npx tsc --noEmit
npm run lint
npm run build
```


Social parity RPCs are separately paired: `contacts.requests` is a read returning `{ contact_requests }`; `contacts.respond` accepts `{ request_id, decision: "accept" | "reject", contact_id?, aliases? }`; `messages.send` accepts `{ recipient_urn, text, message_id? }`; `inbox.mark_read` accepts `{ message_id }` and returns the authoritative message view. `collaboration.execute` accepts the same action parameters as the native runtime and exposes `describe.action_fields` for forms. It is never automatically scheduled; an `uncertain` execution must be inspected, not replayed under a new ID.

`collaboration.state` includes `contact_requests`, `sent_messages`, contact `connection_status` and expiring `presence`, and inbox `read`/`read_at`. `attention.target.kind` supports `contact`. Resolved inbox attention updates older cached read facts and closes notification counts and browser notices. Server push invalidation wakes a closed browser to revalidate and close the original notification; delivery remains subject to browser push availability.
