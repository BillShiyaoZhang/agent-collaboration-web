import { z } from "zod";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import { AccountEmailError } from "./account-email";
import { MAX_PASSWORD_BYTES, validPasswordSize } from "./password";
import { readJsonBody, RequestBodyError } from "@/lib/shared/http-input";

export const accountEmailAddressSchema = z.string().trim().max(254, "邮箱地址过长。").email("请输入有效的邮箱地址。");
export const accountEmailPasswordSchema = z.string().min(8, "密码至少需要 8 个字符。").refine(validPasswordSize, `密码最多允许 ${MAX_PASSWORD_BYTES} 个 UTF-8 字节。`);
export const accountEmailTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "链接无效，请重新申请邮件。");
export const accountEmailHeaders = { "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer" };

function sameOrigin(request: Request) {
  let expected: URL;
  try { expected = new URL(process.env.NEXTAUTH_URL || ""); }
  catch { throw new AccountEmailError("网站地址尚未配置，请稍后重试。", 503, "EMAIL_NOT_CONFIGURED"); }
  if (!["http:", "https:"].includes(expected.protocol) || expected.username || expected.password ||
      (process.env.NODE_ENV === "production" && expected.protocol !== "https:")) throw new AccountEmailError("网站地址尚未配置，请稍后重试。", 503, "EMAIL_NOT_CONFIGURED");
  if (request.headers.get("origin") !== expected.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new AccountEmailError("请求来源无效。", 403, "FORBIDDEN_ORIGIN");
}
export function accountEmailFailure(error: unknown) {
  if (error instanceof AccountEmailError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: accountEmailHeaders });
  if (error instanceof RequestBodyError) return NextResponse.json({ error: error.status === 413 ? "请求内容过大。" : "请求格式无效。", code: "INVALID_INPUT" }, { status: error.status, headers: accountEmailHeaders });
  console.error("[account-email] INTERNAL_ERROR");
  return NextResponse.json({ error: "操作暂时无法完成，请稍后重试。", code: "INTERNAL_ERROR" }, { status: 500, headers: accountEmailHeaders });
}
export async function accountEmailPost<T>(request: Request, schema: z.ZodType<T>, execute: (body: T, userId?: string) => Promise<unknown>, options: { authenticated?: boolean; status?: number } = {}) {
  try {
    sameOrigin(request);
    let userId: string | undefined;
    if (options.authenticated) {
      const session = await getServerSession(authOptions);
      userId = session?.user?.id;
      if (!userId) throw new AccountEmailError("请先登录。", 401, "UNAUTHORIZED");
    }
    const body = await readJsonBody(request, 16384);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.errors[0];
      const message = /[\u3400-\u9fff]/.test(issue.message) ? issue.message : "请求格式无效，请检查输入。";
      throw new AccountEmailError(message, 400, "INVALID_INPUT");
    }
    return NextResponse.json(await execute(parsed.data, userId), { status: options.status || 200, headers: accountEmailHeaders });
  } catch (error) { return accountEmailFailure(error); }
}
