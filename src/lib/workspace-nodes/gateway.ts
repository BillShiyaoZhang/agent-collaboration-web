import "server-only";
import { z } from "zod";
import type { WorkspaceNode } from "./model";

export class WorkspaceGatewayError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

const instant = z.string().datetime({ offset: true });
const nodeSchema = z.object({
  node_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().max(120),
  status: z.enum(["pending", "claimed", "paired", "revoked", "expired"]),
  online: z.boolean(),
  account_id: z.string().nullable(),
  account_label: z.string().nullable(),
  grant_id: z.string().nullable(),
  scopes: z.array(z.enum(["workspace.control", "workspace.manage"])).max(2),
  expires_at: instant,
  workspace_origin: z.string().url(),
  last_seen_at: instant.nullable(),
});

function configured() {
  const secret = process.env.WORKSPACE_GATEWAY_SECRET;
  let url: URL;
  try { url = new URL(process.env.WORKSPACE_GATEWAY_URL || ""); }
  catch { throw new WorkspaceGatewayError("本地工作区入口尚未配置。", 503); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== "/" || !secret || new TextEncoder().encode(secret).length < 32)
    throw new WorkspaceGatewayError("本地工作区入口尚未配置。", 503);
  return { origin: url.origin, secret };
}

async function gateway(accountId: string, path: string, method: string, body?: object): Promise<unknown> {
  const { origin, secret } = configured();
  const url = `${origin}/v1/accounts/${encodeURIComponent(accountId)}/${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new WorkspaceGatewayError("暂时无法连接工作区入口，请稍后重新读取。", 503); }
  if (!response.ok) {
    await response.body?.cancel();
    const status = [400, 404, 409, 410, 429].includes(response.status) ? response.status : 502;
    const message = status === 404 ? "工作区连接不存在，或不属于当前账户。"
      : status === 409 ? "连接尚不可用，请核对本机确认、在线状态或一次性码。"
      : status === 410 ? "申请或授权已到期，请在本机重新发起。"
      : status === 429 ? "请求过于频繁，请稍后重试。"
      : status === 400 ? "一次性码或请求无效。" : "工作区入口暂时不可用。";
    throw new WorkspaceGatewayError(message, status);
  }
  // Gateway metadata is bounded independently of its HTTP/WS data plane.
  const reader = response.body?.getReader();
  if (!reader) throw new WorkspaceGatewayError("工作区入口返回无效响应。");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 131072) { await reader.cancel(); throw new WorkspaceGatewayError("工作区入口返回无效响应。"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new WorkspaceGatewayError("工作区入口返回无效响应。"); }
  finally { reader.releaseLock(); }
}

function ownedNode(value: unknown, accountId: string): WorkspaceNode {
  const parsed = nodeSchema.safeParse(value);
  if (!parsed.success || parsed.data.account_id !== accountId)
    throw new WorkspaceGatewayError("工作区入口返回无效响应。");
  // Zod strips undeclared fields so connector credentials can never be reflected.
  return parsed.data;
}

export async function listWorkspaceNodes(accountId: string): Promise<{ nodes: WorkspaceNode[] }> {
  const value = await gateway(accountId, "nodes", "GET");
  const parsed = z.object({ nodes: z.array(z.unknown()).max(500) }).safeParse(value);
  if (!parsed.success) throw new WorkspaceGatewayError("工作区入口返回无效响应。");
  return { nodes: parsed.data.nodes.map(node => ownedNode(node, accountId)) };
}

export async function claimWorkspaceNode(accountId: string, code: string, label: string) {
  return ownedNode(await gateway(accountId, "pairings/claim", "POST", { code, label }), accountId);
}

export async function revokeWorkspaceNode(accountId: string, id: string) {
  return ownedNode(await gateway(accountId, `nodes/${encodeURIComponent(id)}`, "DELETE"), accountId);
}

export async function launchWorkspaceNode(accountId: string, id: string) {
  const result = z.object({ url: z.string().url(), expires_at: instant }).safeParse(
    await gateway(accountId, `nodes/${encodeURIComponent(id)}/launch`, "POST", {}));
  if (!result.success) throw new WorkspaceGatewayError("工作区入口返回无效响应。");
  const url = new URL(result.data.url);
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && local)))
    throw new WorkspaceGatewayError("工作区入口返回无效访问地址。");
  return result.data;
}


export async function revokeAccountWorkspaceNodes(accountId: string): Promise<void> {
  // Existing installations without the optional gateway retain their deletion path.
  if (!process.env.WORKSPACE_GATEWAY_URL && !process.env.WORKSPACE_GATEWAY_SECRET) return;
  const { origin, secret } = configured();
  let response: Response;
  try {
    response = await fetch(`${origin}/v1/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error("unconfirmed"); }
    const value = z.object({ revoked: z.number().int().nonnegative() }).safeParse(await response.json());
    if (!value.success) throw new Error("unconfirmed");
  } catch { throw new WorkspaceGatewayError("工作区远程访问撤销尚未确认，账户未删除。请稍后重试。", 503); }
}
