import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth/auth";
import { ControlError } from "@/lib/control/control-transport";
import { requireSameOrigin } from "@/lib/control/control-protocol";

export const workspaceJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });

export async function workspaceUserId(): Promise<string> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new ControlError("请先登录。", 401);
  return session.user.id;
}

export async function workspaceBody(request: Request): Promise<unknown> {
  try { requireSameOrigin(request); } catch { throw new ControlError("Forbidden origin", 403); }
  if (Number(request.headers.get("content-length") || 0) > 4096) throw new ControlError("Request too large", 413);
  const text = await request.text();
  if (Buffer.byteLength(text) > 4096) throw new ControlError("Request too large", 413);
  try { return text ? JSON.parse(text) : {}; } catch { throw new ControlError("Invalid JSON", 400); }
}

export function workspaceFailure(error: unknown) {
  return workspaceJson({ error: error instanceof ControlError ? error.message : "暂时无法读取已保存的工作空间，请稍后重试。" }, error instanceof ControlError ? error.status : 500);
}
