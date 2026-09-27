import { z } from "zod";
import { accountDeletionService } from "@/lib/auth/account-deletion";
import { accountEmailPost } from "@/lib/auth/account-email-http";
import { AccountEmailError } from "@/lib/auth/account-email";
import { validPasswordSize } from "@/lib/auth/password";

export const runtime = "nodejs";
const schema = z.object({
  expectedAccountId: z.string().min(1).max(128),
  currentPassword: z.string().refine(validPasswordSize, "请填写有效的当前密码。"),
  confirmation: z.literal("DELETE", { errorMap: () => ({ message: "请输入 DELETE 以确认永久删除。" }) }),
}).strict();

export async function POST(request: Request) {
  return accountEmailPost(request, schema, (body, userId, sessionVersion) => {
    if (!Number.isInteger(sessionVersion)) throw new AccountEmailError("请重新登录后再删除账户。", 401, "UNAUTHORIZED");
    // This is an optimistic identity assertion, never a client-selected target.
    if (body.expectedAccountId !== userId) throw new AccountEmailError("当前登录账户已改变，请刷新页面并重新确认后再操作。", 409, "ACCOUNT_CHANGED");
    return accountDeletionService.deleteAccount(userId!, body.currentPassword, sessionVersion!);
  }, { authenticated: true });
}

// No GET or DELETE handler: opening a link can never consume this destructive action.
