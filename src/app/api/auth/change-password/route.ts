import { z } from "zod";
import { accountEmailService } from "@/lib/auth/account-email";
import { validPasswordSize } from "@/lib/auth/password";
import { accountEmailPost, accountEmailPasswordSchema } from "@/lib/auth/account-email-http";
const schema = z.object({ currentPassword: z.string().refine(validPasswordSize, "当前密码格式无效。"), password: accountEmailPasswordSchema }).strict();
export function POST(request: Request) {
  return accountEmailPost(request, schema, (body, userId) => accountEmailService.changePassword(userId!, body.currentPassword, body.password), { status: 202, authenticated: true });
}
