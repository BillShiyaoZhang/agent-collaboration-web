import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/auth";
import { prisma } from "@/lib/shared/db";
import { controlCallSchema, requireSameOrigin } from "@/lib/control/control-protocol";
import { ControlError } from "@/lib/control/control-transport";
import { createControlCall, pollControlResponses, controlCallResult } from "@/lib/control/control-service";
import { slowControlPollMetric, type ControlGetTimings } from "@/lib/control/control-poll-metrics";
import { recordWorkspaceResponse } from "@/lib/workspace/workspace-store";
import { readJsonBody, RequestBodyError } from "@/lib/shared/http-input";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function measured<T>(timings: ControlGetTimings | undefined,
  phase: "sessionMs" | "identityDbMs" | "controlDbMs" | "pollMs" | "routeProjectionMs",
  operation: () => Promise<T>): Promise<T> {
  if (!timings) return operation();
  const started = performance.now();
  try { return await operation(); }
  finally { timings[phase] = (timings[phase] || 0) + performance.now() - started; }
}

async function context(id: string, timings?: ControlGetTimings) {
  const session = await measured(timings, "sessionMs", () => getServerSession(authOptions));
  if (!session?.user?.id) throw new ControlError("Unauthorized", 401);
  const { agent, user } = await measured(timings, "identityDbMs", async () => ({
    agent: await prisma.agent.findFirst({ where: { id, userId: session.user.id } }),
    user: await prisma.user.findUnique({ where: { id: session.user.id } }),
  }));
  if (!agent || !user) throw new ControlError("Agent connection not found", 404);
  return { user, agent };
}

function failure(error: unknown) {
  const expected = error instanceof ControlError || error instanceof RequestBodyError;
  return json({ error: expected ? error.message : "请求未完成，请检查连接并重试。" }, expected ? error.status : 500);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, agent } = await context((await params).id);
    try { requireSameOrigin(request); } catch { throw new ControlError("Forbidden origin", 403); }
    const data = await readJsonBody(request, 32768);
    const call = controlCallSchema.safeParse(data);
    if (!call.success) return json({ error: "Invalid control request" }, 400);
    const result = await createControlCall(user, agent, call.data);
    return json(result, result.status === "complete" ? 200 : 202);
  } catch (error) { return failure(error); }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const started = performance.now();
  const timings: ControlGetTimings = { totalMs: 0 };
  try {
    const { user, agent } = await context((await params).id, timings);
    const requestId = new URL(request.url).searchParams.get("request_id");
    if (!requestId) return json({ error: "request_id required" }, 400);
    const row = await measured(timings, "controlDbMs", () => prisma.controlRequest.findFirst({ where: { id: requestId, agentId: agent.id, consoleUrn: user.virtualUrn! } }));
    if (!row) return json({ error: "请求不存在或短期缓存已过期。" }, 404);
    if (!row.responseEnvelope && row.deadline.getTime() > Date.now()) await measured(timings, "pollMs", () => pollControlResponses(user, timings));
    const latest = await measured(timings, "controlDbMs", () => prisma.controlRequest.findUnique({ where: { id: row.id } }));
    if (!latest) return json({ error: "请求缓存已过期。" }, 410);
    const decodeStarted = performance.now();
    let result: ReturnType<typeof controlCallResult>;
    try { result = controlCallResult(user, agent, latest); }
    finally { timings.resultDecodeMs = performance.now() - decodeStarted; }
    if ("response" in result && result.response) await measured(timings, "routeProjectionMs", () => recordWorkspaceResponse(user, agent, latest, result.response));
    return json(result);
  } catch (error) {
    timings.failed = true;
    return failure(error);
  } finally {
    timings.totalMs = performance.now() - started;
    const metric = slowControlPollMetric(timings);
    if (metric) console.warn(JSON.stringify(metric));
  }
}
