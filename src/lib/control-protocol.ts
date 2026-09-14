import { z } from "zod";

export const CONTROL_PROTOCOL = "agent-comm-control/v1";
export const controlCallSchema = z.object({
  request_id: z.string().uuid(),
  method: z.enum(["capabilities", "contacts.list", "collaboration.state", "inbox.list", "conversation.send", "conversation.get"]),
  params: z.record(z.unknown()).default({}),
}).strict();

export type ControlRequestBody = {
  protocol: typeof CONTROL_PROTOCOL; type: "request"; request_id: string;
  agent_urn: string; console_urn: string; deadline: string; method: string;
  params: Record<string, unknown>;
};

export function validateControlResponse(value: unknown, expected: Omit<ControlRequestBody, "params" | "type" | "protocol">): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid control response");
  const response = value as Record<string, unknown>;
  const fields = ["protocol", "type", "request_id", "agent_urn", "console_urn", "deadline", "method", "result", "error"];
  if (Object.keys(response).some(key => !fields.includes(key)) || response.protocol !== CONTROL_PROTOCOL || response.type !== "response") {
    throw new Error("Invalid control response protocol");
  }
  for (const key of ["request_id", "agent_urn", "console_urn", "deadline", "method"] as const) {
    if (response[key] !== expected[key]) throw new Error(`Control response ${key} does not match request`);
  }
  if (Object.hasOwn(response, "result") === Object.hasOwn(response, "error")) throw new Error("Response must contain exactly one result or error");
  if (Object.hasOwn(response, "error")) {
    if (!response.error || typeof response.error !== "object" || Array.isArray(response.error) ||
        typeof (response.error as Record<string, unknown>).code !== "string" ||
        typeof (response.error as Record<string, unknown>).message !== "string") throw new Error("Invalid control error");
  }
  return response;
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.NEXTAUTH_URL || request.url).origin;
  if (origin !== expected) throw new Error("Same-origin browser request required");
}
