import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/shared/db";
import { AccountEmailError } from "@/lib/auth/account-email";
import { getWorkspaceModerationTarget } from "@/lib/workspace/workspace-store";
import { seal, unseal } from "../../../scripts/moderation-storage.cjs";
import {moderationRate} from "./rate";

const bytes = (value: string) => new TextEncoder().encode(value).length;
const bounded = (max: number) => z.string().refine(value => bytes(value) <= max);
export const moderationTargetSchema = z.object({ kind: z.enum(["contact", "contact_request", "inbox", "turn", "collaboration"]), id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict();
export const reportPreviewSchema = z.object({ reportId: z.string().uuid(), agentId: z.string().min(1).max(128), target: moderationTargetSchema }).strict();
export const reportSubmitSchema = reportPreviewSchema.extend({ reason: z.enum(["harassment", "hate", "sexual", "violence", "spam", "other"]), comment: bounded(2000), evidence: bounded(4000), previewToken: z.string().min(1).max(4096), consent: z.literal(true) }).strict();
type PreviewInput = z.infer<typeof reportPreviewSchema>;
type SubmitInput = z.infer<typeof reportSubmitSchema>;
type Row = { userId: string; id: string; agentId: string; targetKind: string; targetId: string; reason: string; fingerprint: string; payload: string; status: string; createdAt: number; updatedAt: number };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function problem(message: string, status: number, code: string): never { throw new AccountEmailError(message, status, code); }
export function limitEvidence(value: string) { let result = ""; for (const character of value) { if (bytes(result + character) > 4000) break; result += character; } return result; }
export function createReportService({ db = prisma, secret = process.env.NEXTAUTH_SECRET, now = Date.now, lookup = getWorkspaceModerationTarget }: { db?: PrismaClient; secret?: string; now?: () => number; lookup?: typeof getWorkspaceModerationTarget } = {}) {
  function mac(value: string) { if (!secret) problem("服务尚未配置举报加密。", 503, "MODERATION_UNAVAILABLE"); return createHmac("sha256", secret!).update("report-preview/v1:" + value).digest("base64url"); }
  function view(row: Row) {
    const body = unseal(secret, row.userId, row.agentId, "report", row.id, row.payload);
    return { id: row.id, agentId: row.agentId, target: { kind: row.targetKind, id: row.targetId }, reason: row.reason, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, response: typeof body.response === "string" ? body.response : "" };
  }
  async function target(tx:Prisma.TransactionClient,userId:string,input:PreviewInput) {try{return await lookup(tx,userId,input.agentId,input.target);}catch(error){if(error && typeof error==="object" && "status" in error && error.status===404)problem("已保存的记录不存在。",404,"NOT_FOUND");throw error;}}
  async function owned(tx: Prisma.TransactionClient, userId: string, agentId?: string) {
    const rows = agentId ? await tx.$queryRaw<{ id: string }[]>`SELECT u."id" FROM "User" u JOIN "Agent" a ON a."userId"=u."id" WHERE u."id"=${userId} AND a."id"=${agentId}` : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id"=${userId}`;
    if (!rows.length) problem("账户或所属记录不存在。", 404, "NOT_FOUND");
  }
  return {
    async preview(userId: string, raw: PreviewInput) {
      const input = reportPreviewSchema.parse(raw);
      return db.$transaction(async tx => {
        await owned(tx, userId, input.agentId);
        await moderationRate(tx,userId,"report-preview",60,now());
        const record = await target(tx,userId,input);
        const evidence = limitEvidence(record), expiresAt = now() + 15 * 60_000;
        const encoded = Buffer.from(JSON.stringify({ userId, ...input, evidenceHash: hash(evidence), expiresAt })).toString("base64url");
        return { reportId: input.reportId, evidence, previewToken: encoded + "." + mac(encoded), expiresAt };
      });
    },
    async submit(userId: string, raw: SubmitInput) {
      const input = reportSubmitSchema.parse(raw);
      const fingerprint = hash(JSON.stringify([input.agentId, input.target.kind, input.target.id, input.reason, input.comment, input.evidence, input.consent]));
      return db.$transaction(async tx => {
        await owned(tx, userId, input.agentId);
        const existing = (await tx.$queryRaw<Row[]>`SELECT * FROM "ModerationReport" WHERE "userId"=${userId} AND "id"=${input.reportId}`)[0];
        if (existing) { if (existing.fingerprint !== fingerprint) problem("此报告 ID 已绑定另一份内容。请先核实原报告。", 409, "REPORT_CONFLICT"); return { report: view(existing) }; }
        const [encoded, signature, extra] = input.previewToken.split(".");
        const expected = Buffer.from(mac(encoded || "")), actual = Buffer.from(signature || "");
        if (extra || expected.length !== actual.length || !timingSafeEqual(expected, actual)) problem("证据预览无效，请重新预览后再提交。", 400, "INVALID_PREVIEW");
        let token: { userId: string; reportId: string; agentId: string; target: PreviewInput["target"]; evidenceHash: string; expiresAt: number };
        try { token = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { problem("证据预览无效。", 400, "INVALID_PREVIEW"); }
        if (token!.userId !== userId || token!.reportId !== input.reportId || token!.agentId !== input.agentId || token!.target?.kind !== input.target.kind || token!.target?.id !== input.target.id || token!.expiresAt < now() || input.evidence && hash(input.evidence) !== token!.evidenceHash) problem("证据预览已变化或过期，请重新预览后再提交。", 400, "INVALID_PREVIEW");
        await target(tx,userId,input);
        const rate = await tx.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM "ModerationReport" WHERE "userId"=${userId} AND "createdAt">=${now()-86_400_000}`;
        if (Number(rate[0].n) >= 20) problem("24 小时内最多提交 20 份新报告，请稍后再试；原报告仍可查看。", 429, "REPORT_RATE_LIMIT");
        const timestamp = now(), payload = seal(secret, userId, input.agentId, "report", input.reportId, { comment: input.comment, evidence: input.evidence, response: "" });
        await tx.$executeRaw`INSERT INTO "ModerationReport" ("userId","id","agentId","targetKind","targetId","reason","fingerprint","payload","createdAt","updatedAt") VALUES (${userId},${input.reportId},${input.agentId},${input.target.kind},${input.target.id},${input.reason},${fingerprint},${payload},${timestamp},${timestamp})`;
        const row = (await tx.$queryRaw<Row[]>`SELECT * FROM "ModerationReport" WHERE "userId"=${userId} AND "id"=${input.reportId}`)[0];
        return { report: view(row) };
      });
    },
    async list(userId: string, limit = 20) { return db.$transaction(async tx => { await owned(tx,userId); const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM "ModerationReport" WHERE "userId"=${userId} ORDER BY "createdAt" DESC,"id" DESC LIMIT ${Math.min(50,Math.max(1,limit))}`); return { reports: rows.map(view) }; }); },
    async get(userId: string, id: string) { return db.$transaction(async tx => { await owned(tx,userId); const row = (await tx.$queryRaw<Row[]>`SELECT * FROM "ModerationReport" WHERE "userId"=${userId} AND "id"=${id}`)[0]; if (!row) problem("报告不存在。",404,"NOT_FOUND"); return { report: view(row) }; }); },
  };
}
export const reportService = createReportService();
