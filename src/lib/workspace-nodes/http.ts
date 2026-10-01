import "server-only";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth/auth";
import { requireSameOrigin } from "@/lib/control/control-protocol";
import { readJsonBody, RequestBodyError } from "@/lib/shared/http-input";
import { WorkspaceGatewayError } from "@/lib/workspace-nodes/gateway";

export const nodeJson = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "Referrer-Policy": "no-referrer" },
});

export async function workspaceNodeAccount(request?: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new WorkspaceGatewayError("请先登录。", 401);
  const expected = request?.headers.get("x-workspace-account");
  if (expected && expected !== session.user.id) throw new WorkspaceGatewayError("ACCOUNT_CHANGED", 409);
  return { id: session.user.id, label: session.user.email || session.user.id };
}

export async function nodeBody(request: Request) {
  try { requireSameOrigin(request); } catch { throw new WorkspaceGatewayError("Forbidden origin", 403); }
  return readJsonBody(request, 4096, true);
}

export const claimSchema = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9_-]{6,128}$/) }).strict();
export const emptySchema = z.object({}).strict();
export function nodeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new WorkspaceGatewayError("工作区标识无效。", 400);
  return value;
}
export function nodeFailure(error: unknown) {
  const expected = error instanceof WorkspaceGatewayError || error instanceof RequestBodyError;
  return nodeJson({ error: expected ? error.message : "工作区请求未完成，请重新读取状态。" }, expected ? error.status : 500);
}
