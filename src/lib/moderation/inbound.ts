import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { record, records, string, type RemoteRecord } from "@/lib/control/workbench-client";
import {canonicalJSON} from "@agent-comm/client-contract";
import { seal,unseal } from "../../../scripts/moderation-storage.cjs";
type DB = Pick<Prisma.TransactionClient,"$queryRaw"|"$executeRaw">;
export const CONTENT_PENDING = "对端内容尚未审核，请在网站核对后再允许展示。";
const hash = (body: unknown) => createHash("sha256").update(canonicalJSON(body)).digest("hex");
const stable = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const safeFields = (body: RemoteRecord, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(body,key)).map(key=>[key,body[key]]));
// These are protocol values, never a license to display arbitrary text under a
// familiar key. The host's describe response must remain usable by the forms.
const actions=new Set("describe state attention collaborations prepare_collaboration revoke_collaboration_maintenance inbox import_proposal register_resource resolve_contact export_contact prepare_contact contact_requests prepare_contact_response prepare_message mark_read prepare_task prepare_worker_policy pause_worker revoke_worker prepare_action confirm dispatch revoke memory_search memory_snapshot snapshot_resource".split(" "));
const capabilities=new Set(["share_slots","share_resource","propose_meeting","accept_meeting","send_text"]);
const argumentNames=new Set("task_id collaboration_id operation_id kind payload message_id resource_id title text name contact_id platform_url aliases urn request_id decision recipient_urn scope policy operation approval_id query limit reference max_chars after".split(" "));
const waitingReasons=new Set("peer_join peer_accept waiting_for_peer collaboration_complete agreement_sync agreement_ack agreement_ack_delivery missing_event withdrawal_decision cancel_decision maintenance_permission maintenance_budget event_chain_conflict owner_decision exception_requires_owner send_uncertain budget_exhausted state_changed worker_error peer_content_unavailable owner_revoked owner_paused".split(" "));
export function safeSocialMetadata(value:unknown,key=""):unknown {
  if(Array.isArray(value))return value.map(item=>safeSocialMetadata(item,key));
  if(value && typeof value==="object")return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,safeSocialMetadata(item,name)]));
  if(typeof value!=="string")return value;
  if((key==="actions" && actions.has(value)) || (key==="business_capabilities" && capabilities.has(value)) || (["required","optional"].includes(key) && argumentNames.has(value)) || (key==="rpc_param" && value==="source_conversation_id") || (key==="waiting_reason" && waitingReasons.has(value)))return value;
  if(/_at$/.test(key))return Number.isFinite(Date.parse(value))?value:CONTENT_PENDING;
  if(/(?:^id$|_ids?$|_urns?$|_digest$|_hash$|^(?:urn|status|state|phase|kind|direction|decision|method|action|connection_status|closure_reason|version)$)/.test(key) && /^[A-Za-z0-9._:-]{1,256}$/.test(value))return value;
  return CONTENT_PENDING;
}
function localTask(body:RemoteRecord,agentUrn:string):RemoteRecord|null {
  const scope=record(body.scope),session=string(body.owner_session),caps=scope.capabilities;
  // Store.state() emits owner-bound tasks from the local native authority
  // store. Peer invitations/events do not create this schema. Do not infer
  // ownership from a task ID, and do not trust a foreign sender's lookalike.
  if(body.sender_urn && body.sender_urn!==agentUrn || !stable(body.task_id) || !/^[A-Za-z0-9._:-]{1,128}\|[A-Za-z0-9._:-]{1,128}$/.test(session)
    || !Number.isSafeInteger(body.revision) || Number(body.revision)<1 || !["pending","active","revoked","denied"].includes(string(body.status))
    || !Array.isArray(caps) || !caps.length || !caps.every(value=>typeof value==="string" && capabilities.has(value))
    || typeof scope.purpose!=="string" || scope.purpose.length>1000 || typeof scope.topic!=="string" || scope.topic.length>500
    || !["recipient_ids","participant_ids","resource_ids"].every(key=>Array.isArray(scope[key]) && (scope[key] as unknown[]).every(stable))
    || !["window_start","window_end","expires_at"].every(key=>typeof scope[key]==="string" && Number.isFinite(Date.parse(scope[key] as string)))
    || !["max_duration_minutes","max_candidates","max_actions"].every(key=>Number.isSafeInteger(scope[key]) && Number(scope[key])>0))return null;
  const selected=safeSocialMetadata(body) as RemoteRecord;
  // Only the owner's typed mandate is private local content. Unknown task
  // extensions, peer packets, and source_context strings keep the same gate.
  selected.owner_session=session;
  selected.scope=safeFields(scope,["purpose","topic","capabilities","recipient_ids","participant_ids","resource_ids","window_start","window_end","max_duration_minutes","max_candidates","max_actions","expires_at"]);
  if(Array.isArray(scope.allowed_windows))selected.scope={...record(selected.scope),allowed_windows:records(scope.allowed_windows).map(window=>({start:typeof window.start==="string" && Number.isFinite(Date.parse(window.start))?window.start:CONTENT_PENDING,end:typeof window.end==="string" && Number.isFinite(Date.parse(window.end))?window.end:CONTENT_PENDING}))};
  return selected;
}
export async function reviewPeerContent(db: DB,userId: string,agentId: string,kind: string,id: string,body: RemoteRecord) {
  const digest = hash(body), timestamp=Date.now();
  if (!stable(id) || Buffer.byteLength(canonicalJSON(body),"utf8")>100000) return {status:"pending",digest,reviewId:""};
  const existing = (await db.$queryRaw<{id:string;status:string}[]>`SELECT "id","status" FROM "ModerationContent" WHERE "userId"=${userId} AND "agentId"=${agentId} AND "kind"=${kind} AND "recordId"=${id} AND "digest"=${digest}`)[0];
  if (existing) return {status:existing.status,digest,reviewId:existing.id};
  const reviewId=randomUUID(), payload=seal(process.env.NEXTAUTH_SECRET,userId,agentId,"content",reviewId,body);
  // Ownership is checked in the INSERT as well: legacy tables cannot resurrect
  // content after an account deletion between a read probe and this write.
  await db.$executeRaw`INSERT OR IGNORE INTO "ModerationContent" ("id","userId","agentId","kind","recordId","digest","payload","createdAt","updatedAt") SELECT ${reviewId},${userId},${agentId},${kind},${id},${digest},${payload},${timestamp},${timestamp} FROM "Agent" a JOIN "User" u ON u."id"=a."userId" WHERE a."id"=${agentId} AND u."id"=${userId}`;
  const saved=(await db.$queryRaw<{id:string;status:string}[]>`SELECT "id","status" FROM "ModerationContent" WHERE "userId"=${userId} AND "agentId"=${agentId} AND "kind"=${kind} AND "recordId"=${id} AND "digest"=${digest}`)[0];
  return {status:saved?.status || "pending",digest,reviewId:saved?.id || ""};
}
export async function filterWorkspaceInbound(db:DB,userId:string,agentId:string,agentUrn:string,method:string,original:RemoteRecord):Promise<RemoteRecord> {
  // Private assistant history is not an operator review queue. An explicit
  // report removal is the only moderation decision applied to these turns.
  if(method==="conversation.get" || method==="conversation.send") {
    const removed=await db.$queryRaw<{targetId:string;conversationId:string|null}[]>`SELECT m."targetId",i."conversationId" FROM "ModerationReport" m LEFT JOIN "WorkspaceItem" i ON i."agentId"=m."agentId" AND i."kind"='turn' AND i."itemId"=m."targetId" WHERE m."userId"=${userId} AND m."agentId"=${agentId} AND m."targetKind"='turn' AND m."decision"='hide'`;
    const ids=new Set(removed.map(row=>row.targetId)),clean=(body:RemoteRecord)=>ids.has(string(body.turn_id))?{...safeFields(body,["turn_id","text","status","created_at","updated_at","completed_at","locally_unconfirmed"]),response:"此回复已根据举报处理决定移除。",content_review:{status:"rejected",reviewId:"",digest:""},moderation:{status:"rejected",reason:"report_removed"}}:body;
    const conversationRemoved=removed.some(row=>row.conversationId && row.conversationId===original.conversation_id);
    return Array.isArray(original.turns)?{...(conversationRemoved || records(original.turns).some(turn=>ids.has(string(turn.turn_id)))?safeFields(original,["conversation_id","has_more","before","cursor"]):original),turns:records(original.turns).map(clean)}:clean(original);
  }
  const socialWrites=["contacts.add","contacts.respond","contacts.block","contacts.unblock","approval.respond","messages.send","collaboration.execute","inbox.review"];
  if (!["inbox.list","inbox.mark_read","inbox.review_preview","collaboration.state","contacts.requests","contacts.list","attention.list",...socialWrites].includes(method)) return original;
  const data:RemoteRecord=JSON.parse(JSON.stringify(original));
  data.contentSafety={version:1};
  // A paired host's review receipt binds the owner's decision to the exact
  // full preview. Preserve only this typed digest, never arbitrary strings
  // called fingerprint elsewhere or additional peer content on the receipt.
  const reviewFingerprint=method==="inbox.review" && stable(data.message_id)
    && typeof data.sender_urn==="string" && data.sender_urn.length<=256
    && /^urn:[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(data.sender_urn)
    && ["approved","rejected"].includes(string(data.status))
    && typeof data.fingerprint==="string" && /^[a-f0-9]{64}$/.test(data.fingerprint)
    ? data.fingerprint : undefined;
  let safety=await db.$queryRaw<{urn:string;blocked:number;revision:number}[]>`SELECT s."urn",s."blocked",s."revision" FROM "WorkspacePeerSafety" s JOIN "Agent" a ON a."id"=s."agentId" WHERE s."agentId"=${agentId} AND a."userId"=${userId}`;
  const latest=Math.max(0,...safety.map(peer=>peer.revision));
  if((method==="contacts.list" || method==="collaboration.state") && Number.isSafeInteger(data.safety_revision) && Number(data.safety_revision)>=latest && Array.isArray(data.blocked_peers)) {
    const peers=new Set([...safety.map(peer=>peer.urn),...records(data.blocked_peers).map(peer=>string(peer.urn)),...records(data.contacts).map(peer=>string(peer.urn))].filter(Boolean)),remoteBlocked=new Set(records(data.blocked_peers).filter(peer=>peer.blocked===true).map(peer=>string(peer.urn)));
    for(const urn of peers)await db.$executeRaw`INSERT INTO "WorkspacePeerSafety" ("agentId","urn","blocked","confirmedAt","revision") SELECT ${agentId},${urn},${remoteBlocked.has(urn)?1:0},${Date.now()},${Number(data.safety_revision)} FROM "Agent" a JOIN "User" u ON u."id"=a."userId" WHERE a."id"=${agentId} AND u."id"=${userId} ON CONFLICT("agentId","urn") DO UPDATE SET "blocked"=excluded."blocked","revision"=excluded."revision" WHERE excluded."revision">="WorkspacePeerSafety"."revision"`;
    safety=await db.$queryRaw<{urn:string;blocked:number;revision:number}[]>`SELECT "urn","blocked","revision" FROM "WorkspacePeerSafety" WHERE "agentId"=${agentId}`;
  }
  const blocked=new Set([...safety.filter(peer=>peer.blocked===1).map(peer=>peer.urn),...records(data.blocked_peers).filter(peer=>peer.blocked===true && !safety.some(saved=>saved.urn===peer.urn)).map(peer=>string(peer.urn))]);
  if(Array.isArray(data.contacts)) data.contacts=records(data.contacts).map(contact=>{const saved=safety.find(peer=>peer.urn===contact.urn);return saved?{...contact,blocked:saved.blocked===1,connection_status:saved.blocked===1?"blocked":contact.connection_status==="blocked"?"unverified":contact.connection_status}:contact;});
  data.safety_revision=Math.max(Number.isSafeInteger(data.safety_revision)?Number(data.safety_revision):0,...safety.map(peer=>peer.revision));
  if(method==="contacts.list" || method==="collaboration.state") data.blocked_peers=[...records(data.blocked_peers).filter(peer=>!safety.some(saved=>saved.urn===peer.urn)),...safety.filter(peer=>peer.blocked===1).map(peer=>({urn:peer.urn,blocked:true,connection_status:"blocked"}))];
  if(Array.isArray(data.blocked_peers))data.blocked_peers=records(data.blocked_peers).map(peer=>safeFields(peer,["urn","blocked","connection_status","blocked_at"]));
  if(data.review_policy)data.review_policy=safeSocialMetadata(data.review_policy);
  async function removed(kind:string,id:string) {return (await db.$queryRaw<{id:string}[]>`SELECT "id" FROM "ModerationReport" WHERE "userId"=${userId} AND "agentId"=${agentId} AND "targetKind"=${kind} AND "targetId"=${id} AND "decision"='hide' LIMIT 1`).length>0;}
  async function message(body:RemoteRecord) {
    if(blocked.has(string(body.sender_urn))) return {...safeFields(body,["message_id","sender_urn","kind","received_at","created_at","read","read_at"]),text:"此发送者已屏蔽，正文不会展示。",content_review:{status:"rejected",reviewId:"",digest:""}};
    if(body.text==="协作协议状态已更新，请查看原事项。" && record(body.content_review).metadata_only===true)return {...safeFields(body,["message_id","sender_urn","kind","received_at","created_at","read","read_at","task_id"]),text:body.text,content_review:{status:"approved",reviewId:"",digest:string(record(body.content_review).digest),metadata_only:true}};
    if(body.text===CONTENT_PENDING && record(body.content_review ?? body.moderation).status) {
      const review=record(body.content_review ?? body.moderation),saved=(await db.$queryRaw<{status:string;payload:string;id:string}[]>`SELECT "id","status","payload" FROM "ModerationContent" WHERE "id"=${string(review.reviewId)} AND "userId"=${userId} AND "agentId"=${agentId} AND "recordId"=${string(body.message_id)} AND "kind"='inbox'`)[0];
      if(saved?.status==="approved" && !await removed("inbox",string(body.message_id))) return {...safeFields(body,["message_id","sender_urn","kind","received_at","created_at","read","read_at"]),...unseal(process.env.NEXTAUTH_SECRET,userId,agentId,"content",saved.id,saved.payload),content_review:{...review,status:"approved"}};
      return {...safeFields(body,["message_id","sender_urn","kind","received_at","created_at","read","read_at"]),text:CONTENT_PENDING,content_review:{...review,status:await removed("inbox",string(body.message_id))?"rejected":saved?.status || "pending"}};
    }
    if (!string(body.text)) return {...safeSocialMetadata(body) as RemoteRecord,content_review:{status:"pending",reviewId:"",digest:""}};
    try {const packet=JSON.parse(string(body.text));if(["receipt","agreement_ack","sync"].includes(packet?.kind))return {...safeFields(body,["message_id","sender_urn","kind","received_at","created_at","read","read_at","task_id"]),text:"协作协议状态已更新，请查看原事项。",content_review:{status:"approved",reviewId:"",digest:hash(packet),metadata_only:true}};}catch{/* Ordinary text is queued for review below. */}
    const evidence={...body};for(const key of ["received_at","created_at","updated_at","read","read_at","status","fingerprint","text_truncated","content_review","moderation"])delete evidence[key];const review=await reviewPeerContent(db,userId,agentId,"inbox",string(body.message_id),evidence);
    const isRemoved=await removed("inbox",string(body.message_id));
    if (review.status === "approved" && !isRemoved) return {...body,content_review:review};
    return {...safeFields(body,["message_id","sender_urn","kind","received_at","created_at","read","read_at","task_id","unknown_sender"]),text:CONTENT_PENDING,content_review:isRemoved?{...review,status:"rejected"}:review};
  }
  if(method==="inbox.review_preview") { await message(data); return {...safeFields(data,["message_id","sender_urn","kind","received_at","status","fingerprint"]),text:CONTENT_PENDING}; }
  if (Array.isArray(data.messages)) data.messages=await Promise.all(records(data.messages).map(message));
  if (Array.isArray(data.inbox)) data.inbox=await Promise.all(records(data.inbox).map(message));
  else if (Array.isArray(record(data.inbox).messages)) data.inbox={...safeSocialMetadata(record(data.inbox)) as RemoteRecord,messages:await Promise.all(records(record(data.inbox).messages).map(message))};
  if (method==="inbox.mark_read" && record(data.message).message_id) data.message=await message(record(data.message));
  if(Array.isArray(data.pending_review)) {
    data.pending_review=records(data.pending_review).map(item=>({...safeFields(item,["message_id","sender_urn","kind","received_at"]),status:"pending"}));
    if(method==="inbox.list") data.messages=[...records(data.messages),...records(data.pending_review).filter(item=>!records(data.messages).some(message=>message.message_id===item.message_id)).map(item=>({...item,text:CONTENT_PENDING,content_review:{status:"pending",reviewId:"",digest:""}}))];
  }
  const collaboration=record(data.collaboration ?? data.collaboration_v2);
  const collections=[data,collaboration];
  async function socialRecord(body:RemoteRecord,id:string) {
    const previous=record(body.content_review);
    if(previous.reviewId) {
      const saved=(await db.$queryRaw<{id:string;status:string;payload:string}[]>`SELECT "id","status","payload" FROM "ModerationContent" WHERE "id"=${string(previous.reviewId)} AND "userId"=${userId} AND "agentId"=${agentId} AND "kind"='collaboration' AND "recordId"=${id}`)[0];
      const original=saved?unseal(process.env.NEXTAUTH_SECRET,userId,agentId,"content",saved.id,saved.payload):body;
      const hidden=await removed("collaboration",id) || blocked.has(string(original.sender_urn));
      if(saved?.status==="approved" && !hidden)return {...original,content_review:{...previous,status:"approved"}};
      return {...safeSocialMetadata(body) as RemoteRecord,content_review:{...previous,status:hidden?"rejected":saved?.status || "pending"}};
    }
    const review=await reviewPeerContent(db,userId,agentId,"collaboration",id,body),hidden=await removed("collaboration",id) || blocked.has(string(body.sender_urn));
    return review.status==="approved" && !hidden?{...body,content_review:review}:{...safeSocialMetadata(body) as RemoteRecord,content_review:hidden?{...review,status:"rejected"}:review};
  }
  for(const collection of collections) {
    for(const field of ["tasks","resources","operations","pending_confirmations","approval_decisions","events","proposals","agreements","dependencies"]) if(Array.isArray(collection[field])) collection[field]=await Promise.all(records(collection[field]).map(async body=> {
      const id=string(body.task_id,string(body.approval_id,string(body.operation_id,string(body.resource_id,string(body.event_id,string(body.id))))));
      const native=field==="tasks"?localTask(body,agentUrn):null;
      return native && !await removed("collaboration",id) ? native : socialRecord(body,id);
    }));
    if (Array.isArray(collection.invitations)) collection.invitations=await Promise.all(records(collection.invitations).map(async invitation=> {
      return socialRecord(invitation,string(invitation.collaboration_id,string(invitation.message_id)));
    }));
    if (Array.isArray(collection.collaborations)) collection.collaborations=await Promise.all(records(collection.collaborations).map(async value=> {
      // Terms have a known sender. Unknown extensions and source_context are
      // metadata-only, even after a terms approval: an approved topic cannot
      // authorize an unrelated nested peer string.
      const item:RemoteRecord={...safeSocialMetadata(value) as RemoteRecord,terms:value.terms,change_request:value.change_request,content_review:value.content_review}, id=string(item.collaboration_id,string(item.task_id));
      const hidden=blocked.has(string(item.peer_urn)) || await removed("collaboration",id);
      if(record(item.terms).topic===CONTENT_PENDING || record(record(item.change_request).terms).topic===CONTENT_PENDING) {
        const review=record(item.content_review),saved=(await db.$queryRaw<{id:string;status:string;payload:string}[]>`SELECT "id","status","payload" FROM "ModerationContent" WHERE "id"=${string(review.reviewId)} AND "userId"=${userId} AND "agentId"=${agentId} AND "kind"='collaboration' AND "recordId"=${id}`)[0];
        if(saved?.status==="approved" && !hidden) { const body=unseal(process.env.NEXTAUTH_SECRET,userId,agentId,"content",saved.id,saved.payload);if(string(item.initiator_urn)!==agentUrn) item.terms=body.terms;else item.change_request={...safeSocialMetadata(record(item.change_request)) as RemoteRecord,terms:body.terms};item.content_review={...review,status:"approved"}; }
        else item.content_review={...review,status:hidden?"rejected":saved?.status || "pending"};
        return record(item.content_review).status==="approved"?item:{...safeSocialMetadata(item) as RemoteRecord,content_review:item.content_review};
      }
      if(string(item.initiator_urn) !== agentUrn && Object.keys(record(item.terms)).length) {
        const review=await reviewPeerContent(db,userId,agentId,"collaboration",id,{sender_urn:item.initiator_urn,terms:item.terms});
        if(review.status!=="approved" || hidden) item.terms={...safeSocialMetadata(safeFields(record(item.terms),["version","start","end","participant_ids"])) as RemoteRecord,topic:CONTENT_PENDING};
        item.content_review=hidden?{...review,status:"rejected"}:review;
      }
      if(string(item.initiator_urn)===agentUrn && Object.keys(record(record(item.change_request).terms)).length) {
        const change=record(item.change_request), review=await reviewPeerContent(db,userId,agentId,"collaboration",id,{sender_urn:item.peer_urn,terms:change.terms});
        item.change_request={...safeSocialMetadata(change) as RemoteRecord,terms:review.status==="approved" && !hidden?change.terms:{topic:CONTENT_PENDING}};
        item.content_review=hidden?{...review,status:"rejected"}:review;
      }
      if(record(item.content_review).status && record(item.content_review).status!=="approved")return {...safeSocialMetadata(item) as RemoteRecord,content_review:item.content_review};
      if(hidden)return {...safeSocialMetadata(item) as RemoteRecord,content_review:{status:"rejected",reviewId:"",digest:""}};
      return item;
    }));
  }
  if (data.collaboration) data.collaboration=collaboration;
  else if(data.collaboration_v2) data.collaboration_v2=collaboration;
  for(const field of ["contact_requests",...(method==="contacts.requests"?["requests"]:[])])if(Array.isArray(data[field]))data[field]=records(data[field]).map(item=>safeFields(item,["request_id","peer_urn","sender_urn","recipient_urn","direction","status","contact_id","created_at","updated_at"]));
  if(Array.isArray(data.contacts))data.contacts=records(data.contacts).map(contact=>safeFields(contact,["contact_id","urn","aliases","alias","name","trusted","connection_status","blocked","presence","created_at","updated_at"]));
  const projected=new Set(["contacts","blocked_peers","messages","inbox","message","pending_review","review_policy","collaboration","collaboration_v2","collaborations","invitations","contact_requests","requests","sent_messages","tasks","resources","operations","pending_confirmations","approval_decisions","events","proposals","agreements","dependencies","contentSafety","safety_revision","items"]);
  if(method==="collaboration.state" || method==="inbox.list" || method==="contacts.list" || method==="contacts.requests" || method==="inbox.mark_read" || socialWrites.includes(method))for(const collection of collections)for(const [key,value] of Object.entries(collection))if(!projected.has(key))collection[key]=safeSocialMetadata(value,key);
  if(method==="attention.list") data.items=records(data.items).map(item=>record(item.target).kind!=="conversation" ? {...safeSocialMetadata(item) as RemoteRecord,title:"对端事项有更新",safe_summary:"请在网站核对对端内容后查看。"}:item);
  if(reviewFingerprint)data.fingerprint=reviewFingerprint;
  return data;
}
