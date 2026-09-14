import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { controlCallSchema, requireSameOrigin } from "@/lib/control-protocol";
import { ControlError } from "@/lib/control-transport";
import { createControlCall, pollControlResponses, controlCallResult } from "@/lib/control-service";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function context(id: string) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new ControlError("Unauthorized", 401);
  const agent = await prisma.agent.findFirst({ where: { id, userId: session.user.id } });
  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!agent || !user) throw new ControlError("Agent connection not found", 404);
  return { user, agent };
}

function failure(error: unknown) {
  return json({ error: error instanceof ControlError ? error.message : "请求未完成，请检查连接并重试。" }, error instanceof ControlError ? error.status : 500);
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { user, agent } = await context(params.id);
    try { requireSameOrigin(request); } catch { throw new ControlError("Forbidden origin", 403); }
    const text = await request.text();
    if (Buffer.byteLength(text) > 32768) return json({ error: "Request too large" }, 413);
    let data: unknown;
    try { data = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400); }
    const call = controlCallSchema.safeParse(data);
    if (!call.success) return json({ error: "Invalid control request" }, 400);
    const result = await createControlCall(user, agent, call.data);
    return json(result, result.status === "complete" ? 200 : 202);
  } catch (error) { return failure(error); }
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { user, agent } = await context(params.id);
    const requestId = new URL(request.url).searchParams.get("request_id");
    if (!requestId) return json({ error: "request_id required" }, 400);
    const row = await prisma.controlRequest.findFirst({ where: { id: requestId, agentId: agent.id, consoleUrn: user.virtualUrn! } });
    if (!row) return json({ error: "请求不存在或短期缓存已过期。" }, 404);
    if (!row.responseEnvelope && row.deadline.getTime() > Date.now()) await pollControlResponses(user);
    const latest = await prisma.controlRequest.findUnique({ where: { id: row.id } });
    if (!latest) return json({ error: "请求缓存已过期。" }, 410);
    return json(controlCallResult(user, agent, latest));
  } catch (error) { return failure(error); }
}
