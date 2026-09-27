import type {Prisma} from "@prisma/client";
import {AccountEmailError} from "@/lib/auth/account-email";
export async function moderationRate(tx:Prisma.TransactionClient,userId:string,bucket:string,limit:number,now=Date.now()) {
  const windowStart=Math.floor(now/300_000)*300_000;
  const count=await tx.$executeRaw`INSERT INTO "ModerationRate" ("userId","bucket","windowStart","count") VALUES (${userId},${bucket},${windowStart},1) ON CONFLICT("userId","bucket") DO UPDATE SET "count"=CASE WHEN "ModerationRate"."windowStart"<excluded."windowStart" THEN 1 ELSE "ModerationRate"."count"+1 END,"windowStart"=excluded."windowStart" WHERE "ModerationRate"."windowStart"<excluded."windowStart" OR "ModerationRate"."count"<${limit}`;
  if(count!==1)throw new AccountEmailError("操作过于频繁，请稍后再试。",429,"MODERATION_RATE_LIMIT");
}
