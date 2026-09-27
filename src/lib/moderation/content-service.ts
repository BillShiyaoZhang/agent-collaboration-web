import {createHmac,timingSafeEqual} from "node:crypto";
import {z} from "zod";
import {type PrismaClient} from "@prisma/client";
import {prisma} from "@/lib/shared/db";
import {AccountEmailError} from "@/lib/auth/account-email";
import {unseal} from "../../../scripts/moderation-storage.cjs";
import {moderationRate} from "./rate";
export const contentActionSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("preview"),id:z.string().uuid()}).strict(),
  z.object({action:z.literal("decide"),id:z.string().uuid(),digest:z.string().regex(/^[0-9a-f]{64}$/),decision:z.enum(["approve","reject"]),previewToken:z.string().max(2048),consent:z.literal(true)}).strict(),
]);
type Row={id:string;userId:string;agentId:string;kind:string;recordId:string;digest:string;status:string;payload:string;createdAt:number;updatedAt:number};
const summary=(row:Row)=>({id:row.id,agentId:row.agentId,target:{kind:row.kind,id:row.recordId},digest:row.digest,status:row.status,createdAt:row.createdAt,updatedAt:row.updatedAt});
export function createContentService({db=prisma,secret=process.env.NEXTAUTH_SECRET,now=Date.now}:{db?:PrismaClient;secret?:string;now?:()=>number}={}) {
  function mac(value:string) { if(!secret) throw new AccountEmailError("审核服务尚未配置。",503,"MODERATION_UNAVAILABLE");return createHmac("sha256",secret).update("content-preview/v1:"+value).digest("base64url"); }
  return {
    async list(userId:string,agentId?:string) { const rows=agentId?await db.$queryRaw<Row[]>`SELECT * FROM "ModerationContent" WHERE "userId"=${userId} AND "agentId"=${agentId} ORDER BY "createdAt" DESC LIMIT 50`:await db.$queryRaw<Row[]>`SELECT * FROM "ModerationContent" WHERE "userId"=${userId} ORDER BY "createdAt" DESC LIMIT 50`;return {items:rows.map(summary)}; },
    async action(userId:string,raw:z.infer<typeof contentActionSchema>) {
      const input=contentActionSchema.parse(raw);
      return db.$transaction(async tx=> {
        const row=(await tx.$queryRaw<Row[]>`SELECT m.* FROM "ModerationContent" m JOIN "Agent" a ON a."id"=m."agentId" JOIN "User" u ON u."id"=a."userId" WHERE m."id"=${input.id} AND m."userId"=${userId} AND u."id"=${userId}`)[0];
        if(!row) throw new AccountEmailError("审核记录不存在。",404,"NOT_FOUND");
        await moderationRate(tx,userId,"content-review",60,now());
        if(input.action==="preview") {
          const body=unseal(secret,userId,row.agentId,"content",row.id,row.payload),encoded=Buffer.from(JSON.stringify({userId,id:row.id,digest:row.digest,expiresAt:now()+900_000})).toString("base64url");
          return {item:summary(row),body,previewToken:encoded+"."+mac(encoded)};
        }
        const [encoded,signature,extra]=input.previewToken.split("."),expected=Buffer.from(mac(encoded || "")),actual=Buffer.from(signature || "");
        if(extra || expected.length!==actual.length || !timingSafeEqual(expected,actual)) throw new AccountEmailError("请重新预览后再决定。",400,"INVALID_PREVIEW");
        const preview=JSON.parse(Buffer.from(encoded,"base64url").toString());
        if(preview.userId!==userId || preview.id!==row.id || preview.digest!==input.digest || row.digest!==input.digest || preview.expiresAt<now()) throw new AccountEmailError("预览内容已改变或过期。",409,"CONTENT_CHANGED");
        if(row.status==="rejected" && input.decision==="approve") throw new AccountEmailError("此内容已被拒绝，不会恢复展示。",409,"CONTENT_REJECTED");
        if(row.status==="rejected" && input.decision==="reject") return {item:summary(row)};
        const body=unseal(secret,userId,row.agentId,"content",row.id,row.payload);
        const blocked=await tx.$queryRaw<{urn:string}[]>`SELECT "urn" FROM "WorkspacePeerSafety" WHERE "agentId"=${row.agentId} AND "blocked"=1 AND "urn"=${typeof body.sender_urn==="string"?body.sender_urn:""}`;
        const removed=await tx.$queryRaw<{id:string}[]>`SELECT "id" FROM "ModerationReport" WHERE "userId"=${userId} AND "agentId"=${row.agentId} AND "targetKind"=${row.kind} AND "targetId"=${row.recordId} AND "decision"='hide' LIMIT 1`;
        if(input.decision==="approve" && (blocked.length || removed.length)) throw new AccountEmailError("已屏蔽或已移除的内容不能批准展示。",409,"CONTENT_REJECTED");
        const status=input.decision==="approve"?"approved":"rejected";
        const updatedAt=Math.max(now(),row.updatedAt+1),count=await tx.$executeRaw`UPDATE "ModerationContent" SET "status"=${status},"reviewedBy"=${"owner:"+userId},"updatedAt"=${updatedAt} WHERE "userId"=${userId} AND "id"=${row.id} AND "digest"=${input.digest} AND "status"!='rejected'`;
        if(count!==1)throw new AccountEmailError("审核决定已改变，请刷新原记录。",409,"CONTENT_CHANGED");
        return {item:summary({...row,status,updatedAt})};
      });
    },
  };
}
export const contentService=createContentService();
