/** Compare immutable native content with an exact website record, never queue order. */
export type ReviewItem={id:string;agentId:string;target:{kind:string;id:string};digest:string;status:string};
export type ReviewPreview={item:ReviewItem;body:Record<string,unknown>;previewToken:string};
type NativePreview=Record<string,unknown>;
const object=(value:unknown):Record<string,unknown>=>value && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:{};
const digest=(value:unknown)=>typeof value==="string" && /^[a-f0-9]{64}$/.test(value);
const statuses=new Set(["pending","approved","rejected"]);
export const MAX_NATIVE_REVIEW_CANDIDATES=4;

export function nativeReviewCandidates(queue:unknown,remote:NativePreview,messageId:string,agentId:string):ReviewItem[] {
  if(remote.message_id!==messageId || typeof remote.text!=="string" || !remote.text || remote.text_truncated!==false
    || !digest(remote.fingerprint) || typeof remote.sender_urn!=="string" || remote.sender_urn.length>256
    || !/^urn:[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote.sender_urn)
    || typeof remote.kind!=="string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(remote.kind) || !statuses.has(String(remote.status))) {
    throw new Error("本机没有返回完整且匹配的审核预览，不能据此批准。");
  }
  if(!Array.isArray(queue))throw new Error("无法核对网站审核版本，请刷新原记录。");
  const selected=queue.map(object).filter(item=>object(item.target).kind==="inbox" && object(item.target).id===messageId);
  if(selected.length>MAX_NATIVE_REVIEW_CANDIDATES)throw new Error("这条消息的历史审核版本过多，请先逐项核对原队列。");
  const ids=new Set<string>();
  for(const item of selected) {
    if(typeof item.id!=="string" || !/^[a-f0-9-]{36}$/.test(item.id) || ids.has(item.id) || item.agentId!==agentId
      || !digest(item.digest) || !statuses.has(String(item.status)))throw new Error("网站审核版本的归属或摘要不一致，请重新核实。");
    ids.add(item.id);
  }
  return selected as ReviewItem[];
}

export function websiteReviewPreview(chosen:ReviewItem,raw:unknown):ReviewPreview {
  const preview=object(raw),item=object(preview.item),target=object(item.target),body=object(preview.body);
  if(item.id!==chosen.id || item.agentId!==chosen.agentId || item.digest!==chosen.digest || !digest(item.digest)
    || target.kind!==chosen.target.kind || target.id!==chosen.target.id || !statuses.has(String(item.status))
    || chosen.status==="rejected" && item.status!=="rejected"
    || typeof preview.previewToken!=="string" || !preview.previewToken || !preview.body || Array.isArray(preview.body)
    || typeof preview.body!=="object")throw new Error("网站预览未匹配原记录和摘要，不能批准。");
  return {item:item as ReviewItem,body,previewToken:preview.previewToken};
}

export function matchingNativeReview(previews:ReviewPreview[],remote:NativePreview):ReviewPreview|undefined {
  const matching=previews.filter(preview=>preview.item.target.kind==="inbox" && preview.item.target.id===remote.message_id
    && preview.body.message_id===remote.message_id && preview.body.sender_urn===remote.sender_urn
    && preview.body.text===remote.text && (Object.hasOwn(preview.body,"kind")?preview.body.kind:"chat.message")===remote.kind);
  // An exact rejected version must never be bypassed by a pending/approved twin.
  return matching.find(preview=>preview.item.status==="rejected") || matching[0];
}
