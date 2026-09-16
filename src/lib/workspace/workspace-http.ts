import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth/auth";
import { ControlError } from "@/lib/control/control-transport";
import { requireSameOrigin } from "@/lib/control/control-protocol";
import { readJsonBody, RequestBodyError } from "@/lib/shared/http-input";

export const workspaceJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });

export async function workspaceUserId(): Promise<string> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new ControlError("请先登录。", 401);
  return session.user.id;
}

export async function workspaceBody(request: Request): Promise<unknown> {
  try { requireSameOrigin(request); } catch { throw new ControlError("Forbidden origin", 403); }
  return readJsonBody(request, 4096, true);
}

export function workspaceFailure(error: unknown) {
  const expected = error instanceof ControlError || error instanceof RequestBodyError;
  return workspaceJson({ error: expected ? error.message : "暂时无法读取已保存的工作空间，请稍后重试。" }, expected ? error.status : 500);
}
