import "server-only";
import { z } from "zod";
import type { WorkspaceNode } from "./model";
import { validWorkspaceLaunch, workspacePublicConfig } from "./public-config";

export class WorkspaceGatewayError extends Error {
  constructor(message: string, public status = 502, public retryAfter?: number) { super(message); }
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
    await response.body?.cancel().catch(() => {});
    const status = [400, 404, 409, 410, 429].includes(response.status) ? response.status : 502;
    const message = status === 404 ? "工作区连接不存在，或不属于当前账户。"
      : status === 409 ? "连接尚不可用，请核对本机确认、在线状态或一次性码。"
      : status === 410 ? "申请或授权已到期，请在本机重新发起。"
      : status === 429 ? "请求过于频繁，请稍后重试。"
      : status === 400 ? "一次性码或请求无效。" : "工作区入口暂时不可用。";
    const retry = response.headers.get("retry-after") || "";
    const retryAfter = status === 429 ? (/^[1-9]\d{0,2}$/.test(retry) && Number(retry) <= 300 ? Number(retry) : 60) : undefined;
    throw new WorkspaceGatewayError(message, status, retryAfter);
  }
  // Gateway metadata is bounded independently of its HTTP/WS data plane.
  return readGatewayJson(response);
}

async function readGatewayJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const length = response.headers.get("content-length");
  if (contentType !== "application/json" || (length !== null && (!/^\d+$/.test(length) || Number(length) > 131072))) {
    await response.body?.cancel().catch(() => {});
    throw new WorkspaceGatewayError("工作区入口返回无效响应。");
  }
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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

export type NodePageQuery = { limit: number; view: "active" | "history"; cursor?: string };
export async function listWorkspaceNodes(accountId: string, query: NodePageQuery = { limit: 50, view: "active" }): Promise<{ nodes: WorkspaceNode[]; next_cursor: string | null }> {
  const params = new URLSearchParams({ limit: String(query.limit), view: query.view });
  if (query.cursor) params.set("cursor", query.cursor);
  const value = await gateway(accountId, `nodes?${params}`, "GET");
  const parsed = z.object({ nodes: z.array(z.unknown()).max(query.limit), next_cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).nullable() }).safeParse(value);
  if (!parsed.success) throw new WorkspaceGatewayError("工作区入口返回无效响应。");
  return { nodes: parsed.data.nodes.map(node => ownedNode(node, accountId)), next_cursor: parsed.data.next_cursor };
}

export async function enrollWorkspaceNode(accountId: string, label: string) {
  let publicConfig;
  try { publicConfig = workspacePublicConfig(); }
  catch { throw new WorkspaceGatewayError("本机接入入口尚未正确配置。", 503); }
  const parsed = z.object({ enrollment_token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/), expires_at: instant }).safeParse(
    await gateway(accountId, "enrollments", "POST", { label }));
  if (!parsed.success || Date.parse(parsed.data.expires_at) <= Date.now() || Date.parse(parsed.data.expires_at) > Date.now() + 301_000)
    throw new WorkspaceGatewayError("工作区入口返回无效接入码。");
  return { ...parsed.data, gateway_url: publicConfig.gateway_url };
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
  let valid = false;
  try { valid = validWorkspaceLaunch(url, id); } catch {}
  if (!valid)
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
    const value = z.object({ revoked: z.number().int().nonnegative() }).safeParse(await readGatewayJson(response));
    if (!value.success) throw new Error("unconfirmed");
  } catch { throw new WorkspaceGatewayError("工作区远程访问撤销尚未确认，账户未删除。请稍后重试。", 503); }
}
