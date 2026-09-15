import { z } from "zod";
import { RPC_METHODS } from "@agent-comm/client-contract";
export { CONTROL_PROTOCOL, validateControlResponse } from "@agent-comm/client-contract";
export type { ControlRequestBody } from "@agent-comm/client-contract";

export const controlCallSchema = z.object({
  request_id: z.string().uuid(),
  method: z.enum(RPC_METHODS),
  params: z.record(z.unknown()).default({}),
}).strict();

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.NEXTAUTH_URL || request.url).origin;
  if (origin !== expected) throw new Error("Same-origin browser request required");
}
