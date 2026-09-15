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
  if (call.method === "attention.list" && !z.object({ after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().safeParse(call.params).success)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid attention pagination", path: ["params"] });
});

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.NEXTAUTH_URL || request.url).origin;
  if (origin !== expected) throw new Error("Same-origin browser request required");
}
