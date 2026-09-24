import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/auth";
import { requireSameOrigin } from "@/lib/control/control-protocol";
import { confirmPolicyDisclosure, pausePolicyUse, PolicyChangedError, readPolicyDisclosure, resumePolicyUse } from "@/lib/control/v2-policy";
import { readJsonBody, RequestBodyError } from "@/lib/shared/http-input";
import { scheduleWorkspaceSync } from "@/lib/workspace/workspace-store";
import { startWorkspaceSync } from "@/lib/workspace/workspace-sync";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function accountId() {
  const session = await getServerSession(authOptions);
  return session?.user?.id || null;
}

async function wakeAfterPolicyAccess(userId: string) {
  // Explicit consent and resume override the normal 15-second UI wake throttle.
  // A wake failure must not make an already-saved policy decision appear to fail.
  try { await scheduleWorkspaceSync(userId, undefined, true); }
  catch { console.warn("Policy access saved; workspace synchronization will retry on its next discovery tick."); }
  try { startWorkspaceSync(); }
  catch { console.warn("Policy access saved; workspace synchronization could not start yet."); }
}

export async function GET() {
  const userId = await accountId();
  if (!userId) return json({ error: "Unauthorized" }, 401);
  try { return json(await readPolicyDisclosure(userId)); }
  catch { return json({ error: "无法验证平台当前政策，远程工作台已暂停。" }, 503); }
}

export async function POST(request: Request) {
  const userId = await accountId();
  if (!userId) return json({ error: "Unauthorized" }, 401);
  try { requireSameOrigin(request); }
  catch { return json({ error: "Forbidden origin" }, 403); }
  let body: unknown;
  try { body = await readJsonBody(request, 256); }
  catch (error) { return json({ error: error instanceof RequestBodyError ? error.message : "Invalid request" },
    error instanceof RequestBodyError ? error.status : 400); }
  if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 &&
      "resume" in body && body.resume === true) {
    try { const disclosure = await resumePolicyUse(userId); await wakeAfterPolicyAccess(userId); return json(disclosure); }
    catch (error) { return error instanceof PolicyChangedError ? json({ error: error.message }, 409)
      : json({ error: "无法验证平台当前政策，远程工作台保持暂停。" }, 503); }
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 ||
      !("policy_hash" in body) || !("confirm" in body) ||
      !/^[a-f0-9]{64}$/.test(String((body as {policy_hash: unknown}).policy_hash)) ||
      (body as {confirm: unknown}).confirm !== true)
    return json({ error: "请确认页面展示的当前合规政策。" }, 400);
  try { const disclosure = await confirmPolicyDisclosure(userId, (body as {policy_hash: string}).policy_hash);
    await wakeAfterPolicyAccess(userId); return json(disclosure); }
  catch (error) {
    if (error instanceof PolicyChangedError) return json({ error: error.message }, 409);
    return json({ error: "无法验证平台当前政策，远程工作台已暂停。" }, 503);
  }
}

export async function DELETE(request: Request) {
  const userId = await accountId();
  if (!userId) return json({ error: "Unauthorized" }, 401);
  try { requireSameOrigin(request); }
  catch { return json({ error: "Forbidden origin" }, 403); }
  try { await pausePolicyUse(userId); return json({ paused: true }); }
  catch { return json({ error: "暂时无法保存暂停状态，请重试。" }, 503); }
}
