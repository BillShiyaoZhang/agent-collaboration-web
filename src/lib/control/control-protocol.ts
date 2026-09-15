import { z } from "zod";
import { RPC_METHODS } from "@agent-comm/client-contract";
export { CONTROL_PROTOCOL, validateControlResponse } from "@agent-comm/client-contract";
export type { ControlRequestBody } from "@agent-comm/client-contract";

export const controlCallSchema = z.object({
  request_id: z.string().uuid(),
  method: z.enum(RPC_METHODS),
  params: z.record(z.unknown()).default({}),
}).strict().superRefine((call, context) => {
  if (call.method === "attention.list" && !z.object({ after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().safeParse(call.params).success)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid attention pagination", path: ["params"] });
});

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.NEXTAUTH_URL || request.url).origin;
  if (origin !== expected) throw new Error("Same-origin browser request required");
}
