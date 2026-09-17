import { z } from "zod";
import { RPC_METHODS } from "@agent-comm/client-contract";
export { CONTROL_PROTOCOL, validateControlResponse } from "@agent-comm/client-contract";
export type { ControlRequestBody } from "@agent-comm/client-contract";

const contactParams = z.object({
  contact_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).refine(value => value !== "self" && value.trim() === value),
  aliases: z.array(z.string().min(1).max(100).refine(value => value.trim().length > 0)).min(1).max(16),
  urn: z.string().max(256).regex(/^urn:[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/).refine(value => value.trim() === value),
}).strict();
const approvalParams = z.object({
  approval_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).refine(value => value.trim() === value),
  decision: z.enum(["approve", "deny"]),
}).strict();

export const controlCallSchema = z.object({
  request_id: z.string().uuid(),
  method: z.enum(RPC_METHODS),
  params: z.record(z.unknown()).default({}),
}).strict().superRefine((call, context) => {
  if ((call.method === "contacts.add" && !contactParams.safeParse(call.params).success) ||
      (call.method === "approval.respond" && !approvalParams.safeParse(call.params).success))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid action parameters", path: ["params"] });
  const stableId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
  const socialSchemas: Partial<Record<string, z.ZodTypeAny>> = {
    "collaboration.execute": z.object({ action: z.string().regex(/^[a-z_]{1,64}$/) }).passthrough().refine(params => !["owner_principal", "owner_session", "owner", "context", "answer", "approved"].some(key => key in params)),
    "contacts.requests": z.object({}).strict(),
    "contacts.respond": z.object({ request_id: stableId, decision: z.enum(["accept", "reject"]),
      contact_id: contactParams.shape.contact_id.optional(), aliases: contactParams.shape.aliases.optional() }).strict(),
    "messages.send": z.object({ recipient_urn: contactParams.shape.urn, text: z.string().min(1).refine(value => value.trim().length > 0 && new TextEncoder().encode(value).length <= 24000), message_id: stableId.optional() }).strict(),
    "inbox.mark_read": z.object({ message_id: stableId }).strict(),
  };
  if (socialSchemas[call.method] && !socialSchemas[call.method]!.safeParse(call.params).success)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid communication action parameters", path: ["params"] });
  if (call.method === "attention.list" && !z.object({ after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().safeParse(call.params).success)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid attention pagination", path: ["params"] });
});

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.NEXTAUTH_URL || request.url).origin;
  if (origin !== expected) throw new Error("Same-origin browser request required");
}
